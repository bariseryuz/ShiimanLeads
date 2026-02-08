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

    // Get all user sources to query their tables
    const userSources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
    let allLeads = [];

    for (const sourceRow of userSources) {
      // Skip if filtering by specific source
      if (sourceId && sourceRow.id !== sourceId) continue;

      const tableName = `source_${sourceRow.id}`;
      
      // Check if table exists
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
      if (!tableExists) continue;

      // Get all columns from this source table
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
      const columnNames = columns.map(col => col.name);

      // Build dynamic query
      const where = ['user_id = ?'];
      const params = [userId];

      // Search across all text columns if query provided
      if (q) {
        const textCols = columnNames.filter(col => !['id', 'user_id', 'created_at'].includes(col));
        const searchConditions = textCols.map(col => `${col} LIKE ?`).join(' OR ');
        if (searchConditions) {
          where.push(`(${searchConditions})`);
          const like = `%${q}%`;
          textCols.forEach(() => params.push(like));
        }
      }

      if (Number.isFinite(days) && days > 0 && columnNames.includes('created_at')) {
        const cutoff = new Date(Date.now() - days*24*60*60*1000).toISOString();
        where.push('created_at >= ?');
        params.push(cutoff);
      }

      const sql = `SELECT * FROM ${tableName} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`;
      params.push(limit);
      
      try {
        const rows = db.prepare(sql).all(...params);
        // Add source info to each row
        const sourceData = JSON.parse(sourceRow.source_data);
        rows.forEach(row => {
          row._source_id = sourceRow.id;
          row._source_name = sourceData.name;
        });
        allLeads.push(...rows);
      } catch (queryErr) {
        logger.error(`Error querying ${tableName}: ${queryErr.message}`);
      }
    }

    // Sort by ID desc and limit
    allLeads.sort((a, b) => b.id - a.id);
    allLeads = allLeads.slice(0, limit);

    res.json({ data: allLeads });
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
 * Clear all leads for the current user (from source tables)
 */
router.delete('/clear', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Get all user sources
    const userSources = db.prepare('SELECT id FROM user_sources WHERE user_id = ?').all(userId);
    let totalDeleted = 0;

    for (const sourceRow of userSources) {
      const tableName = `source_${sourceRow.id}`;
      
      // Check if table exists
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
      if (!tableExists) continue;

      try {
        const result = db.prepare(`DELETE FROM ${tableName} WHERE user_id = ?`).run(userId);
        totalDeleted += result.changes || 0;
        logger.info(`Deleted ${result.changes} leads from ${tableName} for user ${userId}`);
      } catch (deleteErr) {
        logger.error(`Error deleting from ${tableName}: ${deleteErr.message}`);
      }
    }

    logger.info(`Total leads cleared for user ${userId}: ${totalDeleted}`);
    res.json({ success: true, deleted: totalDeleted });
  } catch (e) {
    logger.error(`Clear leads error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
