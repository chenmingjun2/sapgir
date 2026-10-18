/**
 * Local webfetch: fetch the target URL directly and convert HTML to Markdown
 * in the extension page (which has a DOM).
 */

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30000;
const IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
const UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Sapgir/1.0';

const HTML_ACCEPT =
  'text/html;q=1.0, application/xhtml+xml;q=0.9, text/markdown;q=0.8, text/plain;q=0.7, */*;q=0.1';

function timeoutSignal(signal, ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function' && signal) {
      return AbortSignal.any([signal, timeout]);
    }
    return timeout;
  }
  return signal;
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^169\.254\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match) {
    const second = Number(match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.includes(':') && /^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return true;
  if (/^::ffff:127\./i.test(host)) return true;
  return false;
}

function charsetFrom(contentType) {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1] : 'utf-8';
}

async function readLimitedText(response, maxBytes, contentType) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length && length > maxBytes) {
    throw new Error(`响应体过大（${length} bytes）`);
  }

  if (!response.body) return await response.text();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch (_) {
        /* ignore */
      }
      throw new Error(`响应体超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decoder;
  try {
    decoder = new TextDecoder(charsetFrom(contentType));
  } catch (_) {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes);
}

function cleanHtmlDocument(doc) {
  doc
    .querySelectorAll(
      'script, style, noscript, iframe, object, embed, form, input, button, select, textarea, svg, canvas, link, meta'
    )
    .forEach((el) => el.remove());

  const candidates = [
    ...doc.querySelectorAll('article, main, [role="main"]'),
  ].filter((el) => (el.textContent || '').trim().length > 200);
  let root = candidates.sort(
    (a, b) => (b.textContent || '').length - (a.textContent || '').length
  )[0];

  if (!root) root = doc.body || doc.documentElement;
  root
    .querySelectorAll(
      'nav, aside, footer, header, .nav, .navbar, .menu, .sidebar, .footer, .header, .ad, .ads, .advert, .advertisement, [role="navigation"], [aria-hidden="true"]'
    )
    .forEach((el) => el.remove());

  return root;
}

function absolutizeLinks(root, baseUrl) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) return;
    try {
      a.setAttribute('href', new URL(href, baseUrl).href);
    } catch (_) {
      a.removeAttribute('href');
    }
  });
  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || /^data:/i.test(src)) return;
    try {
      img.setAttribute('src', new URL(src, baseUrl).href);
    } catch (_) {
      img.removeAttribute('src');
    }
  });
}

function htmlToMarkdown(html, url) {
  if (!IS_BROWSER) throw new Error('本地网页解析需要在浏览器扩展页面中运行');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = (doc.title || doc.querySelector('h1')?.textContent || '').trim();
  const root = cleanHtmlDocument(doc);
  absolutizeLinks(root, url);

  let markdown = '';
  if (typeof window.TurndownService === 'function') {
    const turndown = new window.TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
      emDelimiter: '*',
    });
    if (window.turndownPluginGfm?.gfm) {
      turndown.use(window.turndownPluginGfm.gfm);
    }
    turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button']);
    markdown = turndown.turndown(root);
  } else {
    markdown = root.textContent || '';
  }

  markdown = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!markdown) markdown = (root.textContent || '').replace(/\s+/g, ' ').trim();
  return {
    title: title || url,
    markdown: markdown.slice(0, 24000),
  };
}

/**
 * Fetch one HTTP(S) URL. HTML is converted to Markdown; text/JSON/XML is
 * returned as-is. Private/localhost targets are blocked unless explicitly
 * allowed.
 */
export async function fetchPageLocal({
  url,
  signal,
  timeoutMs = DEFAULT_TIMEOUT,
  maxBytes = MAX_BYTES,
  allowPrivate = false,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch (_) {
    throw new Error('需要有效的 http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http(s) URL');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL 不能包含用户名或密码');
  }
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new Error('默认禁止抓取 localhost / 内网地址（可在设置中允许）');
  }

  const res = await fetch(parsed.toString(), {
    method: 'GET',
    headers: {
      Accept: HTML_ACCEPT,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(IS_BROWSER ? {} : { 'User-Agent': UA }),
    },
    credentials: 'omit',
    redirect: 'follow',
    referrerPolicy: 'no-referrer',
    signal: timeoutSignal(signal, timeoutMs),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!allowPrivate && isPrivateHost(new URL(res.url || parsed.toString()).hostname)) {
    throw new Error('重定向到了内网地址，已拒绝');
  }

  const contentType = res.headers.get('content-type') || '';
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml';
  const isText =
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript';

  if (!isHtml && !isText) {
    throw new Error(`不支持的内容类型：${mime || 'unknown'}`);
  }

  const body = await readLimitedText(res, maxBytes, contentType);
  const finalUrl = res.url || parsed.toString();

  if (isHtml) {
    const converted = htmlToMarkdown(body, finalUrl);
    return {
      url: finalUrl,
      title: converted.title,
      content: converted.markdown,
      contentType,
      mode: 'local',
    };
  }

  const text = body.trim();
  return {
    url: finalUrl,
    title: finalUrl,
    content: text.slice(0, 24000),
    contentType,
    mode: 'local',
  };
}

export { isPrivateHost };
