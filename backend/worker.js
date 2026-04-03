/**
 * Phase 2: Background worker — automated scraping on a schedule.
 * Uses the same pipeline as manual scrape (legacyScraper.scrapeForUser via scrapeAllUsers):
 * active sources only, Playwright headless + existing AI extraction.
 *
 * Run: npm run worker
 * Set WORKER_CRON (default 0 * * * * = hourly at :00). If the API server also has
 * AUTO_SCRAPE_ENABLED=true, disable one of them to avoid duplicate runs.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

require('./db');

const cron = require('node-cron');
const logger = require('./utils/logger');
const { scrapeAllUsers } = require('./services/scheduler/cron');

let running = false;

async function runMasterScrape() {
  logger.info(`[worker] runMasterScrape start ${new Date().toISOString()}`);
  try {
    await scrapeAllUsers();
  } catch (err) {
    logger.error(`[worker] runMasterScrape failed: ${err && err.message ? err.message : err}`);
    throw err;
  } finally {
    logger.info('[worker] runMasterScrape finished');
  }
}

async function tick() {
  if (running) {
    logger.warn('[worker] Previous scrape still running; skipping this tick');
    return;
  }
  running = true;
  try {
    await runMasterScrape();
  } finally {
    running = false;
  }
}

const expr = String(process.env.WORKER_CRON || '0 * * * *').trim();
if (!cron.validate(expr)) {
  logger.error(`[worker] Invalid WORKER_CRON ${JSON.stringify(expr)} — use a 5-field cron expression`);
  process.exit(1);
}

cron.schedule(expr, tick);
logger.info(`[worker] Scheduled: ${JSON.stringify(expr)} → runMasterScrape (is_active sources only)`);

if (String(process.env.WORKER_RUN_ON_START || '').trim().toLowerCase() === 'true') {
  tick().catch(err => logger.error(`[worker] Startup run failed: ${err.message}`));
}

module.exports = { runMasterScrape };
