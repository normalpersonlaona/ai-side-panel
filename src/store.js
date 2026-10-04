/**
 * 存储层：对话 + 全局记忆，都落 chrome.storage.local（关浏览器不丢）。
 *
 * 配置和 Key 也在这块存储里，但由 options 页负责写。
 *
 * 注意 chrome.storage.local 有配额（默认 10MB），所以图片一律存压缩过的，
 * 对话数量也封了顶。存不下的时候 storage.set 会抛，调用方自己兜。
 */

import { t } from './i18n.js';

const K_CONVS = 'conversations';
const K_ACTIVE = 'activeConvId';
const K_MEMS = 'memories';

const MAX_CONVS = 100;      // 最多留这么多个对话，超了丢最老的
const MAX_IMGS_PER_MSG = 4; // 单条消息最多留几张图

export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ── 对话 ───────────────────────────────────────────────────

export async function listConversations() {
  const got = await chrome.storage.local.get(K_CONVS);
  const list = got[K_CONVS] || [];
  return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getActiveId() {
  const got = await chrome.storage.local.get(K_ACTIVE);
  return got[K_ACTIVE] || null;
}

export async function setActiveId(id) {
  await chrome.storage.local.set({ [K_ACTIVE]: id });
}

export async function getConversation(id) {
  if (!id) return null;
  const list = await listConversations();
  return list.find((c) => c.id === id) || null;
}

/** 取当前对话；没有就新建一个。 */
export async function ensureActiveConversation(opts = {}) {
  const id = await getActiveId();
  const conv = await getConversation(id);
  if (conv) return conv;
  return newConversation(opts);
}

export async function newConversation(opts = {}) {
  const now = Date.now();
  const conv = {
    id: uid('c'),
    title: opts.title || t('drawer.defaultConvTitle'),
    createdAt: now,
    updatedAt: now,
    url: opts.url || '',
    pageTitle: opts.pageTitle || '',
    includePage: opts.includePage !== false,
    messages: [],
    summary: '',        // 被压缩掉的早期对话，压成一段话存这
    compressedUpTo: 0,  // messages 里前 N 条已经压进 summary 了
    lastPromptTokens: null, // 上一次请求真实的输入 token，用来校准估算
  };
  const list = await listConversations();
  list.unshift(conv);
  await chrome.storage.local.set({
    [K_CONVS]: list.slice(0, MAX_CONVS),
    [K_ACTIVE]: conv.id,
  });
  return conv;
}

export async function saveConversation(conv) {
  conv.updatedAt = Date.now();

  // 图片只在单条消息里留几张，别让存储被 base64 撑爆
  const slim = {
    ...conv,
    messages: (conv.messages || []).map((m) => ({
      ...m,
      raw: undefined, // raw 是带 base64 的请求体，读回来会重建，不用存
      images: (m.images || []).slice(-MAX_IMGS_PER_MSG),
    })),
  };

  const list = await listConversations();
  const i = list.findIndex((c) => c.id === conv.id);
  if (i >= 0) list[i] = slim;
  else list.unshift(slim);

  try {
    await chrome.storage.local.set({ [K_CONVS]: list.slice(0, MAX_CONVS) });
  } catch (e) {
    // 多半是配额满了。退一步：把所有图片砍掉再试一次
    console.warn('[AI侧边栏] 对话存不下，去掉图片重试：', e);
    const noImg = list.map((c) => ({
      ...c,
      messages: (c.messages || []).map(({ images, raw, ...rest }) => rest),
    }));
    await chrome.storage.local.set({ [K_CONVS]: noImg.slice(0, MAX_CONVS) });
  }
}

export async function deleteConversation(id) {
  const list = await listConversations();
  const next = list.filter((c) => c.id !== id);

  await chrome.storage.local.set({ [K_CONVS]: next });

  const active = await getActiveId();
  if (active === id) await setActiveId(next[0]?.id || null);

  return next;
}

export async function renameConversation(id, title) {
  const list = await listConversations();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.title = title;
  c.updatedAt = Date.now();
  await chrome.storage.local.set({ [K_CONVS]: list });
}

export async function clearConversationMessages(id) {
  const list = await listConversations();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  c.messages = [];
  c.summary = '';
  c.compressedUpTo = 0;
  c.updatedAt = Date.now();
  await chrome.storage.local.set({ [K_CONVS]: list });
}

// ── 模型列表缓存 ───────────────────────────────────────────

const K_MODELS = 'modelCache';

/**
 * 形状：{ [providerId]: { ids: string[], at: number } }
 */
export async function getModelCache() {
  const got = await chrome.storage.local.get(K_MODELS);
  return got[K_MODELS] || {};
}

export async function setModelCacheFor(providerId, ids) {
  const cache = await getModelCache();
  cache[providerId] = { ids, at: Date.now() };
  await chrome.storage.local.set({ [K_MODELS]: cache });
  return cache;
}

export async function clearModelCacheFor(providerId) {
  const cache = await getModelCache();
  delete cache[providerId];
  await chrome.storage.local.set({ [K_MODELS]: cache });
  return cache;
}

// ── 全局记忆 ───────────────────────────────────────────────

export async function listMemories() {
  const got = await chrome.storage.local.get(K_MEMS);
  return got[K_MEMS] || [];
}

export async function addMemory(text, tag = '') {
  const list = await listMemories();
  const m = {
    id: uid('m'),
    text: String(text).trim(),
    tag,
    enabled: true,
    createdAt: Date.now(),
  };
  list.push(m);
  await chrome.storage.local.set({ [K_MEMS]: list });
  return m;
}

export async function updateMemory(id, patch) {
  const list = await listMemories();
  const m = list.find((x) => x.id === id);
  if (!m) return;
  Object.assign(m, patch);
  await chrome.storage.local.set({ [K_MEMS]: list });
}

export async function deleteMemory(id) {
  const list = await listMemories();
  await chrome.storage.local.set({
    [K_MEMS]: list.filter((x) => x.id !== id),
  });
}
