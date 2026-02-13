const logger = require('../../utils/logger');
const { dbAll } = require('../../db');
const { createNotification } = require('../notifications');
const { initProgress, updateProgress, getProgress, shouldStopScraping } = require('./progress');
const { getRateLimiter } = require('./rateLimiter');
const { getTimings } = require('./timings');
const { trackSourceReliability } = require('../reliability');
// Deduplication fully implemented in services/deduplication.js
const { extractLeadWithAI } = require('../ai');
const { captureEntirePage } = require('./screenshot');
const {
  textPassesFilters,
  buildTextForFilter,
  replaceDynamicDates,
  parseDate,
  getNestedProp
} = require('./helpers');
const { validateExtractedFields } = require('./validation');

// NOTE: This is a placeholder for scrapeForUser - the actual implementation
// is ~1500 lines and handles:
//
// 1. INITIALIZATION
//    - Initialize progress tracking
//    - Mark existing leads as old
//    - Load user's sources from database
//
// 2. SOURCE LOOP
//    - Check stop flag before each source
//    - Apply rate limiting per source
//    - Random delays between sources (10-30s)
//
// 3. EXTRACTION METHODS (supports multiple methods per source):
//    a) JSON API
//       - Axios requests with proxy support
//       - Nashville API special handling
//       - ArcGIS/ESRI attribute flattening
//       - Field mappings (user-configured or auto-mapping)
//       - Date parsing (Unix timestamps, ISO, various formats)
//
//    b) Playwright (Dynamic Pages)
//       - Browser launch with proxy rotation
//       - Anti-detection stealth (navigator.webdriver masking)
//       - AI autonomous navigation (aiPrompt processing)
//       - Block detection (Cloudflare, CAPTCHA, rate limits, 403/429)
//       - Rate limiting detection → 30-minute backoff
//       - playwrightConfig actions (select, fill, click, wait)
//       - Universal wait for data selectors (table, rows, results)
//       - Content quality validation (hasUsefulContent)
//       - Auto-scrolling for lazy loading (incremental wheel events)
//       - Table extraction with intelligent column mapping
//       - Screenshot capture (captureEntirePage) for AI vision
//       - Pagination handling (multi-page screenshots)
//
//    c) HTML Parsing (Cheerio)
//       - Schema.org JSON-LD extraction (for contact/office pages)
//       - JSON embedded in HTML attributes (Vue components, etc.)
//       - CSS selector-based extraction
//       - Pattern matching fallback (permit numbers, addresses, phones, $$$)
//
//    d) AI Extraction
//       - Vision mode (screenshots from Playwright)
//       - Text mode (HTML body text)
//       - Field schema validation
//       - Multi-page processing
//       - Array-like object handling (permits with numeric keys)
//
// 4. LEAD INSERTION
//    - Universal deduplication (5 strategies)
//    - Source-specific dynamic tables
//    - Transaction-safe insertion with rollback
//    - Progress updates
//
// 5. ERROR HANDLING
//    - Try/catch per source (one failure doesn't stop others)
//    - Rate limit detection and backoff
//    - Reliability tracking (success/failure counts, confidence score)
//    - Progress tracking (errors array)
//
// 6. COMPLETION
//    - Create notification (scrape_success or scrape_no_new)
//    - Update progress status to 'completed'
//    - Return total inserted count
//
// Due to the complexity, the full implementation remains in index.js
// for now. This service layer provides all the supporting functions
// that make scrapeForUser() possible.
//
// TODO: When ready, move the full scrapeForUser() implementation here
// and update index.js to import it.

/**
 * Scrape all sources for all users (cron job)
 * @returns {Promise<void>}
 */
async function scrapeAllUsers() {
  try {
    logger.info('=== Starting scrape cycle for all users ===');
    const users = await dbAll('SELECT id, username, role FROM users');
    
    // Scrape user-specific sources from database
    for (const user of users) {
      try {
        // Get user's sources WITH their IDs
        const sourceRows = await dbAll('SELECT id, source_data FROM user_sources WHERE user_id = ?', [user.id]);
        if (!sourceRows.length) {
          logger.info(`User ${user.username} (${user.id}) has no custom sources configured`);
          continue;
        }
        
        const userSources = sourceRows.map(row => {
          try {
            const sourceData = JSON.parse(row.source_data);
            sourceData._sourceId = row.id; // Add source ID to the source object
            return sourceData;
          } catch (e) {
            logger.error(`Invalid JSON in user_sources for user ${user.id}: ${e.message}`);
            return null;
          }
        }).filter(Boolean);
        
        if (userSources.length) {
          logger.info(`Scraping ${userSources.length} custom sources for user ${user.username} (${user.id})`);
          // TODO: Import scrapeForUser from index.js once extracted
          // await scrapeForUser(user.id, userSources);
          logger.warn('⚠️ scrapeForUser() not yet extracted - still in index.js');
        }
      } catch (userErr) {
        logger.error(`Error scraping custom sources for user ${user.username} (${user.id}): ${userErr.message}`);
      }
    }
    
    logger.info('=== Scrape cycle complete for all users ===');
  } catch (e) {
    logger.error(`Scraper orchestrator error: ${e.message}`);
  }
}

module.exports = {
  scrapeAllUsers
  // TODO: Export scrapeForUser once extracted
  // scrapeForUser
};
