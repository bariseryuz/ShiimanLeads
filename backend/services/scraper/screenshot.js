const sharp = require('sharp');
const logger = require('../../utils/logger');

/**
 * Prepare page for full-content screenshots with scrolling and viewport sizing.
 * @param {Object} page - Playwright page object
 * @param {Object} options - Screenshot options
 * @returns {Object} Viewport dimensions
 */
async function prepareFullPageViewport(page, options = {}) {
  const {
    maxScrolls = 25,
    scrollDelay = 2000,
    loadWaitTime = 5000
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

  // Step 2: Auto-scroll vertically (supports scrollable containers)
  logger.info(`↕️ Scrolling vertically to reveal all table rows...`);
  const scrollTarget = await page.evaluate(() => {
    const preferredSelectors = [
      '.table-container',
      '.data-table',
      '[role="grid"]',
      '.ag-body-viewport',
      '.ReactVirtualized__Grid',
      'calcite-table',
      'div[style*="overflow"]'
    ];

    for (const sel of preferredSelectors) {
      const elem = document.querySelector(sel);
      if (elem && elem.scrollHeight > elem.clientHeight + 50) {
        elem.setAttribute('data-scrape-scroll', 'true');
        return '[data-scrape-scroll="true"]';
      }
    }

    const candidates = Array.from(document.querySelectorAll('div, section, main, article'));
    const best = candidates
      .filter(el => el.scrollHeight > el.clientHeight + 50)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];

    if (best) {
      best.setAttribute('data-scrape-scroll', 'true');
      return '[data-scrape-scroll="true"]';
    }

    if (document.documentElement.scrollHeight > window.innerHeight + 50) {
      return 'body';
    }

    return 'body';
  });
  logger.info(`🎯 Scroll target: ${scrollTarget || 'body'}`);

  let lastHeight = 0;
  let stableScrolls = 0;
  let scrollAttempts = 0;
  
  while (scrollAttempts < maxScrolls) {
    const currentHeight = await page.evaluate((selector) => {
      if (selector && selector !== 'body') {
        const elem = document.querySelector(selector);
        return elem ? elem.scrollHeight : document.body.scrollHeight;
      }
      return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    }, scrollTarget);
    
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
    await page.evaluate((selector) => {
      if (selector && selector !== 'body') {
        const elem = document.querySelector(selector);
        if (elem) {
          elem.scrollTop = elem.scrollHeight;
          return;
        }
      }
      window.scrollTo(0, document.body.scrollHeight);
    }, scrollTarget);
    
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

  await page.setViewportSize({
    width: viewportWidth,
    height: viewportHeight
  });

  // Step 6: Final wait for animations to complete and DOM to stabilize
  // CRITICAL: For large viewports (32000x100000), need sufficient time for re-render
  const finalWait = Math.max(loadWaitTime, 5000); // Minimum 5 seconds
  logger.info(`⏳ Waiting ${finalWait}ms for large viewport to render...`);
  await new Promise(resolve => setTimeout(resolve, finalWait));

  return {
    viewportWidth,
    viewportHeight,
    dimensions
  };
}

/**
 * Capture entire page screenshot with intelligent scrolling to reveal all content
 * Handles lazy-loaded content and wide tables
 * @param {Object} page - Playwright page object
 * @param {Object} options - Screenshot options
 * @returns {Buffer} Screenshot buffer
 */
async function captureEntirePage(page, options = {}) {
  const { useFullPage = true } = options;

  await prepareFullPageViewport(page, options);

  // Step 7: Take screenshot with fullPage mode and enhanced error handling
  logger.info(`📸 Capturing screenshot with fullPage mode...`);
  let screenshot;
  try {
    screenshot = await page.screenshot({ 
      fullPage: useFullPage,
      type: 'png'
    });
  } catch (screenshotErr) {
    logger.error(`❌ Screenshot failed: ${screenshotErr.message}`);
    logger.warn(`⚠️ Attempting fallback screenshot without fullPage mode...`);
    screenshot = await page.screenshot({ 
      type: 'png'
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

/**
 * Capture the page in multiple tiles for sharper text in large tables.
 * @param {Object} page - Playwright page object
 * @param {Object} options - Tiling options
 * @returns {Object} Tile buffers and metadata
 */
async function captureTiledScreenshots(page, options = {}) {
  const {
    tileRows = 2,
    tileCols = 3,
    overlapPct = 0.1,
    maxTiles = 6
  } = options;

  const { viewportWidth, viewportHeight } = await prepareFullPageViewport(page, options);

  let rows = Math.max(1, tileRows);
  let cols = Math.max(1, tileCols);
  while (rows * cols > maxTiles) {
    if (cols >= rows && cols > 1) {
      cols -= 1;
    } else if (rows > 1) {
      rows -= 1;
    } else {
      break;
    }
  }

  const overlap = Math.min(Math.max(overlapPct, 0), 0.4);
  const baseTileWidth = Math.ceil(viewportWidth / cols);
  const baseTileHeight = Math.ceil(viewportHeight / rows);
  const overlapX = Math.floor(baseTileWidth * overlap);
  const overlapY = Math.floor(baseTileHeight * overlap);

  const tiles = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let x = c * baseTileWidth;
      let y = r * baseTileHeight;
      let width = baseTileWidth;
      let height = baseTileHeight;

      if (c > 0) {
        x -= overlapX;
        width += overlapX;
      }
      if (c < cols - 1) {
        width += overlapX;
      }
      if (r > 0) {
        y -= overlapY;
        height += overlapY;
      }
      if (r < rows - 1) {
        height += overlapY;
      }

      if (x + width > viewportWidth) {
        width = viewportWidth - x;
      }
      if (y + height > viewportHeight) {
        height = viewportHeight - y;
      }

      const tile = await page.screenshot({
        clip: { x, y, width, height },
        type: 'png'
      });
      tiles.push({ buffer: tile, row: r, col: c, clip: { x, y, width, height } });
    }
  }

  const totalBytes = tiles.reduce((sum, t) => sum + t.buffer.length, 0);
  logger.info(`🧩 Tiled screenshots captured: ${tiles.length} tile(s), ${Math.round(totalBytes / 1024)}KB total`);

  let compositeBuffer = null;
  try {
    const composite = tiles.map(tile => ({
      input: tile.buffer,
      left: Math.max(0, Math.floor(tile.clip.x)),
      top: Math.max(0, Math.floor(tile.clip.y))
    }));

    compositeBuffer = await sharp({
      create: {
        width: viewportWidth,
        height: viewportHeight,
        channels: 3,
        background: '#ffffff'
      }
    })
      .composite(composite)
      .png()
      .toBuffer();

    logger.info(`🧩 Composite image created: ${Math.round(compositeBuffer.length / 1024)}KB`);
  } catch (stitchErr) {
    logger.warn(`⚠️ Failed to stitch tiles into composite: ${stitchErr.message}`);
  }

  return {
    tiles,
    tileRows: rows,
    tileCols: cols,
    overlapPct: overlap,
    compositeBuffer,
    viewportWidth,
    viewportHeight
  };
}

module.exports = {
  captureEntirePage,
  captureTiledScreenshots
};
