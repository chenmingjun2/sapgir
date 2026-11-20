import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionSystemMessage } from '../js/api.js';

test('system message is stable and free of per-turn date text', () => {
  const first = buildSessionSystemMessage({ systemPrompt: '稳定提示词' }).content;
  const second = buildSessionSystemMessage({ systemPrompt: '稳定提示词' }).content;

  assert.equal(first, second);
  assert.match(first, /^稳定提示词/);
  assert.equal(first.includes('当前日期'), false);
  assert.match(first, /deepseek_web_search/);
});
