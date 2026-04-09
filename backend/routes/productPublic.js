/**
 * GET /api/product — Public product facts for sales, security reviews, and integrations (no auth).
 */

const express = require('express');
const router = express.Router();
const { getProductIdentity } = require('../config/productIdentity');

router.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    ok: true,
    ...getProductIdentity()
  });
});

module.exports = router;
