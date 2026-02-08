const cron = require('node-cron');
const logger = require('../../utils/logger');
const { scrapeAllUsers } = require('../scraper');

/**
 * Setup automatic scraping with cron
 * Reads configuration from environment variables:
 * - AUTO_SCRAPE_ENABLED: 'true' to enable auto-scraping
 * - AUTO_SCRAPE_ON_STARTUP: 'true' to run scrape on startup
 * - AUTO_SCRAPE_INTERVAL: Cron expression (default: '0 */8 * * *' = every 8 hours)
 */
function setupAutoScraping() {
  const AUTO_SCRAPE_ENABLED = process.env.AUTO_SCRAPE_ENABLED === 'true';
  const AUTO_SCRAPE_ON_STARTUP = process.env.AUTO_SCRAPE_ON_STARTUP === 'true';
  const AUTO_SCRAPE_INTERVAL = process.env.AUTO_SCRAPE_INTERVAL || '0 */8 * * *'; // Default: every 8 hours

  if (AUTO_SCRAPE_ENABLED) {
    cron.schedule(AUTO_SCRAPE_INTERVAL, scrapeAllUsers);
    logger.info(`✅ Auto-scraping ENABLED - Running every 8 hours (${AUTO_SCRAPE_INTERVAL})`);
  } else {
    logger.info(`⏸️  Auto-scraping DISABLED - Use "Scrape Now" button or API endpoint /api/scrape/now`);
  }

  if (AUTO_SCRAPE_ON_STARTUP) {
    logger.info('Running initial scrape on startup...');
    // NOTE: scrapeAllUsers() currently in index.js - imports scrapeForUser
    // Once scrapeForUser is extracted to services/scraper/index.js, this will work seamlessly
    
    // For now, log warning
    logger.warn('⚠️ AUTO_SCRAPE_ON_STARTUP enabled but scrapeForUser() not yet extracted');
    // TODO: Uncomment when scrapeForUser is moved to services/scraper/
    // scrapeAllUsers(); // Run once on startup
  }
}

module.exports = {
  setupAutoScraping
};
