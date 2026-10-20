import test from 'node:test';
import assert from 'node:assert/strict';

import { messagesSearch, streamAnthropicTurn } from '../js/anthropic.js';

function sseResponse(events) {
  return new Response(events.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function searchStream() {
  return sseResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"s1","name":"web_search","input":{"query":"test"}}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"s1","content":[{"type":"web_search_result","url":"https://example.com/a","title":"Example A","page_age":"2026-10-20"}]}}',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"hello"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
    'data: {"type":"message_stop"}',
    '',
  ]);
}

test('streamAnthropicTurn parses native search and text', async () => {
  globalThis.fetch = async () => searchStream();
  const text = [];
  const toolUses = [];
  const toolResults = [];
  let usage = null;
  let finish = null;

  const result = await streamAnthropicTurn({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'hi' }],
    thinking: false,
    onText: (value) => text.push(value),
    onToolUse: (tool) => toolUses.push(tool),
    onToolResult: (data) => toolResults.push(data),
    onUsage: (value) => {
      usage = value;
    },
    onFinish: (value) => {
      finish = value;
    },
  });

  assert.equal(result.stopReason, 'end_turn');
  assert.equal(text.join(''), 'hello');
  assert.equal(toolUses.length, 1);
  assert.deepEqual(toolUses[0].input, { query: 'test' });
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].results[0].url, 'https://example.com/a');
  assert.deepEqual(usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(finish.stopReason, 'end_turn');
});

test('messagesSearch returns sources from web_search_tool_result', async () => {
  globalThis.fetch = async () => searchStream();
  const out = await messagesSearch({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    query: 'test query',
    count: 3,
  });
  assert.equal(out.provider, 'messages');
  assert.equal(out.query, 'test query');
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].title, 'Example A');
  assert.equal(out.sources[0].site, 'example.com');
});

test('streamAnthropicTurn maps HTTP errors', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  await assert.rejects(
    streamAnthropicTurn({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'bad',
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    /API Key 无效/
  );
});
