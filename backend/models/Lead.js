const { dbGet, dbAll, dbRun } = require('../db');
// NOTE: generateLeadHash removed - deduplication will be rebuilt from scratch
const logger = require('../utils/logger');

/**
 * Lead Model
 * Handles lead data access and queries
 */
class Lead {
  /**
   * Find lead by ID
   * @param {number} id - Lead ID
   * @returns {Promise<Object|null>} Lead object or null
   */
  static async findById(id) {
    return await dbGet('SELECT * FROM leads WHERE id = ?', [id]);
  }

  /**
   * Find leads by user ID with pagination
   * @param {number} userId - User ID
   * @param {Object} options - Query options
   * @param {number} options.limit - Number of results (default: 100)
   * @param {number} options.offset - Offset for pagination (default: 0)
   * @param {boolean} options.newOnly - Only return new leads (default: false)
   * @param {string} options.source - Filter by source name
   * @param {string} options.orderBy - Order by field (default: 'date_added')
   * @param {string} options.order - Sort order 'ASC' or 'DESC' (default: 'DESC')
   * @returns {Promise<Array>} Array of lead objects
   */
  static async findByUserId(userId, options = {}) {
    const {
      limit = 100,
      offset = 0,
      newOnly = false,
      source = null,
      orderBy = 'date_added',
      order = 'DESC'
    } = options;

    let query = 'SELECT * FROM leads WHERE user_id = ?';
    const params = [userId];

    if (newOnly) {
      query += ' AND is_new = 1';
    }

    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    query += ` ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return await dbAll(query, params);
  }

  /**
   * Get leads from source-specific table
   * @param {number} sourceId - Source ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of leads from source table
   */
  static async findBySourceTable(sourceId, options = {}) {
    const {
      limit = 100,
      offset = 0,
      orderBy = 'date_added',
      order = 'DESC'
    } = options;

    const tableName = `source_${sourceId}`;
    
    try {
      const query = `SELECT * FROM ${tableName} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
      return await dbAll(query, [limit, offset]);
    } catch (e) {
      logger.error(`Error querying source table ${tableName}: ${e.message}`);
      return [];
    }
  }

  /**
   * Count leads for a user
   * @param {number} userId - User ID
   * @param {Object} options - Filter options
   * @param {boolean} options.newOnly - Only count new leads
   * @param {string} options.source - Filter by source name
   * @returns {Promise<number>} Lead count
   */
  static async countByUserId(userId, options = {}) {
    const { newOnly = false, source = null } = options;

    let query = 'SELECT COUNT(*) as count FROM leads WHERE user_id = ?';
    const params = [userId];

    if (newOnly) {
      query += ' AND is_new = 1';
    }

    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    const result = await dbGet(query, params);
    return result.count;
  }

  /**
   * Mark all leads as read (is_new = 0) for a user
   * @param {number} userId - User ID
   * @returns {Promise<number>} Number of leads updated
   */
  static async markAllAsRead(userId) {
    const result = await dbRun('UPDATE leads SET is_new = 0 WHERE user_id = ? AND is_new = 1', [userId]);
    logger.info(`Marked ${result.changes} leads as read for user ${userId}`);
    return result.changes;
  }

  /**
   * Delete all leads for a user
   * @param {number} userId - User ID
   * @returns {Promise<number>} Number of leads deleted
   */
  static async deleteAllByUserId(userId) {
    const result = await dbRun('DELETE FROM leads WHERE user_id = ?', [userId]);
    logger.info(`Deleted ${result.changes} leads for user ${userId}`);
    return result.changes;
  }

  /**
   * Delete lead by ID
   * @param {number} id - Lead ID
   * @returns {Promise<boolean>} True if successful
   */
  static async delete(id) {
    await dbRun('DELETE FROM leads WHERE id = ?', [id]);
    logger.info(`Lead ${id} deleted`);
    return true;
  }

  /**
   * Get lead statistics for a user
   * @param {number} userId - User ID
   * @returns {Promise<Object>} Statistics object
   */
  static async getStats(userId) {
    const total = await Lead.countByUserId(userId);
    const newCount = await Lead.countByUserId(userId, { newOnly: true });
    
    const sourceStats = await dbAll(`
      SELECT 
        source,
        COUNT(*) as count,
        SUM(CASE WHEN is_new = 1 THEN 1 ELSE 0 END) as new_count
      FROM leads
      WHERE user_id = ?
      GROUP BY source
      ORDER BY count DESC
    `, [userId]);

    const recentLeads = await dbAll(`
      SELECT 
        DATE(date_added) as date,
        COUNT(*) as count
      FROM leads
      WHERE user_id = ? AND date_added >= datetime('now', '-30 days')
      GROUP BY DATE(date_added)
      ORDER BY date DESC
    `, [userId]);

    return {
      total,
      newCount,
      bySource: sourceStats,
      last30Days: recentLeads
    };
  }

  /**
   * Search leads by keyword
   * @param {number} userId - User ID
   * @param {string} keyword - Search keyword
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Array of matching leads
   */
  static async search(userId, keyword, options = {}) {
    const { limit = 100, offset = 0 } = options;
    
    const searchPattern = `%${keyword}%`;
    const query = `
      SELECT * FROM leads
      WHERE user_id = ? AND (
        permit_number LIKE ? OR
        address LIKE ? OR
        contractor_name LIKE ? OR
        owner_name LIKE ? OR
        description LIKE ?
      )
      ORDER BY date_added DESC
      LIMIT ? OFFSET ?
    `;

    return await dbAll(query, [
      userId,
      searchPattern, searchPattern, searchPattern, searchPattern, searchPattern,
      limit, offset
    ]);
  }

  /**
   * Check if lead exists (for deduplication)
   * @param {string} hash - Lead hash
   * @param {number} userId - User ID
   * @returns {Promise<boolean>} True if lead exists
   */
  static async exists(hash, userId) {
    const result = await dbGet(
      'SELECT id FROM leads WHERE dedup_hash = ? AND user_id = ?',
      [hash, userId]
    );
    return !!result;
  }

  /**
   * Get unique sources for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array<string>>} Array of source names
   */
  static async getUniqueSources(userId) {
    const results = await dbAll(
      'SELECT DISTINCT source FROM leads WHERE user_id = ? ORDER BY source',
      [userId]
    );
    return results.map(r => r.source);
  }
}

module.exports = Lead;
