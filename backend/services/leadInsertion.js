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

function buildLeadTitle(leadData, uniqueId) {
  const parts = [];
  const company = (
    leadData.company_name ||
    leadData.contractor_name ||
    leadData.agent_name ||
    leadData.name ||
    leadData.business_name ||
    ''
  ).toString().trim();

  const address = (
    leadData.address ||
    leadData.street_address ||
    leadData.location ||
    ''
  ).toString().trim();

  const cost = (
    leadData.construction_cost ||
    leadData.value ||
    leadData.budget ||
    ''
  ).toString().trim();

  if (company) parts.push(company);
  if (address) parts.push(address);
  if (cost) parts.push(`$${cost}`);

  return parts.join(' - ') || uniqueId;
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
 * @param {string} params.sourceUrl - Source URL (used as fallback for link field)
 * @returns {Promise<boolean|object>} False if duplicate, result object if inserted
 */
async function insertLeadIfNew({ raw, sourceName, lead, hashSalt = '', userId, extractedData = null, sourceId = null, sourceUrl = null }) {
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
      
      // Try to insert into unified leads table with dynamic field mapping
      try {
        // Get all available columns in leads table
        const tableInfo = db.prepare(`PRAGMA table_info(leads)`).all();
        const availableColumns = tableInfo.map(col => col.name);
        
        // Build a mapping of data to columns dynamically
        const columnValues = new Map();
        
        // Required fields
        columnValues.set('user_id', userId);
        columnValues.set('source_id', sourceId);
        columnValues.set('hash', hash);
        columnValues.set('primary_id', uniqueId);
        columnValues.set('title', buildLeadTitle(leadData, uniqueId));
        columnValues.set('data', JSON.stringify(leadData));
        columnValues.set('permit_number', uniqueId);
        columnValues.set('status', leadData.status || 'new');
        columnValues.set('raw_text', JSON.stringify(leadData));
        
        // Map all extracted fields to available columns
        // Includes common variations users might type in "Fields to Extract"
        const fieldMappings = {
          'permit_number': ['permit_number', 'permit_no', 'permit', 'permitNumber', 'permitNo', 'number', 'id'],
          'permit_type': ['permit_type', 'permit_type_description', 'permitType', 'permitTypeDescription', 'type', 'permit_type_desc'],
          'contractor_name': ['contractor_name', 'contractor', 'contractorName', 'builder', 'builder_name'],
          'company_name': ['company_name', 'companyName', 'company', 'business_name', 'business', 'org_name'],
          'address': ['address', 'location', 'street_address', 'street', 'street_loc'],
          'city': ['city', 'city_name'],
          'state': ['state', 'state_code'],
          'zip_code': ['zip_code', 'zip', 'zipCode', 'postal_code', 'zip_code_code'],
          'phone': ['phone', 'contractor_phone', 'phone_number', 'contact_phone', 'telephone'],
          'value': ['value', 'construction_cost', 'cost', 'amount', 'project_value'],
          'description': ['description', 'work_description', 'workDescription', 'scope_of_work'],
          'date_issued': ['date_issued', 'dateIssued', 'issued_date', 'issue_date', 'date', 'permit_date'],
          'date_entered': ['date_entered', 'dateEntered', 'entered_date', 'application_date', 'date_applied'],
          'owner_name': ['owner_name', 'owner', 'ownerName', 'property_owner'],
          'contractor_phone': ['contractor_phone', 'contractorPhone', 'contractor_tel'],
          'square_footage': ['square_footage', 'squareFootage', 'sqft', 'sf', 'square_feet'],
          'parcel_number': ['parcel_number', 'parcelNumber', 'parcel', 'parcel_id', 'parce'],
          'work_description': ['work_description', 'workDescription', 'description', 'work_type'],
          'application_date': ['application_date', 'applicationDate', 'applied_date', 'date_entered', 'submit_date'],
          'contractor_address': ['contractor_address', 'contractorAddress', 'contractor_street'],
          'contractor_city': ['contractor_city', 'contractorCity'],
          'contractor_state': ['contractor_state', 'contractorState'],
          'contractor_zip': ['contractor_zip', 'contractorZip'],
          'units': ['units', 'num_units', 'number_of_units'],
          'floors': ['floors', 'num_floors', 'number_of_floors', 'stories'],
          'permit_subtype': ['permit_subtype', 'permitSubtype', 'subtype', 'permit_subtype_description'],
          'purpose': ['purpose', 'permit_purpose', 'work_purpose'],
          'latitude': ['latitude', 'lat', 'latitude_deg'],
          'longitude': ['longitude', 'lon', 'lng', 'longitude_deg'],
          'record_type': ['record_type', 'recordType', 'type_of_record'],
          'project_name': ['project_name', 'projectName', 'project'],
          'link': ['link', 'url', 'page_url', 'permit_link', 'permit_url'],
          'page_url': ['page_url', 'pageUrl', 'link', 'url']
        };
        
        // Auto-populate link field from sourceUrl if not extracted
        // This is universal - works for any source type
        if (sourceUrl && !columnValues.has('link') && availableColumns.includes('link')) {
          const hasLink = Object.keys(leadData).some(key => {
            const lower = key.toLowerCase();
            return lower.includes('link') || lower.includes('url') || lower.includes('page');
          });
          
          if (!hasLink) {
            columnValues.set('link', sourceUrl);
            logger.debug(`📎 Auto-populated link field with source URL: ${sourceUrl}`);
          }
        }
        
        // Iterate through field mappings and extract values
        for (const [dbColumn, possibleKeys] of Object.entries(fieldMappings)) {
          // Only process if column exists in database
          if (!availableColumns.includes(dbColumn)) continue;
          
          let value = null;
          for (const key of possibleKeys) {
            if (leadData[key] !== undefined && leadData[key] !== null && leadData[key] !== '') {
              value = leadData[key];
              break;
            }
          }
          
          if (value !== null) {
            columnValues.set(dbColumn, value);
          }
        }
        
        // Build dynamic INSERT statement
        const columns = Array.from(columnValues.keys());
        const values = Array.from(columnValues.values());
        const placeholders = columns.map(() => '?').join(', ');
        
        const insertSQL = `INSERT INTO leads (${columns.join(', ')}) VALUES (${placeholders})`;
        
        logger.info(`📝 Inserting lead with ${columns.length} fields: ${columns.slice(0, 5).join(', ')}...`);
        
        const insertResult = db.prepare(insertSQL).run(...values);
        
        const leadId = insertResult.lastInsertRowid;
        
        // Mark as seen
        db.prepare(`
          INSERT INTO seen (lead_hash, user_id, source_id, permit_number)
          VALUES (?, ?, ?, ?)
        `).run(hash, userId, sourceId, permitNumber);
        
        // Also insert into source-specific table for backwards compatibility
        // Use _original data if available (non-normalized field names for source table)
        const sourceTableData = leadData._original || extractedData || leadData;
        insertIntoSourceTableSync(sourceId, userId, raw, lead, sourceTableData);
        
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
