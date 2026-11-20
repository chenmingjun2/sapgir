/**
 * Chat Completions endpoint utilities: base URL normalization, model discovery,
 * and the session system prompt. The streaming client lives in chat.js.
 */

import { DEFAULT_SYSTEM_PROMPT, DEFAULT_SETTINGS } from './storage.js';
import { readErrorBody, withTimeout } from './http.js';

export function normalizeBase(input) {
  let base = String(input || '').trim() || DEFAULT_SETTINGS.baseUrl;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/messages$/i, '');
  // Accept the old Anthropic-style base as well, e.g.
  // https://api.deepseek.com/anthropic/v1 -> https://api.deepseek.com
  base = base.replace(/\/anthropic(?:\/v1)?$/i, '');
  return base;
}

export function chatEndpoint(baseUrl) {
  return `${normalizeBase(baseUrl)}/chat/completions`;
}

function friendlyError(status, serverMessage) {
  const detail = serverMessage ? `：${serverMessage}` : '';
  if (status === 400) return `请求参数有误${detail}`;
  if (status === 401) return 'API Key 无效或已过期，请在设置中检查。';
  if (status === 402) return '账户余额不足，请前往服务提供方控制台充值。';
  if (status === 403) return `请求被拒绝${detail}`;
  if (status === 404) return `接口不存在（404），请检查 Base URL 是否正确${detail}`;
  if (status === 413) return '请求体过大，请减少图片数量或换用更小的图片。';
  if (status === 429) return '请求过于频繁，或已达到速率限制，请稍后重试。';
  if (status >= 500) return `服务暂时不可用（${status}），请稍后重试。`;
  return `请求失败（${status}）${detail}`;
}

export async function listModels({ baseUrl, apiKey, signal }) {
  if (!apiKey) throw new Error('请先填写 API Key');
  let res;
  try {
    res = await fetch(`${normalizeBase(baseUrl)}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: withTimeout(signal, 20000),
    });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error('连接超时，请检查网络或 Base URL。');
    }
    throw new Error(`网络连接失败：${err?.message || err}`);
  }
  if (!res.ok) throw new Error(friendlyError(res.status, await readErrorBody(res)));
  const data = await res.json();
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

/**
 * Build a session-stable system message. It is snapshotted on the conversation
 * so the prefix sent to the API does not change from turn to turn (context
 * caching is prefix-based).
 *
 * Keep this text free of dates and other per-turn values. The current date is
 * added to the latest user message by app.js instead, so changing it only
 * affects the tail of the request.
 */
export function buildSessionSystemMessage(settings) {
  const base = (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();

  const searchRule = `如果本轮请求提供了 deepseek_web_search 工具，需要实时或可核实的信息时可以使用它；搜索结果由服务端返回，不要编造。没有提供该工具时，不要声称已经搜索、不要编造搜索结果或链接。`;

  return {
    role: 'system',
    content: `${base}\n\n${searchRule}`,
  };
}
