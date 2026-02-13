const { generateUniqueIdWithFallback, getDeduplicationInfo } = require('./deduplication');
const { dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * Insert lead if new (universal schema support)
 * Works with ANY field structure - permits, universities, products, real estate, etc.
 */
async function insertLeadIfNew({ raw, sourceName, lead, extractedData, userId, sourceId, sourceUrl }) {
  try {
    // Validate
    if (!lead || typeof lead !== 'object') {
      logger.error(`❌ Invalid lead object`);
      return false;
    }
    
    if (!userId || !sourceId) {
      logger.error(`❌ Missing userId (${userId}) or sourceId (${sourceId})`);
      return false;
    }
    
    const data = extractedData || lead;
    
    // Get deduplication info (for logging)
    const dedupInfo = getDeduplicationInfo(data);
    logger.debug(`🔍 Deduplication using: ${dedupInfo.strategy}, top field: ${dedupInfo.topField?.field || 'none'}`);
    
    // Generate universal unique ID
    const uniqueId = generateUniqueIdWithFallback(data);
    logger.info(`🔑 Unique ID: ${uniqueId.substring(0, 60)}`);
    
    // Check duplicate
    const existing = await dbGet(
      'SELECT id FROM leads WHERE user_id = ? AND source_id = ? AND unique_id = ?',
      [userId, sourceId, uniqueId]
    ).catch(err => {
      logger.error(`❌ DB query failed: ${err.message}`);
      return null;
    });
    
    if (existing) {
      logger.info(`♻️ Duplicate: ${uniqueId.substring(0, 60)}`);
      
      // Try to update seen_count if column exists
      try {
        await dbRun(
          `UPDATE leads 
           SET seen_count = COALESCE(seen_count, 0) + 1,
               last_seen_at = CURRENT_TIMESTAMP 
           WHERE id = ?`,
          [existing.id]
        ).catch(() => {
          // Column might not exist, ignore
        });
      } catch (updateErr) {
        // Ignore - column might not exist
      }
      
      return false;
    }
    
    // Extract first few important fields for storage
    const importantFields = dedupInfo.topField 
      ? { [dedupInfo.topField.field]: dedupInfo.topField.value }
      : {};
    
    // Prepare flexible field mapping
    const allFields = Object.keys(data);
    const field1 = allFields[0] ? data[allFields[0]] : null;
    const field2 = allFields[1] ? data[allFields[1]] : null;
    const field3 = allFields[2] ? data[allFields[2]] : null;
    
    // Insert
    const result = await dbRun(
      `INSERT INTO leads (
        user_id, source_id, source_name, unique_id, raw_data,
        permit_number, address, estimated_value, description,
        application_date, phone, page_url, is_new, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [
        userId,
        sourceId,
        sourceName || 'unknown',
        uniqueId,
        typeof raw === 'string' ? raw : JSON.stringify(raw || data),
        field1 || null,  // Store first field in permit_number column
        field2 || null,  // Store second field in address column
        field3 || null,  // Store third field in estimated_value column
        JSON.stringify(importantFields).substring(0, 200) || null,
        new Date().toISOString(),
        null,
        sourceUrl || null
      ]
    ).catch(err => {
      logger.error(`❌ DB insert failed: ${err.message}`);
      return null;
    });
    
    if (result && result.lastID) {
      logger.info(`✅ Inserted (row ${result.lastID})`);
      return true;
    }
    
    return false;
    
  } catch (err) {
    logger.error(`❌ insertLeadIfNew ERROR: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    return false;
  }
}

module.exports = {
  insertLeadIfNew
};
