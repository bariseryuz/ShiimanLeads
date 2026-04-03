/**
 * Prometheus metrics — protect with METRICS_BEARER_TOKEN in production.
 */
const express = require('express');
const logger = require('../utils/logger');
const { register } = require('../services/metricsRegistry');

const router = express.Router();

function metricsAuth(req, res, next) {
  const token = process.env.METRICS_BEARER_TOKEN && String(process.env.METRICS_BEARER_TOKEN).trim();
  if (!token) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(404).send('Not found');
    }
    return next();
  }
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m ? m[1].trim() : '';
  if (got !== token) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

router.get('/metrics', metricsAuth, async (req, res) => {
  try {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (e) {
    logger.error(`metrics: ${e.message}`);
    res.status(500).end(e.message);
  }
});

module.exports = { router, register };
