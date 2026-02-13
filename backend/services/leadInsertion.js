/**
 * Lead Insertion Service (Bulletproof)
 * Uses deduplication.js for zero-error deduplication
 */

const { generateUniqueIdWithFallback } = require('./deduplication');
const { db } = require('../db');
const logger = require('../utils/logger');

/**
 * Insert lead if it's new (not a duplicate)
 * BULLETPROOF: Never throws errors
 */
async function insertLeadIfNew({ raw, sourceName, lead, extractedData, userId, sourceId, sourceUrl }) {
  try {
    // Validate inputs
    if (!lead || typeof lead !== 'object') {
      logger.error(`❌ insertLeadIfNew: Invalid lead object`);
      return false;
    }
    
    if (!userId || !sourceId) {
      logger.error(`❌ insertLeadIfNew: Missing userId or sourceId`);
      return false;
    }
    
    // Generate unique ID with guaranteed fallback
    const uniqueId = generateUniqueIdWithFallback(extractedData || lead);
    
    logger.info(`🔑 Unique ID: ${uniqueId}`);
    
    try {
      // Check for duplicate
      const existing = db.prepare(
        'SELECT id, seen_count FROM leads WHERE user_id = ? AND unique_id = ?'
      ).get(userId, uniqueId);
      
      if (existing) {
        const seenCount = (existing.seen_count || 0) + 1;
        logger.info(`♻️ Duplicate: ${uniqueId} (seen ${seenCount} times)`);
        
        // Update seen count
        try {
          db.prepare(
            'UPDATE leads SET seen_count = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?'
          ).run(seenCount, existing.id);
        } catch (updateErr) {
          logger.error(`❌ Failed to update seen count: ${updateErr.message}`);
        }
        
        return false;
      }
    } catch (queryErr) {
      logger.error(`❌ Database query failed: ${queryErr.message}`);
      logger.error(`Stack: ${queryErr.stack}`);
      return false;
    }
    
    // Prepare data for insertion
    const data = extractedData || lead;
    
    const permitNumber = data.permit_number || data.permitNumber || data.Permit__ || null;
    const address = data.address || data.Address || null;
    const estimatedValue = data.estimated_value || data.estimatedValue || data.Value || null;
    const description = data.description || data.Description || null;
    const applicationDate = data.application_date || data.applicationDate || data.Date || null;
    const phone = data.phone || data.Phone || null;
    
    // Insert new lead
    try {
      const result = db.prepare(
        `INSERT INTO leads (
          user_id, source_id, source_name, unique_id, raw_data,
          permit_number, address, estimated_value, description,
          application_date, phone, page_url, is_new, seen_count,
          created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(
        userId,
        sourceId,
        sourceName || 'unknown',
        uniqueId,
        typeof raw === 'string' ? raw : JSON.stringify(raw || lead),
        permitNumber,
        address,
        estimatedValue,
        description,
        applicationDate,
        phone,
        sourceUrl || null
      );
      
      if (result && result.lastInsertRowid) {
        logger.info(`✅ Inserted new lead (row ${result.lastInsertRowid}): ${uniqueId}`);
        return true;
      }
      
      logger.error(`❌ Insert failed: No result returned`);
      return false;
      
    } catch (insertErr) {
      logger.error(`❌ Database insert failed: ${insertErr.message}`);
      logger.error(`Stack: ${insertErr.stack}`);
      return false;
    }
    
  } catch (err) {
    logger.error(`❌ insertLeadIfNew CRITICAL ERROR: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    return false;
  }
}

module.exports = {
  insertLeadIfNew
};
