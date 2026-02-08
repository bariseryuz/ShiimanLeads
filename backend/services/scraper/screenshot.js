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
    maxScrolls = 20,         // Maximum scroll attempts (increased from 10)
    scrollDelay = 1500,      // Wait between scrolls (increased from 1000ms)
    loadWaitTime = 3000,     // Wait for content to load after scrolling (increased from 2000ms)
    useFullPage = true       // Use fullPage screenshot vs manual stitching
  } = options;

  logger.info(`📸 Starting full page capture (maxScrolls: ${maxScrolls})...`);

  // Step 1: Scroll horizontally to reveal all columns
  logger.info(`↔️ Scrolling horizontally to reveal all table columns...`);
  
  let lastWidth = 0;
  let horizontalScrollAttempts = 0;
  const maxHorizontalScrolls = 10;  // Increased from 5
  
  while (horizontalScrollAttempts < maxHorizontalScrolls) {
    const currentWidth = await page.evaluate(() => document.body.scrollWidth);
    
    if (currentWidth === lastWidth) {
      logger.info(`✅ Reached right edge after ${horizontalScrollAttempts} horizontal scrolls`);
      break;
    }
    
    lastWidth = currentWidth;
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
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 2: Auto-scroll vertically to reveal all rows
  logger.info(`↕️ Scrolling vertically to reveal all table rows...`);
  
  let lastHeight = 0;
  let scrollAttempts = 0;
  let unchangedCount = 0; // Track how many times height hasn't changed
  
  while (scrollAttempts < maxScrolls) {
    // Get current scroll height
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    // If height hasn't changed, increment counter
    if (currentHeight === lastHeight) {
      unchangedCount++;
      // Only stop if height hasn't changed for 2 consecutive attempts
      if (unchangedCount >= 2) {
        logger.info(`✅ Reached bottom after ${scrollAttempts} vertical scrolls`);
        break;
      }
    } else {
      unchangedCount = 0; // Reset counter if height changed
    }
    
    lastHeight = currentHeight;
    scrollAttempts++;
    
    // Scroll to bottom to trigger lazy loading
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    
    logger.info(`⬇️ Vertical scroll ${scrollAttempts}/${maxScrolls} - Height: ${currentHeight}px`);
    
    // Wait for content to load
    await new Promise(resolve => setTimeout(resolve, scrollDelay));
  }

  // Step 3: Scroll back to top-left corner for clean screenshot
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(resolve => setTimeout(resolve, 500));

  // Step 4: Calculate full dimensions (including scrollable areas)
  const dimensions = await page.evaluate(() => ({
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
  }));

  logger.info(`📐 Full page dimensions: ${dimensions.width}x${dimensions.height}px`);

  // Step 5: Set viewport to capture full content (with increased safety limits)
  const maxWidth = 32000;   // Increased from 20,000 for ultra-wide tables
  const maxHeight = 100000; // Increased from 50,000 for very long pages
  
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
    deviceScaleFactor: 1  // Ensure 1:1 pixel ratio for accurate capture
  });

  // Step 6: Final wait for any animations/rendering
  await new Promise(resolve => setTimeout(resolve, loadWaitTime));

  // Step 7: Take screenshot with fullPage mode
  logger.info(`📸 Capturing screenshot with fullPage mode...`);
  const screenshot = await page.screenshot({ 
    fullPage: useFullPage,
    type: 'png',
    captureBeyondViewport: true  // Capture content beyond initial viewport
  });

  logger.info(`✅ Screenshot captured: ${Math.round(screenshot.length / 1024)}KB`);
  
  return screenshot;
}

module.exports = {
  captureEntirePage
};
