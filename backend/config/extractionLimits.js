/**
 * Extraction Limits Configuration
 * Controls how much data is scraped from sources
 */

const logger = require('../utils/logger');

/**
 * Default extraction limits
 */
const DEFAULTS = {
  maxPages: 10,           // Stop after N pages
  maxRowsPerPage: null,   // No limit per page (extract all)
  maxTotalRows: null,     // No limit total (extract all)
  testMode: false         // False = full scrape, True = 1 page, 10 rows preview
};

/**
 * Validate and normalize extraction limits
 * @param {Object} limits - Limits configuration
 * @returns {Object} Validated limits
 */
function validateLimits(limits) {
  if (!limits) {
    return DEFAULTS;
  }

  const validated = {
    maxPages: limits.maxPages !== undefined ? Math.max(1, parseInt(limits.maxPages) || DEFAULTS.maxPages) : DEFAULTS.maxPages,
    maxRowsPerPage: limits.maxRowsPerPage !== undefined ? (limits.maxRowsPerPage ? Math.max(1, parseInt(limits.maxRowsPerPage)) : null) : DEFAULTS.maxRowsPerPage,
    maxTotalRows: limits.maxTotalRows !== undefined ? (limits.maxTotalRows ? Math.max(1, parseInt(limits.maxTotalRows)) : null) : DEFAULTS.maxTotalRows,
    testMode: limits.testMode === true || limits.testMode === 'true'
  };

  return validated;
}

/**
 * Apply test mode overrides
 * Test mode: extract only 1 page with 10 rows max
 * @param {Object} limits - Limits configuration
 * @returns {Object} Limits with test mode applied
 */
function applyTestMode(limits) {
  if (limits.testMode) {
    logger.info(`🧪 TEST MODE ENABLED: Limiting to 1 page, 10 rows max`);
    return {
      maxPages: 1,
      maxRowsPerPage: 10,
      maxTotalRows: 10,
      testMode: true
    };
  }
  return limits;
}

/**
 * Merge source-level limits with per-scrape overrides
 * Per-scrape limits take priority over source-level limits
 * @param {Object} sourceLimits - Limits defined in source config
 * @param {Object} overrideLimits - Per-scrape limit overrides
 * @returns {Object} Merged limits
 */
function mergeLimits(sourceLimits, overrideLimits) {
  const base = validateLimits(sourceLimits);
  const override = validateLimits(overrideLimits);

  // Merge with override taking priority
  const merged = {
    maxPages: overrideLimits?.maxPages !== undefined ? override.maxPages : base.maxPages,
    maxRowsPerPage: overrideLimits?.maxRowsPerPage !== undefined ? override.maxRowsPerPage : base.maxRowsPerPage,
    maxTotalRows: overrideLimits?.maxTotalRows !== undefined ? override.maxTotalRows : base.maxTotalRows,
    testMode: overrideLimits?.testMode !== undefined ? override.testMode : base.testMode
  };

  return applyTestMode(merged);
}

/**
 * Log extraction limits in readable format
 * @param {Object} limits - Limits configuration
 * @param {String} sourceName - Source name for logging
 */
function logLimits(limits, sourceName) {
  const lines = [
    `📊 Extraction Limits for "${sourceName}":`,
    `   Max Pages: ${limits.maxPages === Infinity ? '∞ (unlimited)' : limits.maxPages}`,
    `   Max Rows/Page: ${limits.maxRowsPerPage === null ? '∞ (unlimited)' : limits.maxRowsPerPage}`,
    `   Max Total Rows: ${limits.maxTotalRows === null ? '∞ (unlimited)' : limits.maxTotalRows}`,
  ];
  
  if (limits.testMode) {
    lines.push(`   🧪 TEST MODE: Preview only (1 page, 10 rows)`);
  }

  lines.forEach(line => logger.info(line));
}

/**
 * Check if page limit reached
 * @param {number} currentPage - Current page number (1-indexed)
 * @param {Object} limits - Limits configuration
 * @returns {boolean} True if limit reached
 */
function isPageLimitReached(currentPage, limits) {
  return currentPage > limits.maxPages;
}

/**
 * Check if row limit reached (per page)
 * @param {number} rowsExtracted - Rows extracted so far on this page
 * @param {Object} limits - Limits configuration
 * @returns {boolean} True if limit reached
 */
function isRowLimitReached(rowsExtracted, limits) {
  if (limits.maxRowsPerPage === null) return false;
  return rowsExtracted >= limits.maxRowsPerPage;
}

/**
 * Check if total row limit reached (across all pages)
 * @param {number} totalRows - Total rows extracted so far
 * @param {Object} limits - Limits configuration
 * @returns {boolean} True if limit reached
 */
function isTotalRowLimitReached(totalRows, limits) {
  if (limits.maxTotalRows === null) return false;
  return totalRows >= limits.maxTotalRows;
}

module.exports = {
  DEFAULTS,
  validateLimits,
  applyTestMode,
  mergeLimits,
  logLimits,
  isPageLimitReached,
  isRowLimitReached,
  isTotalRowLimitReached
};
