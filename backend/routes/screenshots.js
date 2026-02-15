/**
 * SCREENSHOTS ROUTES
 * Endpoints for serving and managing screenshot files
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const logger = require('../utils/logger');
const { dbGet } = require('../db');

/**
 * Serve screenshot image file
 * GET /api/screenshots/tiles-debug/:filename
 */
router.get('/tiles-debug/:filename', requireAuth, (req, res) => {
  try {
    const { filename } = req.params;
    
    // Sanitize filename for security
    const sanitized = path.basename(filename);
    
    const filepath = path.join(__dirname, '../data/screenshots/tiles-debug', sanitized);
    
    // Check if file exists
    if (!fs.existsSync(filepath)) {
      logger.warn(`Screenshot not found: ${sanitized}`);
      return res.status(404).json({ error: 'Screenshot not found' });
    }
    
    // Serve image file
    res.sendFile(filepath);
    
  } catch (err) {
    logger.error('Error serving screenshot:', err);
    res.status(500).json({ error: 'Failed to serve screenshot' });
  }
});

/**
 * Get all screenshots for a source
 * GET /api/screenshots/source/:sourceId
 */
router.get('/source/:sourceId', requireAuth, async (req, res) => {
  try {
    const { sourceId } = req.params;
    
    // Get source to verify ownership
    const source = await dbGet(
      'SELECT * FROM user_sources WHERE id = ? AND user_id = ?',
      [sourceId, req.user.id]
    );
    
    if (!source) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    const sourceData = JSON.parse(source.source_data);
    const sourceSlug = (sourceData.name || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    // List all screenshots for this source
    const screenshotDir = path.join(__dirname, '../data/screenshots/tiles-debug');
    
    if (!fs.existsSync(screenshotDir)) {
      return res.json({ screenshots: [] });
    }
    
    const files = fs.readdirSync(screenshotDir);
    
    // Filter files that match this source
    const sourceScreenshots = files
      .filter(f => f.startsWith(sourceSlug) && f.endsWith('.png'))
      .map(filename => {
        const filepath = path.join(screenshotDir, filename);
        const stats = fs.statSync(filepath);
        
        // Parse metadata from filename
        const scrollMatch = filename.match(/scroll(\d+)/);
        const rowMatch = filename.match(/row(\d+)/);
        const colMatch = filename.match(/col(\d+)/);
        const hashMatch = filename.match(/hash([a-f0-9]+)/);
        const timestampMatch = filename.match(/_(\d{13})_/);
        
        return {
          filename: filename,
          url: `/api/screenshots/tiles-debug/${filename}`,
          size: stats.size,
          created: stats.mtime,
          timestamp: timestampMatch ? parseInt(timestampMatch[1]) : 0,
          scrollY: scrollMatch ? parseInt(scrollMatch[1]) : 0,
          row: rowMatch ? parseInt(rowMatch[1]) : 0,
          col: colMatch ? parseInt(colMatch[1]) : 0,
          hash: hashMatch ? hashMatch[1] : 'unknown'
        };
      })
      .sort((a, b) => b.created - a.created);
    
    res.json({
      screenshots: sourceScreenshots,
      totalScreenshots: sourceScreenshots.length
    });
    
  } catch (err) {
    logger.error('Error fetching screenshots:', err);
    res.status(500).json({ error: 'Failed to fetch screenshots' });
  }
});

module.exports = router;