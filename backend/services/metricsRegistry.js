/**
 * Shared Prometheus registry + HTTP counters (used by routes/metrics + accessLog).
 */
const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'shiiman_node_' });

const httpRequests = new client.Counter({
  name: 'shiiman_http_requests_total',
  help: 'HTTP requests by method and status',
  labelNames: ['method', 'status'],
  registers: [register]
});

const httpDuration = new client.Histogram({
  name: 'shiiman_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register]
});

function observeHttpRequest(method, status, durationSec, routeLabel) {
  try {
    const s = String(status);
    httpRequests.inc({ method: method || 'GET', status: s });
    httpDuration.observe({ method: method || 'GET', route: routeLabel || 'other' }, durationSec);
  } catch (_) {}
}

module.exports = {
  register,
  httpRequests,
  httpDuration,
  observeHttpRequest
};
