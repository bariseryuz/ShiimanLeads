const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { getNotificationSettings, ensureNotificationSettings } = require('../services/alerts');
const { getSourceHealthForUser } = require('../services/sourceHealth');

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

    // Leads by source (column is source_name)
    const leadsBySource = await dbAll(
      'SELECT source_name AS source, COUNT(*) as count FROM leads WHERE user_id = ? GROUP BY source_name ORDER BY count DESC',
      [userId]
    );

    // Recent activity (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentLeadsRow = await dbGet(
      'SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND created_at >= ?',
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
    
    // Leads per source breakdown (column is source_name)
    const leadsPerSource = await dbAll(`
      SELECT source_name AS source, COUNT(*) as count 
      FROM leads 
      WHERE user_id = ? 
      GROUP BY source_name 
      ORDER BY count DESC
    `, [userId]);
    
    // Recent activity (last 7 days) - using created_at
    let recentActivity = [];
    try {
      recentActivity = await dbAll(`
        SELECT DATE(created_at) as date, COUNT(*) as count 
        FROM leads 
        WHERE user_id = ? AND created_at IS NOT NULL AND created_at >= datetime('now', '-7 days')
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `, [userId]);
    } catch (e) {
      // Query failed, skip recent activity
      logger.warn(`Recent activity query failed: ${e.message}`);
    }
    
    // Last scrape time - use created_at
    let lastScrape = null;
    try {
      lastScrape = await dbGet(`
        SELECT MAX(created_at) as last_scrape 
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
 * GET /api/stats/roi
 * Usage & ROI: new leads this month, sources scanned, success rate
 */
router.get('/roi', requireAuth, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartIso = monthStart.toISOString();

    const newLeadsThisMonth = await dbGet(
      'SELECT COUNT(*) as count FROM leads WHERE user_id = ? AND created_at >= ?',
      [userId, monthStartIso]
    );

    const runs = await dbAll(
      'SELECT status, records_inserted FROM source_runs WHERE user_id = ? AND started_at >= ?',
      [userId, monthStartIso]
    );
    const sourcesScanned = runs.length;
    const successRuns = runs.filter(r => r.status === 'success').length;
    const successRate = sourcesScanned ? Math.round((successRuns / sourcesScanned) * 100) : 0;
    const totalInsertedThisMonth = runs.reduce((s, r) => s + (r.records_inserted || 0), 0);

    res.json({
      success: true,
      roi: {
        newLeadsThisMonth: newLeadsThisMonth?.count || 0,
        sourcesScanned,
        successRate,
        totalInsertedThisMonth
      }
    });
  } catch (e) {
    logger.error(`ROI stats error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/stats/notification-settings
 * GET /api/stats/source-health
 */
router.get('/notification-settings', requireAuth, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const settings = await getNotificationSettings(userId);
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/notification-settings', requireAuth, express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    await ensureNotificationSettings(userId);
    const { instant_email_enabled, digest_email_enabled, digest_frequency, webhook_enabled, webhook_url, slack_webhook_url } = req.body || {};
    const updates = [];
    const values = [];
    if (typeof instant_email_enabled === 'number') { updates.push('instant_email_enabled = ?'); values.push(instant_email_enabled); }
    if (typeof digest_email_enabled === 'number') { updates.push('digest_email_enabled = ?'); values.push(digest_email_enabled); }
    if (digest_frequency !== undefined) { updates.push('digest_frequency = ?'); values.push(digest_frequency); }
    if (typeof webhook_enabled === 'number') { updates.push('webhook_enabled = ?'); values.push(webhook_enabled); }
    if (webhook_url !== undefined) { updates.push('webhook_url = ?'); values.push(webhook_url); }
    if (slack_webhook_url !== undefined) { updates.push('slack_webhook_url = ?'); values.push(slack_webhook_url); }
    if (updates.length) {
      values.push(userId);
      await dbRun(`UPDATE notification_settings SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, values);
    }
    const settings = await getNotificationSettings(userId);
    res.json({ success: true, settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/source-health', requireAuth, async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const health = await getSourceHealthForUser(userId);
    res.json({ success: true, data: health });
  } catch (e) {
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
