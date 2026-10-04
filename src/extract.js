/**
 * 正文提取 —— 一个够用的 Readability 简化版。
 *
 * 这个文件的函数会被 chrome.scripting.executeScript 注入到页面里跑，
 * 所以必须自包含：不能引用模块外的变量，不能用 import。
 */

/**
 * 在页面上下文里执行，返回 { title, url, text, chars }。
 * @param {number} maxChars 超过就截断（0 = 不截）
 */
export function extractArticle(maxChars) {
  const NOISE = [
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript',
    'iframe', 'form', 'button', 'select', 'svg', 'canvas',
    '[role=navigation]', '[role=banner]', '[role=contentinfo]', '[role=search]',
    '[aria-hidden=true]',
    '.sidebar', '.comment', '.comments', '.ad', '.ads', '.advert',
    '.nav', '.menu', '.footer', '.header', '.share', '.related',
  ].join(',');

  const isNoise = (el) => {
    if (!el || el.nodeType !== 1) return true;
    try {
      if (el.matches(NOISE)) return true;
    } catch {
      /* 某些站点的选择器会炸，忽略 */
    }
    return false;
  };

  const visibleText = (el) => {
    const t = el.innerText || el.textContent || '';
    return t.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  // ---- 第一轮：语义标签和常见容器，拿来做种子 ----
  const seeds = [];
  const addSeed = (el, weight) => {
    if (el && !isNoise(el)) seeds.push({ el, weight });
  };

  addSeed(document.querySelector('article'), 400);
  addSeed(document.querySelector('main'), 300);
  addSeed(document.querySelector('[role=main]'), 300);
  addSeed(document.querySelector('[itemprop=articleBody]'), 400);
  addSeed(
    document.querySelector('#content, #main, #article, .content, .main, .post, .article, .post-content, .entry-content'),
    150
  );

  // ---- 第二轮：密度打分。直接子节点里的长段落越多，越像正文 ----
  document.querySelectorAll('div, section, article, main, td').forEach((el) => {
    if (isNoise(el)) return;
    // 太深层的小盒子没意义，跳过
    if (el.querySelectorAll('div').length > 300) return;

    let score = 0;
    const kids = el.querySelectorAll(':scope > p, :scope > li, :scope > h2, :scope > h3, :scope > blockquote');
    kids.forEach((k) => {
      const len = (k.innerText || '').trim().length;
      if (len > 25) score += len;
    });
    // 链接密度过高 → 多半是导航/列表页，扣分
    const all = visibleText(el);
    if (all.length > 0) {
      const linkLen = Array.from(el.querySelectorAll('a')).reduce(
        (n, a) => n + (a.innerText || '').length,
        0
      );
      const linkRatio = linkLen / all.length;
      if (linkRatio > 0.5) score *= 0.2;
      else if (linkRatio > 0.3) score *= 0.6;
    }
    if (score > 0) seeds.push({ el, weight: 0, score });
  });

  // ---- 挑分数最高的那个 ----
  let best = null;
  let bestScore = 0;
  seeds.forEach((s) => {
    const base = s.score || 0;
    // 用容器自身的文字量做主要权重，种子权重做加成
    const own = Math.min(visibleText(s.el).length, 20000);
    const total = base + s.weight + own * 0.5;
    if (total > bestScore) {
      bestScore = total;
      best = s.el;
    }
  });

  let text = '';
  if (best) {
    // 把容器里的段落级元素抓出来，保持段落结构
    const parts = [];
    best.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, td').forEach((el) => {
      if (isNoise(el)) return;
      // 只收叶子一点的节点，避免父子重复收录
      if (el.querySelector('p, li, blockquote, pre')) return;
      const t = visibleText(el);
      if (!t) return;
      if (t.length < 2) return;
      // 纯链接行（导航残留）丢掉
      if (t.length < 40 && el.querySelector('a') && !el.querySelector('p')) return;
      parts.push(t);
    });
    text = parts.join('\n\n');
  }

  // 兜底：上面全挂了就直接拿 body
  if (!text || text.length < 200) {
    const body = document.body ? visibleText(document.body) : '';
    if (body.length > text.length) text = body;
  }

  const full = text.length;
  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars) + `\n\n[...内容过长，已截断，原文共约 ${full} 字]`;
  }

  return {
    title: document.title || '',
    url: location.href,
    text,
    chars: full,
  };
}

/** 抓当前选中的文字（注入用，同样必须自包含） */
export function grabSelection() {
  const sel = window.getSelection();
  return sel ? String(sel).trim() : '';
}
