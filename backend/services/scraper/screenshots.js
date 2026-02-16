/**
 * SCREENSHOT CAPTURE SERVICE
 * Handles all screenshot capture operations for the scraper
 */

const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs');

// Screenshot storage directory
const SCREENSHOT_DIR = path.join(__dirname, '../../data/screenshots');

/**
 * Ensure screenshot directory exists
 */
function ensureScreenshotDir() {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    logger.info(`📁 Created screenshot directory: ${SCREENSHOT_DIR}`);
  }
}

/**
 * Capture a simple full-page screenshot
 */
async function captureFullPageScreenshot(page, options = {}) {
  const {
    scrollToTop = true,
    waitBeforeCapture = 1000
  } = options;
  
  logger.info(`📸 Capturing full page screenshot...`);
  
  try {
    if (scrollToTop) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(waitBeforeCapture);
    }
    
    const screenshot = await page.screenshot({
      fullPage: true,
      type: 'png'
    });
    
    const sizeMB = (screenshot.length / 1024 / 1024).toFixed(2);
    logger.info(`✅ Screenshot captured: ${sizeMB} MB`);
    
    if (screenshot.length < 50000) {
      logger.warn(`⚠️ Screenshot very small (${screenshot.length} bytes) - page might be blank`);
    }
    
    return screenshot;
    
  } catch (err) {
    logger.error(`❌ Screenshot capture failed: ${err.message}`);
    throw err;
  }
}

/**
 * LEGACY COMPATIBILITY: captureTiledScreenshots
 * Wraps new simple screenshot in old return format
 */
async function captureTiledScreenshots(page, options = {}) {
  const {
    loadWaitTime = 2000,
    useFullPage = true
  } = options;
  
  logger.info(`📸 Legacy tiled screenshot mode (using simplified capture)`);
  
  try {
    await page.waitForTimeout(loadWaitTime);
    
    const screenshot = await captureFullPageScreenshot(page, {
      scrollToTop: useFullPage,
      waitBeforeCapture: 1000
    });
    
    // Return in legacy format for backward compatibility
    return {
      compositeBuffer: screenshot,
      tiles: [{
        buffer: screenshot,
        index: 0,
        row: 0,
        col: 0
      }],
      metadata: {
        width: 1920,
        height: 1080,
        tileCount: 1,
        captureTime: new Date().toISOString()
      }
    };
    
  } catch (err) {
    logger.error(`❌ Tiled screenshot capture failed: ${err.message}`);
    throw err;
  }
}

/**
 * Wait for page content to load before taking screenshot
 */
async function waitForContent(page, options = {}) {
  const {
    selector = 'table, [role="grid"], .results',
    minRows = 5,
    timeout = 10000
  } = options;
  
  logger.info(`⏳ Waiting for content: ${selector}`);
  
  try {
    await page.waitForSelector(selector, { timeout });
    logger.info(`✅ Found: ${selector}`);
    
    await page.waitForFunction((minRowCount) => {
      const rows = document.querySelectorAll('tr');
      return rows.length >= minRowCount;
    }, minRows, { timeout });
    
    const rowCount = await page.evaluate(() => {
      return document.querySelectorAll('tr').length;
    });
    
    logger.info(`✅ Content loaded: ${rowCount} rows`);
    return true;
    
  } catch (err) {
    logger.warn(`⚠️ Timeout waiting for content: ${err.message}`);
    return false;
  }
}

// EXPORTS
module.exports = {
  captureFullPageScreenshot,
  captureTiledScreenshots,
  waitForContent,
  SCREENSHOT_DIR
};