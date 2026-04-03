/**
 * Optional Redis (ioredis) for distributed rate limits. Set REDIS_URL in .env.
 */

const logger = require('../utils/logger');

let client = null;
let warned = false;

function getRedis() {
  const url = process.env.REDIS_URL && String(process.env.REDIS_URL).trim();
  if (!url) return null;
  if (client) return client;
  try {
    const Redis = require('ioredis');
    client = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: false
    });
    client.on('error', err => {
      logger.warn(`[redis] ${err.message}`);
    });
    logger.info('[redis] Connected for rate limiting');
    return client;
  } catch (e) {
    if (!warned) {
      logger.warn(`[redis] unavailable: ${e.message}`);
      warned = true;
    }
    return null;
  }
}

async function closeRedis() {
  if (client && typeof client.quit === 'function') {
    try {
      await client.quit();
    } catch (_) {}
    client = null;
  }
}

module.exports = { getRedis, closeRedis };
