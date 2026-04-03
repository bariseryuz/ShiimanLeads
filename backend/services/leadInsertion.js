const {
  generateUniqueIdWithFallback,
  getDeduplicationInfo,
  generateLeadFingerprint
} = require('./deduplication');
const { dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const { scoreLeadWithSignalBrain, getSignalScoreThreshold } = require('./ai');
const { onNewLead, onHighPrioritySignal } = require('./alerts');
const { enqueueEnrichmentForHotLead, pickCompanyName } = require('./enrichment');

/**
 * Insert lead if new (universal schema support)
 * Works with ANY field structure - permits, universities, products, real estate, etc.
 */
async function insertLeadIfNew({
  raw,
  sourceName,
  lead,
  extractedData,
  userId,
  sourceId,
  sourceUrl,
  primaryIdField,
  primary_id_field
}) {
  try {
    // Validate (arrays are typeof 'object' but not valid lead rows)
    if (lead == null || typeof lead !== 'object' || Array.isArray(lead)) {
      logger.error(
        `❌ Invalid lead object (expected plain object; got ${lead === null ? 'null' : Array.isArray(lead) ? 'array' : typeof lead})` +
          (typeof lead === 'string' || typeof lead === 'number'
            ? ` preview=${String(lead).slice(0, 80)}`
            : '')
      );
      return false;
    }
    
    if (!userId || !sourceId) {
      logger.error(`❌ Missing userId (${userId}) or sourceId (${sourceId})`);
      return false;
    }
    
    const data = extractedData || lead;
    
    // Get deduplication info (for logging)
    const idOpts = {
      primaryIdField: primaryIdField || primary_id_field
    };
    const dedupInfo = getDeduplicationInfo(data, idOpts);
    logger.debug(`🔍 Deduplication using: ${dedupInfo.strategy}, top field: ${dedupInfo.topField?.field || 'none'}`);
    
    // Generate universal unique ID (manifest primary_id_field when set)
    const uniqueId = generateUniqueIdWithFallback(data, idOpts);
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

    const fingerprint = generateLeadFingerprint(data, sourceUrl);
    if (fingerprint) {
      try {
        const existingFp = await dbGet(
          'SELECT id FROM leads WHERE user_id = ? AND fingerprint = ?',
          [userId, fingerprint]
        );
        if (existingFp) {
          logger.info(`♻️ Duplicate (fingerprint): ${fingerprint.substring(0, 16)}…`);
          try {
            await dbRun(
              `UPDATE leads SET seen_count = COALESCE(seen_count, 0) + 1, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [existingFp.id]
            );
          } catch (_) {}
          return false;
        }
      } catch (fpErr) {
        logger.debug(`Fingerprint check skipped: ${fpErr.message}`);
      }
    }
    
    // ✅ UNIVERSAL INSERT - Only essential columns
    try {
      const result = await dbRun(
        `INSERT INTO leads (
          user_id, source_id, source_name, unique_id, 
          raw_data, is_new, created_at,
          fingerprint, priority_score, ai_summary, status
        ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
        [
          userId,
          sourceId,
          sourceName || 'unknown',
          uniqueId,
          JSON.stringify(data), // Store ALL extracted data as JSON
          fingerprint,
          null,
          null,
          'New'
        ]
      );
      
      if (result && result.lastInsertRowid) {
        const leadId = result.lastInsertRowid;
        logger.info(`✅ Inserted (row ${leadId})`);
        const preview =
          typeof data === 'object' && data !== null
            ? (data.address || data.name || data.title || data.id || '').toString().slice(0, 120)
            : '';
        let leadPreview = preview || undefined;
        try {
          const scored = await scoreLeadWithSignalBrain(userId, data);
          if (scored) {
            try {
              await dbRun(
                `UPDATE leads SET priority_score = ?, ai_summary = ?, contact_name = ? WHERE id = ? AND user_id = ?`,
                [scored.score, scored.reason, scored.contact_name || null, leadId, userId]
              );
            } catch (upErr) {
              if (upErr.message && upErr.message.includes('no such column')) {
                await dbRun(
                  `UPDATE leads SET priority_score = ?, ai_summary = ? WHERE id = ? AND user_id = ?`,
                  [scored.score, scored.reason, leadId, userId]
                );
              } else {
                logger.debug(`SignalBrain update: ${upErr.message}`);
              }
            }
            if (scored.score > getSignalScoreThreshold()) {
              onHighPrioritySignal({
                userId,
                leadId,
                sourceName: sourceName || 'unknown',
                score: scored.score,
                reason: scored.reason,
                contactName: scored.contact_name,
                companyName: pickCompanyName(data),
                leadPreview: preview || undefined
              }).catch(() => {});
              enqueueEnrichmentForHotLead({ userId, leadId, data });
            }
            leadPreview =
              (`${preview} [Signal: ${scored.score}/10]`.trim() || `[Signal: ${scored.score}/10]`) || undefined;
          }
        } catch (sigErr) {
          logger.debug(`SignalBrain: ${sigErr.message}`);
        }
        onNewLead({ userId, sourceName: sourceName || 'unknown', leadCount: 1, leadPreview }).catch(() => {});
        return true;
      }
      
      logger.error(`❌ Insert failed: No result returned`);
      return false;
      
    } catch (insertErr) {
      const msg = insertErr.message || '';
      if (msg.includes('no such column')) {
        try {
          const result = await dbRun(
            `INSERT INTO leads (
              user_id, source_id, source_name, unique_id,
              raw_data, is_new, created_at
            ) VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
            [
              userId,
              sourceId,
              sourceName || 'unknown',
              uniqueId,
              JSON.stringify(data)
            ]
          );
          if (result && result.lastInsertRowid) {
            logger.info(`✅ Inserted (row ${result.lastInsertRowid}, legacy columns)`);
            const preview =
              typeof data === 'object' && data !== null
                ? (data.address || data.name || data.title || data.id || '').toString().slice(0, 120)
                : '';
            onNewLead({
              userId,
              sourceName: sourceName || 'unknown',
              leadCount: 1,
              leadPreview: preview || undefined
            }).catch(() => {});
            return true;
          }
        } catch (legacyErr) {
          logger.error(`❌ DB insert failed: ${legacyErr.message}`);
          return false;
        }
      } else {
        logger.error(`❌ DB insert failed: ${insertErr.message}`);
      }
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