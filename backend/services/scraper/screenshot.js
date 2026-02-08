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
    maxScrolls = 10,        // Maximum scroll attempts
    scrollDelay = 1000,      // Wait between scrolls
    loadWaitTime = 2000,     // Wait for content to load after scrolling
    useFullPage = true       // Use fullPage screenshot vs manual stitching
  } = options;

  logger.info(`📸 Starting full page capture (maxScrolls: ${maxScrolls})...`);

  // Step 1: Scroll horizontally to reveal all columns
  logger.info(`↔️ Scrolling horizontally to reveal all table columns...`);
  
  let lastWidth = 0;
  let horizontalScrollAttempts = 0;
  const maxHorizontalScrolls = 5;
  
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
  
  while (scrollAttempts < maxScrolls) {
    // Get current scroll height
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
    // If height hasn't changed, we've reached the end
    if (currentHeight === lastHeight) {
      logger.info(`✅ Reached bottom after ${scrollAttempts} vertical scrolls`);
      break;
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

  // Step 5: Set viewport to capture full content (with safety limits)
  const maxWidth = 20000;  // Increased for wide tables
  const maxHeight = 50000; // Increased limit for very long pages

  await page.setViewport({
    width: Math.min(dimensions.width, maxWidth),
    height: Math.min(dimensions.height, maxHeight)
  });

  // Step 6: Final wait for any animations/rendering
  await new Promise(resolve => setTimeout(resolve, loadWaitTime));

  // Step 7: Take screenshot
  logger.info(`📸 Capturing screenshot...`);
  const screenshot = await page.screenshot({ 
    fullPage: useFullPage,
    type: 'png'
  });

  logger.info(`✅ Screenshot captured: ${Math.round(screenshot.length / 1024)}KB`);
  
  return screenshot;
}

module.exports = {
  captureEntirePage
};
