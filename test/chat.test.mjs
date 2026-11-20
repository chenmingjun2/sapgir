import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatMessages, searchWeb, streamChatTurn } from '../js/chat.js';

function sseResponse(events) {
  return new Response(events.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function searchStream() {
  return sseResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"server_tool_event":{"type":"call_started","step":0,"call":{"id":"s1","type":"deepseek_web_search","kind":"search","action":{"type":"search","queries":["test"]}}}}]}',
    'data: {"choices":[{"index":0,"delta":{},"server_tool_event":{"type":"call_completed","step":0,"call":{"id":"s1","type":"deepseek_web_search","status":"completed","sources":[{"url":"https://example.com/a","title":"Example A","site_name":"example.com"}]}}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"hello","server_tool_calls":[{"index":0,"calls":[{"id":"s1","type":"deepseek_web_search","status":"completed","action":{"type":"search","queries":["test"]},"sources":[{"url":"https://example.com/a","title":"Example A","site_name":"example.com"}]}]}],"annotations":[{"type":"url_citation","url_citation":{"url":"https://example.com/a","title":"Example A"}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    'data: [DONE]',
    '',
  ]);
}

test('streamChatTurn parses reasoning, server search, citations and usage', async () => {
  globalThis.fetch = async () => searchStream();
  const text = [];
  const reasoning = [];
  const toolUses = [];
  const toolResults = [];
  let usage = null;
  let finish = null;

  const result = await streamChatTurn({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: true,
    effort: 'max',
    webSearch: true,
    onText: (value) => text.push(value),
    onReasoning: (value) => reasoning.push(value),
    onToolUse: (tool) => toolUses.push(tool),
    onToolResult: (data) => toolResults.push(data),
    onUsage: (value) => {
      usage = value;
    },
    onFinish: (value) => {
      finish = value;
    },
  });

  assert.equal(result.stopReason, 'stop');
  assert.equal(reasoning.join(''), 'thinking');
  assert.equal(text.join(''), 'hello');
  assert.ok(toolUses.length >= 1);
  assert.deepEqual(toolUses[0].input, { type: 'search', queries: ['test'] });
  assert.ok(toolResults.length >= 1);
  assert.equal(toolResults[0].results[0].url, 'https://example.com/a');
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(finish.stopReason, 'stop');
  assert.equal(finish.annotations[0].url, 'https://example.com/a');
});

test('streamChatTurn sends Chat Completions body with the right flags', async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), headers: init.headers };
    return searchStream();
  };

  await streamChatTurn({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: true,
    effort: 'low',
    webSearch: false,
  });

  assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(captured.body.thinking, { type: 'enabled' });
  assert.equal(captured.body.reasoning_effort, 'low');
  assert.equal(captured.body.tools, undefined);
  assert.deepEqual(captured.body.messages[0], { role: 'system', content: 'system prompt' });
});

test('searchWeb returns sources from server tool calls', async () => {
  globalThis.fetch = async () => searchStream();
  const out = await searchWeb({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    query: 'test query',
  });
  assert.equal(out.provider, 'chat');
  assert.equal(out.query, 'test query');
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].title, 'Example A');
  assert.equal(out.sources[0].site, 'example.com');
});

test('streamChatTurn maps HTTP errors', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    streamChatTurn({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'bad',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /API Key 无效/
  );
});

test('buildChatMessages converts images to image_url parts', () => {
  const out = buildChatMessages([
    {
      role: 'user',
      content: 'look',
      images: [{ dataUrl: 'data:image/png;base64,AAAA' }],
      files: [{ name: 'a.txt', text: 'file body' }],
    },
    { role: 'assistant', content: 'ok' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].content[0].type, 'text');
  assert.match(out[0].content[0].text, /file body/);
  assert.equal(out[0].content[1].type, 'image_url');
  assert.equal(out[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
  assert.deepEqual(out[1], { role: 'assistant', content: 'ok' });
});
