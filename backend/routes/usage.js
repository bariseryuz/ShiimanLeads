const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getUsageSnapshot } = require('../services/usageMeter');

router.get('/', requireAuth, async (req, res) => {
  try {
    const snap = await getUsageSnapshot(req.session.user.id);
    res.json({ success: true, ...snap });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
