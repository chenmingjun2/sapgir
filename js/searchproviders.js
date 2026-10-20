/**
 * Multi-engine web search (BYOK).
 *
 * Chat mode searches through DeepSeek Search by default and can rotate across
 * several third-party engines. Every engine here uses a key the user created
 * on that provider's own platform: there is no keyless mode and no shared or
 * impersonated client identity. DeepSeek's implementation stays in api.js
 * because it shares the chat endpoint; this module owns the other engines and
 * the rotation policy.
 */

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek Search', keyField: '' },
  {
    id: 'exa',
    label: 'Exa',
    keyField: 'exa',
    keysUrl: 'https://dashboard.exa.ai/api-keys',
  },
  {
    id: 'parallel',
    label: 'Parallel',
    keyField: 'parallel',
    keysUrl: 'https://platform.parallel.ai',
  },
  {
    id: 'tavily',
    label: 'Tavily',
    keyField: 'tavily',
    keysUrl: 'https://app.tavily.com/home',
  },
];

const LABELS = {
  messages: 'Messages 端点',
  anthropic: 'Messages 端点',
  local: '本地抓取',
  auto: '随机轮换',
};

for (const provider of PROVIDERS) LABELS[provider.id] = provider.label;

export const SEARCH_PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

export const SEARCH_PROVIDER_OPTIONS = PROVIDERS.map(({ id, label }) => ({ id, label }));

export const SEARCH_KEY_FIELDS = PROVIDERS.filter((provider) => provider.keyField).map(
  ({ id, label, keyField, keysUrl }) => ({ id, label, keyField, keysUrl })
);

export function providerLabel(id) {
  return LABELS[id] || id || 'Search';
}

export function normalizeSearchKeys(keys) {
  const out = { exa: '', parallel: '', tavily: '' };
  if (!keys || typeof keys !== 'object') return out;
  for (const field of Object.keys(out)) {
    out[field] = typeof keys[field] === 'string' ? keys[field].trim() : '';
  }
  return out;
}

function keyFor(providerId, { apiKey, searchKeys } = {}) {
  if (providerId === 'deepseek') return String(apiKey || '').trim();
  const entry = PROVIDERS.find((provider) => provider.id === providerId);
  if (!entry?.keyField) return '';
  return String(searchKeys?.[entry.keyField] || '').trim();
}

/** Provider ids that can actually run with the current settings. */
export function availableSearchProviders(settings = {}) {
  return PROVIDERS.filter((provider) => keyFor(provider.id, settings)).map(
    (provider) => provider.id
  );
}

function randomUnit() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] / 2 ** 32;
  }
  return Math.random();
}

/**
 * Build the full attempt order for one search.
 *
 * `mode` is 'auto' (default) or 'deepseek'. In auto mode every engine with a
 * configured key takes part: one is picked at random as the primary (avoiding
 * the engine used by the previous search when possible), then every remaining
 * engine follows in random order. executeTool walks this list until one
 * succeeds, so one failing provider only costs an attempt.
 *
 * 'deepseek' is the explicit "only DeepSeek Search" mode and returns just that
 * engine, with no rotation or third-party fallback.
 */
export function planSearchProviders({ mode = 'auto', settings = {}, exclude = '' } = {}) {
  const available = availableSearchProviders(settings);
  if (!available.length) return [];
  if (mode === 'deepseek') {
    return available.includes('deepseek') ? ['deepseek'] : [];
  }

  let pool = available;
  if (pool.length > 1 && exclude) {
    const remaining = pool.filter((provider) => provider !== exclude);
    if (remaining.length) pool = remaining;
  }
  const primary = pool[Math.floor(randomUnit() * pool.length)];
  const rest = available.filter((provider) => provider !== primary);
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(randomUnit() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [primary, ...rest];
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function timeoutSignal(signal, ms = 60000) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function' && signal) {
      return AbortSignal.any([signal, timeout]);
    }
    return timeout;
  }
  return signal;
}

function errorDetail(data) {
  if (!data || typeof data !== 'object') return '';
  return (
    data?.error?.message ||
    data?.error?.detail ||
    data?.message ||
    data?.detail ||
    ''
  );
}

async function postJson({ url, headers, body, signal, label }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: timeoutSignal(signal),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`${label} 搜索请求失败：${err?.message || err}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    /* keep raw text for the error message */
  }

  if (!res.ok) {
    const detail = errorDetail(data) || raw.slice(0, 300);
    throw new Error(
      `${label} 搜索失败（${res.status}）${detail ? `：${detail}` : ''}`
    );
  }
  if (!data || typeof data !== 'object') {
    throw new Error(`${label} 返回了无效 JSON`);
  }
  return data;
}

function mapResults(items, pick, label) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const mapped = pick(item);
    if (!mapped?.url || seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    out.push({
      title: mapped.title || hostOf(mapped.url) || mapped.url,
      url: mapped.url,
      snippet: mapped.snippet || '',
      summary: mapped.summary || '',
      content: mapped.content || '',
      site: hostOf(mapped.url),
      date: mapped.date || '',
    });
  }
  if (!out.length) throw new Error(`${label} 没有返回结果`);
  return out;
}

async function exaSearch({ apiKey, query, count, signal }) {
  const data = await postJson({
    url: 'https://api.exa.ai/search',
    headers: { 'x-api-key': apiKey },
    body: {
      query,
      type: 'auto',
      numResults: Math.max(1, Math.min(20, count)),
      contents: { text: { maxCharacters: 1500 } },
    },
    signal,
    label: 'Exa',
  });
  return mapResults(data.results, (item) => ({
    title: item.title,
    url: item.url,
    content: item.text || '',
    summary: typeof item.summary === 'string' ? item.summary : '',
    date: item.publishedDate || item.published_date || '',
  }), 'Exa');
}

async function parallelSearch({ apiKey, query, count, oriQuestion, signal }) {
  const data = await postJson({
    url: 'https://api.parallel.ai/v1/search',
    headers: { 'x-api-key': apiKey },
    body: {
      objective: String(oriQuestion || query).slice(0, 500),
      search_queries: [query],
      mode: 'fast',
      advanced_settings: {
        max_results: Math.max(1, Math.min(20, count)),
        excerpt_settings: { max_chars_per_result: 1500 },
      },
    },
    signal,
    label: 'Parallel',
  });
  return mapResults(data.results, (item) => ({
    title: item.title,
    url: item.url,
    content: Array.isArray(item.excerpts) ? item.excerpts.join('\n\n') : '',
    date: item.publish_date || '',
  }), 'Parallel');
}

async function tavilySearch({ apiKey, query, count, signal }) {
  const data = await postJson({
    url: 'https://api.tavily.com/search',
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      query,
      max_results: Math.max(1, Math.min(20, count)),
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    },
    signal,
    label: 'Tavily',
  });
  return mapResults(data.results, (item) => ({
    title: item.title,
    url: item.url,
    content: item.raw_content || '',
    summary: item.content || '',
    date: item.published_date || '',
  }), 'Tavily');
}

/**
 * Run one third-party search. Returns normalized results that api.js formats
 * into the same [n]-numbered text used by DeepSeek Search.
 */
export async function searchWithProvider({
  provider,
  apiKey,
  query,
  count = 8,
  oriQuestion = '',
  signal,
}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error(`${providerLabel(provider)} 缺少 API Key`);

  if (provider === 'exa') {
    return exaSearch({ apiKey: key, query, count, signal });
  }
  if (provider === 'parallel') {
    return parallelSearch({ apiKey: key, query, count, oriQuestion, signal });
  }
  if (provider === 'tavily') {
    return tavilySearch({ apiKey: key, query, count, signal });
  }
  throw new Error(`未知搜索 provider：${provider}`);
}
