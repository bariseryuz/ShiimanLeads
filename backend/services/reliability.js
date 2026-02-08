const { dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * Track source reliability for monitoring and alerts
 * @param {number} sourceId - Source ID
 * @param {string} sourceName - Source name for logging
 * @param {boolean} success - Whether the scrape was successful
 * @param {number} extractedCount - Number of leads extracted
 */
async function trackSourceReliability(sourceId, sourceName, success, extractedCount = 0) {
  try {
    // Check if source exists in reliability table
    const existing = await dbGet('SELECT * FROM source_reliability WHERE source_id = ?', [sourceId]);
    
    if (!existing) {
      // Create new entry
      await dbRun(`
        INSERT INTO source_reliability (source_id, source_name, success_count, failure_count, total_leads, avg_leads_per_run, last_success, last_failure, confidence_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sourceId, sourceName, success ? 1 : 0, success ? 0 : 1, extractedCount, extractedCount, 
         success ? new Date().toISOString() : null, 
         success ? null : new Date().toISOString(), 
         success ? 100.0 : 0.0]
      );
      logger.info(`📊 Created reliability tracking for source ${sourceName}`);
    } else {
      // Update existing entry
      const newSuccessCount = existing.success_count + (success ? 1 : 0);
      const newFailureCount = existing.failure_count + (success ? 0 : 1);
      const newTotalLeads = existing.total_leads + extractedCount;
      const totalRuns = newSuccessCount + newFailureCount;
      const newConfidence = totalRuns > 0 ? (newSuccessCount * 100.0 / totalRuns) : 0.0;
      const newAvgLeads = newSuccessCount > 0 ? (newTotalLeads / newSuccessCount) : 0.0;
      
      await dbRun(`
        UPDATE source_reliability SET
          success_count = ?,
          failure_count = ?,
          total_leads = ?,
          avg_leads_per_run = ?,
          confidence_score = ?,
          last_success = ?,
          last_failure = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE source_id = ?`,
        [newSuccessCount, newFailureCount, newTotalLeads, newAvgLeads, newConfidence,
         success ? new Date().toISOString() : existing.last_success,
         success ? existing.last_failure : new Date().toISOString(),
         sourceId]
      );
      
      // Log stats
      logger.info(`📊 ${sourceName} reliability: ${newConfidence.toFixed(1)}% (${newSuccessCount}/${totalRuns} runs, avg ${newAvgLeads.toFixed(1)} leads/run)`);
      
      // Alert if confidence drops below 70%
      if (newConfidence < 70 && totalRuns >= 3) {
        logger.warn(`⚠️ ALERT: ${sourceName} reliability dropped to ${newConfidence.toFixed(1)}% - may need attention!`);
      }
    }
  } catch (e) {
    logger.error(`Failed to track source reliability: ${e.message}`);
  }
}

module.exports = { trackSourceReliability };
