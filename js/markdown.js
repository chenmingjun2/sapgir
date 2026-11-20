/**
 * Markdown rendering with GFM, sanitization, code highlighting, copy buttons,
 * code language labels, numbered citation links and KaTeX math.
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

/**
 * Copy text with a clipboard fallback. Extension pages can reject
 * navigator.clipboard.writeText (for example when the document is not focused),
 * so always fall back to the hidden-textarea + execCommand path.
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (_) {
      /* fall through to execCommand */
    }
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('copy failed');
  } finally {
    ta.remove();
  }
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
    button.setAttribute('aria-label', '复制代码');
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

/* ------------------------------------------------------------------ */
/* Math                                                                */
/* ------------------------------------------------------------------ */

/**
 * Protect LaTeX before Markdown parsing. Marked treats `_`, `*`, `\` and line
 * breaks inside formulas as Markdown syntax, so math has to be replaced with
 * opaque tokens first and restored after sanitization.
 */
function protectMath(source, prefix, store) {
  const add = (raw, tex, display) => {
    const token = `@@${prefix}_${store.size}@@`;
    store.set(token, { raw, tex: tex.trim(), display });
    return token;
  };

  // Skip fenced and inline code. Math inside code must stay literal.
  const parts = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return parts
    .map((part) => {
      if (/^(```|~~~|`)/.test(part)) return part;

      let out = part;
      // Display math first.
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => add(match, tex, true));
      out = out.replace(/\\\[([\s\S]+?)\\\]/g, (match, tex) => add(match, tex, true));
      // Inline math with explicit LaTeX delimiters.
      out = out.replace(/\\\(([\s\S]+?)\\\)/g, (match, tex) => add(match, tex, false));
      // Conservative single-dollar inline math. Currency like $5-$10, $0.15
      // and "$5 和 $10" is rejected by isInlineMath().
      out = out.replace(/(^|[^\\$])\$([^$\n]+?)\$(?!\d)/g, (match, lead, tex) => {
        if (!isInlineMath(tex)) return match;
        return lead + add(match.slice(lead.length), tex, false);
      });
      return out;
    })
    .join('');
}

function isInlineMath(tex) {
  if (!tex || tex !== tex.trim()) return false;
  if (tex.length > 300) return false;
  if (/^[\d.,\s]+$/.test(tex)) return false;
  if (/[A-Za-z\\]/.test(tex)) return true;
  if (/[=^_{}<>]/.test(tex)) return true;
  return /\d\s*[+\-*/]\s*\d/.test(tex);
}

/**
 * Replace math tokens with either KaTeX placeholders (render=true) or the
 * original raw LaTeX (render=false, used during streaming).
 */
function restoreMath(root, prefix, store, { render = true } = {}) {
  if (!store.size) return;
  const needle = `@@${prefix}_`;
  const re = new RegExp(`@@${prefix}_(\\d+)@@`, 'g');
  const canRender = render && typeof window.katex?.render === 'function';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const value = walker.currentNode.nodeValue;
    if (value && value.includes(needle)) nodes.push(walker.currentNode);
  }

  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const item = store.get(match[0]);
      if (!item) continue;
      if (canRender) {
        const span = document.createElement('span');
        span.className = 'math-tex';
        span.dataset.tex = item.tex;
        span.dataset.display = item.display ? '1' : '0';
        frag.appendChild(span);
      } else {
        frag.appendChild(document.createTextNode(item.raw));
      }
      last = match.index + match[0].length;
    }
    if (!last) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderMath(root) {
  if (typeof window.katex?.render !== 'function') return;
  root.querySelectorAll('span.math-tex[data-tex]').forEach((el) => {
    const tex = el.dataset.tex || '';
    if (!tex) {
      el.remove();
      return;
    }
    try {
      window.katex.render(tex, el, {
        displayMode: el.dataset.display === '1',
        throwOnError: false,
        strict: false,
        errorColor: '#d93843',
      });
    } catch (_) {
      el.textContent = tex;
    }
    el.removeAttribute('data-tex');
    el.removeAttribute('data-display');
  });
}

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

function addCitations(root, citations) {
  if (!Array.isArray(citations) || !citations.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || !value.includes('[')) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, .code-block, .katex')) return NodeFilter.FILTER_REJECT;
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
 * @param {{citations?: Array<{url:string,title?:string}>, highlight?: boolean, math?: boolean}} opts
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
  restoreMath(root, mathPrefix, mathStore, { render: opts.math !== false });
  if (opts.math !== false) renderMath(root);

  const container = document.createElement('div');
  container.appendChild(root);

  return container.innerHTML;
}
