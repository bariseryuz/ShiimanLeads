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
    
    try {
      // Check duplicate
      const existing = await dbGet(
        'SELECT id FROM leads WHERE user_id = ? AND source_id = ? AND unique_id = ?',
        [userId, sourceId, uniqueId]
      );
      
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
          );
        } catch (updateErr) {
          // Column might not exist or update failed, ignore
          logger.debug(`⚠️ Could not update seen_count: ${updateErr.message}`);
        }
        
        return false;
      }
    } catch (queryErr) {
      logger.error(`❌ DB query failed: ${queryErr.message}`);
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
    try {
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
          JSON.stringify(data),  // Store full extracted data as JSON
          field1 || null,
          field2 || null,
          field3 || null,
          JSON.stringify(importantFields).substring(0, 200) || null,
          new Date().toISOString(),
          null,
          sourceUrl || null
        ]
      );
      
      if (result && result.lastInsertRowid) {
        logger.info(`✅ Inserted (row ${result.lastInsertRowid})`);
        return true;
      }
      
      logger.error(`❌ Insert failed: No result returned`);
      return false;
      
    } catch (insertErr) {
      logger.error(`❌ DB insert failed: ${insertErr.message}`);
      return false;
    }
    
  } catch (err) {
    logger.error(`❌ insertLeadIfNew ERROR: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    return false;
  }
}

module.exports = {
  insertLeadIfNew
};
