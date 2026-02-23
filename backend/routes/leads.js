const express = require('express');
const router = express.Router();
const { db, dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * GET /api/leads
 * Fetch leads from unified leads table + source-specific tables (hybrid approach)
 * ✅ UNIVERSAL - works with ANY data type stored in raw_data JSON
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
    const sourceId = req.query.source_id ? parseInt(req.query.source_id, 10) : null;
    const q = req.query.q ? String(req.query.q) : null;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;

    const userSources = db.prepare('SELECT id, source_data FROM user_sources WHERE user_id = ?').all(userId);
    const sourceMap = new Map();
    userSources.forEach(row => {
      try {
        const sourceData = JSON.parse(row.source_data);
        sourceMap.set(row.id, { name: sourceData.name || 'Unknown Source', data: sourceData });
      } catch (err) {
        sourceMap.set(row.id, { name: 'Unknown Source', data: {} });
      }
    });

    let allResults = [];

    // HYBRID APPROACH: Query both unified leads table AND source-specific tables
    
    // 1. Query unified leads table (universal JSON-based storage)
    const where = ['user_id = ?'];
    const params = [userId];

    if (sourceId) {
      where.push('source_id = ?');
      params.push(sourceId);
    }

    // ✅ UNIVERSAL SEARCH - searches within raw_data JSON
    if (q) {
      const like = `%${q}%`;
      where.push('raw_data LIKE ?');
      params.push(like);
    }

    if (Number.isFinite(days) && days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      where.push('created_at >= ?');
      params.push(cutoff);
    }

    const leadsSQL = `SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`;
    params.push(limit);
    params.push(offset);

    const leadsRows = db.prepare(leadsSQL).all(...params);

    // Process unified leads table results
    leadsRows.forEach(row => {
      let data = null;

      // Parse raw_data JSON (universal storage)
      if (row.raw_data) {
        try {
          data = JSON.parse(row.raw_data);
        } catch (err) {
          logger.warn(`Invalid JSON in leads.raw_data for id ${row.id}`);
          data = {};
        }
      } else {
        data = {};
      }

      const sourceInfo = sourceMap.get(row.source_id);
      allResults.push({
        ...data,
        id: row.id,
        user_id: row.user_id,
        source_id: row.source_id,
        created_at: row.created_at || null,
        status: 'new',
        is_new: row.is_new,
        _source_id: row.source_id,
        _source_name: sourceInfo?.name || row.source_name || 'Unknown Source',
        _source_table: 'leads'
      });
    });

    // 2. Query source-specific tables (legacy/existing data)
    for (const sourceRow of userSources) {
      if (sourceId && sourceRow.id !== sourceId) continue;

      const tableName = `source_${sourceRow.id}`;
      
      const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
      if (!tableExists) continue;

      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
      const columnNames = columns.map(col => col.name);

      const sourceWhere = ['user_id = ?'];
      const sourceParams = [userId];

      // Universal search across all text columns
      if (q) {
        const textCols = columnNames.filter(col => !['id', 'user_id', 'created_at'].includes(col));
        const searchConditions = textCols.map(col => `${col} LIKE ?`).join(' OR ');
        if (searchConditions) {
          sourceWhere.push(`(${searchConditions})`);
          const like = `%${q}%`;
          textCols.forEach(() => sourceParams.push(like));
        }
      }

      if (Number.isFinite(days) && days > 0 && columnNames.includes('created_at')) {
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        sourceWhere.push('created_at >= ?');
        sourceParams.push(cutoff);
      }

      const sourceSQL = `SELECT * FROM ${tableName} WHERE ${sourceWhere.join(' AND ')} ORDER BY id DESC LIMIT ?`;
      sourceParams.push(limit);
      
      try {
        const rows = db.prepare(sourceSQL).all(...sourceParams);
        const sourceInfo = sourceMap.get(sourceRow.id);
        
        rows.forEach(row => {
          allResults.push({
            ...row,
            _source_id: sourceRow.id,
            _source_name: sourceInfo?.name || 'Unknown Source',
            _source_table: tableName
          });
        });
      } catch (queryErr) {
        logger.error(`Error querying ${tableName}: ${queryErr.message}`);
      }
    }

    // Sort by ID desc
    allResults.sort((a, b) => b.id - a.id);
    
    // Apply limit
    const finalResults = allResults.slice(0, limit);

    res.json({ data: finalResults });
  } catch (e) {
    logger.error(`Error fetching leads: ${e.message}`);
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

    logger.info(`Total leads cleared for user ${userId}: ${totalDeleted}`);
    res.json({ success: true, deleted: totalDeleted, message: 'All leads cleared successfully' });
  } catch (e) {
    logger.error(`Clear leads error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;