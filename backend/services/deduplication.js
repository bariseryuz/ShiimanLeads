/**
 * UNIVERSAL DEDUPLICATION SYSTEM
 * Works with ANY field schema - no hardcoded field names
 * 
 * Strategy:
 * 1. Auto-detect "important" fields (non-empty, unique-looking)
 * 2. Create fingerprint from field values
 * 3. Use content hash as fallback
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Safely convert any value to string
 */
function safeString(value) {
  try {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'boolean') return value.toString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  } catch (err) {
    return '';
  }
}

/**
 * Generate MD5 hash safely
 */
function safeHash(input) {
  try {
    if (!input || typeof input !== 'string') return '';
    return crypto
      .createHash('md5')
      .update(input.toLowerCase().trim())
      .digest('hex')
      .substring(0, 16);
  } catch (err) {
    return '';
  }
}

/**
 * Normalize a string for comparison (remove punctuation, lowercase, trim)
 */
function normalizeString(str) {
  try {
    const s = safeString(str);
    if (!s || s.length === 0) return '';
    
    return s
      .toLowerCase()
      .trim()
      .replace(/[.,#\-_:;]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err) {
    return '';
  }
}

/**
 * Detect if a field name suggests it's a unique identifier
 * @param {string} fieldName - Field name to check
 * @returns {number} Score (higher = more likely to be unique ID)
 */
function getFieldImportanceScore(fieldName) {
  if (!fieldName) return 0;
  
  const name = fieldName.toLowerCase();
  
  // Primary identifiers (highest priority)
  const primaryKeywords = ['id', 'number', 'permit', 'code', 'reference', 'folio'];
  for (const keyword of primaryKeywords) {
    if (name.includes(keyword)) return 100;
  }
  
  // Unique identifiers (high priority)
  const uniqueKeywords = ['name', 'title', 'university', 'school', 'company', 'address', 'email'];
  for (const keyword of uniqueKeywords) {
    if (name.includes(keyword)) return 80;
  }
  
  // Supporting fields (medium priority)
  const supportKeywords = ['date', 'value', 'amount', 'price', 'fee', 'location', 'state', 'city'];
  for (const keyword of supportKeywords) {
    if (name.includes(keyword)) return 50;
  }
  
  // Generic fields (low priority)
  const genericKeywords = ['description', 'notes', 'comments', 'type', 'status'];
  for (const keyword of genericKeywords) {
    if (name.includes(keyword)) return 20;
  }
  
  // Unknown field
  return 10;
}

/**
 * Extract the most important fields from a lead object
 * @param {Object} lead - Lead object with any fields
 * @returns {Array} Sorted array of {field, value, score}
 */
function extractImportantFields(lead) {
  try {
    if (!lead || typeof lead !== 'object') return [];
    
    const fields = [];
    
    for (const [fieldName, value] of Object.entries(lead)) {
      // Skip internal/metadata fields
      if (fieldName.startsWith('_')) continue;
      
      const strValue = safeString(value).trim();
      
      // Skip empty or very short values
      if (!strValue || strValue.length < 2) continue;
      
      // Skip if value looks like JSON
      if (strValue.startsWith('{') || strValue.startsWith('[')) continue;
      
      const score = getFieldImportanceScore(fieldName);
      
      fields.push({
        field: fieldName,
        value: strValue,
        normalized: normalizeString(strValue),
        score: score
      });
    }
    
    // Sort by score (highest first)
    fields.sort((a, b) => b.score - a.score);
    
    return fields;
    
  } catch (err) {
    logger.error(`❌ extractImportantFields failed: ${err.message}`);
    return [];
  }
}


/**
 * Generate unique ID using universal strategy
 * @param {Object} lead - Lead object with any schema
 * @param {string} strategy - 'smart', 'hash', 'combined'
 * @returns {string|null} Unique ID or null
 */
function generateUniqueId(lead, strategy = 'smart') {
  try {
    if (!lead || typeof lead !== 'object') return null;
    
    const importantFields = extractImportantFields(lead);
    
    if (importantFields.length === 0) {
      logger.warn(`⚠️ No valid fields found in lead`);
      return null;
    }
    
    switch (strategy) {
      case 'smart': {
        // Use the single most important field
        const primary = importantFields[0];
        
        if (primary && primary.score >= 80) {
          // High-confidence unique identifier
          const id = primary.normalized.substring(0, 100);
          logger.debug(`🔑 Generated smart ID from '${primary.field}': ${id}`);
          return id;
        }
        
        return null;
      }
      
      case 'hash': {
        // Hash of top 3 most important fields
        const topFields = importantFields.slice(0, 3);
        const combined = topFields.map(f => f.normalized).join('|');
        
        if (combined.length > 0) {
          const hash = safeHash(combined);
          if (hash) {
            const id = `HASH_${hash}`;
            logger.debug(`🔑 Generated hash ID from ${topFields.length} fields: ${id}`);
            return id;
          }
        }
        
        return null;
      }
      
      case 'combined': {
        // Combine top 2-3 fields
        const topFields = importantFields.slice(0, 3);
        const parts = topFields.map(f => f.normalized.substring(0, 20));
        
        if (parts.length >= 2) {
          const id = parts.join('_').substring(0, 100);
          logger.debug(`🔑 Generated combined ID: ${id}`);
          return id;
        }
        
        return null;
      }
      
      default:
        return null;
    }
    
  } catch (err) {
    logger.error(`❌ generateUniqueId failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate unique ID with automatic fallback (NEVER returns null)
 * @param {Object} lead - Lead object
 * @returns {string} Unique ID (guaranteed)
 */
function generateUniqueIdWithFallback(lead) {
  try {
    // Try strategies in order
    const strategies = ['smart', 'combined', 'hash'];
    
    for (const strategy of strategies) {
      const id = generateUniqueId(lead, strategy);
      if (id) {
        return id;
      }
    }
    
    // Fallback 1: Hash entire object
    logger.warn(`⚠️ Standard strategies failed, using full JSON hash`);
    const json = JSON.stringify(lead);
    const hash = safeHash(json);
    
    if (hash && hash.length > 0) {
      return `FALLBACK_${hash}`;
    }
    
    // Fallback 2: Emergency timestamp-based ID
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const emergency = `EMERGENCY_${timestamp}_${random}`;
    
    logger.warn(`⚠️ Using emergency timestamp ID: ${emergency}`);
    return emergency;
    
  } catch (err) {
    // This should NEVER happen
    logger.error(`❌ CRITICAL: All fallbacks failed: ${err.message}`);
    return `CRITICAL_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}

/**
 * Check if two leads are duplicates (universal comparison)
 * @param {Object} lead1 - First lead
 * @param {Object} lead2 - Second lead
 * @returns {boolean} True if duplicates
 */
function areDuplicates(lead1, lead2) {
  try {
    if (!lead1 || !lead2) return false;
    if (typeof lead1 !== 'object' || typeof lead2 !== 'object') return false;
    
    // Compare important fields from both leads
    const fields1 = extractImportantFields(lead1);
    const fields2 = extractImportantFields(lead2);
    
    if (fields1.length === 0 || fields2.length === 0) return false;
    
    // Strategy 1: Check if top field matches (both normalized)
    if (fields1[0].normalized === fields2[0].normalized && 
        fields1[0].normalized.length >= 5) {
      logger.debug(`✓ Duplicate: Top field match (${fields1[0].field})`);
      return true;
    }
    
    // Strategy 2: Check if top 2 fields match
    if (fields1.length >= 2 && fields2.length >= 2) {
      const match1 = fields1[0].normalized === fields2[0].normalized;
      const match2 = fields1[1].normalized === fields2[1].normalized;
      
      if (match1 && match2) {
        logger.debug(`✓ Duplicate: Top 2 fields match`);
        return true;
      }
    }
    
    // Strategy 3: Content hash comparison
    const hash1 = generateUniqueId(lead1, 'hash');
    const hash2 = generateUniqueId(lead2, 'hash');
    
    if (hash1 && hash2 && hash1 === hash2) {
      logger.debug(`✓ Duplicate: Content hash match`);
      return true;
    }
    
    return false;
    
  } catch (err) {
    logger.error(`❌ areDuplicates failed: ${err.message}`);
    return false; // On error, assume not duplicate (safer)
  }
}

/**
 * Deduplicate an array of leads (universal)
 * @param {Array} leads - Array of lead objects
 * @returns {Object} { unique: Array, duplicates: Array, stats: Object }
 */
function deduplicateBatch(leads) {
  const result = {
    unique: [],
    duplicates: [],
    stats: {
      total: 0,
      unique: 0,
      duplicates: 0,
      errors: 0
    }
  };
  
  try {
    if (!Array.isArray(leads)) {
      logger.error(`❌ deduplicateBatch: Input is not an array`);
      return result;
    }
    
    if (leads.length === 0) {
      return result;
    }
    
    result.stats.total = leads.length;
    logger.info(`🔍 Deduplicating ${leads.length} leads (universal mode)...`);
    
    const seenIds = new Set();
    
    for (let i = 0; i < leads.length; i++) {
      try {
        const lead = leads[i];
        
        if (!lead || typeof lead !== 'object') {
          logger.warn(`⚠️ Skipping invalid lead at index ${i}`);
          result.stats.errors++;
          continue;
        }
        
        // Generate universal unique ID
        const uniqueId = generateUniqueIdWithFallback(lead);
        
        // Check if duplicate
        if (seenIds.has(uniqueId)) {
          logger.info(`♻️ Duplicate #${result.duplicates.length + 1}: ${uniqueId.substring(0, 50)}`);
          result.duplicates.push({
            lead: lead,
            uniqueId: uniqueId,
            reason: 'Duplicate ID',
            index: i
          });
          result.stats.duplicates++;
        } else {
          seenIds.add(uniqueId);
          result.unique.push(lead);
          result.stats.unique++;
        }
        
      } catch (leadErr) {
        logger.error(`❌ Error processing lead ${i}: ${leadErr.message}`);
        result.stats.errors++;
      }
    }
    
    const rate = result.stats.total > 0 
      ? ((result.stats.duplicates / result.stats.total) * 100).toFixed(1)
      : '0.0';
    
    logger.info(`✅ Deduplication complete: ${result.stats.unique} unique, ${result.stats.duplicates} duplicates (${rate}%)`);
    
    return result;
    
  } catch (err) {
    logger.error(`❌ deduplicateBatch CRITICAL: ${err.message}`);
    return {
      unique: [],
      duplicates: [],
      stats: { total: 0, unique: 0, duplicates: 0, errors: 1 }
    };
  }
}

/**
 * Get human-readable info about what fields were used for deduplication
 * @param {Object} lead - Lead object
 * @returns {Object} Info about detected fields
 */
function getDeduplicationInfo(lead) {
  try {
    const fields = extractImportantFields(lead);
    
    return {
      totalFields: Object.keys(lead).length,
      importantFields: fields.length,
      topField: fields[0] || null,
      strategy: fields.length > 0 ? 'field-based' : 'hash-based',
      uniqueId: generateUniqueIdWithFallback(lead)
    };
  } catch (err) {
    return {
      totalFields: 0,
      importantFields: 0,
      topField: null,
      strategy: 'error',
      uniqueId: null
    };
  }
}

module.exports = {
  generateUniqueId,
  generateUniqueIdWithFallback,
  areDuplicates,
  deduplicateBatch,
  extractImportantFields,
  getDeduplicationInfo,
  safeString,
  safeHash,
  normalizeString
};
