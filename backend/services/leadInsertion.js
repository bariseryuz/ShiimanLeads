const crypto = require('crypto');
const { db } = require('../db');
const logger = require('../utils/logger');
const { insertIntoSourceTableSync } = require('./sourceTable');

/**
 * Generate stable hash for lead deduplication
 * Uses permit number or other unique identifiers
 * @param {object} leadData - Lead data object
 * @param {number} userId - User ID for namespacing
 * @returns {string} SHA256 hash
 */
function generateLeadHash(leadData, userId) {
  // Extract permit number (try multiple field names)
  const permitNumber = (
    leadData.permit_number || 
    leadData.permitNumber || 
    leadData['Permit Number'] ||
    leadData.permit_no ||
    leadData.number ||
    ''
  ).toString().trim().toUpperCase();
  
  if (!permitNumber) {
    // Fallback: use company + address if no permit number
    const fallback = [
      (leadData.company_name || leadData.contractor_name || '').trim(),
      (leadData.address || '').trim(),
      (leadData.value || '').toString()
    ].filter(Boolean).join('-').toLowerCase();
    
    if (!fallback) {
      // Last resort: use raw JSON
      return crypto.createHash('sha256')
        .update(JSON.stringify(leadData) + userId)
        .digest('hex');
    }
    
    return crypto.createHash('sha256')
      .update(`${fallback}-${userId}`)
      .digest('hex');
  }
  
  // Hash based on permit number + userId (cross-source deduplication)
  const hashInput = `${permitNumber}-${userId}`;
  return crypto.createHash('sha256').update(hashInput).digest('hex');
}

/**
 * Insert lead if it's new (not a duplicate)
 * Handles universal lead types with intelligent ID generation
 * 
 * @param {object} params - Parameters object
 * @param {string} params.raw - Raw text from source
 * @param {string} params.sourceName - Source name
 * @param {object} params.lead - Lead data
 * @param {string} params.hashSalt - Optional salt for hashing
 * @param {number} params.userId - User ID
 * @param {object} params.extractedData - Extracted/formatted data
 * @param {number} params.sourceId - Source ID (required)
 * @returns {Promise<boolean|object>} False if duplicate, result object if inserted
 */
async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '', userId, extractedData = null, sourceId = null }) {
  if (!sourceId) {
    logger.warn(`No sourceId provided - skipping lead insertion`);
    return false;
  }

  // Use extractedData if available, otherwise fall back to lead
  const leadData = extractedData || lead;
  
  // UNIVERSAL UNIQUE ID GENERATION - Works with ANY lead type
  let uniqueId = '';
  let idType = '';
  
  // Strategy 1: Permit number (construction/building permits)
  const permitNumber = (
    leadData.permit_number || 
    leadData.permitNumber || 
    leadData['Permit Number'] ||
    leadData.permit_no ||
    leadData.number ||
    ''
  ).toString().trim();
  
  if (permitNumber) {
    uniqueId = permitNumber;
    idType = 'permit';
  }
  
  // Strategy 2: Address (location-based leads)
  if (!uniqueId) {
    const address = (
      leadData.address || 
      leadData.adress_details || 
      leadData.Address || 
      leadData.location ||
      leadData.street_address ||
      ''
    ).toString().trim();
    
    if (address) {
      uniqueId = `ADDR-${address.substring(0, 50)}`;
      idType = 'address';
    }
  }
  
  // Strategy 3: Company/Agent name + phone (business/people leads)
  if (!uniqueId) {
    const name = (
      leadData.company_name ||
      leadData.contractor_name ||
      leadData.agent_name ||
      leadData.name ||
      leadData.business_name ||
      ''
    ).toString().trim();
    
    const phone = (
      leadData.phone ||
      leadData.contractor_phone ||
      leadData.contact_phone ||
      leadData.mobile ||
      ''
    ).toString().trim();
    
    if (name && phone) {
      uniqueId = `BIZ-${name.substring(0, 30)}-${phone.replace(/\D/g, '')}`;
      idType = 'business';
    } else if (name) {
      uniqueId = `NAME-${name.substring(0, 50)}`;
      idType = 'name';
    }
  }
  
  // Strategy 4: Email or website (company/agent leads)
  if (!uniqueId) {
    const contact = (
      leadData.email ||
      leadData.website ||
      leadData.url ||
      ''
    ).toString().trim();
    
    if (contact) {
      uniqueId = `CONTACT-${contact.substring(0, 50)}`;
      idType = 'contact';
    }
  }
  
  // Strategy 5: Last resort - hash all data
  if (!uniqueId) {
    const dataStr = JSON.stringify(leadData);
    if (dataStr.length > 10) {
      uniqueId = `HASH-${crypto.createHash('md5').update(dataStr).digest('hex').substring(0, 16)}`;
      idType = 'hash';
      logger.warn('⚠️ Using data hash as unique ID (no standard identifiers found)');
    } else {
      logger.warn('⚠️ Lead has no usable data, skipping');
      return false;
    }
  }
  
  logger.info(`🔑 Unique ID: ${uniqueId} (type: ${idType})`);

  // Generate stable hash for deduplication
  const hash = crypto.createHash('sha256').update(`${uniqueId}-${userId}`).digest('hex');

  try {
    const tx = db.transaction(() => {
      // Check if already seen
      const seenRow = db.prepare(`
        SELECT id, seen_count, last_seen 
        FROM seen 
        WHERE lead_hash = ? AND user_id = ?
      `).get(hash, userId);
      
      if (seenRow) {
        // Update seen count and timestamp
        db.prepare(`
          UPDATE seen 
          SET seen_count = seen_count + 1, 
              last_seen = CURRENT_TIMESTAMP 
          WHERE id = ?
        `).run(seenRow.id);
        
        logger.info(`♻️ Duplicate: ${uniqueId} (seen ${seenRow.seen_count + 1} times)`);
        return { inserted: false, reason: 'duplicate', hash, permitNumber };
      }
      
      // Try to insert into unified leads table
      try {
        const insertResult = db.prepare(`
          INSERT INTO leads (
            user_id,
            source_id,
            hash,
            permit_number,
            permit_type,
            contractor_name,
            company_name,
            address,
            city,
            state,
            zip_code,
            phone,
            value,
            description,
            status,
            raw_text,
            date_issued,
            owner_name,
            contractor_phone,
            square_footage,
            parcel_number,
            work_description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          sourceId,
          hash,
          uniqueId,  // Universal unique identifier
          leadData.permit_type || leadData.permitType || null,
          leadData.contractor_name || leadData.contractor || null,
          leadData.company_name || leadData.companyName || null,
          leadData.address || null,
          leadData.city || null,
          leadData.state || null,
          leadData.zip_code || leadData.zip || null,
          leadData.phone || leadData.contractor_phone || null,
          leadData.value || leadData.construction_cost || null,
          leadData.description || leadData.work_description || null,
          leadData.status || 'new',
          JSON.stringify(leadData),
          leadData.date_issued || leadData.dateIssued || null,
          leadData.owner_name || leadData.owner || null,
          leadData.contractor_phone || null,
          leadData.square_footage || leadData.squareFootage || null,
          leadData.parcel_number || leadData.parcelNumber || null,
          leadData.work_description || leadData.workDescription || null
        );
        
        const leadId = insertResult.lastInsertRowid;
        
        // Mark as seen
        db.prepare(`
          INSERT INTO seen (lead_hash, user_id, source_id, permit_number)
          VALUES (?, ?, ?, ?)
        `).run(hash, userId, sourceId, permitNumber);
        
        // Also insert into source-specific table for backwards compatibility
        insertIntoSourceTableSync(sourceId, userId, raw, lead, extractedData);
        
        // Create outbox entry for JSONL export
        const jobId = crypto.randomBytes(8).toString('hex');
        const payload = JSON.stringify({
          leadId,
          hash,
          sourceName,
          userId,
          sourceId,
          permitNumber,
          data: leadData,
          job_id: jobId,
          ts: new Date().toISOString()
        });
        
        db.prepare(`
          INSERT INTO outbox (source_id, job_id, event_type, payload_json)
          VALUES (?, ?, ?, ?)
        `).run(sourceId, jobId, 'append-jsonl', payload);
        
        logger.info(`✅ NEW LEAD: ${permitNumber} | ${leadData.contractor_name || leadData.company_name || 'N/A'} | $${leadData.value || 0}`);
        
        return { 
          inserted: true, 
          leadId, 
          hash, 
          permitNumber 
        };
        
      } catch (dbError) {
        if (dbError.message.includes('UNIQUE constraint failed')) {
          // Permit already exists (caught by unique constraint)
          logger.info(`♻️ Duplicate (DB): ${permitNumber}`);
          
          // Still mark as seen
          db.prepare(`
            INSERT OR IGNORE INTO seen (lead_hash, user_id, source_id, permit_number)
            VALUES (?, ?, ?, ?)
          `).run(hash, userId, sourceId, permitNumber);
          
          return { inserted: false, reason: 'duplicate_db', permitNumber };
        }
        throw dbError;
      }
    });
    
    const result = tx();
    return result.inserted || false;
    
  } catch (err) {
    logger.error(`❌ Failed to insert lead: ${err.message}`);
    return false;
  }
}

module.exports = {
  insertLeadIfNew,
  generateLeadHash
};
