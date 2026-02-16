const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { chromium } = require('playwright');
const axios = require('axios');
const logger = require('./utils/logger');
const { insertLeadIfNew } = require('./services/leadInsertion');
const { trackSourceReliability } = require('./services/reliability');
const { isAIAvailable, extractFromScreenshot, navigateAutonomously } = require('./services/ai');
const { scrapeWithSmartGrid } = require('./services/scraper/smartGridScraper');
const { captureTiledScreenshots } = require('./services/scraper/screenshot');
const { captureGridScrollScreenshots } = require('./services/scraper/gridScrollScraper');
const { initProgress, updateProgress, shouldStopScraping } = require('./services/scraper/progress');
const { setupPopupBlocking, preventAllPopups } = require('./services/scraper/preventPopup');
const { mergeLimits, isPageLimitReached, isTotalRowLimitReached } = require('./config/extractionLimits');

async function scrapeForUser(userId, userSources, extractionLimits) {
  logger.info(`🚀 Starting Master Scrape Session for User ${userId}`);
  initProgress(userId, userSources);
  let totalInserted = 0;

  for (const sourceRow of userSources) {
    if (shouldStopScraping(userId)) break;

    let source = sourceRow.source_data ? (typeof sourceRow.source_data === 'string' ? JSON.parse(sourceRow.source_data) : sourceRow.source_data) : sourceRow;
    source.id = sourceRow.id;
    const limits = mergeLimits(source.extractionLimits || {}, extractionLimits);
    updateProgress(userId, { currentSource: source.name });
    
    let newLeads = 0;

    try {
      // --- METHOD 1: PLAYWRIGHT ---
      if (source.usePlaywright || source.method === 'playwright') {
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'en-US', timezoneId: 'America/New_York' // US Identity Spoofing
        });
        const page = await context.newPage();
        await setupPopupBlocking(page);

        try {
          await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(4000);
          await preventAllPopups(page);

          // AI Navigation Support
          if (source.aiPrompt && isAIAvailable()) {
            await navigateAutonomously(page, source.aiPrompt);
            await page.waitForTimeout(2000);
          }

          // MODE A: 2D Grid Scroll (Horizontal + Vertical)
          if (source.useGridScroll && source.useAI) {
            const grid = await captureGridScrollScreenshots(page, source);
            for (const tile of grid.tiles) {
              const leads = await extractFromScreenshot(tile.buffer, source.name, source.fieldSchema);
              for (const l of leads) if (await insertLeadIfNew({ ...l, userId, sourceId: source.id })) newLeads++;
            }
          } 
          // MODE B: Smart Grid (Vertical Progressive)
          else if (source.useSmartGrid && source.useAI) {
            const gridResult = await scrapeWithSmartGrid(page, source, limits);
            for (const l of gridResult.records) if (await insertLeadIfNew({ ...l, userId, sourceId: source.id })) newLeads++;
          } 
          // MODE C: Standard AI Vision + Robust Pagination
          else if (source.useAI) {
            let pageNumber = 1;
            let hasMorePages = true;

            while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
              // FINGERPRINT to prevent same-page loops
              const fingerprint = await page.evaluate(() => document.querySelector('tr, li, h3')?.innerText?.substring(0, 40));
              const screenshotData = await captureTiledScreenshots(page, { useFullPage: true });
              const aiLeads = await extractFromScreenshot(screenshotData, source.name, source.fieldSchema);
              
              for (const lead of aiLeads) {
                if (isTotalRowLimitReached(totalInserted + newLeads, limits)) { hasMorePages = false; break; }
                if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) newLeads++;
              }

              // SMART NEXT BUTTON DETECTION
              const nextBtn = await page.evaluate(() => {
                const sel = ['button[aria-label*="Next"]', 'button.next', 'a.next', '.pagination-next'];
                for (const s of sel) { const el = document.querySelector(s); if (el && el.clientHeight > 0 && !el.disabled) return s; }
                return null;
              });

              if (nextBtn && hasMorePages) {
                await page.click(nextBtn);
                const success = await page.waitForFunction((f) => document.querySelector('tr, li, h3')?.innerText?.substring(0, 40) !== f, fingerprint, { timeout: 15000 }).catch(() => false);
                if (!success) hasMorePages = false; else { pageNumber++; await page.waitForTimeout(2000); }
              } else hasMorePages = false;
            }
          }
        } finally {
          await browser.close();
        }
      } 
      // --- METHOD 2: DIRECT API ---
      else if (source.method === 'json' || source.type === 'arcgis') {
        const res = await axios.get(source.url, { timeout: 20000 });
        if (res.data) { /* Logic for API records would go here as per your leadInsertion service */ }
      }

      totalInserted += newLeads;
      await trackSourceReliability(source.id, source.name, (newLeads > 0), newLeads);

    } catch (err) {
      logger.error(`❌ Source Failed [${source.name}]: ${err.message}`);
    }
  }

  updateProgress(userId, { status: 'completed', endTime: Date.now(), leadsFound: totalInserted });
  return totalInserted;
}

module.exports = { scrapeForUser };