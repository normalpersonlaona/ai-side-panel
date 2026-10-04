/**
 * 设置页逻辑。
 * 只管读写 chrome.storage.local —— 侧边栏那边有 storage.onChanged 监听，改完立刻生效。
 */

import { PROVIDERS } from './src/providers.js';
import { listModels } from './src/api.js';
import * as store from './src/store.js';
import { t, setLang, applyStatic, defaultQuicks } from './src/i18n.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_BUDGET = 60000; // token
const MODEL_CACHE_TTL = 24 * 3600 * 1000;

let state = null;
let modelCache = {}; // { [providerId]: { ids: [], at: ts } }

// ── 加载 ───────────────────────────────────────────────────

async function load() {
  const raw = await chrome.storage.local.get(null);
  state = {
    keys: raw.keys || {},
    baseUrls: raw.baseUrls || {},
    models: raw.models || {},
    visionOverrides: raw.visionOverrides || {},
    agentSteps: raw.agentSteps || 8,
    maxPageChars: raw.maxPageChars || 30000,
    contextBudget: raw.contextBudget || DEFAULT_BUDGET,
    quicks: raw.quicks || defaultQuicks(),
    systemPrompt: raw.systemPrompt || t('sys.default'),
    lang: raw.lang || 'auto',
    // 记住这两样是不是「还没被用户改过」—— 没改过的话，切语言要跟着换一套默认值
    quicksAreDefault: !raw.quicks,
    promptIsDefault: !raw.systemPrompt,
  };
  modelCache = raw.modelCache || {};
}

// ── 渲染：服务商 ───────────────────────────────────────────

function renderProviders() {
  const box = $('providers');
  box.innerHTML = '';

  for (const p of PROVIDERS) {
    const card = document.createElement('div');
    card.className = 'provider';

    // 头部
    const head = document.createElement('div');
    head.className = 'provider-head';

    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = p.name;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.badgeFor = p.id;

    const link = document.createElement('a');
    link.href = p.keyUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = t('opt.getKey');

    head.append(name, badge, link);
    card.appendChild(head);

    // Key 输入
    const keyrow = document.createElement('div');
    keyrow.className = 'keyrow';

    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.placeholder = t('opt.keyPlaceholder');
    keyInput.value = state.keys[p.id] || '';
    keyInput.dataset.keyFor = p.id;
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;

    const eye = document.createElement('button');
    eye.className = 'btn';
    eye.textContent = t('opt.show');
    eye.type = 'button';
    eye.addEventListener('click', () => {
      const showing = keyInput.type === 'text';
      keyInput.type = showing ? 'password' : 'text';
      eye.textContent = showing ? t('opt.show') : t('opt.hide');
    });

    keyrow.append(keyInput, eye);
    card.appendChild(keyrow);

    // ── 拉取模型列表 ──
    const mrow = document.createElement('div');
    mrow.className = 'modelrow';

    const fetchBtn = document.createElement('button');
    fetchBtn.className = 'btn small';
    fetchBtn.type = 'button';
    fetchBtn.textContent = t('opt.fetchModels');

    const st = document.createElement('span');
    st.className = 'dim small';
    st.dataset.statusFor = p.id;

    mrow.append(fetchBtn, st);
    card.appendChild(mrow);

    const mlist = document.createElement('div');
    mlist.className = 'mlist dim small';
    mlist.dataset.listFor = p.id;
    card.appendChild(mlist);

    fetchBtn.addEventListener('click', async () => {
      const key = (keyInput.value || '').trim();
      if (!key) {
        setStatus(t('opt.resetMustFillKey', { name: p.name }), 'err');
        return;
      }
      fetchBtn.disabled = true;
      fetchBtn.textContent = t('opt.fetching');
      try {
        const base = i1.value.trim() || p.baseUrl;
        const ids = await listModels({ baseUrl: base, key });
        await store.setModelCacheFor(p.id, ids);
        modelCache = await store.getModelCache();
        paintModelCache(p.id);
        setStatus(t('toast.modelFetchedFor', { name: p.name, n: ids.length }), 'ok');
      } catch (e) {
        setStatus(t('toast.modelFetchFail', { name: p.name, msg: String(e.message || e).slice(0, 90) }), 'err');
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = t('opt.fetchModels');
      }
    });

    // 高级：base_url / 模型名覆盖
    const adv = document.createElement('details');
    adv.className = 'adv';

    const sum = document.createElement('summary');
    sum.textContent = t('opt.advSummary');
    adv.appendChild(sum);

    const f1 = document.createElement('div');
    f1.className = 'field';
    const l1 = document.createElement('label');
    l1.textContent = t('opt.baseUrlLabel');
    const i1 = document.createElement('input');
    i1.type = 'text';
    i1.placeholder = p.baseUrl;
    i1.value = state.baseUrls[p.id] || '';
    i1.dataset.baseFor = p.id;
    i1.spellcheck = false;
    l1.appendChild(i1);
    f1.appendChild(l1);
    const h1 = document.createElement('p');
    h1.className = 'dim small';
    h1.textContent = t('opt.baseUrlDefault', { url: p.baseUrl });
    f1.appendChild(h1);

    const f2 = document.createElement('div');
    f2.className = 'field';
    const l2 = document.createElement('label');
    l2.textContent = t('opt.modelNameLabel');
    const i2 = document.createElement('input');
    i2.type = 'text';
    i2.placeholder = p.models[0]?.id || '';
    i2.value = state.models[p.id] || '';
    i2.dataset.modelFor = p.id;
    i2.spellcheck = false;
    l2.appendChild(i2);
    f2.appendChild(l2);
    const h2 = document.createElement('p');
    h2.className = 'dim small';
    h2.textContent = t('opt.modelPresets', { list: p.models.map((m) => m.id).join(' / ') });
    f2.appendChild(h2);

    adv.append(f1, f2);
    card.appendChild(adv);

    box.appendChild(card);
  }

  refreshBadges();
  for (const p of PROVIDERS) paintModelCache(p.id);
}

function ago(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return t('time.justNow');
  if (d < 3600e3) return t('time.minAgo', { n: Math.floor(d / 60e3) });
  if (d < 86400e3) return t('time.hourAgo', { n: Math.floor(d / 3600e3) });
  return t('time.dayAgo', { n: Math.floor(d / 86400e3) });
}

function paintModelCache(pid) {
  const st = document.querySelector(`[data-status-for="${pid}"]`);
  const list = document.querySelector(`[data-list-for="${pid}"]`);
  if (!st || !list) return;

  const c = modelCache[pid];
  if (!c || !c.ids?.length) {
    st.textContent = t('opt.neverFetched');
    st.className = 'dim small';
    list.textContent = '';
    return;
  }
  st.textContent = t('opt.fetchedMeta', { n: c.ids.length, when: ago(c.at) });
  st.className = 'dim small';
  list.textContent = c.ids.join(' · ');
}

/**
 * 填了 Key 的那几家，缓存过期就顺手更新一下。
 * 失败静默 —— 这只是锦上添花，不该拿报错烦人。
 */
async function autoFetchStale() {
  let updated = 0;
  for (const p of PROVIDERS) {
    const key = (state.keys[p.id] || '').trim();
    if (!key) continue;

    const c = modelCache[p.id];
    if (c && Date.now() - (c.at || 0) < MODEL_CACHE_TTL) continue;

    try {
      const base = (state.baseUrls[p.id] || '').trim() || p.baseUrl;
      const ids = await listModels({ baseUrl: base, key });
      await store.setModelCacheFor(p.id, ids);
      modelCache = await store.getModelCache();
      paintModelCache(p.id);
      updated++;
    } catch {
      /* 静默：拉不到就继续用预置列表 */
    }
  }
  if (updated) setStatus(t('toast.autoUpdated', { n: updated }), 'ok');
}

function refreshBadges() {
  document.querySelectorAll('[data-badge-for]').forEach((b) => {
    const id = b.dataset.badgeFor;
    const has = !!(state.keys[id] || '').trim();
    b.textContent = has ? t('opt.keySet') : t('opt.keyUnset');
    b.classList.toggle('on', has);
  });
}

// ── 渲染：快捷按钮 ─────────────────────────────────────────

function renderQuicks() {
  const box = $('quicks');
  box.innerHTML = '';

  state.quicks.forEach((q, i) => {
    const row = document.createElement('div');
    row.className = 'quick-row';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'label-in';
    label.value = q.label;
    label.placeholder = t('opt.quickNamePh');
    label.dataset.qk = `${i}.label`;

    const col = document.createElement('div');
    col.className = 'col';

    const ta = document.createElement('textarea');
    ta.value = q.prompt;
    ta.placeholder = t('opt.quickPromptPh');
    ta.dataset.qk = `${i}.prompt`;

    col.appendChild(ta);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = t('opt.deleteQuick');
    del.addEventListener('click', () => {
      collectQuicks();
      state.quicks.splice(i, 1);
      renderQuicks();
    });

    row.append(label, col, del);
    box.appendChild(row);
  });
}

/** 把输入框里的值收回 state（不落盘） */
function collectQuicks() {
  document.querySelectorAll('[data-qk]').forEach((el) => {
    const [i, field] = el.dataset.qk.split('.');
    const idx = Number(i);
    if (state.quicks[idx]) state.quicks[idx][field] = el.value;
  });
}

// ── 保存 ───────────────────────────────────────────────────

function collectAll() {
  collectQuicks();

  const keys = {};
  const baseUrls = {};
  const models = {};

  document.querySelectorAll('[data-key-for]').forEach((el) => {
    const v = el.value.trim();
    if (v) keys[el.dataset.keyFor] = v;
  });
  document.querySelectorAll('[data-base-for]').forEach((el) => {
    const v = el.value.trim();
    if (v) baseUrls[el.dataset.baseFor] = v;
  });
  document.querySelectorAll('[data-model-for]').forEach((el) => {
    const v = el.value.trim();
    if (v) models[el.dataset.modelFor] = v;
  });

  return {
    keys,
    baseUrls,
    models,
    visionOverrides: parseVision($('visionOverrides').value),
    agentSteps: Math.min(30, Math.max(1, Number($('agentSteps').value) || 8)),
    lang: $('lang').value,
    maxPageChars: Math.max(1000, Number($('maxChars').value) || 30000),
    contextBudget: Math.max(4000, Number($('contextBudget').value) || DEFAULT_BUDGET),
    quicks: state.quicks.filter((q) => (q.label || '').trim() || (q.prompt || '').trim()),
    systemPrompt: $('systemPrompt').value.trim() || t('sys.default'),
  };
}

function setStatus(text, cls = '') {
  const s = $('status');
  s.textContent = text;
  s.className = 'small ' + cls;
  if (text) setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 2600);
}

async function save() {
  const data = collectAll();
  // keys 要整体覆盖（用户可能清空了某个），不能合并残留
  const old = await chrome.storage.local.get('keys');
  const merged = { ...(old.keys || {}) };
  // 清掉所有没填的
  for (const p of PROVIDERS) if (!data.keys[p.id]) delete merged[p.id];
  Object.assign(merged, data.keys);

  await chrome.storage.local.set({ ...data, keys: merged });
  state.keys = merged;
  refreshBadges();
  setStatus(t('opt.saved'), 'ok');

  // 刚填的 Key 可能还没拉过模型列表，顺手补上（失败不吭声）
  autoFetchStale();
}

async function resetAll() {
  if (!confirm(t('opt.resetConfirm'))) return;

  // 只清设置 —— 对话和记忆是用户自己攒的，不能跟着一起没
  const keep = await chrome.storage.local.get([
    'keys', 'conversations', 'activeConvId', 'memories', 'modelCache',
  ]);

  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);

  await load();
  renderProviders();
  renderQuicks();
  fillGeneral();
  setStatus(t('opt.resetDone'), 'ok');
}

function fillGeneral() {
  $('maxChars').value = state.maxPageChars;
  $('contextBudget').value = state.contextBudget;
  $('systemPrompt').value = state.systemPrompt;
  $('visionOverrides').value = stringifyVision(state.visionOverrides);
  $('agentSteps').value = state.agentSteps;
  $('lang').value = state.lang;
}

const YES = ['1', 'true', 'yes', 'y', 'on', '能', '可以', '是', '看得见', '支持', '可', 'ok'];
const NO = ['0', 'false', 'no', 'n', 'off', '不能', '不可以', '否', '看不见', '不支持', '不可'];

function parseVision(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const i = line.lastIndexOf('=');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().toLowerCase();
    if (!name) continue;
    if (YES.includes(v)) out[name] = true;
    else if (NO.includes(v)) out[name] = false;
    // 认不出来的写法就当没写，别瞎猜
  }
  return out;
}

function stringifyVision(obj) {
  return Object.entries(obj || {})
    .map(([k, v]) => `${k}=${v ? t('opt.visionYes') : t('opt.visionNo')}`)
    .join('\n');
}

// ── 事件 ───────────────────────────────────────────────────

$('addQuick').addEventListener('click', () => {
  collectQuicks();
  state.quicks.push({ label: t('opt.newQuickName'), prompt: '' });
  renderQuicks();
});

$('save').addEventListener('click', save);
$('reset').addEventListener('click', resetAll);

// 切语言：立刻生效，顺手落盘（侧边栏那边监听 storage 会自动跟上）
$('lang').addEventListener('change', async () => {
  state.lang = $('lang').value;
  setLang(state.lang);
  await chrome.storage.local.set({ lang: state.lang });

  // 用户没自定义过的，跟着换一套新语言的默认值
  if (state.quicksAreDefault) state.quicks = defaultQuicks();
  if (state.promptIsDefault) state.systemPrompt = t('sys.default');

  applyStatic();
  renderProviders();
  renderQuicks();
  fillGeneral();
  setStatus(t('opt.saved'), 'ok');
});

// Key 一填就更新徽章
document.addEventListener('input', (e) => {
  if (e.target.dataset?.keyFor) {
    const id = e.target.dataset.keyFor;
    const v = e.target.value.trim();
    if (v) state.keys[id] = v;
    else delete state.keys[id];
    refreshBadges();
  }
});

// Ctrl+S 保存
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

// ── 启动 ───────────────────────────────────────────────────

(async function init() {
  // 先定语言，再 load —— load 里的默认提示词/快捷按钮要按语言取
  const { lang } = await chrome.storage.local.get('lang');
  setLang(lang || 'auto');

  await load();
  applyStatic();
  renderProviders();
  renderQuicks();
  fillGeneral();

  // 打开设置页就顺手把过期的模型列表更新一遍
  autoFetchStale();
})();
