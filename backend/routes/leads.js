const express = require('express');
const router = express.Router();
const { db, dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * GET /api/leads
 * Fetch leads from all user sources, dynamically querying source tables
 * Supports filtering by source_id, search query (q), and date range (days)
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
    const q = req.query.q ? String(req.query.q) : null;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;

    const userSources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
    const sourceMap = new Map();
    userSources.forEach(row => {
      try {
        const sourceData = JSON.parse(row.source_data);
        sourceMap.set(row.id, { name: sourceData.name || 'Unknown Source' });
      } catch (err) {
        sourceMap.set(row.id, { name: 'Unknown Source' });
      }
    });

    const where = ['user_id = ?'];
    const params = [userId];

    if (sourceId) {
      where.push('source_id = ?');
      params.push(sourceId);
    }

    if (q) {
      const like = `%${q}%`;
      where.push('(data LIKE ? OR raw_text LIKE ? OR permit_number LIKE ? OR address LIKE ? OR description LIKE ?)');
      params.push(like, like, like, like, like);
    }

    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      where.push('COALESCE(created_at, date_added) >= ?');
      params.push(cutoff);
    }

    const sql = `SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    const excludedKeys = new Set([
      'id', 'user_id', 'source_id', 'hash', 'raw_text', 'data', 'primary_id', 'title',
      'created_at', 'updated_at', 'is_new', 'source', 'date_added', 'dedup_hash',
      'canonical_hash', 'extracted_data', 'ai_confidence', 'ai_validated'
    ]);

    const results = rows.map(row => {
      let data = null;

      if (row.data) {
        try {
          data = JSON.parse(row.data);
        } catch (err) {
          logger.warn(`Invalid JSON in leads.data for id ${row.id}`);
        }
      }

      if (!data && row.raw_text) {
        try {
          data = JSON.parse(row.raw_text);
        } catch (err) {
          data = null;
        }
      }

      if (!data || typeof data !== 'object') {
        data = {};
        Object.entries(row).forEach(([key, value]) => {
          if (!excludedKeys.has(key) && value !== null && value !== undefined && value !== '') {
            data[key] = value;
          }
        });
      }

      const sourceInfo = sourceMap.get(row.source_id);
      return {
        ...data,
        id: row.id,
        user_id: row.user_id,
        source_id: row.source_id,
        created_at: row.created_at || row.date_added || null,
        status: row.status || 'new',
        is_new: row.is_new,
        _source_id: row.source_id,
        _source_name: sourceInfo?.name || row.source || 'Unknown Source'
      };
    });

    res.json({ data: results });
  } catch (e) {
    logger.error(`Error fetching leads: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/leads.raw
 * Legacy raw array response from main leads table
 * Kept for backward compatibility
 */
router.get('.raw', async (req, res) => {
  try {
    // CRITICAL: Filter by user_id from session
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(parseInt(req.query.limit || '200', 10) || 200, 1000);
    const source = req.query.source ? String(req.query.source) : null;
    const q = req.query.q ? String(req.query.q) : null;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    
    const where = ['user_id = ?'];
    const params = [userId];
    
    if (source) { where.push('source = ?'); params.push(source); }
    if (q) {
      where.push('(permit_number LIKE ? OR address LIKE ? OR description LIKE ? OR raw_text LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
      where.push('date_added >= ?');
      params.push(cutoff);
    }
    const sql = `SELECT id, hash, permit_number, address, city, state, zip_code, value, description,
                 contractor_name, contractor_address, owner_name, phone, contractor_phone,
                 square_footage, units, permit_type, permit_subtype, status, parcel_number,
                 source, date_issued, date_added, page_url, raw_text, is_new
                 FROM leads WHERE ${where.join(' AND ')}
                 ORDER BY id DESC LIMIT ?`;
    params.push(limit);
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/leads/clear
 * Clear all leads for the current user (from source tables AND main leads table)
 */
router.delete('/clear', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    let totalDeleted = 0;
    
    // 1. Delete from main leads table
    try {
      const mainLeadsResult = db.prepare('DELETE FROM leads WHERE user_id = ?').run(userId);
      const mainLeadsDeleted = mainLeadsResult.changes || 0;
      totalDeleted += mainLeadsDeleted;
      logger.info(`Deleted ${mainLeadsDeleted} leads from main leads table for user ${userId}`);
    } catch (mainDeleteErr) {
      logger.error(`Error deleting from main leads table: ${mainDeleteErr.message}`);
    }

    // 2. Delete from source-specific tables
    const userSources = db.prepare('SELECT id FROM user_sources WHERE user_id = ?').all(userId);
    for (const sourceRow of userSources) {
      const tableName = `source_${sourceRow.id}`;
      
      // Check if table exists
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
      if (!tableExists) continue;

      try {
        const result = db.prepare(`DELETE FROM ${tableName} WHERE user_id = ?`).run(userId);
        const sourceDeleted = result.changes || 0;
        totalDeleted += sourceDeleted;
        logger.info(`Deleted ${sourceDeleted} leads from ${tableName} for user ${userId}`);
      } catch (deleteErr) {
        logger.error(`Error deleting from ${tableName}: ${deleteErr.message}`);
      }
    }
    
    // 3. Also clear the seen table to reset duplicates
    try {
      const seenResult = db.prepare('DELETE FROM seen WHERE user_id = ?').run(userId);
      logger.info(`Cleared ${seenResult.changes || 0} seen records for user ${userId}`);
    } catch (seenErr) {
      logger.error(`Error clearing seen table: ${seenErr.message}`);
    }

    logger.info(`Total leads cleared for user ${userId}: ${totalDeleted}`);
    res.json({ success: true, deleted: totalDeleted, message: 'All leads cleared successfully' });
  } catch (e) {
    logger.error(`Clear leads error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
