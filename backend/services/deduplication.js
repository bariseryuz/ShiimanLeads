/**
 * BULLETPROOF DEDUPLICATION SYSTEM
 * 
 * Designed for zero-error tolerance with:
 * - Complete null/undefined checks
 * - Try-catch on every operation
 * - Fallback strategies
 * - Detailed error logging
 * - Safe type coercion
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Safely convert any value to string
 * @param {*} value - Any value
 * @returns {string} String representation, never null/undefined
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
    logger.warn(`⚠️ safeString failed for value: ${typeof value}, returning empty string`);
    return '';
  }
}

/**
 * Normalize address with complete error handling
 * @param {*} address - Any address value
 * @returns {string} Normalized address, never fails
 */
function normalizeAddress(address) {
  try {
    const addr = safeString(address);
    
    if (!addr || addr.length === 0) return '';
    
    return addr
      .toLowerCase()
      .trim()
      .replace(/[.,#\-_]/g, ' ')
      .replace(/\bstreet\b/gi, 'st')
      .replace(/\bstrt\b/gi, 'st')
      .replace(/\bavenue\b/gi, 'ave')
      .replace(/\bav\b/gi, 'ave')
      .replace(/\broad\b/gi, 'rd')
      .replace(/\bboulevard\b/gi, 'blvd')
      .replace(/\bblvd\b/gi, 'blvd')
      .replace(/\bdrive\b/gi, 'dr')
      .replace(/\blane\b/gi, 'ln')
      .replace(/\bcourt\b/gi, 'ct')
      .replace(/\bcircle\b/gi, 'cir')
      .replace(/\bplace\b/gi, 'pl')
      .replace(/\bapartment\b/gi, 'apt')
      .replace(/\bsuite\b/gi, 'ste')
      .replace(/\s+/g, ' ')
      .trim();
      
  } catch (err) {
    logger.error(`❌ normalizeAddress failed: ${err.message}`);
    return '';
  }
}

/**
 * Extract permit number from lead with ALL possible field names
 * @param {Object} lead - Lead object
 * @returns {string|null} Permit number or null
 */
function extractPermitNumber(lead) {
  try {
    if (!lead || typeof lead !== 'object') return null;
    
    const possibleFields = [
      'permit_number',
      'permitNumber',
      'permit',
      'Permit__',
      'PermitNumber',
      'PERMIT_NUMBER',
      'process_number',
      'processNumber',
      'ProcessNumber',
      'master_permit_number',
      'masterPermitNumber',
      'MasterPermitNumber',
      'permit_id',
      'permitId',
      'PermitID',
      'application_number',
      'applicationNumber',
      'ApplicationNumber',
      'folio',
      'Folio',
      'FOLIO'
    ];
    
    for (const field of possibleFields) {
      const value = lead[field];
      if (value !== null && value !== undefined && value !== '') {
        const str = safeString(value).trim();
        if (str.length > 0) {
          return str;
        }
      }
    }
    
    return null;
    
  } catch (err) {
    logger.error(`❌ extractPermitNumber failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract address from lead with ALL possible field names
 * @param {Object} lead - Lead object
 * @returns {string|null} Address or null
 */
function extractAddress(lead) {
  try {
    if (!lead || typeof lead !== 'object') return null;
    
    const possibleFields = [
      'address',
      'Address',
      'ADDRESS',
      'street_address',
      'streetAddress',
      'StreetAddress',
      'location',
      'Location',
      'site_address',
      'siteAddress',
      'SiteAddress',
      'property_address',
      'propertyAddress',
      'PropertyAddress'
    ];
    
    for (const field of possibleFields) {
      const value = lead[field];
      if (value !== null && value !== undefined && value !== '') {
        const str = safeString(value).trim();
        if (str.length > 5) {
          return str;
        }
      }
    }
    
    return null;
    
  } catch (err) {
    logger.error(`❌ extractAddress failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate MD5 hash safely
 * @param {string} input - Input string
 * @returns {string} MD5 hash or empty string on error
 */
function safeHash(input) {
  try {
    if (!input || typeof input !== 'string') return '';
    
    return crypto
      .createHash('md5')
      .update(input.toLowerCase().trim())
      .digest('hex')
      .substring(0, 12);
      
  } catch (err) {
    logger.error(`❌ safeHash failed: ${err.message}`);
    return '';
  }
}

/**
 * Generate unique ID with multiple fallback strategies
 * GUARANTEED to never throw an error
 * 
 * @param {Object} lead - Lead object
 * @param {string} strategy - 'permit', 'address', 'hash', 'combined'
 * @returns {string|null} Unique ID or null if impossible to generate
 */
function generateUniqueId(lead, strategy = 'permit') {
  try {
    if (!lead || typeof lead !== 'object') {
      logger.warn(`⚠️ generateUniqueId: Invalid lead object`);
      return null;
    }
    
    switch (strategy) {
      case 'permit': {
        const permit = extractPermitNumber(lead);
        if (permit) {
          logger.debug(`🔑 Generated permit ID: ${permit}`);
          return permit;
        }
        return null;
      }
      
      case 'address': {
        const address = extractAddress(lead);
        if (address) {
          const normalized = normalizeAddress(address);
          if (normalized && normalized.length >= 10) {
            const id = `ADDR_${safeHash(normalized)}`;
            logger.debug(`🔑 Generated address ID: ${id}`);
            return id;
          }
        }
        return null;
      }
      
      case 'hash': {
        const parts = [];
        
        const permit = extractPermitNumber(lead);
        if (permit) parts.push(safeString(permit));
        
        const address = extractAddress(lead);
        if (address) parts.push(normalizeAddress(address));
        
        const value = lead.estimated_value || lead.estimatedValue || lead.Value;
        if (value) {
          const cleanValue = safeString(value).replace(/[^0-9]/g, '');
          if (cleanValue) parts.push(cleanValue);
        }
        
        const date = lead.application_date || lead.applicationDate || lead.Date;
        if (date) {
          const cleanDate = safeString(date).replace(/[^0-9]/g, '').substring(0, 8);
          if (cleanDate) parts.push(cleanDate);
        }
        
        if (parts.length > 0) {
          const combined = parts.join('|');
          const hash = safeHash(combined);
          if (hash) {
            const id = `HASH_${hash}`;
            logger.debug(`🔑 Generated hash ID: ${id}`);
            return id;
          }
        }
        
        return null;
      }
      
      case 'combined': {
        const parts = [];
        
        const permit = extractPermitNumber(lead);
        if (permit) {
          parts.push(safeString(permit).substring(0, 20));
        }
        
        const address = extractAddress(lead);
        if (address) {
          const normalized = normalizeAddress(address);
          parts.push(normalized.substring(0, 20));
        }
        
        const value = lead.estimated_value || lead.estimatedValue || lead.Value;
        if (value) {
          const cleanValue = safeString(value).replace(/[^0-9]/g, '');
          if (cleanValue) parts.push(cleanValue.substring(0, 10));
        }
        
        if (parts.length >= 2) {
          const id = parts.join('_').substring(0, 50);
          logger.debug(`🔑 Generated combined ID: ${id}`);
          return id;
        }
        
        return null;
      }
      
      default:
        logger.warn(`⚠️ Unknown strategy: ${strategy}`);
        return null;
    }
    
  } catch (err) {
    logger.error(`❌ generateUniqueId failed with strategy '${strategy}': ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    return null;
  }
}

/**
 * Generate unique ID with automatic fallback through all strategies
 * GUARANTEED to return a string (never null)
 * 
 * @param {Object} lead - Lead object
 * @returns {string} Unique ID (uses fallback if needed)
 */
function generateUniqueIdWithFallback(lead) {
  try {
    const strategies = ['permit', 'combined', 'hash', 'address'];
    
    for (const strategy of strategies) {
      const id = generateUniqueId(lead, strategy);
      if (id) {
        return id;
      }
    }
    
    logger.warn(`⚠️ All strategies failed, using JSON hash fallback`);
    const json = safeString(JSON.stringify(lead));
    const hash = safeHash(json);
    
    if (hash) {
      return `FALLBACK_${hash}`;
    }
    
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const id = `UNKNOWN_${timestamp}_${random}`;
    
    logger.warn(`⚠️ Using timestamp fallback: ${id}`);
    return id;
    
  } catch (err) {
    logger.error(`❌ CRITICAL: generateUniqueIdWithFallback failed: ${err.message}`);
    const emergency = `EMERGENCY_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.error(`🚨 Using emergency ID: ${emergency}`);
    return emergency;
  }
}

/**
 * Check if two leads are duplicates
 * GUARANTEED to never throw an error
 * 
 * @param {Object} lead1 - First lead
 * @param {Object} lead2 - Second lead
 * @returns {boolean} True if duplicates, false otherwise
 */
function areDuplicates(lead1, lead2) {
  try {
    if (!lead1 || !lead2) return false;
    if (typeof lead1 !== 'object' || typeof lead2 !== 'object') return false;
    
    const permit1 = extractPermitNumber(lead1);
    const permit2 = extractPermitNumber(lead2);
    
    if (permit1 && permit2) {
      const match = safeString(permit1).toLowerCase() === safeString(permit2).toLowerCase();
      if (match) {
        logger.debug(`✓ Duplicate found: Permit match (${permit1})`);
        return true;
      }
    }
    
    const addr1 = extractAddress(lead1);
    const addr2 = extractAddress(lead2);
    
    if (addr1 && addr2) {
      const norm1 = normalizeAddress(addr1);
      const norm2 = normalizeAddress(addr2);
      
      if (norm1 && norm2 && norm1.length >= 10 && norm2.length >= 10) {
        if (norm1 === norm2) {
          const val1 = safeString(lead1.estimated_value || '').replace(/[^0-9]/g, '');
          const val2 = safeString(lead2.estimated_value || '').replace(/[^0-9]/g, '');
          
          if (val1 && val2 && val1 === val2) {
            logger.debug(`✓ Duplicate found: Address + Value match`);
            return true;
          }
          
          if (val1 && val2) {
            const diff = Math.abs(parseInt(val1) - parseInt(val2));
            const avg = (parseInt(val1) + parseInt(val2)) / 2;
            const percentDiff = (diff / avg) * 100;
            
            if (percentDiff < 5) {
              logger.debug(`✓ Duplicate found: Address match with similar values (${percentDiff.toFixed(1)}% diff)`);
              return true;
            }
          }
        }
      }
    }
    
    const hash1 = generateUniqueId(lead1, 'hash');
    const hash2 = generateUniqueId(lead2, 'hash');
    
    if (hash1 && hash2 && hash1 === hash2) {
      logger.debug(`✓ Duplicate found: Content hash match`);
      return true;
    }
    
    return false;
    
  } catch (err) {
    logger.error(`❌ areDuplicates failed: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    return false;
  }
}

/**
 * Deduplicate an array of leads
 * GUARANTEED to never throw an error
 * 
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
      logger.info(`ℹ️ deduplicateBatch: Empty array, nothing to deduplicate`);
      return result;
    }
    
    result.stats.total = leads.length;
    logger.info(`🔍 Deduplicating batch of ${leads.length} leads...`);
    
    const seenIds = new Set();
    
    for (let i = 0; i < leads.length; i++) {
      try {
        const lead = leads[i];
        
        if (!lead || typeof lead !== 'object') {
          logger.warn(`⚠️ Skipping invalid lead at index ${i}`);
          result.stats.errors++;
          continue;
        }
        
        const uniqueId = generateUniqueIdWithFallback(lead);
        
        if (seenIds.has(uniqueId)) {
          logger.info(`♻️ Duplicate #${result.duplicates.length + 1}: ${uniqueId}`);
          result.duplicates.push({
            lead: lead,
            uniqueId: uniqueId,
            reason: 'Duplicate ID',
            index: i
          });
          result.stats.duplicates++;
        } else {
          seenIds.add(uniqueId);
          result.unique.push({
            lead: lead,
            uniqueId: uniqueId,
            index: i
          });
          result.stats.unique++;
        }
        
      } catch (leadErr) {
        logger.error(`❌ Error processing lead at index ${i}: ${leadErr.message}`);
        result.stats.errors++;
      }
    }
    
    logger.info(`✅ Deduplication complete: ${result.stats.unique} unique, ${result.stats.duplicates} duplicates, ${result.stats.errors} errors`);
    
    return result;
    
  } catch (err) {
    logger.error(`❌ CRITICAL: deduplicateBatch failed: ${err.message}`);
    logger.error(`Stack: ${err.stack}`);
    
    return {
      unique: [],
      duplicates: [],
      stats: {
        total: Array.isArray(leads) ? leads.length : 0,
        unique: 0,
        duplicates: 0,
        errors: 1
      }
    };
  }
}

/**
 * Insert lead if it's new (not a duplicate)
 * BULLETPROOF: Never throws errors
 */
async function insertLeadIfNew({ raw, sourceName, lead, extractedData, userId, sourceId, sourceUrl }) {
  try {
    const { db } = require('../db');
    
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
  generateUniqueId,
  generateUniqueIdWithFallback,
  normalizeAddress,
  extractPermitNumber,
  extractAddress,
  areDuplicates,
  deduplicateBatch,
  safeString,
  safeHash,
  insertLeadIfNew
};
