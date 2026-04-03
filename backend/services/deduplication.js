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
  
  // ✅ CRITICAL: Normalize field name (remove underscores/hyphens)
  const name = fieldName.toLowerCase().replace(/[_-]/g, '');
  
  // 🚫 BLACKLIST: Explicitly downgrade non-unique fields
  if (name.includes('permittype') || name === 'type' || name === 'category' || name === 'status') {
    return 5;  // Very low score
  }
  
  // Primary identifiers (highest priority)
  const primaryKeywords = ['id', 'number', 'permitnumber', 'licensenumber', 'code', 'reference', 'folio'];
  for (const keyword of primaryKeywords) {
    if (name.includes(keyword)) return 100;
  }
  
  // Unique identifiers (high priority) - Check for "address" OR "adress" (typo)
  const uniqueKeywords = ['address', 'adress', 'email', 'phone', 'location'];
  for (const keyword of uniqueKeywords) {
    if (name.includes(keyword)) return 90;
  }
  
  // Name fields (medium-high priority)
  const nameKeywords = ['name', 'title', 'university', 'school', 'company', 'contractor', 'constructor'];
  for (const keyword of nameKeywords) {
    if (name.includes(keyword)) return 70;
  }
  
  // Value/Amount fields (medium priority)
  const valueKeywords = ['cost', 'value', 'amount', 'price', 'fee'];
  for (const keyword of valueKeywords) {
    if (name.includes(keyword)) return 50;
  }
  
  // Date/Location fields (medium-low priority)
  const supportKeywords = ['date', 'time', 'state', 'city', 'county'];
  for (const keyword of supportKeywords) {
    if (name.includes(keyword)) return 40;
  }
  
  // Generic fields (low priority)
  const genericKeywords = ['description', 'notes', 'comments'];
  for (const keyword of genericKeywords) {
    if (name.includes(keyword)) return 15;
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
    
    // 🚫 BLACKLIST: Skip fields that are commonly non-unique
    const BLACKLIST = [
      'permit_type',
      'type',
      'category',
      'status',
      'description',
      'notes'
    ];
    
    for (const [fieldName, value] of Object.entries(lead)) {
      // Skip internal/metadata fields
      if (fieldName.startsWith('_')) continue;
      
      // 🚫 SKIP BLACKLISTED FIELDS
      const fieldLower = fieldName.toLowerCase().replace(/[_-]/g, '');
      const isBlacklisted = BLACKLIST.some(banned => 
        fieldLower.includes(banned.toLowerCase().replace(/[_-]/g, ''))
      );
      
      if (isBlacklisted) {
        logger.debug(`   ⏭️  Skipping blacklisted field: ${fieldName}`);
        continue;
      }
      
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
    
    // 🐛 DEBUG: Show top 3 fields chosen
    if (fields.length > 0) {
      logger.info(`   📊 Top fields for deduplication:`);
      fields.slice(0, 3).forEach((f, i) => {
        logger.info(`      ${i + 1}. ${f.field} (score: ${f.score}): "${f.value.substring(0, 40)}..."`);
      });
    }
    
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
        
        if (primary && primary.score >= 70) {  // ← Lowered from 80 to catch more fields
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
 * Resolve manifest `primary_id_field` (final field name after mapping) from lead or _raw.
 * @param {Object} lead
 * @param {string} fieldName
 * @returns {*}
 */
function resolvePrimaryIdValue(lead, fieldName) {
  if (!fieldName || !lead || typeof lead !== 'object') return undefined;
  const v = lead[fieldName];
  if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  if (lead._raw && typeof lead._raw === 'object') {
    const r = lead._raw[fieldName];
    if (r !== undefined && r !== null && String(r).trim() !== '') return r;
  }
  return undefined;
}

/**
 * Generate unique ID with automatic fallback (NEVER returns null)
 * @param {Object} lead - Lead object
 * @param {Object} [options] - { primaryIdField?, primary_id_field? } from manifest (explicit anchor field)
 * @returns {string} Unique ID (guaranteed)
 */
function generateUniqueIdWithFallback(lead, options = {}) {
  try {
    const primaryField = options.primaryIdField || options.primary_id_field;
    if (primaryField) {
      const rawVal = resolvePrimaryIdValue(lead, primaryField);
      if (rawVal !== undefined && rawVal !== null) {
        const s = safeString(rawVal).trim();
        if (s.length > 0) {
          const norm = normalizeString(s);
          const body = (norm && norm.length > 0 ? norm : s).substring(0, 120);
          const id = `anchor:${primaryField}:${body}`;
          logger.debug(`🔑 Manifest primary_id_field '${primaryField}' → unique_id`);
          return id.length > 512 ? id.substring(0, 512) : id;
        }
      }
      logger.warn(
        `⚠️ primary_id_field "${primaryField}" missing or empty on lead; falling back to smart dedupe`
      );
    }

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
/**
 * Phase-1 optional fingerprint: MD5(lower(url) | lower(title)) for cross-source dedup per user.
 * Does not replace unique_id; used as an extra skip rule when both url and title-like fields exist.
 * @param {Object} lead
 * @param {string} [sourceUrl] - fallback URL from source config
 * @returns {string|null} 32-char hex or null if insufficient data
 */
function generateLeadFingerprint(lead, sourceUrl) {
  try {
    if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return null;
    const url = String(lead.url || lead.sourceUrl || lead.source_url || sourceUrl || '').trim();
    const title = String(
      lead.title ||
        lead.name ||
        lead.Permit__ ||
        lead.Permit_ ||
        lead.permit_number ||
        lead.address ||
        ''
    ).trim();
    if (!url && !title) return null;
    const payload = `${url.toLowerCase()}|${title.toLowerCase()}`;
    return crypto.createHash('md5').update(payload).digest('hex');
  } catch {
    return null;
  }
}

function getDeduplicationInfo(lead, options = {}) {
  try {
    const fields = extractImportantFields(lead);
    const primaryField = options.primaryIdField || options.primary_id_field;
    return {
      totalFields: Object.keys(lead).length,
      importantFields: fields.length,
      topField: fields[0] || null,
      strategy: primaryField ? 'manifest-primary_id_field' : fields.length > 0 ? 'field-based' : 'hash-based',
      uniqueId: generateUniqueIdWithFallback(lead, options)
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
  resolvePrimaryIdValue,
  safeString,
  safeHash,
  normalizeString,
  generateLeadFingerprint
};