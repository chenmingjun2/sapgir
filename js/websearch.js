/**
 * DeepSeek Messages-compatible native web search.
 *
 * This is a direct call to the endpoint's server-side web_search tool. The
 * Chat Completions mode uses DeepSeek's Search API instead (see api.js).
 */

const DEFAULT_TIMEOUT = 60000;

const PROVIDER_LABELS = {
  messages: 'Messages 端点',
  anthropic: 'Messages 端点',
  deepseek: 'DeepSeek Search',
  local: '本地抓取',
};

export function providerLabel(id) {
  return PROVIDER_LABELS[id] || id || 'Search';
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function timeoutSignal(signal, ms = DEFAULT_TIMEOUT) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function' && signal) {
      return AbortSignal.any([signal, timeout]);
    }
    return timeout;
  }
  return signal;
}

export function messagesEndpoint(baseUrl) {
  let base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  base = base
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/anthropic(?:\/v1)?$/i, '')
    .replace(/\/v1$/i, '');
  return `${base}/anthropic/v1/messages`;
}



/**
 * Run one server-side native search and return a concise answer plus sources.
 * Used by the settings "test search" button and by callers that need a
 * one-shot search result rather than a streamed assistant turn.
 */
export async function messagesSearch({
  baseUrl,
  apiKey,
  model = 'deepseek-flash',
  query,
  count = 5,
  signal,
} = {}) {
  const textQuery = String(query || '').trim();
  if (!textQuery) throw new Error('搜索关键词为空');
  if (!apiKey) throw new Error('缺少 API Key，无法使用 Messages 端点搜索');

  const maxUses = Math.max(2, Math.min(5, Number(count) || 5));
  const body = {
    model,
    max_tokens: 1200,
    system:
      '你是搜索助手。必须调用 web_search 搜索用户问题；然后用中文给出 3-6 条要点总结。不要编造，不要重复大段原文，不要单独列来源清单（客户端会展示来源）。',
    messages: [
      {
        role: 'user',
        content: `请使用 web_search 搜索下面的问题，并给出简洁的要点总结：\n\n${textQuery}`,
      },
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxUses,
      },
    ],
    thinking: { type: 'disabled' },
  };

  let res;
  try {
    res = await fetch(messagesEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      credentials: 'omit',
      signal: timeoutSignal(signal),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`Messages 端点搜索失败：${err?.message || err}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `Messages 端点搜索失败（${res.status}）${raw ? `：${raw.slice(0, 300)}` : ''}`
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('Messages 端点返回了无效 JSON');
  }
  if (data?.error) {
    throw new Error(data.error.message || 'Messages 端点搜索失败');
  }

  const blocks = Array.isArray(data?.content) ? data.content : [];
  const searchRequests = data?.usage?.server_tool_use?.web_search_requests || 0;
  if (!searchRequests) {
    throw new Error('Messages 端点没有执行 web_search（0 次搜索）');
  }

  const sources = [];
  const seen = new Set();
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result' || !Array.isArray(block.content)) {
      continue;
    }
    for (const result of block.content) {
      if (result?.type !== 'web_search_result' || !result.url || seen.has(result.url)) {
        continue;
      }
      seen.add(result.url);
      sources.push({
        title: result.title || result.url,
        url: result.url,
        site: hostOf(result.url),
        date: result.page_age || '',
        snippet: '',
        summary: '',
      });
    }
  }

  const answer = blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n')
    .trim();

  if (!answer && !sources.length) {
    throw new Error('Messages 端点搜索没有返回可用结果');
  }

  return {
    provider: 'messages',
    query: textQuery,
    answer,
    sources,
    searchRequests,
    usage: data.usage || null,
  };
}

