/**
 * Service worker：右键菜单、点图标开侧边栏、把「要发给 AI 的东西」暂存起来。
 *
 * MV3 的 service worker 随时会被杀，所以这里不保存任何内存状态，
 * 一切走 chrome.storage.session。
 */

import { setLang, t } from './src/i18n.js';

const PENDING_KEY = 'pendingPrompt';

/** 点扩展图标 → 开侧边栏 */
function enableActionClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[AI Sidebar] setPanelBehavior failed:', e));
}

/**
 * 建右键菜单。文案跟着界面语言走 ——
 * 装好时建一次，之后语言一变就重建（removeAll + create）。
 */
async function buildMenus() {
  const { lang } = await chrome.storage.local.get('lang');
  setLang(lang || 'auto');

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ask-selection',
      title: t('menu.ask'),
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'summarize-page',
      title: t('menu.summarize'),
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'translate-page',
      title: t('menu.translate'),
      contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  enableActionClick();
  buildMenus();
});

// 扩展重载 / 浏览器启动（开发时重载不会触发 onInstalled）
chrome.runtime.onStartup.addListener(() => {
  enableActionClick();
  buildMenus();
});

// 有些情况下 service worker 冷启动，菜单可能不在，兜一下
enableActionClick();
buildMenus();

// 切了界面语言 → 菜单跟着重建
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.lang) buildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;

  let payload = null;
  if (info.menuItemId === 'ask-selection') {
    payload = { action: 'ask', text: info.selectionText || '' };
  } else if (info.menuItemId === 'summarize-page') {
    payload = { action: 'summarize' };
  } else if (info.menuItemId === 'translate-page') {
    payload = { action: 'translate' };
  }
  if (!payload) return;

  payload.tabId = tab.id;
  payload.ts = Date.now();

  await chrome.storage.session.set({ [PENDING_KEY]: payload });

  // 打开侧边栏需要用户手势，右键点击算手势，但 Chrome 对 sidePanel.open
  // 的手势校验很严，失败就退化成「让用户自己点图标」，内容不会丢。
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn('[AI Sidebar] auto-open rejected, click the icon manually:', e);
    await setBadge();
  }
});

async function setBadge() {
  try {
    await chrome.action.setBadgeText({ text: '1' });
    await chrome.action.setBadgeBackgroundColor({ color: '#E4572E' });
  } catch {
    /* 忽略 */
  }
}

// 侧边栏取走待处理内容后清掉角标
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pending-consumed') {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }
});

// 注意：对话历史现在存在 chrome.storage.local 的 conversations 里，
// 由侧边栏自己管，不再跟着标签页走。这里不用做清理。
