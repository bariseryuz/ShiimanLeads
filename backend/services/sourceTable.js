const { db } = require('../db');
const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Create a source-specific table for storing leads
 * @param {number} sourceId - Source ID
 * @param {object} fieldSchema - Field schema from source configuration
 * @returns {string} Table name created
 */
function createSourceTable(sourceId, fieldSchema) {
  const tableName = `source_${sourceId}`;
  
  // Base columns that every source table has
  const baseColumns = [
    'id INTEGER PRIMARY KEY AUTOINCREMENT',
    'user_id INTEGER DEFAULT 1',
    'raw_text TEXT',
    'page_url TEXT',
    'hash TEXT UNIQUE',
    'source_name TEXT',
    'created_at DATETIME DEFAULT CURRENT_TIMESTAMP'
  ];
  
  // Add custom fields from fieldSchema
  const customColumns = [];
  if (fieldSchema && typeof fieldSchema === 'object') {
    Object.keys(fieldSchema).forEach(fieldName => {
      customColumns.push(`${fieldName} TEXT`);
    });
  }
  
  // Combine all columns
  const allColumns = [...baseColumns, ...customColumns];
  const createSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${allColumns.join(', ')})`;
  
  logger.info(`📊 Creating source table: ${tableName} with ${customColumns.length} custom fields`);
  db.exec(createSQL);
  
  return tableName;
}

/**
 * Insert lead into source-specific table (synchronous for transaction use)
 * @param {number} sourceId - Source ID
 * @param {number} userId - User ID
 * @param {string} rawText - Raw text extracted from source
 * @param {object} lead - Lead data
 * @param {object} extractedData - Extracted/formatted data
 * @returns {boolean} Success status
 */
function insertIntoSourceTableSync(sourceId, userId, rawText, lead, extractedData) {
  // Validate table name to prevent SQL injection
  const tableName = `source_${sourceId}`;
  if (!/^source_\d+$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  
  try {
    // Check if table exists, create if missing
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
    if (!tableExists) {
      logger.warn(`Table ${tableName} doesn't exist - creating it now with source's fieldSchema`);
      
      // Fetch the source config to get fieldSchema
      const sourceRow = db.prepare(`SELECT source_data FROM user_sources WHERE id = ?`).get(sourceId);
      let fieldSchema = null;
      if (sourceRow) {
        try {
          const sourceConfig = JSON.parse(sourceRow.source_data);
          fieldSchema = sourceConfig.fieldSchema || null;
        } catch (parseErr) {
          logger.warn(`Failed to parse source config for source_${sourceId}: ${parseErr.message}`);
        }
      }
      
      createSourceTable(sourceId, fieldSchema);
    }
    
    // Get table columns to determine available fields
    const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const columns = tableInfo.map(col => col.name);
    
    // Build dynamic insert based on available columns
    const values = {};
    values.user_id = userId;
    values.raw_text = rawText;
    values.page_url = lead.page_url || '';
    values.source_name = lead.source_name || '';
    
    // Map extractedData to available columns
    if (extractedData) {
      for (const [key, value] of Object.entries(extractedData)) {
        if (columns.includes(key) && key !== '_aiConfidence' && key !== '_validationIssues') {
          values[key] = value;
        }
      }
    }
    
    // Generate hash for this source-specific table
    const hash = crypto.createHash('md5').update(`${rawText}${sourceId}`).digest('hex');
    if (columns.includes('_hash')) {
      values._hash = hash;
    } else if (columns.includes('hash')) {
      values.hash = hash;
    }
    
    // Build INSERT statement
    const columnNames = Object.keys(values).join(', ');
    const placeholders = Object.keys(values).map(() => '?').join(', ');
    const insertSQL = `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
    
    logger.debug(`📋 Inserting into ${tableName}:`);
    Object.entries(values).forEach(([col, val]) => {
      const display = val ? String(val).substring(0, 40) : '[EMPTY]';
      logger.debug(`   - ${col}: ${display}`);
    });
    
    const result = db.prepare(insertSQL).run(...Object.values(values));
    
    if (result.changes > 0) {
      logger.info(`✅ Inserted into ${tableName} (row ${result.lastInsertRowid})`);
      return true;
    } else {
      logger.warn(`⚠️ No rows inserted into ${tableName} - possible duplicate or constraint violation`);
      return false;
    }
  } catch (err) {
    logger.error(`Failed to insert into ${tableName}: ${err.message}`);
    return false;
  }
}

/**
 * Async wrapper for backwards compatibility
 */
async function insertIntoSourceTable(sourceId, userId, rawText, lead, extractedData) {
  return insertIntoSourceTableSync(sourceId, userId, rawText, lead, extractedData);
}

module.exports = {
  createSourceTable,
  insertIntoSourceTableSync,
  insertIntoSourceTable
};
