/**
 * Markdown rendering with GFM, sanitization, code highlighting, copy buttons
 * and numbered citation links.
 */

const markedLib = window.marked;
const purify = window.DOMPurify;
const hljs = window.hljs;

if (markedLib) {
  markedLib.setOptions({
    gfm: true,
    breaks: true,
  });
}

const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw) {
  const href = String(raw || '').trim();
  return SAFE_URL.test(href) ? href : '';
}

function enhanceLinks(root) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = safeHref(a.getAttribute('href'));
    if (!href) {
      a.removeAttribute('href');
      return;
    }
    a.setAttribute('href', href);
    if (!href.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function enhanceImages(root) {
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^(https?:\/\/|data:image\/)/i.test(src)) {
      img.remove();
      return;
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.classList.add('md-img');
    if (!img.getAttribute('alt')) img.setAttribute('alt', '图片');
  });
}

function enhanceTables(root) {
  root.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.classList.contains('table-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      ta.remove();
    }
  });
}

function enhanceCode(root, { highlight = true } = {}) {
  root.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('code-block')) return;
    const langClass = [...code.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    const raw = code.textContent || '';

    if (highlight && hljs && raw.length < 60000) {
      try {
        if (lang && hljs.getLanguage(lang)) {
          code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
        } else if (raw.length < 20000) {
          code.innerHTML = hljs.highlightAuto(raw).value;
        } else {
          code.textContent = raw;
        }
      } catch (_) {
        code.textContent = raw;
      }
      code.classList.add('hljs');
      if (lang) code.classList.add(`language-${lang}`);
    }

    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);

    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang || 'code';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = '复制';
    button.addEventListener('click', async () => {
      try {
        await copyText(raw);
        button.textContent = '已复制';
        setTimeout(() => {
          button.textContent = '复制';
        }, 1500);
      } catch (_) {
        button.textContent = '复制失败';
      }
    });
    head.append(label, button);
    wrap.insertBefore(head, pre);
  });
}

function enhanceTaskLists(root) {
  root.querySelectorAll('li > input[type="checkbox"]').forEach((input) => {
    input.disabled = true;
    input.parentElement?.classList.add('task-item');
  });
}

/**
 * Markdown strips the backslashes in \( \) and \[ \], so protect those
 * delimiters before parsing and restore them after sanitization. $$...$$ is
 * already stable and is left untouched.
 */
function protectMath(source, prefix, store) {
  const parts = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return parts
    .map((part) => {
      if (/^(```|~~~)/.test(part)) return part;
      return part.replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g, (match) => {
        const token = `@@${prefix}_${store.size}@@`;
        store.set(token, match);
        return token;
      });
    })
    .join('');
}

function restoreMath(root, prefix, store) {
  if (!store.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes(`@@${prefix}_`)) {
      nodes.push(walker.currentNode);
    }
  }
  const re = new RegExp(`@@${prefix}_(\\d+)@@`, 'g');
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const raw = store.get(match[0]);
      if (raw) frag.appendChild(document.createTextNode(raw));
      last = match.index + match[0].length;
    }
    if (!last) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function addCitations(root, citations) {
  if (!Array.isArray(citations) || !citations.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.includes('[')) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, .code-block')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  const re = /\[(\d{1,2})\]/g;
  for (const node of nodes) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const index = Number(match[1]);
      const source = citations[index - 1];
      if (!source?.url || !/^https?:\/\//i.test(source.url)) continue;
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const a = document.createElement('a');
      a.className = 'cite';
      a.href = source.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = source.title || source.url;
      a.textContent = match[0];
      frag.appendChild(a);
      last = match.index + match[0].length;
    }
    if (!last) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

/**
 * Render markdown to a sanitized HTML string.
 * @param {string} text
 * @param {{citations?: Array<{url:string,title?:string}>, highlight?: boolean}} opts
 */
export function renderMarkdown(text, opts = {}) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const mathStore = new Map();
  const mathPrefix = `M${Math.random().toString(36).slice(2, 8)}`;
  const parseSource = protectMath(source, mathPrefix, mathStore);
  let html = '';

  if (markedLib) {
    try {
      html = markedLib.parse(parseSource);
    } catch (_) {
      html = `<p>${escapeHtml(parseSource)}</p>`;
    }
  } else {
    html = `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
  }

  const clean = purify
    ? purify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ['target', 'rel', 'loading', 'referrerpolicy', 'align'],
        FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button'],
        FORBID_ATTR: ['style'],
        ALLOW_DATA_ATTR: true,
      })
    : html;

  const template = document.createElement('template');
  template.innerHTML = clean;
  const root = template.content;

  enhanceLinks(root);
  enhanceImages(root);
  enhanceTables(root);
  enhanceCode(root, { highlight: opts.highlight !== false });
  enhanceTaskLists(root);
  addCitations(root, opts.citations);
  restoreMath(root, mathPrefix, mathStore);

  const container = document.createElement('div');
  container.appendChild(root);

  // Render explicit LaTeX delimiters. Single-dollar math is intentionally not
  // enabled so currency like "$0.15" is never parsed as a formula.
  if (
    opts.math !== false &&
    (mathStore.size > 0 || source.includes('$$')) &&
    typeof window.renderMathInElement === 'function'
  ) {
    try {
      window.renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
        ],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'button'],
        ignoredClasses: ['code-block'],
        throwOnError: false,
        strict: false,
        errorColor: '#d93843',
      });
    } catch (_) {
      /* leave raw LaTeX if rendering fails */
    }
  }

  return container.innerHTML;
}

export function escapeText(text) {
  return escapeHtml(text);
}

export { copyText };
