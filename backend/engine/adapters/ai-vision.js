/**
 * Engine Adapter: AI Vision (sites with no API)
 * Uses Playwright + screenshot + Gemini to extract data. Returns same shape as REST/ArcGIS.
 */

const { chromium } = require('playwright');
const { extractFromScreenshot } = require('../../services/ai');
const { getStealthLaunchOptions, getStealthContextOptions, injectStealthScripts } = require('../../services/scraper/stealth');
const logger = require('../../utils/logger');

/**
 * Build field schema for extractor: { fieldName: description }.
 * Uses manifest.field_schema if present; else builds from field_mapping (key -> "Extract [key]").
 */
function buildFieldSchema(manifest) {
  if (manifest.field_schema && Object.keys(manifest.field_schema).length > 0) {
    return manifest.field_schema;
  }
  const mapping = manifest.field_mapping || {};
  return Object.keys(mapping).reduce((acc, apiKey) => {
    acc[mapping[apiKey]] = `Extract ${apiKey}`;
    return acc;
  }, {});
}

/**
 * @param {string} url - Page URL to scrape
 * @param {Object} manifest - { ai_instructions?, field_mapping?, field_schema?, name? }
 * @returns {Array} Raw records (array of objects)
 */
async function fetch(url, manifest) {
  let browser;
  try {
    logger.info(`[Engine AI Vision] Starting for: ${url}`);

    browser = await chromium.launch(getStealthLaunchOptions());
    const context = await browser.newContext(getStealthContextOptions());
    const page = await context.newPage();
    await injectStealthScripts(page);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(manifest.wait_before_screenshot || 3000);

    const screenshotBuffer = await page.screenshot({ fullPage: true, type: 'png' });
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    const sourceName = manifest.name || 'AI Source';
    const fieldSchema = buildFieldSchema(manifest);
    const results = await extractFromScreenshot(screenshotBuffer, sourceName, fieldSchema);

    return Array.isArray(results) ? results : [];
  } catch (err) {
    logger.error(`[Engine AI Vision] ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
}

module.exports = { fetch };
