/**
 * DeepSeek Messages-compatible client. It uses the
 * /anthropic/v1/messages endpoint and the native server-side web_search tool,
 * so search, fetching and answer generation all happen on the server.
 */

import { messagesEndpoint } from './api.js';
import { hostOf, readErrorBody } from './http.js';

function textWithFiles(msg) {
  let text = msg.content || '';
  for (const file of msg.files || []) {
    if (!file?.text) continue;
    const name = String(file.name || 'file').replace(/[<>"]/g, '_');
    text += `\n\n<file name="${name}">\n${file.text}\n</file>`;
  }
  return text;
}

function imageBlock(dataUrl) {
  const match = String(dataUrl || '').match(
    /^data:(image\/(?:jpeg|png|gif|webp));base64,([\s\S]+)$/i
  );
  if (!match) return null;
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1].toLowerCase(),
      data: match[2],
    },
  };
}

function userContent(msg) {
  const text = textWithFiles(msg);
  const images = (msg.images || [])
    .map((img) => imageBlock(img?.dataUrl))
    .filter(Boolean);
  if (!images.length) return text;
  const parts = [];
  if (text.trim()) parts.push({ type: 'text', text });
  parts.push(...images);
  if (!parts.length) parts.push({ type: 'text', text: '请看这些图片。' });
  return parts;
}

export function buildAnthropicMessages(messages) {
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

function anthropicError(status, message) {
  if (status === 401) return 'API Key 无效或已过期';
  if (status === 402) return '账户余额不足';
  if (status === 429) return '请求过于频繁或达到速率限制';
  if (status >= 500) return `Messages 端点暂时不可用（${status}）`;
  return `Messages 端点请求失败（${status}）${message ? `：${message}` : ''}`;
}

function usageFrom(data) {
  return data?.usage || data?.message?.usage || null;
}

function mergeUsage(target, patch) {
  if (!patch) return target || null;
  return { ...(target || {}), ...patch };
}

function handleBlockStart(block, callbacks) {
  if (!block) return;
  if (block.type === 'text' && block.text) callbacks.onText?.(block.text);
  if (block.type === 'thinking' && block.thinking) {
    callbacks.onReasoning?.(block.thinking);
  }
  if (block.type === 'server_tool_use') {
    callbacks.onToolUse?.({
      id: block.id || '',
      name: block.name || 'web_search',
      input: block.input || {},
    });
  }
  if (block.type === 'web_search_tool_result') {
    callbacks.onToolResult?.({
      toolUseId: block.tool_use_id || '',
      results: Array.isArray(block.content) ? block.content : [],
    });
  }
}

function handleBlockDelta(delta, callbacks) {
  if (!delta) return;
  if (delta.type === 'text_delta' && delta.text) {
    callbacks.onText?.(delta.text);
  } else if (delta.type === 'thinking_delta' && delta.thinking) {
    callbacks.onReasoning?.(delta.thinking);
  }
}

/**
 * Stream one Messages-compatible turn. Returns {stopReason, usage}.
 * The server-side web_search tool is always declared; the model decides
 * whether to use it.
 */
export async function streamAnthropicTurn({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  thinking = true,
  effort = 'high',
  maxTokens = 8192,
  temperature = 1,
  searchCount = 5,
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
    max_tokens: maxTokens > 0 ? maxTokens : 8192,
    messages,
    stream: true,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: Math.max(2, Math.min(8, Number(searchCount) || 5)),
      },
    ],
  };
  if (system) body.system = system;
  if (thinking && effort) body.output_config = { effort };
  if (!thinking && Number.isFinite(temperature)) body.temperature = temperature;

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
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`连接 Messages 端点失败：${err.message || err}`);
  }

  if (!res.ok) {
    throw new Error(anthropicError(res.status, await readErrorBody(res)));
  }

  const contentType = res.headers.get('content-type') || '';

  // Non-stream JSON fallback (some gateways ignore stream:true).
  if (contentType.includes('application/json')) {
    const data = await res.json();
    if (data?.type === 'error' || data?.error) {
      throw new Error(data.error?.message || 'Messages 端点返回错误');
    }
    const usage = usageFrom(data);
    for (const block of data.content || []) {
      handleBlockStart(block, { onText, onReasoning, onToolUse, onToolResult });
    }
    onUsage?.(usage);
    const stopReason = data.stop_reason || 'end_turn';
    onFinish?.({ stopReason, usage });
    if (stopReason === 'tool_use' || stopReason === 'pause_turn') {
      throw new Error('Messages 端点返回了未完成的工具调用，请重试。');
    }
    return { stopReason, usage };
  }

  if (!res.body) throw new Error('Messages 端点没有返回内容。');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let stopReason = '';
  let done = false;
  const toolInputs = new Map();

  const handlePayload = (payload) => {
    if (!payload) return;
    if (payload.type === 'error') {
      throw new Error(payload.error?.message || 'Messages 流返回错误');
    }
    if (payload.type === 'message_start') {
      usage = mergeUsage(usage, usageFrom(payload));
      return;
    }
    if (payload.type === 'content_block_start') {
      const block = payload.content_block;
      if (block?.type === 'server_tool_use') {
        toolInputs.set(payload.index, {
          id: block.id || '',
          name: block.name || 'web_search',
          input: block.input && Object.keys(block.input).length
            ? JSON.stringify(block.input)
            : '',
          started: false,
        });
        if (toolInputs.get(payload.index).input) {
          const item = toolInputs.get(payload.index);
          let input = {};
          try {
            input = JSON.parse(item.input);
          } catch (_) {
            input = {};
          }
          onToolUse?.({ id: item.id, name: item.name, input });
          item.started = true;
        }
      } else {
        handleBlockStart(block, { onText, onReasoning, onToolUse, onToolResult });
      }
      return;
    }
    if (payload.type === 'content_block_delta') {
      const delta = payload.delta;
      if (delta?.type === 'input_json_delta' && payload.index != null) {
        const item = toolInputs.get(payload.index);
        if (item) item.input += delta.partial_json || '';
      } else {
        handleBlockDelta(delta, { onText, onReasoning });
      }
      return;
    }
    if (payload.type === 'content_block_stop') {
      const item = toolInputs.get(payload.index);
      if (item && !item.started) {
        let input = {};
        try {
          input = item.input ? JSON.parse(item.input) : {};
        } catch (_) {
          input = {};
        }
        onToolUse?.({ id: item.id, name: item.name, input });
        item.started = true;
      }
      return;
    }
    if (payload.type === 'message_delta') {
      usage = mergeUsage(usage, payload.usage || null);
      if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
      return;
    }
    if (payload.type === 'message_stop') {
      done = true;
    }
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
      if (!data || data === '[DONE]') continue;
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
    try {
      handlePayload(JSON.parse(data));
    } catch (_) {
      /* ignore trailing partial data */
    }
  }

  onUsage?.(usage);
  const finalStop = stopReason || 'end_turn';
  onFinish?.({ stopReason: finalStop, usage });
  if (finalStop === 'tool_use' || finalStop === 'pause_turn') {
    // Search runs server-side; a tool_use/pause_turn here means the endpoint
    // stopped before producing a final answer. Make it retryable.
    throw new Error('Messages 端点返回了未完成的工具调用，请重试。');
  }
  return { stopReason: finalStop, usage };
}

/**
 * One-shot server-side search used by the settings "test search" button.
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
  if (!apiKey) throw new Error('缺少 API Key，无法测试服务端搜索');

  const sources = [];
  const seen = new Set();
  let answer = '';
  let toolUses = 0;

  await streamAnthropicTurn({
    baseUrl,
    apiKey,
    model,
    system:
      '你是搜索助手。请调用 web_search 搜索用户问题，然后用中文给出简洁的要点总结。不要编造，不要重复大段原文。',
    messages: [
      {
        role: 'user',
        content: `请使用 web_search 搜索下面的问题，并给出简洁的要点总结：\n\n${textQuery}`,
      },
    ],
    maxTokens: 1200,
    thinking: false,
    searchCount: count,
    signal,
    onText: (text) => {
      answer += text;
    },
    onToolUse: () => {
      toolUses += 1;
    },
    onToolResult: ({ results }) => {
      for (const result of results || []) {
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
    },
  });

  if (!toolUses && !sources.length) throw new Error('Messages 端点没有执行 web_search');
  if (!sources.length && !answer.trim()) {
    throw new Error('Messages 端点搜索没有返回可用结果');
  }
  return { provider: 'messages', query: textQuery, sources };
}
