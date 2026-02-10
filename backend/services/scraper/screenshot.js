const logger = require('../../utils/logger');

/**
 * Capture entire page screenshot with intelligent scrolling to reveal all content
 * Handles lazy-loaded content and wide tables
 * @param {Object} page - Puppeteer page object
 * @param {Object} options - Screenshot options
 * @returns {Buffer} Screenshot buffer
 */
async function captureEntirePage(page, options = {}) {
  const {
    maxScrolls = 25,
    scrollDelay = 2000,
    loadWaitTime = 5000,
    useFullPage = true
  } = options;

  logger.info(`📸 Starting full page capture (maxScrolls: ${maxScrolls})...`);

  // Step 1: Scroll horizontally to reveal all columns
  logger.info(`↔️ Scrolling horizontally to reveal all table columns...`);
  
  let lastWidth = 0;
  let horizontalScrollAttempts = 0;
  let stableHorizontal = 0;
  const maxHorizontalScrolls = 10;
  
  while (horizontalScrollAttempts < maxHorizontalScrolls) {
    const currentWidth = await page.evaluate(() => document.body.scrollWidth);
    
    if (currentWidth === lastWidth) {
      stableHorizontal++;
      if (stableHorizontal >= 2) {
        logger.info(`✅ Reached right edge after ${horizontalScrollAttempts} horizontal scrolls`);
        break;
      }
    } else {
      stableHorizontal = 0;
      lastWidth = currentWidth;
    }
    
    horizontalScrollAttempts++;
    
    // Scroll to the right
    await page.evaluate(() => {
      window.scrollTo(document.body.scrollWidth, 0);
    });
    
    logger.info(`➡️ Horizontal scroll ${horizontalScrollAttempts}/${maxHorizontalScrolls} - Width: ${currentWidth}px`);
    await new Promise(resolve => setTimeout(resolve, scrollDelay));
  }
  
  // Scroll back to left
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Step 2: Auto-scroll vertically to reveal all rows with improved lazy-load detection
  logger.info(`↕️ Scrolling vertically to reveal all table rows...`);
  
  let lastHeight = 0;
  let stableScrolls = 0;
  let scrollAttempts = 0;
  
  while (scrollAttempts < maxScrolls) {
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    // Track stability: only break if height hasn't changed for multiple attempts
    if (currentHeight === lastHeight) {
      stableScrolls++;
      logger.info(`📊 Height unchanged: ${stableScrolls}/3 stable checks`);
      if (stableScrolls >= 3) {
        logger.info(`✅ Reached bottom after ${scrollAttempts} vertical scrolls`);
        break;
      }
    } else {
      stableScrolls = 0; // Reset stability counter
      lastHeight = currentHeight;
      logger.info(`📈 New content loaded: height now ${currentHeight}px`);
    }
    
    scrollAttempts++;
    
    // Scroll to bottom to trigger lazy loading
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    
    logger.info(`⬇️ Vertical scroll ${scrollAttempts}/${maxScrolls} - Height: ${currentHeight}px - Stable: ${stableScrolls}/3`);
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, scrollDelay));
  }

  // Step 3: Scroll back to top-left corner and wait for re-render
  logger.info(`↩️ Scrolling back to top for final capture...`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(resolve => setTimeout(resolve, 3000)); // Increased wait for re-render

  // Step 4: Calculate full dimensions with detailed logging for debugging
  logger.info(`📋 Measuring final page dimensions...`);
  const dimensions = await page.evaluate(() => {
    const measurements = {
      width: Math.max(
        document.body.scrollWidth,
        document.documentElement.scrollWidth,
        document.body.offsetWidth,
        document.documentElement.offsetWidth
      ),
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.offsetHeight
      )
    };
    
    // Log detailed measurements for debugging
    console.log('📊 Dimension breakdown:', {
      scrollWidth: document.body.scrollWidth,
      scrollHeight: document.body.scrollHeight,
      offsetWidth: document.body.offsetWidth,
      offsetHeight: document.body.offsetHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight
    });
    
    return measurements;
  });

  logger.info(`📐 Full page dimensions: ${dimensions.width}x${dimensions.height}px`);

  // Step 5: Set viewport to capture full content (with increased safety limits)
  const maxWidth = 32000;
  const maxHeight = 100000;
  
  const viewportWidth = Math.min(dimensions.width, maxWidth);
  const viewportHeight = Math.min(dimensions.height, maxHeight);
  
  // Warn if page exceeds limits (will be cropped)
  if (dimensions.width > maxWidth) {
    logger.warn(`⚠️ Page width ${dimensions.width}px exceeds max ${maxWidth}px - will be cropped`);
  }
  if (dimensions.height > maxHeight) {
    logger.warn(`⚠️ Page height ${dimensions.height}px exceeds max ${maxHeight}px - will be cropped`);
  }
  
  logger.info(`📱 Setting viewport: ${viewportWidth}x${viewportHeight}px`);

  await page.setViewport({
    width: viewportWidth,
    height: viewportHeight,
    deviceScaleFactor: 1
  });

  // Step 6: Final wait for animations to complete and DOM to stabilize
  // CRITICAL: For large viewports (32000x100000), need sufficient time for re-render
  const finalWait = Math.max(loadWaitTime, 5000); // Minimum 5 seconds
  logger.info(`⏳ Waiting ${finalWait}ms for large viewport to render...`);
  await new Promise(resolve => setTimeout(resolve, finalWait));

  // Step 7: Take screenshot with fullPage mode and enhanced error handling
  logger.info(`📸 Capturing screenshot with fullPage mode...`);
  let screenshot;
  try {
    screenshot = await page.screenshot({ 
      fullPage: useFullPage,
      type: 'png',
      captureBeyondViewport: true
    });
  } catch (screenshotErr) {
    logger.error(`❌ Screenshot failed: ${screenshotErr.message}`);
    logger.warn(`⚠️ Attempting fallback screenshot without fullPage mode...`);
    screenshot = await page.screenshot({ 
      type: 'png',
      captureBeyondViewport: false
    });
  }

  const screenshotSizeKB = Math.round(screenshot.length / 1024);
  logger.info(`✅ Screenshot captured: ${screenshotSizeKB}KB`);
  
  // Verify screenshot is not empty or corrupted
  if (screenshot.length < 1000) {
    logger.warn(`⚠️ WARNING: Screenshot is very small (${screenshot.length} bytes) - may be blank!`);
  }
  
  return screenshot;
}

module.exports = {
  captureEntirePage
};
