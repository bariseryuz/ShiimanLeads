const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { SCREENSHOT_DIR } = require('../config/paths');
const logger = require('../utils/logger');

// Authentication middleware (imported from middleware/auth)
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/screenshots
 * List all screenshots with metadata
 */
router.get('/', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(SCREENSHOT_DIR)
      .filter(file => file.endsWith('.png') || file.endsWith('.jpg'))
      .map(file => {
        const filepath = path.join(SCREENSHOT_DIR, file);
        const stats = fs.statSync(filepath);
        return {
          filename: file,
          url: `/api/screenshots/view/${encodeURIComponent(file)}`,
          downloadUrl: `/api/screenshots/download/${encodeURIComponent(file)}`,
          size: stats.size,
          sizeFormatted: `${(stats.size / 1024 / 1024).toFixed(2)} MB`,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created);

    res.json({
      success: true,
      count: files.length,
      directory: SCREENSHOT_DIR,
      screenshots: files
    });
  } catch (error) {
    logger.error('Error reading screenshots:', error);
    res.status(500).json({ error: 'Failed to load screenshots' });
  }
});

/**
 * GET /api/screenshots/view/:filename
 * View specific screenshot (serves image file)
 */
router.get('/view/:filename', requireAuth, (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    
    // Security: prevent directory traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Invalid filename');
    }
    
    const filepath = path.join(SCREENSHOT_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).send('Screenshot not found');
    }
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filepath);
  } catch (error) {
    logger.error('Error serving screenshot:', error);
    res.status(500).send('Error loading screenshot');
  }
});

/**
 * GET /api/screenshots/download/:filename
 * Download screenshot as attachment
 */
router.get('/download/:filename', requireAuth, (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).send('Invalid filename');
    }
    
    const filepath = path.join(SCREENSHOT_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).send('Screenshot not found');
    }
    
    res.download(filepath);
  } catch (error) {
    logger.error('Error downloading screenshot:', error);
    res.status(500).send('Error downloading screenshot');
  }
});

/**
 * DELETE /api/screenshots/:filename
 * Delete a screenshot
 */
router.delete('/:filename', requireAuth, (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    const filepath = path.join(SCREENSHOT_DIR, filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    
    fs.unlinkSync(filepath);
    logger.info(`🗑️ Deleted screenshot: ${filename}`);
    res.json({ success: true, message: 'Screenshot deleted' });
  } catch (error) {
    logger.error('Error deleting screenshot:', error);
    res.status(500).json({ error: 'Failed to delete screenshot' });
  }
});

module.exports = router;
