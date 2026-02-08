const cron = require('node-cron');
const logger = require('../../utils/logger');
const { scrapeForUser } = require('../../legacyScraper');
const { dbAll } = require('../../db');

/**
 * Scrape all users' sources (cron job)
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
          await scrapeForUser(user.id, userSources);
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
    scrapeAllUsers().catch(err => logger.error('Startup scrape failed:', err));
  }
}

module.exports = {
  setupAutoScraping
};
