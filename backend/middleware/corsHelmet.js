const cors = require('cors');
const helmet = require('helmet');
const { getCorsOrigins } = require('../config/security');

function corsMiddleware() {
  const origins = getCorsOrigins();
  const allowAll = origins.includes('*');
  return cors({
    origin(origin, cb) {
      if (allowAll) return cb(null, true);
      if (!origin) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: !allowAll,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-API-Key', 'X-CSRF-Token'],
    maxAge: 86400
  });
}

/** Helmet with CSP relaxed for same-origin SPA + inline scripts in legacy HTML */
function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
  });
}

module.exports = { corsMiddleware, helmetMiddleware };
