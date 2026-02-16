/**
 * SCREENSHOT SERVICE - Optimized for Vision AI
 */
const logger = require('../../utils/logger');

async function captureTiledScreenshots(page, options = {}) {
  const waitTime = options.loadWaitTime || 3500;
  
  try {
    logger.info(`📸 Capturing vision-optimized screenshot...`);
    await page.waitForTimeout(waitTime);

    // Scroll to top for consistent mapping
    await page.evaluate(() => window.scrollTo(0, 0));
    
    const buffer = await page.screenshot({
      fullPage: true, 
      type: 'png'
    });

    return {
      compositeBuffer: buffer,
      tiles: [{ buffer, index: 0 }],
      metadata: { capturedAt: new Date().toISOString() }
    };
  } catch (err) {
    logger.error(`❌ Screenshot failed: ${err.message}`);
    throw err;
  }
}

module.exports = { captureTiledScreenshots };