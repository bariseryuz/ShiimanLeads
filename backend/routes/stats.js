const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/stats
 * Get dashboard statistics for current user
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Total leads for this user
    const totalLeadsRow = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ?', [userId]);
    const totalLeads = totalLeadsRow?.count || 0;

    // Active sources (configured sources)
    const sourcesRow = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
    const activeSources = sourcesRow?.count || 0;

    // Leads by source
    const leadsBySource = await dbAll(
      'SELECT source, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY source ORDER BY count DESC',
      [userId]
    );

    // Recent activity (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLeadsRow = await dbGet(
      'SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND date_added >= ?',
      [userId, sevenDaysAgo]
    );
    const recentLeads = recentLeadsRow?.count || 0;

    res.json({
      totalLeads,
      activeSources,
      recentLeads,
      leadsBySource
    });
  } catch (e) {
    logger.error(`Stats API error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /metrics
 * Get detailed metrics/statistics for current user
 */
router.get('/metrics', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    
    // Total leads count
    const totalLeads = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ?', [userId]);
    
    // New leads count (last scrape)
    const newLeads = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND is_new = 1', [userId]);
    
    // Total sources
    const totalSources = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
    
    // Leads per source breakdown
    const leadsPerSource = await dbAll(`
      SELECT source, COUNT(*) as count 
      FROM leads 
      WHERE user_id = ? 
      GROUP BY source 
      ORDER BY count DESC
    `, [userId]);
    
    // Recent activity (last 7 days) - using date_added if available
    let recentActivity = [];
    try {
      recentActivity = await dbAll(`
        SELECT DATE(date_added) as date, COUNT(*) as count 
        FROM leads 
        WHERE user_id = ? AND date_added IS NOT NULL AND date_added >= datetime('now', '-7 days')
        GROUP BY DATE(date_added)
        ORDER BY date DESC
      `, [userId]);
    } catch (e) {
      // Column might not exist, just skip recent activity
      logger.warn(`Recent activity query failed: ${e.message}`);
    }
    
    // Last scrape time - use date_added as proxy
    let lastScrape = null;
    try {
      lastScrape = await dbGet(`
        SELECT MAX(date_added) as last_scrape 
        FROM leads 
        WHERE user_id = ?
      `, [userId]);
    } catch (e) {
      logger.warn(`Last scrape query failed: ${e.message}`);
    }
    
    res.json({
      success: true,
      metrics: {
        totalLeads: totalLeads.count || 0,
        newLeads: newLeads.count || 0,
        totalSources: totalSources.count || 0,
        leadsPerSource: leadsPerSource || [],
        recentActivity: recentActivity || [],
        lastScrape: lastScrape?.last_scrape || null
      }
    });
  } catch (e) {
    logger.error(`Metrics error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /notifications
 * Get notifications for current user
 */
router.get('/notifications', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = parseInt(req.query.limit || '50', 10);
    const notifications = await dbAll(
      'SELECT id, type, message, created_at, is_read FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );

    res.json({ data: notifications || [] });
  } catch (e) {
    logger.error(`Notifications API error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /notifications/:id/read
 * Mark single notification as read
 */
router.post('/notifications/:id/read', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const notificationId = parseInt(req.params.id, 10);
    await dbRun(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
      [notificationId, userId]
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /notifications/mark-all-read
 * Mark all notifications as read
 */
router.post('/notifications/mark-all-read', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    await dbRun('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
