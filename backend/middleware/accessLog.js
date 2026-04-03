const logger = require('../utils/logger');
const { observeHttpRequest } = require('../services/metricsRegistry');

/**
 * One-line access log with request id (structured when LOG_FORMAT=json).
 */
function accessLogMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = `${req.method} ${req.originalUrl || req.url} ${res.statusCode} ${ms}ms`;
    const rid = req.reqId || '';
    if (String(process.env.LOG_FORMAT || '').toLowerCase() === 'json') {
      logger.info(JSON.stringify({ msg: 'access', requestId: rid, method: req.method, path: req.originalUrl, status: res.statusCode, durationMs: ms }));
    } else {
      logger.info(`[${rid}] ${line}`);
    }
    try {
      const route = req.route && req.route.path ? String(req.route.path) : (req.path || 'other').split('?')[0];
      observeHttpRequest(req.method, res.statusCode, ms / 1000, route.slice(0, 80));
    } catch (_) {}
  });
  next();
}

module.exports = { accessLogMiddleware };
