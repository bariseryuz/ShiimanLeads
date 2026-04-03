/**
 * Liveness and readiness for orchestrators (Railway, K8s, load balancers).
 */
const express = require('express');
const path = require('path');
const { dbGet } = require('../db');
const logger = require('../utils/logger');

const router = express.Router();

let startTime = Date.now();
let serviceVersion = '1.0.0';
try {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  serviceVersion = pkg.version || '1.0.0';
} catch {
  /* keep default */
}

router.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'shiiman-leads',
    version: serviceVersion,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString()
  });
});

router.get('/health/ready', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await dbGet('SELECT 1 AS ok');
    res.json({
      ready: true,
      db: 'ok',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    logger.error(`[health/ready] ${e.message}`);
    res.status(503).json({
      ready: false,
      db: 'error',
      error: e.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
