const crypto = require('crypto');

/**
 * Generate MD5 hash for lead deduplication
 */
function generateHash(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return crypto.createHash('md5').update(text).digest('hex');
}

/**
 * Generate lead hash based on permit number (cross-source deduplication)
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
    
    return crypto.createHash('md5')
      .update(`user_${userId}_${fallback}`)
      .digest('hex');
  }
  
  // Use permit number as primary deduplication key
  return crypto.createHash('md5')
    .update(`user_${userId}_permit_${permitNumber}`)
    .digest('hex');
}

module.exports = {
  generateHash,
  generateLeadHash
};
