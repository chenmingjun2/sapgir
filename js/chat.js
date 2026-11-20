/**
 * Chat Completions client.
 *
 * Uses POST {baseUrl}/chat/completions with the native server-side
 * `deepseek_web_search` tool, thinking mode and reasoning_effort. Search,
 * page opening and answer generation all happen on the server.
 */

import { chatEndpoint } from './api.js';
import { hostOf, readErrorBody, withTimeout } from './http.js';

function textWithFiles(msg) {
  let text = msg.content || '';
  for (const file of msg.files || []) {
    if (!file?.text) continue;
    const name = String(file.name || 'file').replace(/[<>"]/g, '_');
    text += `\n\n<file name="${name}">\n${file.text}\n</file>`;
  }
  return text;
}

function imagePart(dataUrl) {
  const url = String(dataUrl || '');
  if (!/^data:image\/(?:jpeg|png|gif|webp);base64,/i.test(url)) return null;
  return { type: 'image_url', image_url: { url } };
}

function userContent(msg) {
  const text = textWithFiles(msg);
  const images = (msg.images || []).map((img) => imagePart(img?.dataUrl)).filter(Boolean);
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  parts.push(...images);
  if (!parts.length) parts.push({ type: 'text', text: '请看这些图片。' });
  return parts;
}

/**
 * Convert the app's stored messages into Chat Completions messages.
 * System is prepended by streamChatTurn, so it is not included here.
 */
export function buildChatMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (msg.role === 'user') {
      const content = userContent(msg);
      if (typeof content === 'string' && !content.trim()) continue;
      out.push({ role: 'user', content });
      continue;
    }
    if (msg.role === 'assistant') {
      const text =
        typeof msg.apiFinalContent === 'string'
          ? msg.apiFinalContent
          : typeof msg.content === 'string'
            ? msg.content
            : '';
      if (!text.trim()) continue;
      out.push({ role: 'assistant', content: text });
    }
  }
  return out;
}

function chatError(status, message) {
  if (status === 401) return 'API Key 无效或已过期';
  if (status === 402) return '账户余额不足';
  if (status === 429) return '请求过于频繁或达到速率限制';
  if (status >= 500) return `Chat Completions 端点暂时不可用（${status}）`;
  return `Chat Completions 端点请求失败（${status}）${message ? `：${message}` : ''}`;
}

function normalizeEffort(effort) {
  return ['low', 'high', 'max'].includes(effort) ? effort : 'high';
}

function apiError(payload) {
  return new Error(
    payload?.error?.message || payload?.message || 'Chat Completions 端点返回错误'
  );
}

/** Normalize a `server_tool_calls` entry or a streamed `call` object. */
function toolCallPayload(call) {
  if (!call) return null;
  const input = call.action || call.input || {};
  return {
    id: call.id || '',
    name: call.type || call.name || 'deepseek_web_search',
    input,
    status: call.status || '',
    error: call.error || null,
    sources: Array.isArray(call.sources) ? call.sources : [],
  };
}

function annotationsOf(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => item?.url_citation || item)
    .filter((item) => item && item.url);
}

function collectFinalCalls(serverToolCalls, callbacks) {
  for (const step of serverToolCalls || []) {
    for (const raw of step?.calls || []) {
      const call = toolCallPayload(raw);
      if (!call?.id) continue;
      callbacks.onToolUse?.({
        id: call.id,
        name: call.name,
        input: call.input,
        step: step.index,
      });
      callbacks.onToolResult?.({
        toolUseId: call.id,
        call,
        results: call.sources,
        error: call.error,
      });
    }
  }
}

/**
 * Stream one Chat Completions turn. Returns {stopReason, usage, annotations}.
 *
 * `thinking` is always enabled in this app: the UI's "off" state means
 * reasoning_effort=low, and "on" means reasoning_effort=max.
 */
export async function streamChatTurn({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  thinking = true,
  effort = 'high',
  maxTokens = 8192,
  webSearch = true,
  signal,
  onText,
  onReasoning,
  onToolUse,
  onToolResult,
  onUsage,
  onFinish,
} = {}) {
  if (!apiKey) throw new Error('请先在设置中填写 API Key。');
  if (!model) throw new Error('请先选择模型。');

  const body = {
    model,
    messages: system
      ? [{ role: 'system', content: system }, ...(messages || [])]
      : messages || [],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens > 0 ? maxTokens : 8192,
  };

  body.thinking = { type: thinking ? 'enabled' : 'disabled' };
  if (thinking) body.reasoning_effort = normalizeEffort(effort);

  if (webSearch) {
    // The model decides whether to search, what to query and whether to open
    // pages. No client-side tool execution is needed.
    body.tools = [{ type: 'deepseek_web_search' }];
  }

  let res;
  try {
    res = await fetch(chatEndpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: withTimeout(signal, 180000),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`连接 Chat Completions 端点失败：${err.message || err}`);
  }

  if (!res.ok) {
    throw new Error(chatError(res.status, await readErrorBody(res)));
  }

  const contentType = res.headers.get('content-type') || '';

  // Non-stream JSON fallback (some gateways ignore stream:true).
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data?.error) throw apiError(data);
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    if (message.reasoning_content) onReasoning?.(message.reasoning_content);
    if (message.content) onText?.(message.content);
    const usage = data?.usage || null;
    const stopReason = choice?.finish_reason || 'stop';
    const annotations = annotationsOf(message.annotations);
    collectFinalCalls(message.server_tool_calls, { onToolUse, onToolResult });
    onUsage?.(usage);
    onFinish?.({ stopReason, usage, annotations, serverToolCalls: message.server_tool_calls });
    return { stopReason, usage, annotations };
  }

  if (!res.body) throw new Error('Chat Completions 端点没有返回内容。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let stopReason = '';
  let annotations = [];
  let done = false;

  const handlePayload = (payload) => {
    if (!payload) return;
    if (payload.error) throw apiError(payload);

    if (payload.usage && typeof payload.usage === 'object') usage = payload.usage;

    const choice = payload.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (delta.reasoning_content) onReasoning?.(delta.reasoning_content);
    if (delta.content) onText?.(delta.content);

    const event = choice.server_tool_event;
    if (event?.type === 'call_started' && event.call) {
      const call = toolCallPayload(event.call);
      if (call?.id) {
        onToolUse?.({
          id: call.id,
          name: call.name,
          input: call.input,
          step: event.step,
        });
      }
    } else if (event?.type === 'call_completed' && event.call) {
      const call = toolCallPayload(event.call);
      if (call?.id) {
        onToolResult?.({
          toolUseId: call.id,
          call,
          results: call.sources,
          error: call.error,
        });
      }
    }

    // The last chunk carries the complete tool calls and citations.
    if (Array.isArray(delta.server_tool_calls)) {
      collectFinalCalls(delta.server_tool_calls, { onToolUse, onToolResult });
    }
    if (Array.isArray(delta.annotations)) {
      annotations = annotations.concat(annotationsOf(delta.annotations));
    }
    if (Array.isArray(choice.message?.server_tool_calls)) {
      collectFinalCalls(choice.message.server_tool_calls, { onToolUse, onToolResult });
    }
    if (Array.isArray(choice.message?.annotations)) {
      annotations = annotations.concat(annotationsOf(choice.message.annotations));
    }

    if (choice.finish_reason) stopReason = choice.finish_reason;
  };

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (readerDone) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') {
        done = true;
        break;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch (_) {
        continue;
      }
      handlePayload(payload);
      if (done) break;
    }
  }

  buffer += decoder.decode();
  if (!done && buffer.trim().startsWith('data:')) {
    const data = buffer.trim().slice(5).trim();
    if (data && data !== '[DONE]') {
      try {
        handlePayload(JSON.parse(data));
      } catch (_) {
        /* ignore trailing partial data */
      }
    }
  }

  onUsage?.(usage);
  const finalStop = stopReason || 'stop';
  onFinish?.({ stopReason: finalStop, usage, annotations });
  return { stopReason: finalStop, usage, annotations };
}

/**
 * One-shot server-side search used by the settings "test search" button.
 */
export async function searchWeb({
  baseUrl,
  apiKey,
  model = 'deepseek-flash',
  query,
  signal,
} = {}) {
  const textQuery = String(query || '').trim();
  if (!textQuery) throw new Error('搜索关键词为空');
  if (!apiKey) throw new Error('缺少 API Key，无法测试服务端搜索');

  const sources = [];
  const seen = new Set();
  let answer = '';
  let toolUses = 0;

  const pushSource = (result) => {
    const url = result?.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({
      title: result.title || url,
      url,
      site: result.site_name || hostOf(url),
      date: result.published_at || result.page_age || '',
      snippet: result.snippet || '',
      summary: '',
    });
  };

  const result = await streamChatTurn({
    baseUrl,
    apiKey,
    model,
    system:
      '你是搜索助手。请调用 deepseek_web_search 搜索用户问题，然后用中文给出简洁的要点总结。不要编造，不要重复大段原文。',
    messages: [
      {
        role: 'user',
        content: `请使用 deepseek_web_search 搜索下面的问题，并给出简洁的要点总结：\n\n${textQuery}`,
      },
    ],
    maxTokens: 1200,
    thinking: false,
    webSearch: true,
    signal,
    onText: (text) => {
      answer += text;
    },
    onToolUse: () => {
      toolUses += 1;
    },
    onToolResult: ({ results }) => {
      for (const item of results || []) pushSource(item);
    },
    onFinish: ({ annotations }) => {
      for (const item of annotations || []) pushSource(item);
    },
  });

  if (!toolUses && !sources.length) {
    throw new Error('Chat Completions 端点没有执行 deepseek_web_search');
  }
  if (!sources.length && !answer.trim()) {
    throw new Error('Chat Completions 端点搜索没有返回可用结果');
  }
  return { provider: 'chat', query: textQuery, sources };
}
