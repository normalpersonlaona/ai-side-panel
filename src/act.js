/**
 * 页面操控。
 *
 * ⚠️ 关键约束：pageAction 会被 chrome.scripting.executeScript 注入到页面里跑。
 * executeScript 是把函数**序列化**过去的，闭包和模块作用域全丢 ——
 * 所以 pageAction 里用到的每一段逻辑都必须**写在它自己肚子里**，
 * 不能引用本文件里别的东西。这是这个文件唯一容易写错的地方。
 *
 * 其余导出（agentTools / actionTier / describeAction …）跑在扩展环境里，随便用。
 */

import { t } from './i18n.js';

/**
 * 在页面里执行一个动作。自包含，别引用外部变量。
 *
 * @param {string} action
 * @param {object} payload
 * @returns {{ok: boolean, error?: string, value?: any}}
 */
export function pageAction(action, payload) {
  const REF = 'data-ai-ref';
  const p = payload || {};

  // ── 下面所有 helper 都必须在函数内部定义 ──

  const snapshot = (limit) => {
    document.querySelectorAll(`[${REF}]`).forEach((e) => e.removeAttribute(REF));

    const SELECTOR = [
      'a[href]', 'button', 'input', 'textarea', 'select',
      '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]',
      '[role=menuitem]', '[role=option]', '[contenteditable=true]',
      '[onclick]', 'summary',
    ].join(',');

    const out = [];
    let i = 0;

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (i >= limit) break;

      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;

      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      if (el.disabled) continue;

      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();

      let label;
      if (tag === 'input' || tag === 'textarea') {
        const hint = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.name || '(无名输入框)';
        const cur = String(el.value || '').slice(0, 30) || '空';
        label = `${hint}｜当前值：${cur}`;
      } else {
        label = (
          el.innerText || el.value ||
          el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || ''
        ).trim().replace(/\s+/g, ' ').slice(0, 60);
      }

      if (!label) continue;

      el.setAttribute(REF, String(i));
      out.push({ ref: i, tag, type, label });
      i++;
    }

    return {
      url: location.href,
      title: document.title,
      count: out.length,
      elements: out,
      note: '编号只在这一刻有效，页面一变就要重新 list',
    };
  };

  const flash = (node, color) => {
    if (!node || !node.style) return;
    const old = node.style.outline;
    const oldOff = node.style.outlineOffset;
    node.style.outline = `3px solid ${color || '#2f6feb'}`;
    node.style.outlineOffset = '2px';
    setTimeout(() => {
      node.style.outline = old;
      node.style.outlineOffset = oldOff;
    }, 1200);
  };

  const el = p.ref == null ? null : document.querySelector(`[${REF}="${p.ref}"]`);
  const needEl = () => {
    if (!el) throw new Error(`找不到编号 ${p.ref} 的元素 —— 页面多半变了，重新 list 一次`);
  };
  const textOf = (n) => (n.innerText || n.value || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  try {
    switch (action) {
      case 'list':
        return { ok: true, value: snapshot(80) };

      case 'scroll_to': {
        needEl();
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(el);
        return { ok: true, value: `已滚动到 #${p.ref}「${textOf(el)}」` };
      }

      case 'highlight': {
        needEl();
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(el, '#f5a623');
        return { ok: true, value: `已高亮 #${p.ref}` };
      }

      case 'read': {
        needEl();
        return { ok: true, value: (el.innerText || el.value || '').trim().slice(0, 3000) };
      }

      case 'click': {
        needEl();
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        const opts = {
          bubbles: true, cancelable: true, view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        // 有些站只认真实鼠标事件序列，光 .click() 会被忽略
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        if (typeof el.focus === 'function') el.focus();
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return { ok: true, value: `已点击 #${p.ref}「${textOf(el)}」` };
      }

      case 'type_text': {
        needEl();
        const text = String(p.text == null ? '' : p.text);
        if (typeof el.focus === 'function') el.focus();

        if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        } else {
          // 走原生 setter，React / Vue 才认得出值变了
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, text);
          else el.value = text;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        flash(el);
        const shown = el.type === 'password' ? '•'.repeat(Math.min(text.length, 12)) : text.slice(0, 40);
        return { ok: true, value: `已填入「${shown}」` };
      }

      case 'select_option': {
        needEl();
        const want = String(p.value == null ? '' : p.value);
        const opts = Array.from(el.options || []);
        const hit = opts.find((o) => o.value === want || (o.textContent || '').trim() === want);
        if (!hit) {
          return {
            ok: false,
            error: `下拉框里没有「${want}」。可选项：${opts.map((o) => o.textContent.trim()).slice(0, 20).join(' / ')}`,
          };
        }
        el.value = hit.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: `已选择「${hit.textContent.trim()}」` };
      }

      case 'key': {
        needEl();
        const k = String(p.key || 'Enter');
        ['keydown', 'keypress', 'keyup'].forEach((t) =>
          el.dispatchEvent(new KeyboardEvent(t, { key: k, bubbles: true, cancelable: true }))
        );
        return { ok: true, value: `已按 ${k}` };
      }

      case 'navigate': {
        const url = String(p.url || '');
        if (!/^https?:/i.test(url)) return { ok: false, error: '只允许跳 http/https 地址' };
        location.href = url;
        return { ok: true, value: `正在跳转到 ${url}` };
      }

      default:
        return { ok: false, error: `不认识的动作：${action}` };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ── 下面这些跑在扩展环境，不进页面 ──────────────────────────

/** 无副作用的动作，直接放行 */
const SAFE_ACTIONS = ['list', 'scroll_to', 'highlight', 'read'];

/** 'safe' = 直接做；'write' = 要你点头 */
export function actionTier(action) {
  return SAFE_ACTIONS.includes(action) ? 'safe' : 'write';
}

/**
 * 给模型用的工具声明（OpenAI 兼容格式）。
 *
 * ⚠️ 必须是函数：文案要跟着界面语言走，写成模块级常量的话，
 *    导入那一刻就把语言定死了，之后切语言不生效。
 */
export function agentTools() {
  return [
  {
    type: 'function',
    function: {
      name: 'list',
      description: t('tool.list.desc'),
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: t('tool.click.desc'),
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer', description: t('tool.ref') },
          why: { type: 'string', description: t('tool.click.why') },
        },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: t('tool.type.desc'),
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          text: { type: 'string', description: t('tool.type.text') },
        },
        required: ['ref', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_option',
      description: t('tool.select.desc'),
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          value: { type: 'string', description: t('tool.select.value') },
        },
        required: ['ref', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'key',
      description: t('tool.key.desc'),
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          key: { type: 'string', description: t('tool.key.name') },
        },
        required: ['ref', 'key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll_to',
      description: t('tool.scroll.desc'),
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'highlight',
      description: t('tool.highlight.desc'),
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: t('tool.read.desc'),
      parameters: {
        type: 'object',
        properties: { ref: { type: 'integer' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: t('tool.navigate.desc'),
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: t('tool.navigate.url') } },
        required: ['url'],
      },
    },
  },
  ];
}

/**
 * 高危词。按钮上带这些字的话，确认框里会红字再提醒一次。
 * 不是拦截 —— 只是让那一下点击慢半拍。
 */
export const DANGER_WORDS = [
  '提交', '确定', '确认', '同意', '授权', '允许',
  '支付', '付款', '购买', '下单', '立即购买', '结算', '转账', '汇款',
  '充值', '提现', '打赏', '续费', '订阅', '开通',
  '删除', '移除', '注销', '卸载', '解绑', '退订', '清空', '重置', '格式化',
  '发送', '发布', '发表', '投稿', '上传', '退出登录', '登出', '关闭账户',
  '取消订单', '退款', '举报', '拉黑', '屏蔽',
];

export function isDangerousLabel(label) {
  const s = String(label || '');
  return DANGER_WORDS.some((w) => s.includes(w));
}

/** 把一次工具调用说成人话，给确认框和聊天记录用 */
export function describeAction(name, args, targetLabel) {
  const a = args || {};
  const tgt = targetLabel ? t('note.target', { label: targetLabel }) : a.ref != null ? t('note.targetRef', { ref: a.ref }) : '';

  switch (name) {
    case 'list': return t('note.list');
    case 'click': return t('note.click', { target: tgt });
    case 'type_text': {
      const txt = String(a.text == null ? '' : a.text);
      return t('note.type', { target: t, text: txt.slice(0, 30) + (txt.length > 30 ? '…' : '') });
    }
    case 'select_option': return t('note.select', { target: t, value: a.value });
    case 'key': return t('note.key', { target: t, key: a.key || 'Enter' });
    case 'scroll_to': return t('note.scrollTo', { target: tgt });
    case 'highlight': return t('note.highlight', { target: tgt });
    case 'read': return t('note.read', { target: tgt });
    case 'navigate': return t('note.navigate', { url: a.url });
    default: return `${name} ${JSON.stringify(a).slice(0, 60)}`;
  }
}
