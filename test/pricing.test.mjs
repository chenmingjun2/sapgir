import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateCostUsd,
  formatCostUsd,
  isPeakTime,
} from '../js/pricing.js';

const usage = {
  prompt_tokens: 2_000_000,
  prompt_cache_hit_tokens: 1_000_000,
  prompt_cache_miss_tokens: 1_000_000,
  completion_tokens: 1_000_000,
};

test('peak hours follow UTC weekdays', () => {
  assert.equal(isPeakTime('2026-11-23T02:00:00Z'), true); // Monday 02:00 UTC
  assert.equal(isPeakTime('2026-11-23T05:00:00Z'), false); // Monday 05:00
  assert.equal(isPeakTime('2026-11-21T02:00:00Z'), false); // Saturday
});

test('estimates flash peak and off-peak cost', () => {
  const peak = estimateCostUsd({
    model: 'deepseek-flash',
    usage,
    at: '2026-11-23T02:00:00Z',
    baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(peak, 1.506); // 1M hit * 0.006 + 1M miss * 0.3 + 1M out * 1.2

  const offPeak = estimateCostUsd({
    model: 'deepseek-flash',
    usage,
    at: '2026-11-21T02:00:00Z',
    baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(offPeak, 0.753); // 1M hit * 0.003 + 1M miss * 0.15 + 1M out * 0.6
});

test('estimates pro cost and legacy flash aliases', () => {
  const pro = estimateCostUsd({
    model: 'deepseek-v4-pro',
    usage,
    at: '2026-11-21T02:00:00Z',
    baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(pro, 2.662); // 0.022 + 0.66 + 1.98

  const legacy = estimateCostUsd({
    model: 'deepseek-chat',
    usage,
    at: '2026-11-21T02:00:00Z',
    baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(legacy, 0.753);

  const bareHost = estimateCostUsd({
    model: 'deepseek-flash',
    usage,
    at: '2026-11-21T02:00:00Z',
    baseUrl: 'api.deepseek.com',
  });
  assert.equal(bareHost, 0.753);
});

test('does not price unknown models or third-party gateways', () => {
  assert.equal(
    estimateCostUsd({ model: 'my-model', usage, baseUrl: 'https://api.deepseek.com' }),
    null
  );
  assert.equal(
    estimateCostUsd({ model: 'deepseek-flash', usage, baseUrl: 'https://gateway.example' }),
    null
  );
});

test('formats small costs', () => {
  assert.equal(formatCostUsd(0.0042), '$0.0042');
  assert.equal(formatCostUsd(0.000012), '$0.000012');
  assert.equal(formatCostUsd(0), '');
  assert.equal(formatCostUsd(null), '');
});
