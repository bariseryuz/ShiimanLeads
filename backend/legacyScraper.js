/**
 * SHIIMAN LEADS - SMART AUTO-DETECT SCRAPER (Feb 2026)
 * Detects wide tables and infinite scroll automatically without UI changes.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { chromium } = require('playwright');
const logger = require('./utils/logger');

// Project Service Imports
const { dbRun } = require('./db');
const { insertLeadIfNew } = require('./services/leadInsertion');
const { trackSourceReliability } = require('./services/reliability');
const { isAIAvailable, extractFromScreenshot, navigateAutonomously } = require('./services/ai');
const { captureTiledScreenshots } = require('./services/scraper/screenshot');
const { captureGridScrollScreenshots } = require('./services/scraper/gridScrollScraper');
const { initProgress, updateProgress, shouldStopScraping } = require('./services/scraper/progress');
const { setupPopupBlocking, preventAllPopups } = require('./services/scraper/preventPopup');
const { getRateLimiter } = require('./services/scraper/rateLimiter');
const { mergeLimits, isPageLimitReached, isTotalRowLimitReached } = require('./config/extractionLimits');
const { SCREENSHOT_DIR } = require('./config/paths');

async function scrapeForUser(userId, userSources, extractionLimits) {
  logger.info(`🚀 Starting SMART PRODUCTION Scrape for User ${userId}`);
  initProgress(userId, userSources);

  let totalInserted = 0;

  for (const sourceRow of userSources) {
    if (shouldStopScraping(userId)) break;

    let source;
    try {
      source = sourceRow.source_data ? (typeof sourceRow.source_data === 'string' ? JSON.parse(sourceRow.source_data) : sourceRow.source_data) : sourceRow;
      source.id = sourceRow.id || source._sourceId;
    } catch (e) { continue; }

    const limits = mergeLimits(source.extractionLimits || {}, extractionLimits);
    updateProgress(userId, { currentSource: source.name });
    const rateLimiter = getRateLimiter(source);

    try {
      await rateLimiter.waitIfNeeded();
      let sourceNewLeads = 0;

      if (source.usePlaywright || source.method === 'playwright') {
        const browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: 'en-US', timezoneId: 'America/New_York'
        });
        const page = await context.newPage();
        await setupPopupBlocking(page);

        try {
          logger.info(`🌐 Navigating to: ${source.url}`);
          await page.goto(source.url, { waitUntil: 'commit', timeout: 90000 });
          await page.locator('tr, li, .item, h3').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(5000);
          await preventAllPopups(page);

          // Handle AI Instructions from UI
          if (source.aiPrompt && isAIAvailable()) {
            await navigateAutonomously(page, Array.isArray(source.aiPrompt) ? source.aiPrompt.join('\n') : source.aiPrompt);
            await page.waitForTimeout(3000);
          }

          // --- AUTO-DETECTION LOGIC ---
          const dimensions = await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            isScrollable: document.documentElement.scrollHeight > window.innerHeight
          }));

          const isWideTable = dimensions.width > (dimensions.viewportWidth + 100);
          
          if (isWideTable && source.useAI) {
            // AUTO-MODE: WIDE TABLE (Grid Scroll)
            logger.info(`🎯 AUTO-DETECT: Wide table found (${dimensions.width}px). Using 2D Grid Scroll.`);
            const gridResult = await captureGridScrollScreenshots(page, {
                selector: 'table, [role="grid"], .results',
                horizontalScrollStep: 1000,
                verticalScrollStep: 800
            });

            for (const tile of gridResult.tiles) {
              const filename = `tile_${source.id}_${Date.now()}.png`;
              const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
              if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
              fs.writeFileSync(path.join(debugDir, filename), tile.buffer);

              const aiLeads = await extractFromScreenshot(tile.buffer, source.name, source.fieldSchema);
              if (aiLeads) {
                for (const lead of aiLeads) {
                  if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) {
                    sourceNewLeads++; totalInserted++;
                  }
                }
              }
            }
          } else if (source.useAI) {
            // AUTO-MODE: STANDARD (Next Button or Infinite Scroll)
            let pageNumber = 1;
            let hasMorePages = true;

            while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
              const fingerprint = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40));
              const screenshotData = await captureTiledScreenshots(page, { useFullPage: true });
              const screenshot = screenshotData?.compositeBuffer || screenshotData;

              // Save for UI
              const filename = `${source.id}_${Date.now()}_page${pageNumber}.png`;
              const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
              if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
              fs.writeFileSync(path.join(debugDir, filename), screenshot);
              logger.info(`💾 Screenshot saved: ${filename}`);

              const aiLeads = await extractFromScreenshot(screenshot, source.name, source.fieldSchema);
              if (aiLeads) {
                for (const lead of aiLeads) {
                  if (isTotalRowLimitReached(totalInserted, limits)) { hasMorePages = false; break; }
                  if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) {
                    sourceNewLeads++; totalInserted++;
                  }
                }
              }

              // Look for Next Button
              const nextBtn = await page.evaluate(() => {
                const sel = ['button[aria-label*="Next"]', 'button.next', 'a.next', '.pagination-next', 'text="Next"'];
                for (const s of sel) { const el = document.querySelector(s); if (el && el.clientHeight > 0 && !el.disabled) return s; }
                return null;
              });

              if (nextBtn && hasMorePages) {
                logger.info(`🖱️ Clicking Next Page...`);
                await page.click(nextBtn);
                const changed = await page.waitForFunction((f) => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40) !== f, fingerprint, { timeout: 15000 }).catch(() => false);
                if (!changed) hasMorePages = false; else { pageNumber++; await page.waitForTimeout(3000); }
              } else {
                // AUTO-DETECT: No button? Try infinite scroll
                logger.info("No Next button. Attempting scroll-down to load more...");
                await page.evaluate(() => window.scrollBy(0, 1200));
                await page.waitForTimeout(4000);
                const newFingerprint = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40));
                if (newFingerprint !== fingerprint && newFingerprint !== 'empty') {
                    logger.info("✅ New content loaded via scroll.");
                    pageNumber++;
                } else {
                    hasMorePages = false;
                }
              }
            }
          }
        } finally {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      }
      await trackSourceReliability(source.id, source.name, true, sourceNewLeads);
    } catch (err) { logger.error(`❌ Source Failed: ${err.message}`); }
  }
  updateProgress(userId, { status: 'completed', endTime: Date.now(), leadsFound: totalInserted });
  return totalInserted;
}

module.exports = { scrapeForUser };