/**
 * DeepSeek API client: streaming chat completions, cloud search/fetch tools,
 * and model discovery. Runs in the extension page, where host permissions
 * let us call api.deepseek.com directly without CORS issues.
 */

import { DEFAULT_SYSTEM_PROMPT, DEFAULT_SETTINGS } from './storage.js';
import { fetchPageLocal } from './webfetch.js';

export function normalizeBase(input) {
  let base = String(input || '').trim() || DEFAULT_SETTINGS.baseUrl;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/messages$/i, '');
  return base;
}

function endpoint(baseUrl, path) {
  const base = normalizeBase(baseUrl);
  return base + path;
}

function searchEndpoint(baseUrl, path) {
  const base = normalizeBase(baseUrl);
  if (/\/v1$/i.test(base)) return `${base}${path}`;
  return `${base}/v1${path}`;
}

function authHeaders(apiKey, extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export function friendlyError(status, serverMessage) {
  const detail = serverMessage ? `：${serverMessage}` : '';
  if (status === 400) return `请求参数有误${detail}`;
  if (status === 401) return 'API Key 无效或已过期，请在设置中检查。';
  if (status === 402) return '账户余额不足，请前往 DeepSeek 开放平台充值。';
  if (status === 403) return `请求被拒绝${detail}`;
  if (status === 404) return `接口不存在（404），请检查 Base URL 是否正确${detail}`;
  if (status === 413) return '请求体过大，请减少图片数量或换用更小的图片。';
  if (status === 429) return '请求过于频繁，或已达到速率限制，请稍后重试。';
  if (status >= 500) return `DeepSeek 服务暂时不可用（${status}），请稍后重试。`;
  return `请求失败（${status}）${detail}`;
}

async function readError(res) {
  let message = '';
  try {
    const text = await res.text();
    try {
      const data = JSON.parse(text);
      message = data?.error?.message || data?.message || '';
    } catch (_) {
      message = text.slice(0, 500);
    }
  } catch (_) {
    /* ignore */
  }
  return friendlyError(res.status, message);
}

function withTimeout(signal, ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function' && signal) {
      return AbortSignal.any([signal, timeout]);
    }
    return timeout;
  }
  return signal;
}

export async function listModels({ baseUrl, apiKey, signal }) {
  if (!apiKey) throw new Error('请先填写 API Key');
  let res;
  try {
    res = await fetch(endpoint(baseUrl, '/models'), {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal: withTimeout(signal, 20000),
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error('连接超时，请检查网络或 Base URL。');
    }
    throw new Error(`网络连接失败：${err?.message || err}`);
  }
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

export function buildToolDefinitions(allowFetch = true) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          '使用 DeepSeek 云端搜索引擎搜索实时网页。适用于新闻、价格、版本、人物、政策等可能超出你知识截止日期的问题。可多次调用。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                '搜索关键词，1-128 个字符。支持 site:、-site:、lang:、after:、before:、"" 精确短语等操作符。',
            },
            count: {
              type: 'integer',
              description: '返回结果数量，1-20，默认 8。',
              minimum: 1,
              maximum: 20,
            },
          },
          required: ['query'],
        },
      },
    },
  ];

  if (allowFetch) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          '抓取一个网页并把正文转换为 Markdown。通常在 web_search 找到有价值的链接后使用，以便阅读完整内容。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '要抓取的 http(s) 网页地址。' },
          },
          required: ['url'],
        },
      },
    });
  }
  return tools;
}

/**
 * Build a session-stable system message. It is snapshotted on the conversation
 * so the prefix sent to the API does not change from turn to turn (DeepSeek
 * context caching is prefix-based). The tool note is deliberately neutral:
 * tools may be enabled or disabled per turn without rewriting the prefix.
 */
export function buildSessionSystemMessage(settings) {
  const base = (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
  const now = new Date();
  const dateText = now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  const extra = `\n\n当前日期：${dateText}。你的训练知识可能早于这个日期，涉及最新信息时不要凭空猜测。

当本轮请求提供联网工具时，你可以调用：
- web_search：搜索网页（由当前回答端点提供：DeepSeek Search 或 Messages 原生搜索）。
- web_fetch：抓取指定网页的正文（仅 Chat 模式）。
使用原则：需要实时或可核实的信息时先搜索；搜索摘要不够时抓取原文；不要编造搜索结果。搜索结果已经带有全局编号 [n]，引用时可以直接使用 [n]；也可以使用 Markdown 链接 [标题](URL) 的形式，并在正文中自然标注出处。如果本轮没有提供某个工具，请不要假装调用它。对于 coding、数学、翻译、写作、常识解释，或上下文已经足够回答的追问，不要为了搜索而搜索。`;

  return { role: 'system', content: base + extra };
}

function userContent(msg) {
  let text = msg.content || '';
  for (const file of msg.files || []) {
    if (!file?.text) continue;
    const safeName = String(file.name || 'file').replace(/[<>"]/g, '_');
    text += `\n\n<file name="${safeName}">\n${file.text}\n</file>`;
  }
  const images = (msg.images || []).filter((img) => img?.dataUrl);
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: 'high' } });
  }
  if (!parts.length) parts.push({ type: 'text', text: '请看这些图片。' });
  return parts;
}

function normalizeToolTokens(text) {
  return String(text || '').replace(/｜/g, '|').replace(/▁/g, '_');
}

function isInFencedCode(text, index) {
  const before = text.slice(0, index);
  const fences = before.match(/```|~~~/g);
  return !!fences && fences.length % 2 === 1;
}

function stripToolTags(text) {
  return String(text || '')
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part; // fenced code block: leave untouched
      return part
        .replace(/<[｜|]tool[▁_]?call[^｜|>]*[｜|]>/g, '')
        .replace(/<[｜|]tool[▁_]?sep[｜|]>/g, '')
        .replace(/<\/?tool[▁_]?calls?>/gi, '');
    })
    .join('');
}

function readJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return { value: JSON.parse(raw), end: i + 1 };
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function parseToolPayload(inner) {
  let parsed;
  try {
    parsed = JSON.parse(inner);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const name = parsed.name || parsed.tool || parsed.function?.name;
  let args = parsed.arguments ?? parsed.args ?? parsed.function?.arguments ?? {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (_) {
      return null;
    }
  }
  if (!name || typeof name !== 'string') return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, args };
}

/**
 * Some models (notably when tools were not declared in the request) fall back
 * to emitting a textual tool-call protocol. Normalize and recover those calls
 * so the app can execute them instead of displaying raw markers.
 *
 * Supported:
 *   <tool_call>{"name":"web_search","arguments":{...}}</tool_call>
 *   <|tool_call|>web_search<|tool_sep|>{...}<|tool_call|>
 * with full-width ｜ / ▁ variants.
 */
export function parseRawToolCalls(content) {
  const original = String(content || '');
  const normalized = normalizeToolTokens(original);
  const calls = [];
  const ranges = [];

  const addRange = (start, end) => {
    if (end > start) ranges.push([start, end]);
  };

  const xmlRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  while ((match = xmlRe.exec(normalized))) {
    const start = match.index;
    if (isInFencedCode(normalized, start)) continue;
    const end = start + match[0].length;
    const payload = parseToolPayload(match[1]);
    if (payload) {
      calls.push(payload);
      addRange(start, end);
    } else if (!/<\|tool_sep\|>/.test(match[1])) {
      // Hide malformed tool-call blocks rather than leaking raw markers.
      addRange(start, end);
    }
  }

  const sepRe = /<\|tool_sep\|>/g;
  const separators = [];
  while ((match = sepRe.exec(normalized))) {
    separators.push({ index: match.index, end: match.index + match[0].length });
  }

  for (const separator of separators) {
    if (isInFencedCode(normalized, separator.index)) continue;
    if (ranges.some(([start, end]) => separator.index >= start && separator.index < end)) {
      continue;
    }
    const before = normalized.slice(0, separator.index);
    const nameMatch = before.match(/([A-Za-z_][A-Za-z0-9_.-]*)\s*$/);
    if (!nameMatch) continue;

    let cursor = separator.end;
    while (cursor < normalized.length && /\s/.test(normalized[cursor])) cursor += 1;
    if (normalized[cursor] !== '{') continue;
    const json = readJsonObject(normalized, cursor);
    if (!json) continue;

    const start = nameMatch.index;
    let end = json.end;
    const tagAfter = normalized.slice(end).match(/^\s*<\|tool_call[^|]*\|>/);
    if (tagAfter) end += tagAfter[0].length;

    addRange(start, end);
    calls.push({ name: nameMatch[1], args: json.value });
  }

  ranges.sort((a, b) => a[0] - b[0]);
  let cleaned = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) continue;
    cleaned += original.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  cleaned += original.slice(cursor);

  cleaned = stripToolTags(cleaned).replace(/\n{3,}/g, '\n\n').trim();

  return { calls, cleaned };
}

function traceMessages(trace) {
  const out = [];
  const items = Array.isArray(trace) ? trace : [];
  let index = 0;

  while (index < items.length) {
    const item = items[index];
    if (
      !item ||
      item.role !== 'assistant' ||
      !Array.isArray(item.tool_calls) ||
      !item.tool_calls.length
    ) {
      index += 1;
      continue;
    }

    const callIds = item.tool_calls
      .map((call) => call?.id)
      .filter((id) => typeof id === 'string' && id);
    const following = [];
    let next = index + 1;
    while (next < items.length && items[next]?.role === 'tool') {
      following.push(items[next]);
      next += 1;
    }

    const resultIds = new Set(
      following.map((msg) => msg?.tool_call_id).filter(Boolean)
    );
    const complete =
      callIds.length > 0 && callIds.every((id) => resultIds.has(id));
    if (complete) {
      const entry = {
        role: 'assistant',
        content: typeof item.content === 'string' ? item.content : '',
        tool_calls: item.tool_calls,
      };
      if (item.reasoning_content) entry.reasoning_content = item.reasoning_content;
      out.push(entry);
      for (const msg of following) {
        out.push({
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : '',
        });
      }
    }
    index = next;
  }

  return out;
}

/**
 * Rebuild the request as an append-only log:
 *   system + (user | assistant-with-hidden-tool-trace)...
 *
 * Tool calls and their results are kept in `msg.toolTrace` so the next request
 * repeats the exact same prefix. Combined with the stable session system
 * message, this gives DeepSeek's prefix cache a chance to hit every turn.
 */
export function buildApiMessages(messages, settings, systemMessage = null) {
  const system =
    typeof systemMessage === 'string'
      ? { role: 'system', content: systemMessage }
      : systemMessage || buildSessionSystemMessage(settings);
  const out = [system];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = userContent(msg);
      if (typeof content === 'string' && !content.trim()) continue;
      out.push({ role: 'user', content });
      continue;
    }

    if (msg.role === 'assistant') {
      const finalContent =
        typeof msg.apiFinalContent === 'string'
          ? msg.apiFinalContent
          : typeof msg.content === 'string'
            ? msg.content
            : '';
      const finalReasoning =
        typeof msg.apiFinalReasoning === 'string'
          ? msg.apiFinalReasoning
          : typeof msg.reasoning === 'string'
            ? msg.reasoning
            : '';
      const hasContent = !!finalContent.trim();
      const hasReasoning = !!finalReasoning.trim();
      if (!hasContent && !hasReasoning) continue;

      if (Array.isArray(msg.toolTrace) && msg.toolTrace.length) {
        out.push(...traceMessages(msg.toolTrace));
      }

      const entry = { role: 'assistant', content: finalContent };
      // Always pass reasoning back for a stable prefix (and because DeepSeek
      // requires it when the request carries tools).
      if (hasReasoning) entry.reasoning_content = finalReasoning;
      out.push(entry);
    }
  }

  return out;
}

/** Parse SSE from fetch Response into aggregated chat result. */
export async function streamChat({
  baseUrl,
  apiKey,
  model,
  messages,
  thinking = true,
  reasoningEffort = 'high',
  maxTokens = 0,
  temperature = 1,
  tools = null,
  includeUsage = true,
  signal,
  onDelta,
  onToolCall,
}) {
  if (!apiKey) throw new Error('请先在设置中填写 API Key。');
  if (!model) throw new Error('请先选择或填写模型名称。');

  const body = {
    model,
    messages,
    stream: true,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
  };
  if (thinking && reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (!thinking && Number.isFinite(temperature)) body.temperature = temperature;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (tools && tools.length) body.tools = tools;
  if (includeUsage) body.stream_options = { include_usage: true };

  let res;
  try {
    res = await fetch(endpoint(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`网络连接失败：${err?.message || err}。请检查网络、代理或 Base URL。`);
  }

  if (!res.ok) throw new Error(await readError(res));

  const contentType = res.headers.get('content-type') || '';

  // Some OpenAI-compatible gateways ignore stream:true.
  if (contentType.includes('application/json')) {
    const data = await res.json();
    const message = data?.choices?.[0]?.message || {};
    const content = message.content || '';
    const reasoning = message.reasoning_content || message.reasoning || '';
    if (content) onDelta?.({ content });
    if (reasoning) onDelta?.({ reasoning });
    return {
      content,
      reasoning,
      toolCalls: message.tool_calls || [],
      usage: data?.usage || null,
      finishReason: data?.choices?.[0]?.finish_reason || 'stop',
    };
  }

  if (!res.body) throw new Error('服务器未返回流式内容。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = '';
  const toolCalls = [];
  const announced = new Set();

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (payload.usage) usage = payload.usage;
    if (payload.error) {
      throw new Error(payload.error.message || 'API 返回错误');
    }
    const choice = payload.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const c = delta.content;
    const r = delta.reasoning_content || delta.reasoning;
    if (c) {
      content += c;
      onDelta?.({ content: c });
    }
    if (r) {
      reasoning += r;
      onDelta?.({ reasoning: r });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const i = Number.isInteger(part.index) ? part.index : toolCalls.length;
        if (!toolCalls[i]) {
          toolCalls[i] = {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
        }
        const target = toolCalls[i];
        if (part.id) target.id = part.id;
        if (part.type) target.type = part.type;
        if (part.function?.name) {
          if (!target.function.name) target.function.name = part.function.name;
          else if (!target.function.name.endsWith(part.function.name)) {
            target.function.name += part.function.name;
          }
        }
        if (part.function?.arguments) target.function.arguments += part.function.arguments;
        if (target.function.name && !announced.has(i)) {
          announced.add(i);
          onToolCall?.({ index: i, name: target.function.name });
        }
      }
    }
  };

  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('data:')) handleLine(line);
      if (line.includes('[DONE]')) {
        done = true;
        break;
      }
    }
  }
  buffer += decoder.decode();
  if (!done && buffer.trim()) {
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    if (buffer.startsWith('data:')) handleLine(buffer);
  }

  return {
    content,
    reasoning,
    toolCalls: toolCalls.filter(Boolean),
    usage,
    finishReason,
  };
}

function clip(text, max) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n…（内容已截断，共 ${str.length} 字符）`;
}

function sourceIndex(url, sourceOffset, existingUrls) {
  const existing = (existingUrls || []).indexOf(url);
  return existing >= 0 ? existing + 1 : sourceOffset + 1;
}

function formatSearchResults(
  results,
  query,
  { sourceOffset = 0, existingUrls = [], provider = 'search' } = {}
) {
  const known = new Set((existingUrls || []).filter(Boolean));
  const unique = [];
  for (const result of results || []) {
    if (!result?.url || known.has(result.url)) continue;
    known.add(result.url);
    unique.push(result);
  }

  const sources = unique.map((r) => ({
    title: r.title || r.url || '未命名网页',
    url: r.url || '',
    snippet: r.snippet || '',
    summary: r.summary || '',
    site: r.site || '',
    date: r.date || '',
  }));

  if (!unique.length) {
    return {
      text: `搜索“${query}”没有返回结果。可以更换关键词或使用更宽泛的查询。`,
      sources: [],
      meta: { query, count: 0, provider },
    };
  }

  const text = unique
    .map((r, i) => {
      const bits = [
        `[${sourceOffset + i + 1}] ${r.title || '(无标题)'}`,
        `URL: ${r.url}`,
        r.site ? `站点: ${r.site}` : '',
        r.date ? `时间: ${r.date}` : '',
        r.summary ? `摘要: ${clip(r.summary, 1000)}` : '',
        r.snippet && !r.summary && !r.content
          ? `片段: ${clip(r.snippet, 400)}`
          : '',
        r.content ? `正文: ${clip(r.content, 1500)}` : '',
      ].filter(Boolean);
      return bits.join('\n');
    })
    .join('\n\n');

  return {
    text: `搜索“${query}”的结果（共 ${unique.length} 条）：\n\n${clip(text, 16000)}`,
    sources,
    meta: { query, count: unique.length, provider },
  };
}

function formatFetchResult(
  { url, title, content },
  { sourceOffset = 0, existingUrls = [], provider = 'local' } = {}
) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (_) {
    /* ignore */
  }
  const citationIndex = sourceIndex(url, sourceOffset, existingUrls);
  return {
    text: `已抓取网页 [${citationIndex}]：${title || url}\nURL: ${url}\n\n${
      clip(content, 28000) || '(页面没有可提取的正文)'
    }`,
    sources: [{ title: title || url, url, site: host, snippet: '', summary: '' }],
    meta: { url, length: content?.length || 0, title: title || url, provider },
  };
}

async function deepseekSearch({
  baseUrl,
  apiKey,
  query,
  count,
  oriQuestion,
  signal,
  sourceOffset,
  existingUrls,
}) {
  const payload = { query, count, need_content: false };
  if (oriQuestion) payload.ori_question = String(oriQuestion).slice(0, 128);

  let res;
  try {
    res = await fetch(searchEndpoint(baseUrl, '/tools/search'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: withTimeout(signal, 60000),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`搜索请求失败：${err?.message || err}`);
  }
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  const results = (Array.isArray(data?.results) ? data.results : []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    summary: r.summary,
    content: r.content || '',
    site: r.site_name || '',
    date: r.date || '',
  }));
  return formatSearchResults(results, query, {
    sourceOffset,
    existingUrls,
    provider: 'deepseek',
  });
}

async function deepseekFetch({ baseUrl, apiKey, url, signal, sourceOffset, existingUrls }) {
  let res;
  try {
    res = await fetch(searchEndpoint(baseUrl, '/tools/fetch'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ url }),
      signal: withTimeout(signal, 60000),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`抓取网页失败：${err?.message || err}`);
  }
  if (!res.ok) throw new Error(await readError(res));
  const data = await res.json();
  return formatFetchResult(
    {
      url: data?.url || url,
      title: data?.title || url,
      content: data?.content || '',
    },
    { sourceOffset, existingUrls, provider: 'deepseek' }
  );
}

/**
 * Execute one web tool using the official DeepSeek API.
 */
export async function executeTool({
  baseUrl,
  apiKey,
  name,
  args = {},
  signal,
  defaultCount = 8,
  oriQuestion = '',
  sourceOffset = 0,
  existingUrls = [],
  webFetchMode = 'local',
  fallbackDeepSeek = true,
  allowPrivateFetch = false,
}) {
  if (name === 'web_search') {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('搜索关键词为空');
    const count = Math.max(1, Math.min(20, Number(args.count) || defaultCount));
    return deepseekSearch({
      baseUrl,
      apiKey,
      query,
      count,
      oriQuestion,
      signal,
      sourceOffset,
      existingUrls,
    });
  }

  if (name === 'web_fetch') {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('需要 http(s) 网页地址');

    if (webFetchMode === 'local') {
      try {
        const page = await fetchPageLocal({
          url,
          signal,
          allowPrivate: allowPrivateFetch,
        });
        return formatFetchResult(page, {
          sourceOffset,
          existingUrls,
          provider: 'local',
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (!fallbackDeepSeek || !apiKey) {
          throw new Error(`抓取网页失败（本地）：${err.message}`);
        }
        try {
          const out = await deepseekFetch({
            baseUrl,
            apiKey,
            url,
            signal,
            sourceOffset,
            existingUrls,
          });
          return {
            ...out,
            meta: { ...out.meta, fallbackFrom: 'local' },
          };
        } catch (fallbackErr) {
          throw new Error(
            `抓取网页失败（本地）：${err.message}；DeepSeek 回退也失败：${fallbackErr.message}`
          );
        }
      }
    }

    return deepseekFetch({
      baseUrl,
      apiKey,
      url,
      signal,
      sourceOffset,
      existingUrls,
    });
  }

  throw new Error(`未知工具：${name}`);
}
