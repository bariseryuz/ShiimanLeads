const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { SCREENSHOT_DIR } = require('../config/paths');

router.get('/tiles-debug/:filename', requireAuth, (req, res) => {
  const filepath = path.join(SCREENSHOT_DIR, 'tiles-debug', path.basename(req.params.filename));
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

router.get('/source/:sourceId', requireAuth, async (req, res) => {
  const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
  if (!fs.existsSync(debugDir)) return res.json({ screenshots: [] });
  
  const files = fs.readdirSync(debugDir)
    .filter(f => f.endsWith('.png'))
    .map(f => ({
      filename: f,
      url: `/api/screenshots/tiles-debug/${f}`,
      created: fs.statSync(path.join(debugDir, f)).mtime
    }))
    .sort((a, b) => b.created - a.created);

  res.json({ screenshots: files });
});

module.exports = router;