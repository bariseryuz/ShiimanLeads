/**
 * Shared retry/backoff for Gemini and other external APIs (429, transient overload).
 */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isRetryableGeminiError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|quota|rate|temporar/i.test(msg);
}

function isRateLimitError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /429|RESOURCE_EXHAUSTED|rate limit|resource exhausted/i.test(msg);
}

/**
 * Best-effort parse of server-provided retry hints.
 * The @google/generative-ai SDK error shape isn't stable, so we look for common fields.
 * @returns {number|null}
 */
function getRetryAfterMs(err) {
  try {
    const direct = err?.retryAfterMs ?? err?.retry_after_ms ?? err?.retryAfter ?? null;
    if (Number.isFinite(Number(direct)) && Number(direct) > 0) return Number(direct);

    const hdr =
      err?.response?.headers?.['retry-after'] ??
      err?.response?.headers?.['Retry-After'] ??
      err?.headers?.['retry-after'] ??
      err?.headers?.['Retry-After'];
    if (hdr) {
      const sec = parseFloat(String(hdr));
      if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, baseMs?: number, maxDelayMs?: number, jitterMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  const baseMs = opts.baseMs != null ? opts.baseMs : 900;
  const maxDelayMs = opts.maxDelayMs != null ? opts.maxDelayMs : 20000;
  const jitterMs = opts.jitterMs != null ? opts.jitterMs : 250;
  let last;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === maxRetries || !isRetryableGeminiError(e)) throw e;
      const hinted = getRetryAfterMs(e);
      const exp = baseMs * Math.pow(2, i);
      const extra = isRateLimitError(e) ? 500 * i : 0;
      const jitter = Math.floor(Math.random() * jitterMs);
      const delay = Math.min(maxDelayMs, Math.max(0, (hinted != null ? hinted : exp) + extra + jitter));
      await sleep(delay);
    }
  }
  throw last;
}

module.exports = { retryWithBackoff, sleep, isRetryableGeminiError, isRateLimitError, getRetryAfterMs };
