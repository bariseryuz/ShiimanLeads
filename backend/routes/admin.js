const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/auth');

// Will be imported from services in Phase 5
let createSourceTable;

function setHelpers(helpers) {
  createSourceTable = helpers.createSourceTable;
}

/**
 * Admin middleware - already provided by requireAdmin from middleware/auth
 * Keeping local implementation for backward compatibility
 */
function ensureAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * GET /api/admin/users
 * Get all users (admin only)
 */
router.get('/users', ensureAdmin, async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, email, role, created_at FROM users ORDER BY id');
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/sources/:userId
 * Get sources for a specific user (admin only)
 */
router.get('/sources/:userId', ensureAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const sourceRows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    
    const sources = sourceRows.map(row => {
      try {
        return {
          id: row.id,
          data: JSON.parse(row.source_data),
          created_at: row.created_at
        };
      } catch (e) {
        logger.error(`Failed to parse source_data for source id ${row.id}: ${e.message}`);
        logger.error(`   Raw data (first 200 chars): ${row.source_data.substring(0, 200)}`);
        return null;
      }
    }).filter(Boolean);
    
    res.json({ data: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/sources/:userId
 * Add source for any user (admin only)
 */
router.post('/sources/:userId', ensureAdmin, express.json(), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const sourceData = req.body;
    
    // Validate required fields
    if (!sourceData.name || !sourceData.url) {
      return res.status(400).json({ error: 'Source name and URL are required' });
    }
    
    // Auto-enable AI if no selector provided
    if (!sourceData.selector) {
      sourceData.useAI = true;
    }
    
    // Store as JSON string
    const sourceJson = JSON.stringify(sourceData);
    const result = await dbRun(
      'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
      [userId, sourceJson, new Date().toISOString()]
    );
    
    // Create source table if createSourceTable helper is available
    if (createSourceTable && sourceData.fieldSchema) {
      const tableName = createSourceTable(result.lastID, sourceData.fieldSchema);
      logger.info(`✅ Admin created table: ${tableName} for "${sourceData.name}"`);
    }
    
    logger.info(`Admin added source "${sourceData.name}" for user ID ${userId}`);
    res.json({ success: true, id: result.lastID });
  } catch (e) {
    logger.error(`Admin add source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/admin/sources/:userId/:sourceId
 * Delete source for any user (admin only)
 */
router.delete('/sources/:userId/:sourceId', ensureAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const sourceId = parseInt(req.params.sourceId, 10);
    
    const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    logger.info(`Admin deleted source ID ${sourceId} for user ID ${userId}`);
    res.json({ success: true });
  } catch (e) {
    logger.error(`Admin delete source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Delete user and all their data (admin only)
 */
router.delete('/users/:userId', ensureAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    
    // Prevent admin from deleting themselves
    if (req.session.user.id === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Check if user exists
    const user = await dbGet('SELECT id, username, role FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get counts before deletion
    const sourcesCount = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
    const leadsCount = await dbGet('SELECT COUNT(*) as count FROM leads WHERE user_id = ?', [userId]);
    
    // Delete in correct order (respect foreign keys)
    await dbRun('DELETE FROM leads WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM user_sources WHERE user_id = ?', [userId]);
    await dbRun('DELETE FROM users WHERE id = ?', [userId]);
    
    logger.info(`Admin deleted user "${user.username}" (ID: ${userId})`);
    logger.info(`  - Deleted ${leadsCount.count} leads`);
    logger.info(`  - Deleted ${sourcesCount.count} sources`);
    
    res.json({ 
      success: true, 
      deleted: {
        user: user.username,
        leads: leadsCount.count,
        sources: sourcesCount.count
      }
    });
  } catch (e) {
    logger.error(`Admin delete user error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
