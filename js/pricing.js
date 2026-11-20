/**
 * Rough DeepSeek API cost estimates in USD.
 *
 * Prices are per 1M tokens from the public Models & Pricing page
 * (checked 2026-11-20). Peak hours are 01:00-04:00 and 06:00-10:00 UTC,
 * Monday through Friday. Chinese public holidays are not modelled, so the
 * result is an estimate, not an invoice.
 */

const PRICES = {
  flash: {
    peak: { hit: 0.006, miss: 0.3, output: 1.2 },
    offPeak: { hit: 0.003, miss: 0.15, output: 0.6 },
  },
  pro: {
    peak: { hit: 0.044, miss: 1.32, output: 3.96 },
    offPeak: { hit: 0.022, miss: 0.66, output: 1.98 },
  },
};

function pricingForModel(model) {
  const name = String(model || '').trim().toLowerCase();
  if (!name.startsWith('deepseek')) return null;
  if (name.includes('pro')) return PRICES.pro;
  if (name.includes('flash') || name === 'deepseek-chat' || name === 'deepseek-reasoner') {
    return PRICES.flash;
  }
  return null;
}

function isDeepSeekHost(baseUrl) {
  if (!baseUrl) return true;
  const value = /^https?:\/\//i.test(String(baseUrl)) ? String(baseUrl) : `https://${baseUrl}`;
  try {
    return new URL(value).hostname.toLowerCase() === 'api.deepseek.com';
  } catch (_) {
    return false;
  }
}

export function isPeakTime(at = Date.now()) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Estimate one response's cost from Chat Completions usage fields.
 * Returns null when the model or endpoint is not one we can price.
 */
export function estimateCostUsd({ model, usage, at = Date.now(), baseUrl } = {}) {
  if (!usage || !isDeepSeekHost(baseUrl)) return null;
  const prices = pricingForModel(model);
  if (!prices) return null;

  const prompt = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  const hit =
    Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0;
  const miss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit)) || 0;
  if (!prompt && !output) return null;

  const rate = isPeakTime(at) ? prices.peak : prices.offPeak;
  return (hit * rate.hit + miss * rate.miss + output * rate.output) / 1_000_000;
}

export function formatCostUsd(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return '';
  if (cost < 0.000001) return '<$0.000001';
  const fixed = (cost >= 1 ? cost.toFixed(4) : cost.toFixed(6))
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  return `$${fixed}`;
}
