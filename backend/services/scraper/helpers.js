const logger = require('../../utils/logger');

// === HELPER FUNCTIONS ===

/**
 * Normalize any value to a string
 */
function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Build text string for filtering from item (JSON or HTML)
 */
function buildTextForFilter(item, source) {
  // For JSON items: if jsonFields specified, concatenate those; else stringify
  if (typeof item === 'object') {
    const fields = Array.isArray(source?.jsonFields) ? source.jsonFields : null;
    if (fields && fields.length) {
      return fields.map(f => normalizeText(item[f])).join(' ').trim();
    }
    return normalizeText(item);
  }
  // For HTML raw strings
  return normalizeText(item);
}

/**
 * Check if text passes source filters (keywords, regex, minLength)
 */
function textPassesFilters(text, source) {
  const t = (text || '').toString();
  const minLength = Number.isFinite(source?.minLength) ? source.minLength : 0;
  if (t.length < minLength) return false;

  const kws = Array.isArray(source?.keywords) ? source.keywords : [];
  const includeRegex = Array.isArray(source?.includeRegex) ? source.includeRegex : [];
  const excludeRegex = Array.isArray(source?.excludeRegex) ? source.excludeRegex : [];

  if (kws.length) {
    const hit = kws.some(k => {
      try { return new RegExp(k, 'i').test(t); } catch { return t.toLowerCase().includes(String(k).toLowerCase()); }
    });
    if (!hit) return false;
  }

  if (includeRegex.length) {
    const hit = includeRegex.some(r => {
      try { return new RegExp(r, 'i').test(t); } catch { return false; }
    });
    if (!hit) return false;
  }

  if (excludeRegex.length) {
    const bad = excludeRegex.some(r => {
      try { return new RegExp(r, 'i').test(t); } catch { return false; }
    });
    if (bad) return false;
  }
  return true;
}

/**
 * Get default columns for a source type (permits, agents, etc.)
 */
function getDefaultColumnsForSource(source) {
  const sourceName = (source.name || '').toLowerCase();
  const url = (source.url || '').toLowerCase();
  
  // Real Estate Agents (Zillow, Realtor, etc.)
  if (sourceName.includes('zillow') || sourceName.includes('realtor') || sourceName.includes('agent')) {
    return [
      'agent_name',
      'company_name',
      'phone',
      'email',
      'address',
      'city',
      'state',
      'source',
      'page_url',
      'date_added'
    ];
  }
  
  // Construction/Building Permits
  if (sourceName.includes('permit') || sourceName.includes('building') || url.includes('permit')) {
    return [
      'permit_number',
      'date_issued',
      'address',
      'city',
      'state',
      'value',
      'contractor_name',
      'contractor_phone',
      'owner_name',
      'square_footage',
      'permit_type',
      'permit_subtype',
      'parcel_number',
      'source',
      'page_url',
      'date_added'
    ];
  }
  
  // Default: show most common fields
  return [
    'permit_number',
    'address',
    'value',
    'contractor_name',
    'phone',
    'description',
    'source',
    'page_url',
    'date_added'
  ];
}

/**
 * Parse various date formats to YYYY-MM-DD
 */
function parseDate(value) {
  if (!value) return null;
  
  // If it's already a valid date string in YYYY-MM-DD format, return it
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.split('T')[0]; // Remove time component if present
  }
  
  // Handle Unix timestamps (milliseconds)
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const timestamp = parseInt(value);
    // Check if it's in milliseconds (13 digits) or seconds (10 digits)
    const date = new Date(timestamp > 9999999999 ? timestamp : timestamp * 1000);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }
  
  // Try to parse as a date string
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    return date.toISOString().split('T')[0];
  }
  
  return null;
}

/**
 * Get nested property by dot notation (e.g., "attributes.permitNumber")
 */
function getNestedProp(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

/**
 * Format a date to YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Replace dynamic date placeholders like {{DATE_365_DAYS_AGO}} with actual dates
 */
function replaceDynamicDates(text) {
  if (!text) return text;
  
  const today = new Date();
  
  // {{DATE_365_DAYS_AGO}} or {{LAST_365_DAYS}} → date from 365 days ago
  if (text.includes('{{DATE_365_DAYS_AGO}}') || text.includes('{{LAST_365_DAYS}}')) {
    const date365DaysAgo = new Date(today);
    date365DaysAgo.setDate(date365DaysAgo.getDate() - 365);
    const formatted = formatDate(date365DaysAgo);
    text = text.replace(/\{\{DATE_365_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_365_DAYS\}\}/g, formatted);
  }
  
  // {{DATE_30_DAYS_AGO}} or {{LAST_30_DAYS}} → date from 30 days ago
  if (text.includes('{{DATE_30_DAYS_AGO}}') || text.includes('{{LAST_30_DAYS}}')) {
    const date30DaysAgo = new Date(today);
    date30DaysAgo.setDate(date30DaysAgo.getDate() - 30);
    const formatted = formatDate(date30DaysAgo);
    text = text.replace(/\{\{DATE_30_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_30_DAYS\}\}/g, formatted);
  }
  
  // {{DATE_90_DAYS_AGO}} or {{LAST_90_DAYS}} → date from 90 days ago
  if (text.includes('{{DATE_90_DAYS_AGO}}') || text.includes('{{LAST_90_DAYS}}')) {
    const date90DaysAgo = new Date(today);
    date90DaysAgo.setDate(date90DaysAgo.getDate() - 90);
    const formatted = formatDate(date90DaysAgo);
    text = text.replace(/\{\{DATE_90_DAYS_AGO\}\}/g, formatted);
    text = text.replace(/\{\{LAST_90_DAYS\}\}/g, formatted);
  }
  
  // {{TODAY}} → today's date
  if (text.includes('{{TODAY}}')) {
    const formatted = formatDate(today);
    text = text.replace(/\{\{TODAY\}\}/g, formatted);
  }
  
  // {{FIRST_DAY_OF_MONTH}} → first day of current month
  if (text.includes('{{FIRST_DAY_OF_MONTH}}')) {
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const formatted = formatDate(firstDay);
    text = text.replace(/\{\{FIRST_DAY_OF_MONTH\}\}/g, formatted);
  }
  
  // {{FIRST_DAY_OF_YEAR}} → January 1st of current year
  if (text.includes('{{FIRST_DAY_OF_YEAR}}')) {
    const firstDay = new Date(today.getFullYear(), 0, 1);
    const formatted = formatDate(firstDay);
    text = text.replace(/\{\{FIRST_DAY_OF_YEAR\}\}/g, formatted);
  }
  
  return text;
}

/**
 * Load sources from sources.json file
 */
function loadSources() {
  const fs = require('fs');
  try {
    const raw = fs.readFileSync('sources.json', 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('sources.json must be an array');
    return parsed;
  } catch (e) {
    logger.error(`sources.json not found or invalid! ${e.message}`);
    return [];
  }
}

module.exports = {
  normalizeText,
  buildTextForFilter,
  textPassesFilters,
  getDefaultColumnsForSource,
  parseDate,
  getNestedProp,
  formatDate,
  replaceDynamicDates,
  loadSources
};
