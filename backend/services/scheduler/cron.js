const cron = require('node-cron');
const logger = require('../../utils/logger');
const { scrapeForUser } = require('../../legacyScraper');
const { dbAll, dbRun } = require('../../db');
const { runDigestForAllDue } = require('../alerts');
const { runBackup } = require('../backup');

function envBool(name) {
  const v = process.env[name];
  if (v == null || !String(v).trim()) return false;
  return String(v).trim().toLowerCase() === 'true';
}

/**
 * Scrape all users' sources (cron job)
 */
async function scrapeAllUsers() {
  try {
    logger.info(`=== Starting scrape cycle for all users (${new Date().toISOString()}) ===`);
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
 * Run lead digest for all users who are due (daily/weekly).
 */
async function runDigestJob() {
  try {
    await runDigestForAllDue();
  } catch (e) {
    logger.error(`Digest job error: ${e.message}`);
  }
}

/**
 * Data retention: delete leads older than LEAD_RETENTION_DAYS.
 */
async function runRetentionJob() {
  const days = parseInt(process.env.LEAD_RETENTION_DAYS || '0', 10);
  if (days <= 0) return;
  try {
    const result = await dbRun(
      `DELETE FROM leads WHERE created_at < datetime('now', ?)`,
      [`-${days} days`]
    );
    if (result?.changes > 0) logger.info(`Retention: removed ${result.changes} old lead(s)`);
  } catch (e) {
    logger.error(`Retention job error: ${e.message}`);
  }
}

/**
 * Setup automatic scraping with cron
 */
function setupAutoScraping() {
  const AUTO_SCRAPE_ENABLED = envBool('AUTO_SCRAPE_ENABLED');
  const AUTO_SCRAPE_ON_STARTUP = envBool('AUTO_SCRAPE_ON_STARTUP');
  let interval = String(process.env.AUTO_SCRAPE_INTERVAL || '0 */8 * * *').trim();
  const defaultInterval = '0 */8 * * *';

  if (AUTO_SCRAPE_ENABLED) {
    if (!cron.validate(interval)) {
      logger.error(
        `Invalid AUTO_SCRAPE_INTERVAL ${JSON.stringify(interval)} — falling back to ${defaultInterval}. Fix the cron expression in .env`
      );
      interval = defaultInterval;
    }
    const tz = String(process.env.AUTO_SCRAPE_TIMEZONE || '').trim();
    const scheduleOpts = tz ? { timezone: tz } : {};
    const tick = async () => {
      logger.info(`[cron] Auto-scrape tick fired (${interval}${tz ? `, tz=${tz}` : ', server local time'})`);
      try {
        await scrapeAllUsers();
      } catch (err) {
        logger.error(`[cron] Auto-scrape failed: ${err && err.message ? err.message : err}`);
      }
    };
    cron.schedule(interval, tick, scheduleOpts);
    logger.info(`Auto-scraping ENABLED (${interval})${tz ? ` timezone=${tz}` : ' — times use server local clock unless AUTO_SCRAPE_TIMEZONE is set'}`);
  } else {
    logger.info(`Auto-scraping DISABLED (set AUTO_SCRAPE_ENABLED=true to enable)`);
  }

  if (AUTO_SCRAPE_ON_STARTUP) {
    logger.info('Running initial scrape on startup...');
    scrapeAllUsers().catch(err => logger.error('Startup scrape failed:', err));
  }

  cron.schedule('0 13 * * *', runDigestJob);
  logger.info('Digest job scheduled (daily 13:00 UTC)');

  cron.schedule('0 3 * * *', runRetentionJob);
  logger.info('Retention job scheduled (daily 03:00 UTC)');

  cron.schedule('0 4 * * *', () => runBackup().catch(err => logger.error('Backup failed: ' + err.message)));
  logger.info('Backup job scheduled (daily 04:00 UTC)');
}

module.exports = {
  setupAutoScraping,
  runDigestJob,
  runRetentionJob
};
