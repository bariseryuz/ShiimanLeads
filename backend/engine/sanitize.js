/**
 * Post-fetch normalization: trim strings, coerce numeric/currency strings to numbers.
 * Runs after field_mapping, before validator (so numeric filters work).
 */

function looksLikeNumericString(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length === 0 || t.length > 40) return false;
  // Currency or plain number: $1,234.56 | 1,234 | €99
  return /^[\s$€£]*[\d,]+(\.\d+)?\s*$/.test(t) || /^[\d,]+(\.\d+)?$/.test(t);
}

function coerceNumberString(s) {
  const n = parseFloat(String(s).replace(/[$€£,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {*} val
 * @returns {*} Same type or coerced number for numeric strings
 */
function sanitizeValue(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length === 0) return trimmed;
    if (looksLikeNumericString(trimmed)) {
      const n = coerceNumberString(trimmed);
      if (n !== null && String(n).length <= 24) return n;
    }
    return trimmed;
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (typeof val === 'object' && val.constructor === Object) {
    return sanitizeObject(val);
  }
  return val;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeValue(v);
  }
  return out;
}

/**
 * @param {Object} lead - One lead after transformer
 * @returns {Object} Sanitized copy (does not mutate input)
 */
function sanitizeLead(lead) {
  if (!lead || typeof lead !== 'object') return lead;
  return sanitizeObject(lead);
}

module.exports = { sanitizeLead, sanitizeValue, looksLikeNumericString };
