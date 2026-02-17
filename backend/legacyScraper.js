/**
 * SHIIMAN LEADS - MASTER SCRAPER (MASTER FIX - FEB 17)
 * Fixed: SyntaxError in querySelector.
 * Fixed: Screenshot persistence for UI.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const fs = require('fs');
const { chromium } = require('playwright');
const axios = require('axios');
const logger = require('./utils/logger');

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
  logger.info(`🚀 Starting FIXED PRODUCTION Scrape for User ${userId}`);
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
          
          // Wait for any table data to exist
          await page.locator('tr, li, .item, h3').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
          await page.waitForTimeout(5000);
          await preventAllPopups(page);

          if (source.aiPrompt && isAIAvailable()) {
            await navigateAutonomously(page, Array.isArray(source.aiPrompt) ? source.aiPrompt.join('\n') : source.aiPrompt);
            await page.waitForTimeout(3000);
          }

          // MODE DETECT
          const isWide = await page.evaluate(() => document.documentElement.scrollWidth > (window.innerWidth + 100));

          if (isWide && source.useAI) {
            logger.info(`🎯 Mode: Wide Table Grid Scroll`);
            const gridResult = await captureGridScrollScreenshots(page, { selector: 'body', horizontalScrollStep: 1000, verticalScrollStep: 800 });
            for (const tile of gridResult.tiles) {
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
            logger.info(`🎯 Mode: Standard Pagination/Scroll`);
            let pageNumber = 1;
            let hasMorePages = true;

            while (hasMorePages && !isPageLimitReached(pageNumber, limits)) {
              const fingerprint = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40) || 'empty');
              
              const screenshotData = await captureTiledScreenshots(page, { useFullPage: true });
              const screenshot = screenshotData?.compositeBuffer || screenshotData;

              // Save screenshot for Dashboard
              try {
                const debugDir = path.join(SCREENSHOT_DIR, 'tiles-debug');
                if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
                const filename = `${source.id}_${Date.now()}_p${pageNumber}.png`;
                fs.writeFileSync(path.join(debugDir, filename), screenshot);
              } catch (e) {}

              const aiLeads = await extractFromScreenshot(screenshot, source.name, source.fieldSchema);
              if (aiLeads) {
                for (const lead of aiLeads) {
                  if (isTotalRowLimitReached(totalInserted, limits)) { hasMorePages = false; break; }
                  if (await insertLeadIfNew({ raw: JSON.stringify(lead), sourceName: source.name, lead, userId, sourceId: source.id, sourceUrl: source.url })) {
                    sourceNewLeads++; totalInserted++;
                  }
                }
              }

              // === FIXED NEXT BUTTON DETECTION (Safe Standard CSS only) ===
              const nextBtnSelector = await page.evaluate(() => {
                const selectors = ['button[aria-label*="Next"]', 'button.next', 'a.next', '.pagination-next', '.next-page'];
                for (const s of selectors) {
                  const el = document.querySelector(s);
                  if (el && el.offsetHeight > 0 && !el.disabled) return s;
                }
                // Fallback: search all buttons for text "Next"
                const allBtns = Array.from(document.querySelectorAll('button, a'));
                const textBtn = allBtns.find(b => b.innerText && b.innerText.toLowerCase().includes('next'));
                if (textBtn && textBtn.offsetHeight > 0) {
                    textBtn.setAttribute('data-ai-next', 'true');
                    return '[data-ai-next="true"]';
                }
                return null;
              });

              if (nextBtnSelector && hasMorePages) {
                logger.info(`🖱️ Clicking Next via ${nextBtnSelector}`);
                await page.click(nextBtnSelector);
                
                const changed = await page.waitForFunction((old) => {
                  const current = document.querySelector('tr, li, .item, h3')?.innerText?.trim()?.substring(0, 40) || 'empty';
                  return current !== old;
                }, fingerprint, { timeout: 15000 }).catch(() => false);

                if (!changed) hasMorePages = false; else { pageNumber++; await page.waitForTimeout(3000); }
              } else {
                // Infinite Scroll Fallback
                await page.evaluate(() => window.scrollBy(0, 1000));
                await page.waitForTimeout(4000);
                const scrollCheck = await page.evaluate(() => document.querySelector('tr, li, .item, h3')?.innerText?.substring(0, 40) || 'empty');
                if (scrollCheck !== fingerprint && scrollCheck !== 'empty') pageNumber++; else hasMorePages = false;
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