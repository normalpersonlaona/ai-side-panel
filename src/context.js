/**
 * 上下文组装 + 预算控制。
 *
 * ⭐ 顺序是专门排过的，为的是吃满前缀缓存：
 *
 *   基础提示(永不变) → 网页正文(换页才变) → 全局记忆(偶尔改) → 历史 → 新问题
 *
 * 前缀缓存从第 0 个 token 开始连续匹配，所以「变化少的必须排前面」。
 * 千万别把易变的东西插到前面去 —— 那样每轮都全量 miss，纯烧钱。
 *
 * 早先的对话会被压成一段 summary 塞在历史前面（不是 system 末尾，
 * 因为历史才是它语义上属于的地方），压缩过的原文就不再发了。
 */

import { t } from './i18n.js';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/** 粗估 token 数。中文 ≈ 1 字 1 token，其余 ≈ 3.5 字符 1 token。 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.round(cjk + other / 3.5);
}

/** 一条消息占的 token（含角色开销和图片估算） */
export function messageTokens(m) {
  const OVERHEAD = 4;
  const IMG = 900; // 1600px 的图，各家大致都在 800~1500 之间

  if (typeof m.content === 'string') {
    return estimateTokens(m.content) + OVERHEAD;
  }
  if (Array.isArray(m.content)) {
    let n = OVERHEAD;
    for (const part of m.content) {
      if (part.type === 'text') n += estimateTokens(part.text);
      else if (part.type === 'image_url') n += IMG;
    }
    return n;
  }
  return OVERHEAD;
}

export function countMessages(msgs) {
  // note 只是界面提示，不算进预算
  return (msgs || [])
    .filter((m) => m.role !== 'note')
    .reduce((n, m) => n + messageTokens(m), 0);
}

/** 把一条消息拍平成纯文本（压缩历史、估算时用） */
export function flatten(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (p.type === 'text' ? p.text : '【图片】'))
      .join(' ');
  }
  return '';
}

// ── 组装 ───────────────────────────────────────────────────

/**
 * system 段。三段拼起来，顺序就是缓存顺序。
 */
export function buildSystem({ systemPrompt, page, memories }) {
  const parts = [systemPrompt || ''];

  // ① 网页正文 —— 同一个对话里基本不变，放前面
  if (page && page.text) {
    parts.push(
      t('sys.pageHead', { title: page.title, url: page.url }) + page.text + t('sys.pageFoot')
    );
  } else {
    // 这一轮没带页面内容，也得把话说明白，免得模型拿历史里的旧页面凑数
    parts.push(
      t('sys.noPage')
    );
  }

  // ② 全局记忆 —— 你可能随时改，放后面
  const mem = (memories || []).filter((m) => m.enabled && (m.text || '').trim());
  if (mem.length) {
    parts.push(
      t('sys.memHead') +
      mem.map((m) => `- ${m.text}`).join('\n') +
      t('sys.memFoot')
    );
  }

  return parts.join('');
}

/**
 * 组装最终要发出去的 messages。
 *
 * @param {object} o
 * @param {string} o.systemPrompt
 * @param {object|null} o.page        {title, url, text}
 * @param {Array}  o.memories         全部记忆（内部按 enabled 过滤）
 * @param {object} o.conv             当前对话
 * @returns {Array} OpenAI 格式 messages
 */
export function buildMessages({ systemPrompt, page, memories, conv }) {
  const out = [];

  const sys = buildSystem({ systemPrompt, page, memories });
  if (sys.trim()) out.push({ role: 'system', content: sys });

  // 压缩过的早期对话，作为第一对消息还原回去
  if (conv.summary) {
    out.push({ role: 'user', content: t('sys.compressSummaryLabel', { summary: conv.summary }) });
    out.push({ role: 'assistant', content: t('sys.compressAck') });
  }

  const rest = conv.messages.slice(conv.compressedUpTo || 0);
  for (const m of rest) {
    // note 是界面上的提示（比如「上下文已压缩」），不发给模型
    if (m.role === 'system' || m.role === 'note') continue;

    const msg = { role: m.role, content: m.raw ?? m.content ?? '' };
    // 工具调用要原样带回去，不然模型看不见自己刚才要干什么、结果是什么
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    out.push(msg);
  }

  return out;
}

// ── 预算与压缩 ─────────────────────────────────────────────

/** 超没超预算。budget 是 token 数。 */
export function overBudget(msgs, budget) {
  return countMessages(msgs) > budget;
}



/**
 * 把最老的一批消息压成摘要，写进 conv.summary / conv.compressedUpTo。
 * 就地修改 conv，调用方负责 saveConversation。
 *
 * @returns {Promise<boolean>} 是否真的压缩了
 */
export async function compressOldest({ conv, chatOnce, baseUrl, key, model, signal }) {
  const start = conv.compressedUpTo || 0;
  const all = conv.messages;

  // 至少留最近 4 条不压，不然刚说的话转头就被压没了
  const available = all.length - start - 4;
  if (available < 2) return false;

  // 一次压掉可用部分的一半，别每轮都压（每压一次就是一次请求）
  const take = Math.max(2, Math.floor(available / 2));
  const chunk = all.slice(start, start + take);

  const input =
    (conv.summary ? t('sys.compressHeadOld', { summary: conv.summary }) : '') +
    t('sys.compressHeadNew') +
    chunk
      .map((m) => `${m.role === 'user' ? t('sys.roleUser') : t('sys.roleAssistant')}：${flatten(m)}`)
      .join('\n\n');

  const { text } = await chatOnce({
    baseUrl,
    key,
    model,
    messages: [{ role: 'user', content: `${t('sys.compress')}\n\n${input}` }],
    maxTokens: 900,
    signal,
  });

  const summary = (text || '').trim();
  if (!summary) return false;

  conv.summary = summary;
  conv.compressedUpTo = start + take;
  return true;
}

/**
 * 把一条 AI 回答压成一条可以存进全局记忆的短句。
 */


export async function makeNote({ text, chatOnce, baseUrl, key, model, signal }) {
  const { text: out } = await chatOnce({
    baseUrl,
    key,
    model,
    messages: [{ role: 'user', content: `${t('sys.note')}\n\n${text}` }],
    maxTokens: 200,
    signal,
  });
  const note = (out || '').trim().replace(/^["「『]|["」』]$/g, '');
  if (!note || note.includes(t('sys.noteWorthless'))) return null;
  return note;
}
