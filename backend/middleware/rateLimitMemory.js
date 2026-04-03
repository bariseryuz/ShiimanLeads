const logger = require('../utils/logger');

/**
 * Fixed-window in-memory rate limiter (per Node process).
 * For multi-instance horizontal scale, replace with Redis-backed limiter.
 *
 * @param {{ windowMs: number, max: number, keyFn: (req: import('express').Request) => string, name?: string }} opts
 */
function createRateLimiter(opts) {
  const windowMs = Math.max(1000, opts.windowMs || 60000);
  const max = Math.max(1, opts.max || 60);
  const keyFn = opts.keyFn || (req => req.ip || 'unknown');
  const name = opts.name || 'rl';

  const store = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of store) {
      if (now - b.start > windowMs) store.delete(k);
    }
  }, 60000).unref();

  return function rateLimiter(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let b = store.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      store.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, max - b.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      const retrySec = Math.ceil((windowMs - (now - b.start)) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retrySec)));
      logger.warn(`[${name}] 429 key=${key.slice(0, 80)} reqId=${req.reqId || ''}`);
      return res.status(429).json({
        error: 'Too many requests for this action. Please wait and try again.',
        code: 'RATE_LIMIT'
      });
    }
    next();
  };
}

module.exports = { createRateLimiter };
