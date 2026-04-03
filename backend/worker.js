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
const scaleLimits = require('./config/scaleLimits');
const { scrapeAllUsers } = require('./services/scheduler/cron');

let running = false;
let shuttingDown = false;
/** @type {import('node-cron').ScheduledTask | null} */
let cronTask = null;
/** @type {Promise<void> | null} */
let currentWork = null;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
  if (shuttingDown) return;
  if (running) {
    logger.warn('[worker] Previous scrape still running; skipping this tick');
    return;
  }
  running = true;
  currentWork = runMasterScrape();
  try {
    await currentWork;
  } finally {
    currentWork = null;
    running = false;
  }
}

const expr = String(process.env.WORKER_CRON || '0 * * * *').trim();
if (!cron.validate(expr)) {
  logger.error(`[worker] Invalid WORKER_CRON ${JSON.stringify(expr)} — use a 5-field cron expression`);
  process.exit(1);
}

cronTask = cron.schedule(expr, tick);
logger.info(`[worker] Scheduled: ${JSON.stringify(expr)} → runMasterScrape (is_active sources only)`);

if (String(process.env.WORKER_RUN_ON_START || '').trim().toLowerCase() === 'true') {
  tick().catch(err => logger.error(`[worker] Startup run failed: ${err.message}`));
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const grace = scaleLimits.worker.shutdownGraceMs;
  logger.info(`[worker] ${signal} — stopping schedule, draining in-flight scrape (max ${grace}ms)`);
  try {
    if (cronTask && typeof cronTask.stop === 'function') cronTask.stop();
  } catch (e) {
    logger.warn(`[worker] cron stop: ${e.message}`);
  }
  if (currentWork) {
    try {
      await Promise.race([currentWork, sleep(grace)]);
    } catch (e) {
      logger.warn(`[worker] drain: ${e.message}`);
    }
  }
  if (running) {
    logger.warn('[worker] Exiting while scrape may still be running (grace elapsed)');
  }
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { runMasterScrape };
