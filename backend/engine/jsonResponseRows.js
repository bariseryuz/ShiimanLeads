/**
 * Extract row arrays from common API JSON shapes (shared by REST adapter and endpoint discovery).
 */

/**
 * @param {*} data - Parsed JSON body
 * @returns {Array} Rows suitable for field mapping (features → attributes flattened)
 */
function extractRowsFromApiJson(data) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;

  if (data.results && Array.isArray(data.results)) return data.results;
  if (data.items && Array.isArray(data.items)) return data.items;
  if (data.data && Array.isArray(data.data)) return data.data;
  if (data.Data && Array.isArray(data.Data)) return data.Data;
  if (data.aaData && Array.isArray(data.aaData)) return data.aaData;
  if (data.rows && Array.isArray(data.rows)) return data.rows;
  if (data.value && Array.isArray(data.value)) return data.value;

  if (data.features && Array.isArray(data.features)) {
    return data.features.map(f => (f && typeof f === 'object' ? f.attributes || f : f));
  }

  if (data.error) return [];
  return [];
}

/**
 * @param {*} data
 * @returns {number} Approximate row count (0 if error-shaped payload)
 */
function countRowsInApiJson(data) {
  return extractRowsFromApiJson(data).length;
}

module.exports = { extractRowsFromApiJson, countRowsInApiJson };
