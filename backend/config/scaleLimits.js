/**
 * Central limits for cost control, abuse prevention, and predictable scaling.
 * Tune via environment variables; defaults favor safety over max throughput.
 */

function int(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

module.exports = {
  /** POST /api/discover* — per authenticated user, rolling window */
  discoverRate: {
    windowMs: int('DISCOVER_RATE_WINDOW_MS', 15 * 60 * 1000),
    max: int('DISCOVER_RATE_MAX', 24)
  },

  /** Cap Serper HTTP calls inside one discovery request (search_query expansion) */
  serper: {
    maxCallsPerDiscoveryRequest: int('DISCOVER_MAX_SERPER_CALLS', 8),
    /** POST /api/discover/google — multi-query flow */
    maxCallsGoogleDiscovery: int('DISCOVER_GOOGLE_MAX_SERPER_CALLS', 12),
    timeoutMs: int('SERPER_TIMEOUT_MS', 20000),
    maxRetries: int('SERPER_MAX_RETRIES', 2)
  },

  gemini: {
    maxRetries: int('GEMINI_MAX_RETRIES', 3),
    retryBaseMs: int('GEMINI_RETRY_BASE_MS', 900)
  },

  worker: {
    shutdownGraceMs: int('WORKER_SHUTDOWN_GRACE_MS', 120000)
  }
};
