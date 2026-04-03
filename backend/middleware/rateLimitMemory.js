const logger = require('../utils/logger');

/**
 * Fixed-window rate limiter — in-memory, or Redis when `opts.redis` is an ioredis client.
 * For multi-instance horizontal scale, set REDIS_URL so discover/API limits are shared.
 *
 * @param {{ windowMs: number, max: number, keyFn: (req: import('express').Request) => string, name?: string, redis?: import('ioredis').default }} opts
 */
function createRateLimiter(opts) {
  const windowMs = Math.max(1000, opts.windowMs || 60000);
  const max = Math.max(1, opts.max || 60);
  const keyFn = opts.keyFn || (req => req.ip || 'unknown');
  const name = opts.name || 'rl';
  const redis = opts.redis;

  if (redis) {
    return async function rateLimiterRedis(req, res, next) {
      try {
        const key = `rl:${name}:${keyFn(req)}`;
        const n = await redis.incr(key);
        if (n === 1) await redis.pexpire(key, windowMs);
        const remaining = Math.max(0, max - n);
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(remaining));
        res.setHeader('X-RateLimit-Backend', 'redis');
        if (n > max) {
          const ttl = await redis.pttl(key);
          const retrySec = Math.max(1, Math.ceil(ttl / 1000));
          res.setHeader('Retry-After', String(retrySec));
          logger.warn(`[${name}] 429 redis key=${key.slice(0, 100)} reqId=${req.reqId || ''}`);
          return res.status(429).json({
            error: 'Too many requests for this action. Please wait and try again.',
            code: 'RATE_LIMIT'
          });
        }
        next();
      } catch (e) {
        logger.warn(`[${name}] Redis rate limit fallback: ${e.message}`);
        next();
      }
    };
  }

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
    res.setHeader('X-RateLimit-Backend', 'memory');
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
