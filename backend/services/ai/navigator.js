/**
 * AI Autonomous Navigator
 * 
 * Uses Google Gemini to interpret natural language instructions and autonomously
 * navigate websites, click buttons, fill forms, handle pagination, and extract data.
 */

const logger = require('../../utils/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { replaceDynamicDates } = require('../scraper/helpers');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
let genAI = null;

if (GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  logger.info('✅ AI Navigator initialized with Gemini API');
} else {
  logger.warn('⚠️ GEMINI_API_KEY not set - AI autonomous navigation disabled');
}

/**
 * Check if AI navigator is available
 */
function isNavigatorAvailable() {
  return !!genAI;
}

/**
 * Parse AI prompt into actionable steps using Gemini
 * @param {string} userPrompt - Natural language instructions from user
 * @param {string} pageUrl - Current page URL for context
 * @param {Buffer} screenshot - Screenshot of current page state
 * @returns {Promise<Array>} Array of navigation steps
 */
async function parseNavigationSteps(userPrompt, pageUrl, screenshot) {
  if (!genAI) {
    throw new Error('Gemini API not configured');
  }

  try {
    // Replace date placeholders before sending to AI
    const processedPrompt = replaceDynamicDates(userPrompt);
    
    logger.info(`🤖 Asking Gemini to interpret navigation instructions...`);
    logger.info(`📝 User prompt: ${processedPrompt.substring(0, 200)}...`);

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const systemPrompt = `You are a web automation expert. Analyze the screenshot and user instructions to generate precise Playwright automation steps.

IMPORTANT RULES:
1. Return ONLY a JSON array of action objects - no markdown, no explanations
2. Each action must have a "type" field
3. Be specific with selectors - prefer IDs, then data-test attributes, then stable classes
4. For dropdowns, use the visible text that appears in the UI
5. For date fields, use the exact format shown on the page
6. Always add wait steps after clicks and form submissions
7. For pagination, look for "Next", page numbers, or "Load More" buttons

AVAILABLE ACTION TYPES:
- click: Click a button/link. Fields: {type: "click", selector: "...", description: "..."}
- select: Choose from dropdown. Fields: {type: "select", selector: "...", value: "text to select", description: "..."}
- fill: Enter text in input. Fields: {type: "fill", selector: "...", value: "...", description: "..."}
- wait: Wait for element or duration. Fields: {type: "wait", selector: "..." OR duration: 3000, description: "..."}
- scroll: Scroll page. Fields: {type: "scroll", distance: 1000, description: "..."}
- extract: Extract data from current page. Fields: {type: "extract", description: "..."}
- paginate: Click next page and extract. Fields: {type: "paginate", nextButtonSelector: "...", maxPages: 10, description: "..."}

EXAMPLE OUTPUT:
[
  {"type": "select", "selector": "#permitType", "value": "All Building Permits", "description": "Select permit type"},
  {"type": "select", "selector": "#structureClass", "value": "10 or More Family Units", "description": "Select structure class"},
  {"type": "fill", "selector": "#startDate", "value": "{{DATE_365_DAYS_AGO}}", "description": "Enter start date"},
  {"type": "click", "selector": "button[type='submit']", "description": "Click Create List button"},
  {"type": "wait", "duration": 3000, "description": "Wait for results to load"},
  {"type": "extract", "description": "Extract data from results table"},
  {"type": "paginate", "nextButtonSelector": "a.next-page", "maxPages": 10, "description": "Extract from all pages"}
]

User's URL: ${pageUrl}
User's Instructions: ${processedPrompt}

Analyze the screenshot and generate the JSON array of actions needed to fulfill these instructions.`;

    const parts = [
      { text: systemPrompt }
    ];

    // Add screenshot if provided
    if (screenshot && Buffer.isBuffer(screenshot)) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: screenshot.toString('base64')
        }
      });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text();

    logger.info(`🤖 Gemini response received (${text.length} chars)`);

    // Clean up the response - remove markdown code blocks if present
    text = text.trim();
    if (text.startsWith('```json')) {
      text = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    } else if (text.startsWith('```')) {
      text = text.replace(/^```\s*/, '').replace(/```\s*$/, '');
    }

    // Parse JSON
    const actions = JSON.parse(text);

    if (!Array.isArray(actions)) {
      throw new Error('AI did not return an array of actions');
    }

    logger.info(`✅ Parsed ${actions.length} navigation steps`);
    actions.forEach((action, idx) => {
      logger.info(`  ${idx + 1}. ${action.type}: ${action.description || action.selector || ''}`);
    });

    return actions;

  } catch (error) {
    logger.error(`❌ Failed to parse navigation steps: ${error.message}`);
    throw error;
  }
}

/**
 * Execute a single navigation action
 * @param {Object} page - Playwright page object
 * @param {Object} action - Action object from parseNavigationSteps
 * @returns {Promise<Object>} Result with success status and any data
 */
async function executeAction(page, action) {
  logger.info(`🎬 Executing: ${action.type} - ${action.description || ''}`);

  try {
    switch (action.type) {
      case 'click':
        await page.click(action.selector, { timeout: 10000 });
        await page.waitForTimeout(1500); // Brief wait after click
        logger.info(`✅ Clicked: ${action.selector}`);
        return { success: true, action: 'click' };

      case 'select':
        // Handle both <select> dropdowns and custom dropdowns
        try {
          // Try standard select first
          await page.selectOption(action.selector, { label: action.value }, { timeout: 5000 });
        } catch (selectError) {
          // Fallback: try clicking the dropdown and then the option
          logger.info(`  Standard select failed, trying custom dropdown...`);
          await page.click(action.selector);
          await page.waitForTimeout(500);
          // Try to find and click the option by text
          const optionSelector = `${action.selector} option:has-text("${action.value}"), [role="option"]:has-text("${action.value}")`;
          await page.click(optionSelector, { timeout: 3000 });
        }
        await page.waitForTimeout(1000); // Wait for any onChange handlers
        logger.info(`✅ Selected "${action.value}" in ${action.selector}`);
        return { success: true, action: 'select', value: action.value };

      case 'fill':
        // Replace date placeholders
        const value = replaceDynamicDates(action.value);
        await page.fill(action.selector, value, { timeout: 10000 });
        await page.waitForTimeout(500); // Brief wait after fill
        logger.info(`✅ Filled "${value}" into ${action.selector}`);
        return { success: true, action: 'fill', value };

      case 'wait':
        if (action.selector) {
          await page.waitForSelector(action.selector, { timeout: 30000, state: 'visible' });
          logger.info(`✅ Element appeared: ${action.selector}`);
        } else if (action.duration) {
          await page.waitForTimeout(action.duration);
          logger.info(`✅ Waited ${action.duration}ms`);
        }
        return { success: true, action: 'wait' };

      case 'scroll':
        const distance = action.distance || 1000;
        await page.evaluate((dist) => {
          window.scrollBy(0, dist);
        }, distance);
        await page.waitForTimeout(1000); // Wait for lazy loading
        logger.info(`✅ Scrolled ${distance}px`);
        return { success: true, action: 'scroll' };

      case 'extract':
        // This is a marker - actual extraction happens in the main scraper
        logger.info(`📊 Extract marker - will capture screenshot for AI extraction`);
        return { success: true, action: 'extract', shouldExtract: true };

      case 'paginate':
        // This is handled specially in the main navigation loop
        logger.info(`📄 Pagination marker - will handle multi-page extraction`);
        return { 
          success: true, 
          action: 'paginate', 
          shouldPaginate: true,
          nextButtonSelector: action.nextButtonSelector,
          maxPages: action.maxPages || 10
        };

      default:
        logger.warn(`⚠️ Unknown action type: ${action.type}`);
        return { success: false, error: 'Unknown action type' };
    }

  } catch (error) {
    logger.error(`❌ Action failed: ${action.type} - ${error.message}`);
    return { success: false, error: error.message, action: action.type };
  }
}

/**
 * Execute autonomous navigation based on natural language prompt
 * @param {Object} page - Playwright page object
 * @param {string} userPrompt - Natural language navigation instructions
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Navigation results including pagination info
 */
async function navigateAutonomously(page, userPrompt, options = {}) {
  if (!genAI) {
    throw new Error('AI Navigator not available - GEMINI_API_KEY not set');
  }

  const {
    maxRetries = 1,
    takeInitialScreenshot = true
  } = options;

  logger.info(`🤖 Starting AI autonomous navigation...`);
  logger.info(`📝 Prompt: ${userPrompt}`);

  try {
    // Take initial screenshot to understand the page
    let screenshot = null;
    if (takeInitialScreenshot) {
      logger.info(`📸 Capturing initial page state...`);
      screenshot = await page.screenshot({ fullPage: false, type: 'png' });
    }

    // Get navigation steps from AI
    const actions = await parseNavigationSteps(userPrompt, page.url(), screenshot);

    if (!actions || actions.length === 0) {
      logger.warn(`⚠️ No actions generated by AI`);
      return { 
        success: false, 
        error: 'No actions generated',
        shouldExtract: true // Extract anyway
      };
    }

    // Execute each action
    const results = [];
    let shouldExtract = false;
    let paginationInfo = null;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      
      let result = await executeAction(page, action);
      
      // Retry once if action failed
      if (!result.success && maxRetries > 0) {
        logger.warn(`⚠️ Action failed, retrying...`);
        await page.waitForTimeout(2000);
        result = await executeAction(page, action);
      }

      results.push({ ...action, ...result });

      // Check for extract or paginate markers
      if (result.shouldExtract) {
        shouldExtract = true;
      }
      if (result.shouldPaginate) {
        paginationInfo = {
          nextButtonSelector: result.nextButtonSelector,
          maxPages: result.maxPages
        };
      }

      // Stop if critical action failed
      if (!result.success && action.type !== 'wait') {
        logger.error(`❌ Critical action failed, stopping navigation`);
        break;
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info(`✅ Navigation complete: ${successCount}/${results.length} actions succeeded`);

    return {
      success: successCount > 0,
      actions: results,
      shouldExtract,
      paginationInfo
    };

  } catch (error) {
    logger.error(`❌ Autonomous navigation failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      shouldExtract: true // Try to extract anyway
    };
  }
}

/**
 * Handle pagination based on AI instructions
 * @param {Object} page - Playwright page object
 * @param {Object} paginationInfo - Pagination configuration from navigation
 * @returns {Promise<boolean>} True if next page exists and was clicked
 */
async function clickNextPage(page, paginationInfo) {
  if (!paginationInfo || !paginationInfo.nextButtonSelector) {
    // Fallback to standard pagination detection
    return await clickNextPageFallback(page);
  }

  try {
    const selector = paginationInfo.nextButtonSelector;
    
    // Check if next button exists and is enabled
    const isDisabled = await page.evaluate((sel) => {
      const elem = document.querySelector(sel);
      if (!elem) return true;
      return elem.disabled || 
             elem.classList.contains('disabled') || 
             elem.getAttribute('aria-disabled') === 'true';
    }, selector);

    if (isDisabled) {
      logger.info(`📄 No more pages (button disabled or not found)`);
      return false;
    }

    // Click next page
    await page.click(selector, { timeout: 5000 });
    logger.info(`✅ Clicked next page: ${selector}`);
    
    // Wait for page to load
    await page.waitForTimeout(3000);
    return true;

  } catch (error) {
    logger.warn(`⚠️ Failed to click next page: ${error.message}`);
    return false;
  }
}

/**
 * Fallback pagination when AI didn't specify selector
 */
async function clickNextPageFallback(page) {
  try {
    const nextFound = await page.evaluate(() => {
      const selectors = [
        'button[aria-label*="Next" i]',
        'a[aria-label*="Next" i]',
        'button[title*="Next" i]',
        'a[title*="Next" i]',
        '.pagination .next:not(.disabled)',
        'a.next:not(.disabled)',
        'button.next:not(:disabled)'
      ];

      for (const sel of selectors) {
        const elem = document.querySelector(sel);
        if (elem && !elem.disabled && !elem.classList.contains('disabled')) {
          elem.click();
          return true;
        }
      }

      // Try finding by text
      const links = Array.from(document.querySelectorAll('a, button'));
      const next = links.find(e => {
        const text = e.textContent.trim().toLowerCase();
        return (text === 'next' || text === '›' || text === '>') &&
               !e.disabled && 
               !e.classList.contains('disabled');
      });

      if (next) {
        next.click();
        return true;
      }

      return false;
    });

    if (nextFound) {
      logger.info(`✅ Clicked next page (fallback detection)`);
      await page.waitForTimeout(3000);
      return true;
    } else {
      logger.info(`📄 No more pages found`);
      return false;
    }

  } catch (error) {
    logger.warn(`⚠️ Pagination fallback failed: ${error.message}`);
    return false;
  }
}

module.exports = {
  isNavigatorAvailable,
  navigateAutonomously,
  clickNextPage,
  parseNavigationSteps,
  executeAction
};
