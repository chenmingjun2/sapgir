/**
 * DeepSeek endpoint utilities: base URL normalization, model discovery, and
 * the session system prompt. The Messages client lives in anthropic.js.
 */

import { DEFAULT_SYSTEM_PROMPT, DEFAULT_SETTINGS } from './storage.js';
import { readErrorBody, withTimeout } from './http.js';

export function normalizeBase(input) {
  let base = String(input || '').trim() || DEFAULT_SETTINGS.baseUrl;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  base = base.replace(/\/messages$/i, '');
  // Accept the Anthropic-style base as well, e.g.
  // https://api.deepseek.com/anthropic/v1 -> https://api.deepseek.com
  base = base.replace(/\/anthropic(?:\/v1)?$/i, '');
  return base;
}

export function messagesEndpoint(baseUrl) {
  const base = normalizeBase(baseUrl).replace(/\/v1$/i, '');
  return `${base}/anthropic/v1/messages`;
}

function endpoint(baseUrl, path) {
  return normalizeBase(baseUrl) + path;
}

function friendlyError(status, serverMessage) {
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

export async function listModels({ baseUrl, apiKey, signal }) {
  if (!apiKey) throw new Error('请先填写 API Key');
  let res;
  try {
    res = await fetch(endpoint(baseUrl, '/models'), {
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
 * so the prefix sent to the API does not change from turn to turn (DeepSeek
 * context caching is prefix-based).
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

本轮请求已提供服务端联网工具：
- web_search：由 DeepSeek 服务端执行的网页搜索，搜索和正文抓取都在服务端完成，结果会直接进入你的上下文。
使用原则：需要实时或可核实的信息时可以使用搜索；不要编造搜索结果。搜索结果已经带有全局编号 [n]，引用时可以直接使用 [n]；也可以使用 Markdown 链接 [标题](URL) 的形式，并在正文中自然标注出处。对于 coding、数学、翻译、写作、常识解释，或上下文已经足够回答的追问，不要为了搜索而搜索。`;

  return { role: 'system', content: base + extra };
}
