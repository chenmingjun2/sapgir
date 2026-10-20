/**
 * Small shared HTTP helpers used by the API client and the UI.
 */

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

/** Combine a caller's abort signal with a timeout, when supported. */
export function withTimeout(signal, ms = 60000) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    const timeout = AbortSignal.timeout(ms);
    if (typeof AbortSignal.any === 'function' && signal) {
      return AbortSignal.any([signal, timeout]);
    }
    return timeout;
  }
  return signal;
}

/** Read a provider error body and return its most useful message. */
export async function readErrorBody(res) {
  let raw = '';
  try {
    raw = await res.text();
  } catch (_) {
    return '';
  }
  try {
    const data = JSON.parse(raw);
    return (
      data?.error?.message ||
      data?.error?.detail ||
      data?.message ||
      data?.detail ||
      raw.slice(0, 300)
    );
  } catch (_) {
    return raw.slice(0, 300);
  }
}
