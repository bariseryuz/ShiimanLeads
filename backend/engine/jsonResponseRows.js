/**
 * Extract row arrays from common API JSON shapes (shared by REST adapter and endpoint discovery).
 */

/**
 * One lead row must be a plain object (ArcGIS attributes, etc.), not a number/string.
 * @param {*} row
 * @returns {boolean}
 */
function isLeadLikeRow(row) {
  return row != null && typeof row === 'object' && !Array.isArray(row);
}

/**
 * @param {Array} rows
 * @returns {Array}
 */
function filterLeadLikeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(isLeadLikeRow);
}

/**
 * ArcGIS feature → attributes object (or full feature if attributes missing/null).
 * @param {*} f
 * @returns {Object|null}
 */
function featureToRow(f) {
  if (!f || typeof f !== 'object') return null;
  const row = f.attributes != null ? f.attributes : f;
  return isLeadLikeRow(row) ? row : null;
}

/**
 * @param {*} data - Parsed JSON body
 * @returns {Array} Rows suitable for field mapping (features → attributes flattened)
 */
function extractRowsFromApiJson(data) {
  if (data == null) return [];

  if (Array.isArray(data)) {
    return filterLeadLikeRows(data);
  }

  if (data.results && Array.isArray(data.results)) return filterLeadLikeRows(data.results);
  if (data.items && Array.isArray(data.items)) return filterLeadLikeRows(data.items);
  if (data.data && Array.isArray(data.data)) return filterLeadLikeRows(data.data);
  if (data.Data && Array.isArray(data.Data)) return filterLeadLikeRows(data.Data);
  if (data.aaData && Array.isArray(data.aaData)) return filterLeadLikeRows(data.aaData);
  if (data.rows && Array.isArray(data.rows)) return filterLeadLikeRows(data.rows);
  if (data.value && Array.isArray(data.value)) return filterLeadLikeRows(data.value);

  if (data.objectIds && Array.isArray(data.objectIds)) {
    return [];
  }

  if (data.features && Array.isArray(data.features)) {
    return data.features.map(featureToRow).filter(Boolean);
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

module.exports = { extractRowsFromApiJson, countRowsInApiJson, isLeadLikeRow, filterLeadLikeRows };
