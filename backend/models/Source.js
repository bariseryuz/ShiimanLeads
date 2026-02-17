const { dbGet, dbAll, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * Source Model
 * Handles user-specific source management
 */
class Source {
  /**
   * Find source by ID
   * @param {number} id - Source ID
   * @returns {Promise<Object|null>} Source object or null
   */
  static async findById(id) {
    const row = await dbGet('SELECT * FROM user_sources WHERE id = ?', [id]);
    if (!row) return null;
    
    try {
      return {
        id: row.id,
        userId: row.user_id,
        ...JSON.parse(row.source_data)
      };
    } catch (e) {
      logger.error(`Failed to parse source_data for source id ${id}: ${e.message}`);
      return null;
    }
  }

  /**
   * Find all sources for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} Array of source objects
   */
  static async findByUserId(userId) {
    const rows = await dbAll('SELECT * FROM user_sources WHERE user_id = ?', [userId]);
    return rows.map(row => {
      try {
        return {
          id: row.id,
          userId: row.user_id,
          ...JSON.parse(row.source_data)
        };
      } catch (e) {
        logger.error(`Failed to parse source_data for source id ${row.id}: ${e.message}`);
        return null;
      }
    }).filter(Boolean);
  }

  /**
   * Create a new source
   * @param {number} userId - User ID
   * @param {Object} sourceData - Source configuration
   * @returns {Promise<Object>} Created source object
   */
  static async create(userId, sourceData) {
    const sourceJson = JSON.stringify(sourceData);
    const result = await dbRun(
      'INSERT INTO user_sources (user_id, source_data) VALUES (?, ?)',
      [userId, sourceJson]
    );
    logger.info(`Source created for user ${userId}: ${sourceData.name}`);
    return await Source.findById(result.lastInsertRowid);
  }

  /**
   * Update a source
   * @param {number} id - Source ID
   * @param {Object} sourceData - Updated source configuration
   * @returns {Promise<Object>} Updated source object
   */
  static async update(id, sourceData) {
    const sourceJson = JSON.stringify(sourceData);
    await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ?', [sourceJson, id]);
    logger.info(`Source ${id} updated`);
    return await Source.findById(id);
  }

  /**
   * Delete a source
   * @param {number} id - Source ID
   * @returns {Promise<boolean>} True if successful
   */
  static async delete(id) {
    await dbRun('DELETE FROM user_sources WHERE id = ?', [id]);
    logger.info(`Source ${id} deleted`);
    return true;
  }

  /**
   * Get source reliability stats
   * @param {number} sourceId - Source ID
   * @returns {Promise<Object|null>} Reliability stats or null
   */
  static async getReliability(sourceId) {
    return await dbGet(`
      SELECT 
        source_id,
        source_name,
        total_scrapes,
        successful_scrapes,
        failed_scrapes,
        total_leads_found,
        average_leads_per_scrape,
        last_scrape_at,
        last_success_at,
        confidence_score
      FROM source_reliability
      WHERE source_id = ?
    `, [sourceId]);
  }

  /**
   * Get reliability stats for all sources of a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} Array of reliability stats
   */
  static async getUserSourcesReliability(userId) {
    const sources = await Source.findByUserId(userId);
    const reliabilityPromises = sources.map(async (source) => {
      const reliability = await Source.getReliability(source.id);
      return {
        ...source,
        reliability
      };
    });
    return await Promise.all(reliabilityPromises);
  }

  /**
   * Count total sources for a user
   * @param {number} userId - User ID
   * @returns {Promise<number>} Source count
   */
  static async countByUserId(userId) {
    const result = await dbGet('SELECT COUNT(*) as count FROM user_sources WHERE user_id = ?', [userId]);
    return result.count;
  }

  /**
   * Validate source configuration
   * @param {Object} sourceData - Source configuration
   * @returns {Object} { valid: boolean, errors: Array<string> }
   */
  static validate(sourceData) {
    const errors = [];
    
    if (!sourceData.name || sourceData.name.trim().length === 0) {
      errors.push('Source name is required');
    }
    
    if (!sourceData.url || sourceData.url.trim().length === 0) {
      errors.push('Source URL is required');
    }
    
    // Validate URL format
    if (sourceData.url) {
      try {
        new URL(sourceData.url);
      } catch (e) {
        errors.push('Invalid URL format');
      }
    }
    
    // Validate requests per minute
    if (sourceData.requestsPerMinute && (sourceData.requestsPerMinute < 1 || sourceData.requestsPerMinute > 60)) {
      errors.push('Requests per minute must be between 1 and 60');
    }
    
    // Validate field mappings if present
    if (sourceData.fieldMappings && typeof sourceData.fieldMappings !== 'object') {
      errors.push('Field mappings must be an object');
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = Source;
