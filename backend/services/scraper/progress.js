const logger = require('../../utils/logger');

// === SCRAPING PROGRESS TRACKING ===

// Global progress maps
const scrapeProgress = new Map(); // userId -> progress object
const stopFlags = new Map(); // userId -> boolean (true = should stop)

/**
 * Initialize progress tracking for a user
 * @param {number} userId - User ID
 * @param {Array} sources - Array of sources to scrape
 */
function initProgress(userId, sources) {
  scrapeProgress.set(userId, {
    status: 'running',
    startTime: Date.now(),
    totalSources: sources.length,
    completedSources: 0,
    currentSource: null,
    leadsFound: 0,
    errors: []
  });
  stopFlags.set(userId, false); // Reset stop flag
}

/**
 * Update progress for a user
 * @param {number} userId - User ID
 * @param {Object} updates - Progress updates
 */
function updateProgress(userId, updates) {
  const progress = scrapeProgress.get(userId);
  if (progress) {
    Object.assign(progress, updates);
  }
}

/**
 * Get current progress for a user
 * @param {number} userId - User ID
 * @returns {Object|null} Progress object or null
 */
function getProgress(userId) {
  return scrapeProgress.get(userId) || null;
}

/**
 * Check if scraping should stop for a user
 * @param {number} userId - User ID
 * @returns {boolean} True if should stop
 */
function shouldStopScraping(userId) {
  return stopFlags.get(userId) === true;
}

/**
 * Set stop flag for a user
 * @param {number} userId - User ID
 * @param {boolean} value - Stop flag value
 */
function setShouldStop(userId, value) {
  stopFlags.set(userId, value);
  logger.info(`🛑 Stop flag for user ${userId} set to: ${value}`);
}

module.exports = {
  initProgress,
  updateProgress,
  getProgress,
  shouldStopScraping,
  setShouldStop
};
