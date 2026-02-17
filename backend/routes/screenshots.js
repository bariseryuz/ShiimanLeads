const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { dbAll, dbGet } = require('../db');
const { SCREENSHOT_DIR } = require('../config/paths');

function toSourceSlug(name) {
  return (name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function listScreenshots(debugDir, slug, limit) {
  const files = fs.readdirSync(debugDir)
    .filter(f => f.endsWith('.png'))
    .filter(f => f.startsWith(`${slug}_`))
    .map(f => ({
      filename: f,
      url: `/api/screenshots/tiles-debug/${f}`,
      created: fs.statSync(path.join(debugDir, f)).mtime
    }))
    .sort((a, b) => b.created - a.created);

  if (Number.isFinite(limit) && limit > 0) {
    return files.slice(0, limit);
  }

  return files;
}

router.get('/tiles-debug/:filename', requireAuth, (req, res) => {
  const filepath = path.join(SCREENSHOT_DIR, 'tiles-debug', path.basename(req.params.filename));
  if (!fs.existsSync(filepath)) return res.status(404).send('Not found');
  res.sendFile(filepath);
});

router.delete('/tiles-debug/:filename', requireAuth, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename || '');
    if (!filename) return res.status(400).json({ error: 'Invalid filename' });

    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
    const filepath = path.join(debugDir, filename);

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    const sources = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ?', [userId]);
    const allowedSlugs = new Set();
    sources.forEach(row => {
      try {
        const data = JSON.parse(row.source_data);
        allowedSlugs.add(toSourceSlug(data.name));
      } catch (err) {
        logger.error(`Failed to parse source_data in screenshot access check: ${err.message}`);
        // Skip malformed rows
      }
    });

    const isAllowed = Array.from(allowedSlugs).some(slug => filename.startsWith(`${slug}_`));
    if (!isAllowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    fs.unlinkSync(filepath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/source/:sourceId', requireAuth, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const sourceId = parseInt(req.params.sourceId, 10);
    if (!Number.isFinite(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    const row = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!row) return res.status(404).json({ error: 'Source not found' });

    let sourceData;
    try {
      sourceData = JSON.parse(row.source_data || '{}');
    } catch (parseError) {
      logger.error(`Failed to parse source ${sourceId}: ${parseError.message}`);
      logger.error(`   Raw data (first 200 chars): ${row.source_data.substring(0, 200)}`);
      return res.status(500).json({ error: 'Source data is corrupted' });
    }
    const slug = toSourceSlug(sourceData.name);
    const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');

    if (!fs.existsSync(debugDir)) return res.json({ screenshots: [] });

    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
    const files = listScreenshots(debugDir, slug, limit);

    res.json({ screenshots: files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;