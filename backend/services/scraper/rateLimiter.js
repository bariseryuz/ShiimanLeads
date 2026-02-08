const logger = require('../../utils/logger');

// === RATE LIMITING ===

/**
 * Simple rate limiter with exponential backoff
 */
class RateLimiter {
  constructor(requestsPerMinute = 10) {
    this.requestsPerMinute = requestsPerMinute;
    this.minDelay = Math.floor(60000 / requestsPerMinute); // ms between requests
    this.lastRequest = 0;
    this.backoffMultiplier = 1;
    this.maxBackoff = 8; // Max 8x slowdown
  }

  async waitIfNeeded() {
    const now = Date.now();
    const elapsed = now - this.lastRequest;
    const requiredDelay = this.minDelay * this.backoffMultiplier;
    
    if (elapsed < requiredDelay) {
      const wait = requiredDelay - elapsed;
      logger.info(`⏳ Rate limiting: waiting ${Math.round(wait / 1000)}s (backoff: ${this.backoffMultiplier}x)`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    
    this.lastRequest = Date.now();
  }

  onError() {
    // Exponential backoff on errors (rate limiting detected)
    this.backoffMultiplier = Math.min(this.backoffMultiplier * 2, this.maxBackoff);
    logger.warn(`⚠️ Rate limit detected - increasing backoff to ${this.backoffMultiplier}x`);
  }

  onSuccess() {
    // Gradually reduce backoff on successful requests
    if (this.backoffMultiplier > 1) {
      this.backoffMultiplier = Math.max(this.backoffMultiplier * 0.8, 1);
    }
  }
}

// Store rate limiters per source
const rateLimiters = new Map();

/**
 * Get or create rate limiter for a source
 * @param {Object} source - Source configuration
 * @returns {RateLimiter}
 */
function getRateLimiter(source) {
  if (!rateLimiters.has(source.name)) {
    const rpm = source.requestsPerMinute || 10; // Default 10 requests per minute
    rateLimiters.set(source.name, new RateLimiter(rpm));
  }
  return rateLimiters.get(source.name);
}

module.exports = {
  RateLimiter,
  getRateLimiter
};
