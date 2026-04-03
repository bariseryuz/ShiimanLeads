const crypto = require('crypto');

/**
 * Propagate or generate X-Request-Id for log correlation (load balancers often set this).
 */
function requestIdMiddleware(req, res, next) {
  const incoming = req.get('x-request-id') || req.get('x-correlation-id');
  const id =
    incoming && String(incoming).trim().slice(0, 128) ? String(incoming).trim().slice(0, 128) : crypto.randomUUID();
  req.reqId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = { requestIdMiddleware };
