/**
 * SMART GRID SCRAPER - 12-TILE PROGRESSIVE CAPTURE SYSTEM
 * Handles infinite scroll, auto-loading pages, and complex layouts
 */

const logger = require('../../utils/logger');
const { navigateAutonomously, extractFromScreenshot } = require('../ai');

// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG = {
  // Tile layout (12 tiles = 3 columns × 4 rows)
  columns: 3,
  rows: 4,
  totalTiles: 12,
  tileWidth: 640,
  tileHeight: 270,
  
  // Scrolling behavior
  scrollAmount: 1080,        // Pixels to scroll each time
  waitAfterScroll: 2000,     // Wait 2s for auto-load
  maxScrolls: 50,            // Max scroll positions (safety limit)
  stableChecks: 3,           // Confirm 3 times page stopped loading
  
  // Targets
  targetLeadCount: 500,      // Stop when this many leads extracted
  
  // Performance
  delayBetweenTiles: 400,    // ms delay between AI API calls
  screenshotTimeout: 3000    // Max wait for screenshot
};

// Alternative tile configurations
const TILE_PRESETS = {
  'fast': {
    columns: 2,
    rows: 2,
    totalTiles: 4,
    tileWidth: 960,
    tileHeight: 540
  },
  'balanced': {
    columns: 3,
    rows: 2,
    totalTiles: 6,
    tileWidth: 640,
    tileHeight: 540
  },
  'detailed': {
    columns: 3,
    rows: 4,
    totalTiles: 12,
    tileWidth: 640,
    tileHeight: 270
  }
};

// ============================================================================
// SECTION 2: PAGE MEASUREMENT
// ============================================================================

/**
 * Measure complete page dimensions
 */
async function measurePageDimensions(page) {
  logger.info(`📏 Measuring page dimensions...`);
  
  const dimensions = await page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    
    return {
      // Viewport (visible area)
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      
      // Full document size
      fullWidth: Math.max(
        body.scrollWidth,
        body.offsetWidth,
        html.clientWidth,
        html.scrollWidth,
        html.offsetWidth
      ),
      fullHeight: Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.clientHeight,
        html.scrollHeight,
        html.offsetHeight
      ),
      
      // Current scroll position
      currentScrollX: window.scrollX || window.pageXOffset,
      currentScrollY: window.scrollY || window.pageYOffset,
      
      // Maximum scroll possible
      maxScrollX: Math.max(0, html.scrollWidth - window.innerWidth),
      maxScrollY: Math.max(0, html.scrollHeight - window.innerHeight)
    };
  });
  
  dimensions.canScrollHorizontally = dimensions.maxScrollX > 0;
  dimensions.canScrollVertically = dimensions.maxScrollY > 0;
  
  logger.info(`📐 Measurement Results:`);
  logger.info(`   Viewport: ${dimensions.viewportWidth}×${dimensions.viewportHeight}px`);
  logger.info(`   Full Page: ${dimensions.fullWidth}×${dimensions.fullHeight}px`);
  logger.info(`   Horizontal Scroll: ${dimensions.canScrollHorizontally ? 'YES' : 'NO'} (max: ${dimensions.maxScrollX}px)`);
  logger.info(`   Vertical Scroll: ${dimensions.canScrollVertically ? 'YES' : 'NO'} (max: ${dimensions.maxScrollY}px)`);
  
  return dimensions;
}

// ============================================================================
// SECTION 3: AUTO-LOAD DETECTION
// ============================================================================

/**
 * Wait for auto-loading content (infinite scroll)
 */
async function waitForAutoLoad(page, config) {
  logger.info(`⏳ Waiting for auto-load (${config.waitAfterScroll}ms)...`);
  
  const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
  
  // Wait configured time
  await page.waitForTimeout(config.waitAfterScroll);
  
  // Check if new content loaded
  const afterHeight = await page.evaluate(() => document.body.scrollHeight);
  
  if (afterHeight > beforeHeight) {
    logger.info(`   ✅ New content loaded (+${afterHeight - beforeHeight}px)`);
    
    // Wait a bit more for images/content to stabilize
    await page.waitForTimeout(1000);
    
    return { loaded: true, heightChange: afterHeight - beforeHeight };
  } else {
    logger.info(`   ⏸️  No new content detected`);
    return { loaded: false, heightChange: 0 };
  }
}

/**
 * Detect and click "Load More" button if present
 */
async function detectAndClickLoadMore(page) {
  const loadMoreSelectors = [
    'button:has-text("Load More")',
    'button:has-text("Show More")',
    'a:has-text("Load More")',
    'a:has-text("Show More")',
    '.load-more',
    '#load-more',
    '[data-testid="load-more"]',
    'button[class*="load"]',
    'button[class*="more"]'
  ];
  
  for (const selector of loadMoreSelectors) {
    try {
      const button = await page.$(selector);
      if (button) {
        const isVisible = await button.isVisible();
        if (isVisible) {
          logger.info(`   🔘 Found "Load More" button: ${selector}`);
          await button.click();
          logger.info(`   ✅ Clicked "Load More"`);
          await page.waitForTimeout(2000); // Wait for content
          return true;
        }
      }
    } catch (e) {
      // Try next selector
      continue;
    }
  }
  
  return false;
}

// ============================================================================
// SECTION 4: TILE CAPTURE
// ============================================================================

/**
 * Capture all tiles at current scroll position
 */
async function captureAllTilesAtPosition(page, scrollPosition, config) {
  const { columns, rows, tileWidth, tileHeight } = config;
  
  logger.info(`📸 Capturing ${columns}×${rows} grid at position Y=${scrollPosition}`);
  
  const tiles = [];
  
  // Get current page dimensions
  const dimensions = await page.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    scrollWidth: document.body.scrollWidth
  }));
  
  // Capture each tile in the grid
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const tileScrollY = scrollPosition + (row * tileHeight);
      const tileScrollX = col * tileWidth;
      
      // Check if this tile is within page bounds
      if (tileScrollY >= dimensions.scrollHeight) {
        logger.debug(`   ⏭️  Tile [${row},${col}] beyond page height, skipping`);
        continue;
      }
      
      try {
        // ✅ FIX: Wrap coordinates in object (Playwright evaluate limitation)
        await page.evaluate((coords) => {
          window.scrollTo(coords.x, coords.y);
        }, { x: tileScrollX, y: tileScrollY });
        
        // Small wait for rendering
        await page.waitForTimeout(300);
        
        // Take screenshot
        const screenshot = await page.screenshot({
          fullPage: false,
          type: 'png',
          timeout: config.screenshotTimeout
        });
        
        const tileIndex = tiles.length;
        const sizeKB = (screenshot.length / 1024).toFixed(1);
        
        logger.info(`   📸 Tile ${tileIndex + 1}: [Row ${row}, Col ${col}] - ${sizeKB}KB`);
        
        tiles.push({
          index: tileIndex,
          row: row,
          col: col,
          scrollX: tileScrollX,
          scrollY: tileScrollY,
          screenshot: screenshot,
          sizeBytes: screenshot.length,
          label: `[Row ${row}, Col ${col}]`
        });
        
      } catch (error) {
        logger.error(`   ❌ Failed to capture tile [${row},${col}]: ${error.message}`);
      }
    }
  }
  
  logger.info(`✅ Captured ${tiles.length} tiles at position Y=${scrollPosition}`);
  
  return tiles;
}

// ============================================================================
// SECTION 5: DATA EXTRACTION
// ============================================================================

/**
 * Extract data from a single tile using AI
 */
async function extractFromTile(tile, sourceName, fieldMapping) {
  try {
    const extracted = await extractFromScreenshot(
      tile.screenshot,
      sourceName,
      fieldMapping
    );
    
    if (extracted && Array.isArray(extracted) && extracted.length > 0) {
      // Tag each record with tile metadata
      extracted.forEach(record => {
        record._metadata = {
          tile: tile.label,
          tileIndex: tile.index,
          row: tile.row,
          col: tile.col,
          scrollPosition: { x: tile.scrollX, y: tile.scrollY }
        };
      });
      
      return extracted;
    }
    
    return [];
    
  } catch (error) {
    logger.error(`   ❌ Extraction failed for tile ${tile.index}: ${error.message}`);
    return [];
  }
}

/**
 * Extract data from all tiles with real-time processing
 */
async function extractFromAllTiles(tiles, sourceName, fieldMapping, config) {
  logger.info(`🤖 Extracting data from ${tiles.length} tiles...`);
  
  const allLeads = [];
  
  for (const tile of tiles) {
    logger.info(`🤖 Analyzing tile ${tile.index + 1}/${tiles.length} ${tile.label}...`);
    
    const extracted = await extractFromTile(tile, sourceName, fieldMapping);
    
    if (extracted.length > 0) {
      logger.info(`   ✅ Found ${extracted.length} records`);
      allLeads.push(...extracted);
      logger.info(`   📊 Total leads so far: ${allLeads.length}`);
    } else {
      logger.info(`   ℹ️  No records found in this tile`);
    }
    
    // Delay between API calls to avoid rate limiting
    if (tile.index < tiles.length - 1) {
      await new Promise(resolve => setTimeout(resolve, config.delayBetweenTiles));
    }
  }
  
  logger.info(`✅ Extraction complete: ${allLeads.length} total leads from ${tiles.length} tiles`);
  
  return allLeads;
}

// ============================================================================
// SECTION 6: DATA PROCESSING
// ============================================================================

/**
 * Remove duplicate records
 */
function deduplicateRecords(records, fieldMapping) {
  if (!records || records.length === 0) {
    return { unique: [], duplicates: [], stats: { original: 0, unique: 0, duplicatesRemoved: 0 } };
  }
  
  logger.info(`🔍 Deduplicating ${records.length} records...`);
  
  // Use first field as primary key
  const fieldNames = Object.keys(fieldMapping);
  const primaryKeyField = fieldNames[0];
  
  logger.info(`   Using primary key: "${primaryKeyField}"`);
  
  const seen = new Map();
  const unique = [];
  const duplicates = [];
  
  for (const record of records) {
    const keyValue = record[primaryKeyField];
    
    // Skip records with no primary key
    if (!keyValue || keyValue === '-' || keyValue === '' || keyValue === null) {
      continue;
    }
    
    // Normalize key
    const normalizedKey = String(keyValue).toLowerCase().trim().replace(/\s+/g, ' ');
    
    if (!seen.has(normalizedKey)) {
      seen.set(normalizedKey, record);
      unique.push(record);
    } else {
      duplicates.push(record);
    }
  }
  
  logger.info(`✅ Deduplication complete:`);
  logger.info(`   Original: ${records.length}`);
  logger.info(`   Unique: ${unique.length}`);
  logger.info(`   Duplicates removed: ${duplicates.length}`);
  
  return {
    unique: unique,
    duplicates: duplicates,
    stats: {
      original: records.length,
      unique: unique.length,
      duplicatesRemoved: duplicates.length
    }
  };
}

/**
 * Validate record quality
 */
function validateRecords(records) {
  logger.info(`✅ Validating ${records.length} records...`);
  
  const valid = [];
  const invalid = [];
  const empty = [];
  
  for (const record of records) {
    // Get data fields (exclude metadata)
    const dataFields = Object.keys(record).filter(key => !key.startsWith('_'));
    
    if (dataFields.length === 0) {
      empty.push({ ...record, _validationError: 'No data fields' });
      continue;
    }
    
    // Count filled fields
    const filledFields = dataFields.filter(key => {
      const value = record[key];
      return value !== null && 
             value !== undefined && 
             value !== '' && 
             value !== '-' &&
             String(value).trim() !== '';
    });
    
    const fillRate = filledFields.length / dataFields.length;
    
    if (fillRate === 0) {
      empty.push({ ...record, _validationError: 'All fields empty', _fillRate: 0 });
    } else if (fillRate < 0.3) {
      invalid.push({
        ...record,
        _validationError: `Only ${Math.round(fillRate * 100)}% filled`,
        _fillRate: fillRate
      });
    } else {
      valid.push({ ...record, _fillRate: fillRate });
    }
  }
  
  logger.info(`📊 Validation Results:`);
  logger.info(`   ✅ Valid: ${valid.length} (${(valid.length / records.length * 100).toFixed(1)}%)`);
  logger.info(`   ⚠️  Invalid: ${invalid.length} (${(invalid.length / records.length * 100).toFixed(1)}%)`);
  logger.info(`   ❌ Empty: ${empty.length} (${(empty.length / records.length * 100).toFixed(1)}%)`);
  
  return {
    valid: valid,
    invalid: invalid,
    empty: empty,
    stats: {
      total: records.length,
      validCount: valid.length,
      invalidCount: invalid.length,
      emptyCount: empty.length,
      validPercent: (valid.length / records.length * 100).toFixed(1)
    }
  };
}

// ============================================================================
// SECTION 7: MAIN SCRAPER FUNCTION
// ============================================================================

/**
 * MAIN FUNCTION: Smart Grid Scraper with Progressive Capture
 */
async function scrapeWithSmartGrid(page, source, userConfig = {}) {
  logger.info(`\n🚀 ========================================`);
  logger.info(`🚀 SMART GRID SCRAPER (12-TILE)`);
  logger.info(`🚀 Source: ${source.name}`);
  logger.info(`🚀 ========================================\n`);
  
  const startTime = Date.now();
  
  // Merge user config with defaults
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  
  // Allow preset selection
  if (config.preset && TILE_PRESETS[config.preset]) {
    Object.assign(config, TILE_PRESETS[config.preset]);
  }
  
  logger.info(`⚙️  Configuration:`);
  logger.info(`   Grid: ${config.columns}×${config.rows} (${config.totalTiles} tiles)`);
  logger.info(`   Tile size: ${config.tileWidth}×${config.tileHeight}px`);
  logger.info(`   Target: ${config.targetLeadCount} leads`);
  logger.info(`   Max scrolls: ${config.maxScrolls}`);
  
  try {
    // PHASE 1: Navigate to page
    logger.info(`\n📍 Phase 1: Navigation`);
    await page.goto(source.url, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2000);
    logger.info(`✅ Page loaded`);
    
    // PHASE 2: Execute navigation instructions
    if (source.scraping_instructions) {
      logger.info(`\n🤖 Phase 2: Executing navigation instructions`);
      
      const navResult = await navigateAutonomously(
        page,
        source.scraping_instructions,
        { takeScreenshot: true }
      );
      
      if (!navResult.success) {
        throw new Error(`Navigation failed: ${navResult.error}`);
      }
      
      logger.info(`✅ Navigation complete`);
      await page.waitForTimeout(3000);
    }
    
    // PHASE 3: Progressive capture with auto-load handling
    logger.info(`\n📸 Phase 3: Progressive Tile Capture`);
    
    const fieldMapping = typeof source.field_mapping === 'string'
      ? JSON.parse(source.field_mapping)
      : source.field_mapping;
    
    const allLeads = [];
    const allTiles = [];
    let scrollPosition = 0;
    let scrollCount = 0;
    let stableCount = 0;
    let previousHeight = 0;
    
    // Main scrolling loop
    while (scrollCount < config.maxScrolls) {
      logger.info(`\n📸 ========== SCROLL POSITION ${scrollCount + 1} ==========`);
      logger.info(`   Current Y position: ${scrollPosition}px`);
      
      // Capture tiles at current position
      const tiles = await captureAllTilesAtPosition(page, scrollPosition, config);
      allTiles.push(...tiles);
      
      // Extract data from tiles immediately
      logger.info(`\n🤖 Analyzing ${tiles.length} tiles...`);
      const extracted = await extractFromAllTiles(tiles, source.name, fieldMapping, config);
      
      if (extracted.length > 0) {
        allLeads.push(...extracted);
        logger.info(`📊 Running total: ${allLeads.length} leads`);
        
        // Check if target reached
        if (allLeads.length >= config.targetLeadCount) {
          logger.info(`\n🎯 TARGET REACHED! (${allLeads.length}/${config.targetLeadCount})`);
          logger.info(`✅ Stopping capture early`);
          break;
        }
      }
      
      // Check if at bottom of page
      const currentDimensions = await measurePageDimensions(page);
      const isAtBottom = (scrollPosition + config.tileHeight) >= currentDimensions.fullHeight;
      
      if (isAtBottom) {
        logger.info(`\n🏁 Reached bottom of page`);
        break;
      }
      
      // Scroll down
      logger.info(`\n⬇️  Scrolling down ${config.scrollAmount}px...`);
      await page.evaluate((amount) => {
        window.scrollBy(0, amount);
      }, config.scrollAmount);
      
      scrollPosition = await page.evaluate(() => window.scrollY);
      
      // Wait for auto-load
      const loadResult = await waitForAutoLoad(page, config);
      
      // Try clicking "Load More" if no auto-load detected
      if (!loadResult.loaded) {
        const clicked = await detectAndClickLoadMore(page);
        if (clicked) {
          await waitForAutoLoad(page, config);
        }
      }
      
      // Check if page height changed
      const newHeight = await page.evaluate(() => document.body.scrollHeight);
      
      if (newHeight > previousHeight) {
        stableCount = 0;
        previousHeight = newHeight;
      } else {
        stableCount++;
        logger.info(`   ⏸️  Page stable (${stableCount}/${config.stableChecks})`);
        
        if (stableCount >= config.stableChecks) {
          logger.info(`\n✅ Page stopped loading - no more content`);
          break;
        }
      }
      
      scrollCount++;
    }
    
    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    
    // PHASE 4: Process results
    logger.info(`\n🔄 Phase 4: Processing Results`);
    logger.info(`   Total tiles captured: ${allTiles.length}`);
    logger.info(`   Raw leads extracted: ${allLeads.length}`);
    
    // Deduplicate
    const dedupeResult = deduplicateRecords(allLeads, fieldMapping);
    
    // Validate
    const validationResult = validateRecords(dedupeResult.unique);
    
    // Calculate stats
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    logger.info(`\n🎉 ========================================`);
    logger.info(`🎉 SCRAPE COMPLETE in ${duration}s`);
    logger.info(`🎉 ========================================`);
    logger.info(`📊 Final Statistics:`);
    logger.info(`   Scroll positions: ${scrollCount + 1}`);
    logger.info(`   Total tiles: ${allTiles.length}`);
    logger.info(`   Raw extracted: ${allLeads.length}`);
    logger.info(`   After deduplication: ${dedupeResult.unique.length}`);
    logger.info(`   Valid leads: ${validationResult.valid.length}`);
    logger.info(`   Invalid: ${validationResult.invalid.length}`);
    logger.info(`   Empty: ${validationResult.empty.length}`);
    logger.info(`   Success rate: ${validationResult.stats.validPercent}%`);
    
    return {
      success: true,
      records: validationResult.valid,
      invalidRecords: validationResult.invalid,
      emptyRecords: validationResult.empty,
      stats: {
        duration: parseFloat(duration),
        scrollPositions: scrollCount + 1,
        totalTiles: allTiles.length,
        rawLeadCount: allLeads.length,
        uniqueLeadCount: dedupeResult.unique.length,
        validLeadCount: validationResult.valid.length,
        invalidLeadCount: validationResult.invalid.length,
        emptyLeadCount: validationResult.empty.length,
        successRate: validationResult.stats.validPercent,
        targetReached: allLeads.length >= config.targetLeadCount
      }
    };
    
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    logger.error(`\n❌ ========================================`);
    logger.error(`❌ SCRAPE FAILED after ${duration}s`);
    logger.error(`❌ Error: ${error.message}`);
    logger.error(`❌ ========================================`);
    logger.error(error.stack);
    
    return {
      success: false,
      error: error.message,
      stack: error.stack,
      duration: parseFloat(duration)
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  scrapeWithSmartGrid,
  TILE_PRESETS,
  DEFAULT_CONFIG
};