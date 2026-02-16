/**
 * 2D GRID SCROLL SCRAPER
 * 
 * For tables with BOTH horizontal and vertical scrollbars
 * 
 * Pattern: Read like lines of text
 * - Start at left edge
 * - Scroll right → capture → scroll right → capture
 * - Return to left edge
 * - Scroll down to next row
 * - Repeat
 */

const logger = require('../../utils/logger');

/**
 * Capture screenshots with 2D scrolling (horizontal + vertical)
 */
async function captureGridScrollScreenshots(page, options = {}) {
  const {
    horizontalScrollStep = 800,
    verticalScrollStep = 1000,
    maxHorizontalScrolls = 5,
    maxVerticalScrolls = 20,
    scrollDelay = 1500,
    selector = 'table, [role="grid"]'
  } = options;

  logger.info(`🎯 2D Grid Scroll Scraper Started`);
  logger.info(`📏 H-Step: ${horizontalScrollStep}px, V-Step: ${verticalScrollStep}px`);

  const tiles = [];
  let tileIndex = 0;

  try {
    // Wait for table
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Get dimensions
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      maxScrollX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
    }));

    logger.info(`📊 Page: ${dimensions.scrollWidth}x${dimensions.scrollHeight}`);
    logger.info(`📊 Viewport: ${dimensions.viewportWidth}x${dimensions.viewportHeight}`);
    logger.info(`📊 Max scroll: X=${dimensions.maxScrollX}px, Y=${dimensions.maxScrollY}px`);

    // Calculate grid size
    const horizontalTiles = Math.min(
      Math.ceil(dimensions.maxScrollX / horizontalScrollStep) + 1,
      maxHorizontalScrolls
    );
    
    const verticalTiles = Math.min(
      Math.ceil(dimensions.maxScrollY / verticalScrollStep) + 1,
      maxVerticalScrolls
    );

    logger.info(`📐 Grid: ${horizontalTiles} cols × ${verticalTiles} rows = ${horizontalTiles * verticalTiles} tiles`);

    // ============================================
    // MAIN LOOP: Process each vertical row
    // ============================================
    
    for (let vStep = 0; vStep < verticalTiles; vStep++) {
      
      const targetY = Math.min(vStep * verticalScrollStep, dimensions.maxScrollY);
      
      logger.info(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      logger.info(`📄 ROW ${vStep + 1}/${verticalTiles} (Y=${targetY}px)`);
      logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

      // ✅ CRITICAL: Start at LEFT edge for this row
      logger.info(`⬅️  Positioning at left edge (0, ${targetY})`);
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(scrollDelay);

      // ────────────────────────────────────────
      // Inner loop: Capture columns (horizontal)
      // ────────────────────────────────────────
      
      for (let hStep = 0; hStep < horizontalTiles; hStep++) {
        
        const targetX = Math.min(hStep * horizontalScrollStep, dimensions.maxScrollX);
        
        logger.info(`🔄 Scroll to (${targetX}, ${targetY})`);
        
        await page.evaluate((x, y) => window.scrollTo(x, y), targetX, targetY);
        await page.waitForTimeout(scrollDelay);

        // Verify position
        const actualPos = await page.evaluate(() => ({
          x: window.scrollX,
          y: window.scrollY
        }));

        logger.info(`📍 Actual: (${actualPos.x}, ${actualPos.y})`);

        // Take screenshot
        logger.info(`📸 Tile ${tileIndex + 1} [Row ${vStep + 1}, Col ${hStep + 1}]`);
        
        const screenshot = await page.screenshot({
          type: 'png',
          fullPage: false
        });

        const sizeMB = (screenshot.length / 1024 / 1024).toFixed(2);

        tiles.push({
          buffer: screenshot,
          index: tileIndex,
          rowSet: vStep,
          columnSet: hStep,
          scrollX: actualPos.x,
          scrollY: actualPos.y,
          size: screenshot.length,
          sizeMB: sizeMB
        });

        logger.info(`✅ Captured: ${sizeMB} MB`);
        
        tileIndex++;

        if (targetX >= dimensions.maxScrollX && hStep > 0) {
          logger.info(`➡️  Reached right edge`);
          break;
        }
      }

      // ✅ CRITICAL: Return to LEFT edge after finishing row
      logger.info(`⬅️  Row ${vStep + 1} complete. Returning to left (0, ${targetY})`);
      await page.evaluate((y) => window.scrollTo(0, y), targetY);
      await page.waitForTimeout(500);

      if (targetY >= dimensions.maxScrollY && vStep > 0) {
        logger.info(`⬇️  Reached bottom`);
        break;
      }
    }

    // Reset to origin
    logger.info(`\n🔙 Complete. Returning to (0, 0)`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const totalSizeMB = (tiles.reduce((sum, t) => sum + t.size, 0) / 1024 / 1024).toFixed(2);

    logger.info(`\n✅ SUMMARY:`);
    logger.info(`   ├─ Tiles: ${tiles.length}`);
    logger.info(`   ├─ Grid: ${horizontalTiles}×${verticalTiles}`);
    logger.info(`   └─ Size: ${totalSizeMB} MB`);

    return {
      tiles: tiles,
      metadata: {
        totalTiles: tiles.length,
        gridColumns: horizontalTiles,
        gridRows: verticalTiles,
        totalSizeMB: totalSizeMB,
        captureTime: new Date().toISOString(),
        dimensions: dimensions
      }
    };

  } catch (err) {
    logger.error(`❌ Grid scroll failed: ${err.message}`);
    throw err;
  }
}

module.exports = {
  captureGridScrollScreenshots
};