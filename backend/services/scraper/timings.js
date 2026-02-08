const logger = require('../../utils/logger');

// === DEFAULT TIMING CONFIGURATION ===

/**
 * Default timing configuration for scraping (can be overridden per source)
 */
const DEFAULT_TIMINGS = {
  networkIdleTimeout: 15000,    // Wait longer for complex pages to load
  jsRenderWait: 8000,            // Increased for heavy JS apps (ArcGIS, etc)
  afterScrollWait: 5000,         // More time for lazy-loaded content
  betweenScrollWait: 2000,       // Slower scrolling for better capture
  betweenSourcesWait: 500,       // Cleanup delay between sources
  pageLoadWait: 3000,            // Initial wait after page load
  aiNavigationWait: 2000         // Wait between AI navigation steps
};

/**
 * Get timing configuration for a source (merge source-specific with defaults)
 * @param {Object} source - Source configuration
 * @returns {Object} Timing configuration
 */
function getTimings(source) {
  return {
    ...DEFAULT_TIMINGS,
    ...source.timings
  };
}

module.exports = {
  DEFAULT_TIMINGS,
  getTimings
};
