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

/**
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, baseMs?: number }} [opts]
 * @returns {Promise<T>}
 */
async function retryWithBackoff(fn, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
  const baseMs = opts.baseMs != null ? opts.baseMs : 900;
  let last;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === maxRetries || !isRetryableGeminiError(e)) throw e;
      await sleep(baseMs * Math.pow(2, i));
    }
  }
  throw last;
}

module.exports = { retryWithBackoff, sleep, isRetryableGeminiError };
