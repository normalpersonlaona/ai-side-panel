/**
 * 极简 i18n。
 *
 * 为什么不用 chrome.i18n？因为那套是跟着浏览器语言走的，
 * **没法在设置里手动切成英文**。这里自己管一份词典，语言可以随时切。
 *
 * 用法：
 *   t('bar.settings')                     → 取文案
 *   t('toast.fetched', { n: 12 })         → 带占位符
 *   applyStatic(document)                 → 刷 HTML 里标了 data-i18n 的元素
 */

import zh from './lang/zh.js';
import en from './lang/en.js';

const DICTS = { zh, en };
const HTML_LANG = { zh: 'zh-CN', en: 'en' };

export const LANGS = [
  { id: 'auto', label: '跟随浏览器 / Auto' },
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

let current = 'zh';

/** 'auto' 时按浏览器语言猜；中文环境用中文，其余一律英文 */
export function resolveLang(setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  const nav = String(navigator.language || '').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export function setLang(setting) {
  current = resolveLang(setting);
  document.documentElement.lang = HTML_LANG[current] || 'en';
  return current;
}

export function getLang() {
  return current;
}

/**
 * 取文案。找不到就退回中文，再找不到就把 key 原样返回 ——
 * 宁可界面上出现一个 key，也别出现 undefined。
 */
export function t(key, vars) {
  const raw = DICTS[current]?.[key] ?? DICTS.zh?.[key] ?? key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * 把 HTML 里标了 data-i18n 的元素刷一遍。
 *
 * ⚠️ 只往**纯文本**元素上加 data-i18n —— 这个函数会直接覆盖 textContent，
 *    加在带 SVG 子节点的按钮上会把图标抹掉。
 */
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

/** 快捷按钮的默认值 —— 跟着语言走 */
export function defaultQuicks() {
  return [
    { label: t('quick.summarize'), prompt: t('quick.summarizePrompt') },
    { label: t('quick.translate'), prompt: t('quick.translatePrompt') },
    { label: t('quick.explain'), prompt: t('quick.explainPrompt') },
    { label: t('quick.ask'), prompt: t('quick.askPrompt') },
  ];
}
