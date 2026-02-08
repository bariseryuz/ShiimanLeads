const logger = require('../../utils/logger');

/**
 * Validate extracted fields from AI or scraper
 * @param {Object|Array} data - Extracted data (can be array of leads or single lead)
 * @param {string} sourceName - Name of the source for logging
 * @param {Object} fieldSchema - Optional field schema for validation
 * @returns {Object} { isValid, confidence, issues }
 */
function validateExtractedFields(data, sourceName, fieldSchema = null) {
  // If data is an array, validate the first item as a sample
  const sampleData = Array.isArray(data) ? (data[0] || {}) : data;
  
  // If it's an object with numeric keys (array-like), validate first entry
  if (!Array.isArray(data) && typeof data === 'object') {
    const keys = Object.keys(data).filter(k => !k.startsWith('_'));
    if (keys.some(k => !isNaN(k))) {
      const firstKey = keys.find(k => !isNaN(k));
      if (firstKey && data[firstKey]) {
        return validateExtractedFields(data[firstKey], sourceName, fieldSchema);
      }
    }
  }
  
  const validations = {
    hasData: false,
    confidence: 0,
    issues: []
  };

  // ✅ CRITICAL FIELD VALIDATION - These MUST be present
  const criticalFields = ['link', 'permit_number', 'address'];
  const missingCritical = criticalFields.filter(f => 
    !sampleData[f] || 
    sampleData[f] === null || 
    sampleData[f] === 'null' || 
    sampleData[f] === undefined || 
    sampleData[f] === '' ||
    sampleData[f] === '-'
  );
  
  if (missingCritical.length > 0) {
    validations.issues.push(`Missing critical fields: ${missingCritical.join(', ')}`);
    logger.warn(`⚠️ Critical validation failed for ${sourceName}: Missing ${missingCritical.join(', ')}`);
    return { isValid: false, confidence: 0, issues: validations.issues };
  }

  // Count how many non-null fields we have
  const dataKeys = Object.keys(sampleData).filter(k => !k.startsWith('_'));
  const nonNullFields = dataKeys.filter(k => 
    sampleData[k] !== null && 
    sampleData[k] !== 'null' && 
    sampleData[k] !== undefined &&
    sampleData[k] !== '' &&
    sampleData[k] !== '-'
  );
  
  // If we have any data at all, consider it valid
  if (nonNullFields.length > 0) {
    validations.hasData = true;
    // Base confidence on percentage of fields filled (increased threshold to 40%)
    const fillPercentage = (nonNullFields.length / Math.max(dataKeys.length, 1)) * 100;
    validations.confidence = Math.min(Math.round(fillPercentage), 100);
  } else {
    validations.issues.push(`No data extracted - all fields are null or empty`);
  }

  const isValid = validations.hasData && validations.confidence >= 40;

  if (!isValid) {
    logger.warn(`⚠️ Validation failed for ${sourceName}: ${validations.issues.join(', ')} (confidence: ${validations.confidence}%)`);
  }

  return { isValid, confidence: validations.confidence, issues: validations.issues };
}

module.exports = {
  validateExtractedFields
};
