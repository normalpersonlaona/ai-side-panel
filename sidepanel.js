/**
 * 侧边栏主逻辑。
 *
 * 存储：chrome.storage.local —— 配置、Key、对话、全局记忆，都是长期的。
 *
 * 上下文怎么组装、什么时候压缩，全在 src/context.js。那边注释解释了
 * 为什么消息顺序是那样排的（关系到前缀缓存命中）。
 *
 * 对模型的请求只有一个出口：src/api.js。
 */

import { PROVIDERS, findProvider, modelVision, guessVision } from './src/providers.js';
import { extractArticle, grabSelection } from './src/extract.js';
import { streamChat, chatOnce, listModels } from './src/api.js';
import * as store from './src/store.js';
import {
  buildMessages, countMessages, compressOldest, makeNote, overBudget, estimateTokens,
} from './src/context.js';
import {
  pageAction, agentTools, actionTier, describeAction, isDangerousLabel,
} from './src/act.js';
import { t, setLang, applyStatic, defaultQuicks } from './src/i18n.js';

// ── DOM ────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elConvTitle = $('conv-title');
const elDrawerBtn = $('btn-drawer');
const elNew = $('btn-new');
const elOptions = $('open-options');
const elProvider = $('provider');
const elModel = $('model');
const elRefreshModels = $('btn-refresh-models');
const elInclude = $('include-page');
const elPageHint = $('page-hint');
const elBudget = $('budget');
const elQuick = $('quick');
const elLog = $('log');
const elEmpty = $('empty');
const elThumbs = $('thumbs');
const elInput = $('input');
const elSend = $('btn-send');
const elStop = $('btn-stop');
const elFile = $('btn-file');
const elShot = $('btn-shot');
const elClear = $('btn-clear');
const elFileInput = $('file-input');
const elScrim = $('scrim');
const elDrawer = $('drawer');
const elDrawerClose = $('drawer-close');
const elConvList = $('conv-list');
const elMemList = $('mem-list');
const elMemInput = $('mem-input');
const elMemAdd = $('mem-add-btn');
const elMemCount = $('mem-count');
const elNew2 = $('btn-new2');
const elAgentMode = $('agent-mode');
const elConfirmBar = $('confirm-bar');
const elCbTitle = $('cb-title');
const elCbDetail = $('cb-detail');
const elCbAllow = $('cb-allow');
const elCbDeny = $('cb-deny');

// ── 默认值 ─────────────────────────────────────────────────

const DEFAULT_BUDGET = 60000; // token
const DEFAULT_STEPS = 8;      // 一次任务最多连续操作几步

// 默认快捷按钮、默认系统提示、操控规矩 —— 都在 src/lang/*.js 里，跟着界面语言走。

// ── 状态 ───────────────────────────────────────────────────

let cfg = null;
let conv = null;         // 当前对话
let memories = [];
let modelCache = {};     // { [providerId]: { ids: [], at: ts } } —— 自动拉回来的模型列表
let pendingImages = [];
let pageCache = null;    // {url, title, text, chars}
let abortCtl = null;
let busy = false;
let stickToBottom = true;

// ── 配置 ───────────────────────────────────────────────────

async function loadConfig() {
  const raw = await chrome.storage.local.get(null);
  cfg = {
    providerId: raw.providerId || 'deepseek',
    modelId: raw.modelId || 'deepseek-chat',
    keys: raw.keys || {},
    baseUrls: raw.baseUrls || {},
    models: raw.models || {},
    visionOverrides: raw.visionOverrides || {},
    includePage: raw.includePage !== false,
    maxPageChars: raw.maxPageChars || 30000,
    contextBudget: raw.contextBudget || DEFAULT_BUDGET,
    quicks: raw.quicks || defaultQuicks(),
    systemPrompt: raw.systemPrompt || t('sys.default'),
    agentMode: raw.agentMode === true,
    agentSteps: raw.agentSteps || 8,
    lang: raw.lang || 'auto',
  };
  modelCache = raw.modelCache || {};
}

async function saveConfig() {
  await chrome.storage.local.set(cfg);
}

function currentProvider() {
  return findProvider(cfg.providerId);
}

function currentBaseUrl() {
  const p = currentProvider();
  return (cfg.baseUrls[p.id] || '').trim() || p.baseUrl;
}

function currentKey() {
  return (cfg.keys[cfg.providerId] || '').trim();
}

// ── 服务商 / 模型 ──────────────────────────────────────────

function renderProviders() {
  elProvider.innerHTML = '';
  for (const p of PROVIDERS) {
    const o = document.createElement('option');
    o.value = p.id;
    const hasKey = !!(cfg.keys[p.id] || '').trim();
    o.textContent = hasKey ? p.name : `${p.name} · ${t('opt.keyUnset')}`;
    elProvider.appendChild(o);
  }
  elProvider.value = cfg.providerId;
}

function renderModels() {
  const p = currentProvider();
  elModel.innerHTML = '';

  // 设置页手填的模型名优先，别的都不看
  const custom = (cfg.models[p.id] || '').trim();
  if (custom) {
    const o = document.createElement('option');
    o.value = custom;
    o.textContent = t('model.custom', { id: custom });
    elModel.appendChild(o);
    elModel.value = custom;
    cfg.modelId = custom;
    return;
  }

  const mkOption = (id, label, parent) => {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = label;
    (parent || elModel).appendChild(o);
  };

  const presetIds = new Set(p.models.map((m) => m.id));
  const cached = modelCache[p.id]?.ids || [];
  // 拉回来的列表里，预置已经有了的不重复列
  const extra = cached.filter((id) => !presetIds.has(id));

  if (extra.length) {
    // 有额外的时候分组，一眼能看出哪些是预置、哪些是刚拉回来的
    const g1 = document.createElement('optgroup');
    g1.label = t('model.preset');
    p.models.forEach((m) => mkOption(m.id, m.label, g1));
    elModel.appendChild(g1);

    const g2 = document.createElement('optgroup');
    g2.label = t('model.fetched', { n: extra.length });
    extra.forEach((id) => {
      const v = guessVision(id);
      mkOption(id, id + (v === true ? ' 👁' : ''), g2);
    });
    elModel.appendChild(g2);
  } else {
    p.models.forEach((m) => mkOption(m.id, m.label));
  }

  // 当前选中的模型不在上面任何一组里 → 补一个，免得选择被吞掉
  const allIds = new Set([...presetIds, ...extra]);
  if (cfg.modelId && !allIds.has(cfg.modelId)) {
    mkOption(cfg.modelId, cfg.modelId);
  } else if (!cfg.modelId) {
    cfg.modelId = p.models[0]?.id || '';
  }

  elModel.value = cfg.modelId;
}

/** true / false / null（拿不准 → 界面按允许处理） */
function visionOk() {
  // ① 你在设置页手动定死的，最权威
  const ov = (cfg.visionOverrides || {})[cfg.modelId];
  if (ov === true || ov === false) return ov;

  const p = currentProvider();
  if ((cfg.models[p.id] || '').trim()) return null;

  // ② 预置表里写死的
  const known = modelVision(p, cfg.modelId);
  if (known !== null) return known;

  // ③ 按名字猜 —— 猜不出来返回 null，也就是放行
  return guessVision(cfg.modelId);
}

/**
 * 拉一次当前服务商的模型列表。
 * 静默失败 —— 这只是个锦上添花的功能，拉不到就用预置列表，不打扰你。
 */
async function refreshModelList({ silent = true } = {}) {
  const p = currentProvider();
  const key = currentKey();
  if (!key) {
    if (!silent) toast(t('toast.noKeyFor', { name: p.name }));
    return false;
  }

  try {
    const ids = await listModels({ baseUrl: currentBaseUrl(), key });
    if (!ids.length) {
      if (!silent) toast(t('toast.emptyList'));
      return false;
    }
    const cache = await store.setModelCacheFor(p.id, ids);
    modelCache = cache;
    renderModels();
    refreshImageButtons();
    if (!silent) toast(t('toast.fetched', { n: ids.length }));
    return true;
  } catch (e) {
    console.warn('[AI侧边栏] 拉模型列表失败：', e);
    if (!silent) toast(t('toast.fetchFail', { msg: String(e.message || e).slice(0, 60) }));
    return false;
  }
}

/** 缓存超过这个时间就后台悄悄刷新一次 */
const MODEL_CACHE_TTL = 24 * 3600 * 1000;

async function maybeAutoRefreshModels() {
  const p = currentProvider();
  if (!currentKey()) return;
  const at = modelCache[p.id]?.at || 0;
  if (Date.now() - at < MODEL_CACHE_TTL) return;
  await refreshModelList({ silent: true });
}

function refreshImageButtons() {
  const can = visionOk() !== false;
  elFile.disabled = !can;
  elShot.disabled = !can;
  const tip = can ? '' : t('composer.visionUnsupported');
  elFile.title = t('composer.uploadTip') + tip;
  elShot.title = t('composer.shotTip') + tip;
}

// ── 快捷按钮 ───────────────────────────────────────────────

function renderQuicks() {
  elQuick.innerHTML = '';
  for (const q of cfg.quicks) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = q.label;
    b.title = (q.prompt || '').slice(0, 120);
    b.addEventListener('click', () => runQuick(q));
    elQuick.appendChild(b);
  }
}

function setQuicksEnabled(on) {
  elQuick.querySelectorAll('button').forEach((b) => (b.disabled = !on));
}

async function runQuick(q) {
  if (busy) return;
  const sel = await getSelection();
  let text = q.prompt || '';
  if (sel) text += `\n\n${sel}`;
  elInput.value = '';
  autoGrow();
  send(text);
}

// ── 当前标签页 / 正文 ──────────────────────────────────────

const INJECTABLE = /^(https?|file):/i;

async function getActiveTab() {
  // 侧边栏是属于某个窗口的，就只认那个窗口的当前标签页。
  //
  // 原来用的是 lastFocusedWindow —— 你要是开了两个浏览器窗口，
  // 它有可能跑去认另一个窗口的标签页（「我刚打开的这个页面它抓不到」）。
  // currentWindow 对侧边栏来说才是对的语义。
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) return tab;

  // 兜底：万一 currentWindow 在某个环境下拿不到
  [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function getSelection() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return '';
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabSelection,
    });
    return r?.result || '';
  } catch {
    return '';
  }
}

/** 每次抓取发一个号，并发时只让最后发起的那次写入缓存 */
let pageFetchSeq = 0;

async function getPageContent(force = false) {
  const tab = await getActiveTab();
  if (!tab || tab.id == null || !INJECTABLE.test(tab.url || '')) {
    pageCache = null;
    updatePageHint();
    return null;
  }

  // 同一页不重复提取 —— 重复提取会让正文微抖，前缀缓存就断了
  if (!force && pageCache && pageCache.url === tab.url) return pageCache;

  const seq = ++pageFetchSeq;
  // 排查用：装了 devtools 就能看到它每次认的是哪个标签页
  console.log(`[AI侧边栏] 抓取 tabId=${tab.id} ${tab.url}`);

  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractArticle,
      args: [cfg.maxPageChars],
    });

    // 这次抓取已经被后来的覆盖了，结果直接丢掉，别写进缓存
    if (seq !== pageFetchSeq) return pageCache;

    const res = r?.result;
    if (!res) {
      pageCache = null;
      updatePageHint();
      return null;
    }

    // 标题和正文都取自页面自己（document.title / 提取结果），
    // url 也优先用页面自己报的 location.href —— 三者同源，
    // 避免 tab.url 和页面实际地址不一致时对不上号
    pageCache = {
      url: res.url || tab.url || '',
      title: res.title || tab.title || '',
      text: res.text,
      chars: res.chars,
      tabId: tab.id,
      at: Date.now(),
    };
    updatePageHint();
    return pageCache;
  } catch (e) {
    if (seq === pageFetchSeq) {
      console.warn('[AI侧边栏] 正文提取失败：', e);
      pageCache = null;
      updatePageHint(t('page.fail'));
    }
    return pageCache;
  }
}

/** 顶部显示「现在认的是哪个页面」，方便一眼核对 */
function updatePageHint(override) {
  if (!elPageHint) return;

  if (override) {
    elPageHint.textContent = override;
    elPageHint.title = '';
    return;
  }
  if (!cfg.includePage) {
    elPageHint.textContent = t('page.off');
    elPageHint.title = t('page.offTip');
    return;
  }
  if (pageCache && pageCache.text) {
    elPageHint.textContent = pageCache.title || t('page.untitled');
    elPageHint.title =
      t('page.detail', { title: pageCache.title, url: pageCache.url, chars: pageCache.chars, sent: pageCache.text.length });
  } else {
    elPageHint.textContent = t('page.none');
    elPageHint.title = t('page.noneTip');
  }
}

/** 发送前把 pageCache 刷成当前页，免得发出去的是上一个标签页的内容 */
async function refreshPage() {
  if (!cfg.includePage) return null;
  return await getPageContent();
}

// ── 预算 ───────────────────────────────────────────────────

function fmtTokens(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function refreshBudget() {
  if (!conv || !cfg) return;

  const msgs = buildMessages({
    systemPrompt: cfg.systemPrompt,
    page: cfg.includePage ? pageCache : null,
    memories,
    conv,
  });

  const shown = countMessages(msgs) + estimateTokens(elInput.value);
  const budget = cfg.contextBudget || DEFAULT_BUDGET;
  const pct = shown / budget;

  elBudget.textContent = `${fmtTokens(shown)} / ${fmtTokens(budget)}`;
  elBudget.classList.toggle('warn', pct >= 0.8 && pct < 1);
  elBudget.classList.toggle('over', pct >= 1);
  elBudget.title =
    t('tool.budgetTitle', { n: shown, cap: budget });
}

/**
 * 超预算就把最老的几轮压成摘要。
 * 压缩本身要发一次请求，所以只在真的超了才做 —— 不是每轮都压。
 */
async function ensureBudget(signal) {
  const budget = cfg.contextBudget || DEFAULT_BUDGET;
  const snapshot = () => buildMessages({
    systemPrompt: cfg.systemPrompt,
    page: cfg.includePage ? pageCache : null,
    memories,
    conv,
  });

  if (!overBudget(snapshot(), budget)) return;

  const ok = await compressOldest({
    conv,
    chatOnce,
    baseUrl: currentBaseUrl(),
    key: currentKey(),
    model: cfg.modelId,
    signal,
  });

  if (ok) {
    conv.messages.push({
      role: 'note',
      content: t('note.compressDone'),
    });
    await store.saveConversation(conv);
    renderAll();
    toast(t('toast.compressed'));
  } else {
    toast(t('toast.compressNoop'));
  }
}

// ── 图片 ───────────────────────────────────────────────────

async function compressImage(blobOrFile, maxSide = 1600, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(blobOrFile);
    let w = bmp.width;
    let h = bmp.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透明处填白，不然 JPEG 会变黑
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return await blobToDataUrl(out);
  } catch (e) {
    console.warn('[AI侧边栏] 压缩失败，用原图：', e);
    return await blobToDataUrl(blobOrFile);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function addImages(list) {
  if (visionOk() === false) {
    toast(t('toast.visionUnsupported'));
    return;
  }
  for (const f of list) {
    if (!f.type || !f.type.startsWith('image/')) continue;
    pendingImages.push({
      dataUrl: await compressImage(f),
      name: f.name || 'image',
    });
  }
  renderThumbs();
  refreshBudget();
}

function renderThumbs() {
  elThumbs.innerHTML = '';
  elThumbs.hidden = pendingImages.length === 0;

  pendingImages.forEach((img, i) => {
    const box = document.createElement('div');
    box.className = 'thumb';

    const im = document.createElement('img');
    im.src = img.dataUrl;
    im.alt = img.name;
    im.addEventListener('click', () => openLightbox(img.dataUrl));

    const x = document.createElement('button');
    x.textContent = '×';
    x.title = t('common.remove');
    x.addEventListener('click', () => {
      pendingImages.splice(i, 1);
      renderThumbs();
      refreshBudget();
    });

    box.append(im, x);
    elThumbs.appendChild(box);
  });
}

async function captureVisible() {
  if (visionOk() === false) {
    toast(t('toast.visionUnsupported'));
    return;
  }
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  try {
    // 得让被截的窗口在最前面，不然截到的是别的窗口
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    pendingImages.push({ dataUrl: await compressImage(blob), name: '截图' });
    renderThumbs();
    refreshBudget();
  } catch (e) {
    console.error(e);
    toast(t('toast.shotFail', { msg: e.message || e }));
  }
}

// ── Markdown 轻量渲染（CSP 不让引外部库，自己来） ──────────

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function renderMarkdown(src) {
  src = String(src ?? '');

  // 流式输出时代码围栏可能只开了一半，先补齐，不然满屏反引号
  if ((src.match(/```/g) || []).length % 2 === 1) src += '\n```';

  const blocks = [];

  // 占位符用 Unicode 私有区字符，普通正文里不会出现这两个
  let text = src.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `${blocks.length - 1}`;
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  text = text.replace(/^#{1,6}\s+(.*)$/gm, '<b>$1</b>');
  text = text.replace(/^&gt;\s?(.*)$/gm, '<span style="opacity:.75">▏$1</span>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

  return text.replace(/(\d+)/g, (_m, i) => blocks[+i]);
}

// ── 消息渲染 ───────────────────────────────────────────────

function hideEmpty() {
  if (elEmpty) elEmpty.style.display = 'none';
}

function showEmpty() {
  if (elEmpty) elEmpty.style.display = '';
}

function scrollDown(force = false) {
  if (force) stickToBottom = true;
  if (stickToBottom) elLog.scrollTop = elLog.scrollHeight;
}

function modelLabel() {
  const p = currentProvider();
  const custom = (cfg.models[p.id] || '').trim();
  if (custom) return custom;
  const m = p.models.find((x) => x.id === cfg.modelId);
  return m ? m.label : cfg.modelId;
}

function addMessageEl(role, { text = '', images = [], streaming = false } = {}) {
  hideEmpty();

  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? t('msg.you') : modelLabel();
  wrap.appendChild(who);

  if (images.length) {
    const pics = document.createElement('div');
    pics.className = 'pics';
    for (const src of images) {
      const im = document.createElement('img');
      im.src = src;
      im.addEventListener('click', () => openLightbox(src));
      pics.appendChild(im);
    }
    wrap.appendChild(pics);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = streaming
    ? '<span class="caret"></span>'
    : renderMarkdown(text);
  wrap.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'meta';
  wrap.appendChild(meta);

  elLog.appendChild(wrap);
  scrollDown(true);
  return { wrap, bubble, meta };
}

function addNoteEl(text) {
  const n = document.createElement('div');
  n.className = 'sysnote';
  n.textContent = text;
  elLog.appendChild(n);
  scrollDown();
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  const im = document.createElement('img');
  im.src = src;
  box.appendChild(im);
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

// 一次只留一条提示，每条自己管自己的生死。
// （之前共用一个计时器 —— 连着弹两条时第一条的计时器被掐掉，
//   那个 DOM 就永远没人删了，会一直挂在屏幕上。）
let toastEl = null;

function clearToast() {
  if (toastEl) {
    toastEl.remove();
    toastEl = null;
  }
}

function toast(text) {
  clearToast();

  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  toastEl = t;

  setTimeout(() => {
    if (toastEl === t) toastEl = null;
    t.remove();
  }, 2600);
}

// 兜底：只要你在面板里点一下或敲个键，挂着的提示立刻清掉。
// 万一计时器因为什么原因没跑（页面被节流之类的），也不会永远赖着不走。
['pointerdown', 'keydown', 'wheel'].forEach((ev) =>
  document.addEventListener(ev, clearToast, true)
);

function buildMeta(meta, m, index) {
  meta.innerHTML = '';

  if (m.usage?.prompt_tokens) {
    const s = document.createElement('span');
    s.className = 'tok';
    s.textContent = `${m.usage.prompt_tokens} → ${m.usage.completion_tokens ?? '?'} tok`;
    s.title = '输入 token → 输出 token（服务商返回的真实值，不是估算）';
    meta.appendChild(s);
  }

  if (m.role !== 'assistant') return;

  const copy = document.createElement('button');
  copy.textContent = t('msg.copy');
  copy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(m.content || '');
    copy.textContent = t('msg.copied');
    setTimeout(() => (copy.textContent = t('msg.copy')), 1200);
  });
  meta.appendChild(copy);

  const note = document.createElement('button');
  note.textContent = t('msg.saveNote');
  note.title = t('msg.saveNoteTip');
  note.addEventListener('click', () => saveAsNote(m.content || '', note));
  meta.appendChild(note);

  const retry = document.createElement('button');
  retry.textContent = t('msg.retry');
  retry.addEventListener('click', () => retryFrom(index));
  meta.appendChild(retry);
}

function renderAll() {
  elLog.querySelectorAll('.msg, .sysnote').forEach((n) => n.remove());

  if (!conv || !conv.messages.length) {
    showEmpty();
    return;
  }
  hideEmpty();

  conv.messages.forEach((m, i) => {
    if (m.role === 'system') return;
    if (m.role === 'note') {
      addNoteEl(m.content);
      return;
    }
    // 工具结果不单独画出来，界面上已经有「▸ 点击了…」那一行
    if (m.role === 'tool') return;
    // 光调工具没说话的助手消息，不用画一个空气泡
    if (m.role === 'assistant' && !m.content && m.tool_calls?.length) return;
    const { meta } = addMessageEl(m.role, {
      text: m.display ?? m.content,
      images: m.images || [],
    });
    buildMeta(meta, m, i);
  });
}

// ── 对话管理 ───────────────────────────────────────────────

function renderConvTitle() {
  elConvTitle.textContent = conv?.title || t('drawer.defaultConvTitle');
  elConvTitle.title = conv?.title || t('drawer.defaultConvTitle');
}

function timeAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return t('time.justNow');
  if (d < 3600e3) return t('time.minAgo', { n: Math.floor(d / 60e3) });
  if (d < 86400e3) return t('time.hourAgo', { n: Math.floor(d / 3600e3) });
  if (d < 7 * 86400e3) return t('time.dayAgo', { n: Math.floor(d / 86400e3) });
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

async function renderConvList() {
  const list = await store.listConversations();
  const activeId = conv?.id;

  elConvList.innerHTML = '';

  if (!list.length) {
    const n = document.createElement('div');
    n.className = 'empty-note';
    n.textContent = t('drawer.noConvs');
    elConvList.appendChild(n);
    return;
  }

  for (const c of list) {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === activeId ? ' on' : '');

    const info = document.createElement('div');
    info.className = 'info';

    // 注意：别把这个局部变量叫 t —— 会把上面导入的 t() 遮蔽掉，整段直接炸
    const titleEl = document.createElement('div');
    titleEl.className = 't';
    titleEl.textContent = c.title || t('drawer.defaultConvTitle');

    const s = document.createElement('div');
    s.className = 's';
    s.textContent = t('drawer.convMeta', { n: (c.messages || []).length, when: timeAgo(c.updatedAt) });

    info.append(titleEl, s);
    item.appendChild(info);

    const acts = document.createElement('div');
    acts.className = 'acts';

    const ren = document.createElement('button');
    ren.className = 'mini';
    ren.textContent = '✎';
    ren.title = t('drawer.rename');
    ren.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt(t('drawer.renamePrompt'), c.title);
      if (name == null) return;
      const v = name.trim() || t('drawer.defaultConvTitle');
      await store.renameConversation(c.id, v);
      if (c.id === conv.id) {
        conv.title = v;
        renderConvTitle();
      }
      renderConvList();
    });

    const del = document.createElement('button');
    del.className = 'mini del';
    del.textContent = '×';
    del.title = t('drawer.delete');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删掉「${c.title}」？删了就找不回来了。`)) return;
      const rest = await store.deleteConversation(c.id);
      if (c.id === conv.id) {
        if (rest.length) await switchConversation(rest[0].id);
        else await makeNewConversation();
      }
      renderConvList();
    });

    acts.append(ren, del);
    item.appendChild(acts);

    item.addEventListener('click', () => switchConversation(c.id));
    elConvList.appendChild(item);
  }
}

async function switchConversation(id) {
  if (busy) return;
  if (conv && conv.id === id) {
    closeDrawer();
    return;
  }
  if (conv) await store.saveConversation(conv);

  const next = await store.getConversation(id);
  if (!next) return;

  await store.setActiveId(id);
  conv = next;
  conv.messages = conv.messages || [];
  conv.summary = conv.summary || '';
  conv.compressedUpTo = conv.compressedUpTo || 0;

  elInclude.checked = conv.includePage !== false;
  renderConvTitle();
  renderAll();
  updatePageHint();
  refreshBudget();
  closeDrawer();
}

async function makeNewConversation() {
  if (busy) return;
  if (conv) await store.saveConversation(conv);

  const tab = await getActiveTab();
  conv = await store.newConversation({
    includePage: cfg.includePage,
    url: tab?.url || '',
    pageTitle: pageCache?.title || tab?.title || '',
  });

  elInclude.checked = conv.includePage !== false;
  renderConvTitle();
  renderAll();
  updatePageHint();
  refreshBudget();
  await renderConvList();
  closeDrawer();
  elInput.focus();
}

// ── 全局记忆 ───────────────────────────────────────────────

async function reloadMemories() {
  memories = await store.listMemories();
}

function renderMemList() {
  elMemList.innerHTML = '';
  elMemCount.textContent = memories.length ? String(memories.length) : '';

  if (!memories.length) {
    const n = document.createElement('div');
    n.className = 'empty-note';
    n.style.whiteSpace = 'pre-line';
    n.textContent = '还没有笔记。\n\n聊到值得长期记住的东西时，\n把鼠标移到某条回答上，点「存为笔记」。';
    elMemList.appendChild(n);
    return;
  }

  for (const m of memories) {
    const item = document.createElement('div');
    item.className = 'mem-item' + (m.enabled ? '' : ' off');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!m.enabled;
    cb.title = t('mem.toggleTip');
    cb.addEventListener('change', async () => {
      await store.updateMemory(m.id, { enabled: cb.checked });
      item.classList.toggle('off', !cb.checked);
      await reloadMemories();
      refreshBudget();
    });

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.contentEditable = 'true';
    txt.textContent = m.text;
    txt.title = t('mem.editTip');
    txt.addEventListener('blur', async () => {
      const v = txt.textContent.trim();
      if (!v) {
        txt.textContent = m.text;
        return;
      }
      if (v !== m.text) {
        await store.updateMemory(m.id, { text: v });
        await reloadMemories();
        refreshBudget();
      }
    });
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        txt.blur();
      }
    });

    const del = document.createElement('button');
    del.className = 'mini del';
    del.textContent = '×';
    del.title = t('mem.deleteTip');
    del.addEventListener('click', async () => {
      await store.deleteMemory(m.id);
      await reloadMemories();
      renderMemList();
      refreshBudget();
    });

    item.append(cb, txt, del);
    elMemList.appendChild(item);
  }
}

async function onAddMemory() {
  const v = elMemInput.value.trim();
  if (!v) return;
  await store.addMemory(v);
  elMemInput.value = '';
  await reloadMemories();
  renderMemList();
  refreshBudget();
  toast(t('toast.remembered'));
}

/** 把一条 AI 回答提炼成一条全局记忆 */
async function saveAsNote(text, btn) {
  const key = currentKey();
  if (!key) {
    toast(t('toast.needKeyFirst'));
    return;
  }
  if (!text.trim()) return;

  const old = btn.textContent;
  btn.textContent = t('toast.distilling');
  btn.disabled = true;

  try {
    const note = await makeNote({
      text,
      chatOnce,
      baseUrl: currentBaseUrl(),
      key,
      model: cfg.modelId,
    });

    if (!note) {
      toast(t('toast.noteNone'));
      return;
    }

    await store.addMemory(note);
    await reloadMemories();
    renderMemList();
    refreshBudget();
    toast(t('toast.noteDone', { note: note.slice(0, 26) + (note.length > 26 ? '…' : '') }));
  } catch (e) {
    console.error(e);
    toast(t('toast.noteFail', { msg: e.message || e }));
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

// ── 抽屉 ───────────────────────────────────────────────────

function openDrawer() {
  elDrawer.hidden = false;
  elScrim.hidden = false;
  renderConvList();
  if (!$('pane-mems').hidden) renderMemList();
}

function closeDrawer() {
  elDrawer.hidden = true;
  elScrim.hidden = true;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.dataset.tab === name);
  });
  $('pane-convs').hidden = name !== 'convs';
  $('pane-mems').hidden = name !== 'mems';
  if (name === 'mems') renderMemList();
}

// ── 页面操控 ───────────────────────────────────────────────

let lastSnapshot = null;   // 最近一次 list 的结果，用来把 ref 翻译成人话
let confirmResolve = null; // 确认条的 pending promise

/** 记一条动作日志：既显示在界面上，也存进对话里（重开后还能看见干过什么） */
function pushNote(text) {
  if (conv) conv.messages.push({ role: 'note', content: text });
  addNoteEl(text);
}

function askConfirm(name, args, targetLabel) {
  const danger =
    isDangerousLabel(targetLabel) ||
    (name === 'navigate' && isDangerousLabel(args.url));

  elCbTitle.textContent = `AI 想${describeAction(name, args, targetLabel)}`;
  elCbDetail.textContent = danger
    ? t('confirm.danger')
    : t('confirm.normal');
  elConfirmBar.classList.toggle('danger', danger);
  elConfirmBar.hidden = false;

  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function settleConfirm(allow) {
  elConfirmBar.hidden = true;
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(allow);
}

function labelOfRef(ref) {
  const hit = lastSnapshot?.elements?.find((e) => e.ref === ref);
  return hit ? hit.label : '';
}

async function executeToolCall(tc) {
  let args = {};
  try {
    args = JSON.parse(tc.function.arguments || '{}');
  } catch {
    return { ok: false, error: `工具参数不是合法 JSON：${String(tc.function.arguments).slice(0, 120)}` };
  }

  const name = tc.function.name;
  const targetLabel = args.ref != null ? labelOfRef(args.ref) : '';

  // 会改页面的动作，先问用户
  if (actionTier(name) === 'write') {
    const allow = await askConfirm(name, args, targetLabel);
    if (!allow) {
      pushNote(`✗ 你拒绝了：${describeAction(name, args, targetLabel)}`);
      return { ok: false, error: t('err.toolDenied') };
    }
  }

  const tab = await getActiveTab();
  if (!tab || tab.id == null || !INJECTABLE.test(tab.url || '')) {
    return { ok: false, error: t('err.tabNotOperable') };
  }

  let result;
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: pageAction,
      args: [name, args],
    });
    result = r?.result || { ok: false, error: t('err.noResult') };
  } catch (e) {
    result = { ok: false, error: String(e.message || e) };
  }

  if (name === 'list' && result.ok) lastSnapshot = result.value;

  pushNote(
    `${result.ok ? '▸' : '✗'} ${describeAction(name, args, targetLabel)}` +
    (result.ok ? '' : ` —— ${result.error}`)
  );

  // 跳转之后页面会换，缓存作废
  if (name === 'navigate' && result.ok) pageCache = null;

  return result;
}

/**
 * 跑一轮对话。开了操控就进工具循环：模型可以连着调好几次工具，直到它不再调为止。
 */
async function runTurn(bubble, key, signal) {
  const useTools = !!cfg.agentMode;
  const maxSteps = cfg.agentSteps || DEFAULT_STEPS;

  let last = { text: '', reasoning: '', usage: null };
  let steps = 0;

  while (true) {
    await ensureBudget(signal);

    const apiMessages = buildMessages({
      systemPrompt: cfg.systemPrompt + (useTools ? t('sys.agent') : ''),
      page: cfg.includePage ? pageCache : null,
      memories,
      conv,
    });

    const res = await streamChat({
      baseUrl: currentBaseUrl(),
      key,
      model: cfg.modelId,
      messages: apiMessages,
      tools: useTools ? agentTools() : undefined,
      signal,
      onDelta: (t) => {
        bubble.innerHTML = renderMarkdown(t) + '<span class="caret"></span>';
        scrollDown();
      },
    });

    last = {
      text: res.text,
      reasoning: res.reasoning || last.reasoning,
      usage: res.usage || last.usage,
    };

    // 没开操控，或者模型不再要工具了 → 这轮结束
    if (!useTools || !res.toolCalls.length) return last;

    // 把模型的工具调用记进历史（要原样带回给模型，不然它看不见自己说过什么）
    const toolMsgs = res.toolCalls.map((tc) => ({
      id: tc.id || `call_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    conv.messages.push({
      role: 'assistant',
      content: res.text || '',
      tool_calls: toolMsgs,
    });

    for (const tc of toolMsgs) {
      const out = await executeToolCall(tc);
      conv.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(out).slice(0, 4000),
      });
      await store.saveConversation(conv);
    }

    steps++;
    if (steps >= maxSteps) {
      pushNote(`⚠ 已经连续操作 ${steps} 步了，先停下 —— 你接着说要干什么`);
      return last;
    }

    // 下一轮重新写
    bubble.innerHTML = '<span class="caret"></span>';
  }
}

// ── 发送 ───────────────────────────────────────────────────

function buildUserContent(text, images) {
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  return parts;
}

async function send(text, images = []) {
  if (busy) return;

  const provider = currentProvider();
  const key = currentKey();
  if (!key) {
    toast(t('toast.noKeyFor', { name: provider.name }));
    chrome.runtime.openOptionsPage();
    return;
  }

  const trimmed = (text || '').trim();
  if (!trimmed && !images.length) return;

  // ① 先落库，这样即使发到一半崩了，用户的话也还在
  await refreshPage();

  const userMsg = {
    role: 'user',
    content: trimmed,
    display: trimmed,
    images: images.map((i) => i.dataUrl),
    raw: buildUserContent(trimmed, images),
  };
  conv.messages.push(userMsg);

  if (conv.title === '新对话' && trimmed) {
    conv.title = trimmed.slice(0, 20);
    renderConvTitle();
  }

  addMessageEl('user', { text: trimmed, images: images.map((i) => i.dataUrl) });
  await store.saveConversation(conv);

  // ② 开流
  const { bubble, meta } = addMessageEl('assistant', { streaming: true });

  busy = true;
  setBusy(true);
  abortCtl = new AbortController();

  let acc = '';

  try {
    const res = await runTurn(bubble, key, abortCtl.signal);
    acc = res.text;
    bubble.innerHTML = renderMarkdown(acc || t('msg.emptyReply'));

    if (res.reasoning) {
      const det = document.createElement('details');
      det.style.cssText = 'margin-top:8px;font-size:12px;opacity:.8';
      const sum = document.createElement('summary');
      sum.textContent = t('msg.reasoning');
      sum.style.cursor = 'pointer';
      const pre = document.createElement('div');
      pre.style.cssText = 'white-space:pre-wrap;margin-top:6px;color:var(--fg-dim)';
      pre.textContent = res.reasoning;
      det.append(sum, pre);
      bubble.appendChild(det);
    }

    const aiMsg = {
      role: 'assistant',
      content: acc,
      reasoning: res.reasoning,
      usage: res.usage,
    };
    conv.messages.push(aiMsg);
    if (res.usage?.prompt_tokens) conv.lastPromptTokens = res.usage.prompt_tokens;

    buildMeta(meta, aiMsg, conv.messages.length - 1);
    await store.saveConversation(conv);
  } catch (e) {
    if (e.name === 'AbortError') {
      bubble.innerHTML = renderMarkdown(acc + '\n\n' + t('err.stopped'));
      if (acc) conv.messages.push({ role: 'assistant', content: acc });
      else conv.messages.pop(); // 撤掉没发成的用户消息
      await store.saveConversation(conv);
    } else {
      console.error(e);
      bubble.closest('.msg').classList.add('error');

      // 带图报错时给个针对性提示 —— 多半就是这个模型其实不能看图
      const errStr = String(e.message || '');
      const maybeVision =
        userMsg.images?.length &&
        /image|vision|multimodal|modality|media|图片|不支持/i.test(errStr);

      bubble.innerHTML = renderMarkdown(
        t('err.title', { msg: e.message }) + '\n\n' +
        (maybeVision
          ? t('err.visionHint', { n: userMsg.images.length, model: cfg.modelId }) + '\n\n'
          : '') +
        t('err.checks')
      );
      // 撤掉用户消息，把话放回输入框，方便改了重发
      conv.messages.pop();
      elInput.value = trimmed;
      autoGrow();
      await store.saveConversation(conv);
    }
  } finally {
    busy = false;
    setBusy(false);
    abortCtl = null;
    renderAll();
    refreshBudget();
  }
}

async function retryFrom(index) {
  if (busy) return;

  // 找到这条往前的最近一条用户消息，从那儿重发
  let userIdx = -1;
  for (let i = index; i >= 0; i--) {
    if (conv.messages[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return;

  const u = conv.messages[userIdx];
  conv.messages = conv.messages.slice(0, userIdx);
  await store.saveConversation(conv);

  const imgs = (u.images || []).map((d) => ({ dataUrl: d, name: 'image' }));
  renderAll();
  send(u.display || u.content || '', imgs);
}

function setBusy(on) {
  elSend.disabled = on;
  elStop.hidden = !on;
  setQuicksEnabled(!on);
  elInput.disabled = on;
}

// ── 输入框 ─────────────────────────────────────────────────

function autoGrow() {
  elInput.style.height = 'auto';
  elInput.style.height = Math.min(elInput.scrollHeight, 160) + 'px';
}

// ── 右键菜单塞进来的活 ─────────────────────────────────────

async function consumePending() {
  const got = await chrome.storage.session.get('pendingPrompt');
  const p = got.pendingPrompt;
  if (!p) return;

  await chrome.storage.session.remove('pendingPrompt');
  chrome.runtime.sendMessage({ type: 'pending-consumed' }).catch(() => {});

  await new Promise((r) => setTimeout(r, 150));

  if (p.action === 'ask' && p.text) {
    await send(t('pending.ask', { text: p.text }));
  } else if (p.action === 'summarize') {
    await send(t('pending.summarize'));
  } else if (p.action === 'translate') {
    await send(t('pending.translate'));
  }
}

// ── 事件 ───────────────────────────────────────────────────

elRefreshModels.addEventListener('click', async () => {
  const btn = elRefreshModels;
  btn.disabled = true;
  await refreshModelList({ silent: false });
  btn.disabled = false;
});

elProvider.addEventListener('change', async () => {
  cfg.providerId = elProvider.value;
  cfg.modelId = currentProvider().models[0]?.id || '';
  await saveConfig();
  renderModels();
  refreshImageButtons();
  refreshBudget();
  // 换到这家，如果还没拉过或者缓存过期了，顺手拉一次
  maybeAutoRefreshModels();
});

elModel.addEventListener('change', () => {
  cfg.modelId = elModel.value;
  delete cfg.models[cfg.providerId]; // 选了预置的，就把自定义覆盖清掉
  saveConfig();
  refreshImageButtons();
  refreshBudget();
});

elOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

elInclude.addEventListener('change', async () => {
  cfg.includePage = elInclude.checked;
  if (conv) {
    conv.includePage = elInclude.checked;
    await store.saveConversation(conv);
  }
  await saveConfig();
  if (cfg.includePage) {
    await getPageContent(true);
  } else {
    pageCache = null;
    updatePageHint();
  }
  refreshBudget();
});

elSend.addEventListener('click', () => {
  const text = elInput.value;
  const imgs = pendingImages.slice();
  pendingImages = [];
  renderThumbs();
  elInput.value = '';
  autoGrow();
  send(text, imgs);
});

elStop.addEventListener('click', () => {
  settleConfirm(false); // 正在等确认的话，一并取消
  abortCtl?.abort();
});

// 操控页面开关
elAgentMode.addEventListener('change', async () => {
  cfg.agentMode = elAgentMode.checked;
  await saveConfig();
  toast(cfg.agentMode
    ? t('toast.agentOn')
    : t('toast.agentOff'));
});

// 确认条
elCbAllow.addEventListener('click', () => settleConfirm(true));
elCbDeny.addEventListener('click', () => settleConfirm(false));

elClear.addEventListener('click', async () => {
  if (busy) return;
  if (!confirm(t('composer.clearConfirm'))) return;
  await store.clearConversationMessages(conv.id);
  conv.messages = [];
  conv.summary = '';
  conv.compressedUpTo = 0;
  renderAll();
  refreshBudget();
});

elFile.addEventListener('click', () => elFileInput.click());

elFileInput.addEventListener('change', async () => {
  await addImages(Array.from(elFileInput.files || []));
  elFileInput.value = '';
});

elShot.addEventListener('click', captureVisible);

elInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    elSend.click();
  }
});

elInput.addEventListener('input', () => {
  autoGrow();
  refreshBudget();
});

elInput.addEventListener('paste', async (e) => {
  const files = Array.from(e.clipboardData?.items || [])
    .filter((i) => i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    await addImages(files);
  }
});

document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
});

document.addEventListener('drop', async (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.some((f) => f.type.startsWith('image/'))) {
    e.preventDefault();
    await addImages(files);
  }
});

// 提示词困难症
// 抽屉
elDrawerBtn.addEventListener('click', openDrawer);
elDrawerClose.addEventListener('click', closeDrawer);
elScrim.addEventListener('click', closeDrawer);
elNew.addEventListener('click', makeNewConversation);
elNew2.addEventListener('click', makeNewConversation);

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !elDrawer.hidden) closeDrawer();
});

// 记忆
elMemAdd.addEventListener('click', onAddMemory);

elMemInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    onAddMemory();
  }
});

// 用户自己往上翻的时候，别把他硬拽回底部
elLog.addEventListener('scroll', () => {
  stickToBottom = elLog.scrollHeight - elLog.scrollTop - elLog.clientHeight < 60;
});

// 页面跳转 / 切标签页 → 正文缓存作废，重新抓
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  // 后台标签页加载完跟我没关系，别白抓一遍
  const tab = await getActiveTab();
  if (!tab || tab.id !== tabId) return;

  pageCache = null;
  if (cfg.includePage) await getPageContent(true);
  refreshBudget();
});

// 新标签页建出来时先清掉缓存，免得在新页面加载完之前
// 还拿着旧页面凑数（新标签页是 about:blank，抓也抓不到东西）
chrome.tabs.onCreated.addListener(async (tab) => {
  if (busy) return;
  const cur = await getActiveTab();
  if (!cur || cur.id !== tab.id) return;
  pageCache = null;
  updatePageHint();
  refreshBudget();
});

chrome.tabs.onActivated.addListener(async () => {
  if (busy) return;
  pageCache = null;
  if (cfg.includePage) await getPageContent(true);
  refreshBudget();
});

// 设置页改了东西 → 同步过来。对话和记忆本页自己维护，不在这处理（会有回环）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.conversations || changes.memories || changes.activeConvId) return;
  (async () => {
    const { lang } = await chrome.storage.local.get('lang');
    setLang(lang || 'auto');
    await loadConfig();
    applyStatic();
    renderProviders();
    renderModels();
    renderQuicks();
    refreshImageButtons();
    refreshBudget();
  })();
});

// 侧边栏重新可见时，看看有没有右键菜单塞进来的活
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) consumePending();
});

// ── 启动 ───────────────────────────────────────────────────

(async function init() {
  // 语言必须先定下来 —— loadConfig 里的「默认系统提示 / 默认快捷按钮」
  // 都要当场按语言取；放到 loadConfig 后面就晚了一拍，会一直是中文。
  const { lang } = await chrome.storage.local.get('lang');
  setLang(lang || 'auto');

  await loadConfig();
  applyStatic();
  await reloadMemories();

  conv = await store.ensureActiveConversation({ includePage: cfg.includePage });
  conv.messages = conv.messages || [];
  conv.summary = conv.summary || '';
  conv.compressedUpTo = conv.compressedUpTo || 0;

  renderProviders();
  renderModels();
  renderQuicks();
  refreshImageButtons();
  renderConvTitle();
  renderAll();

  elInclude.checked = conv.includePage !== false;
  elAgentMode.checked = !!cfg.agentMode;
  autoGrow();

  if (cfg.includePage) await getPageContent(true);
  else updatePageHint();
  refreshBudget();

  if (!Object.values(cfg.keys).some((v) => (v || '').trim())) {
    toast(t('toast.noKeyAtAll'));
  }

  await consumePending();
})();
