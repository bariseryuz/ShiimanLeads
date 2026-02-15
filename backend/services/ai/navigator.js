/**
 * AI Navigator - Agent 1
 * Handles form filling, clicking, navigation
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { NAVIGATION_SYSTEM_PROMPT, buildNavigationPrompt } = require('../../prompts/navigation');
const { replaceDynamicDates } = require('../scraper/helpers');

/**
 * Parse natural language instructions into actionable steps
 */

async function parseNavigationSteps(instructions, pageUrl, screenshot) {
  if (!isAIAvailable()) {
    throw new Error('Gemini API not configured');
  }

  try {
    const processedInstructions = replaceDynamicDates(instructions);
    
    logger.info(`🤖 [Navigator] Parsing instructions...`);
    logger.info(`📝 Instructions: ${processedInstructions.substring(0, 100)}...`);

    const model = getGeminiModel('navigation');
    const userPrompt = buildNavigationPrompt(processedInstructions, pageUrl);

    const parts = [
      { text: NAVIGATION_SYSTEM_PROMPT },
      { text: userPrompt }
    ];

    // Add screenshot if provided
    if (screenshot && Buffer.isBuffer(screenshot)) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: screenshot.toString('base64')
        }
      });
      logger.info(`📸 Screenshot included: ${(screenshot.length / 1024).toFixed(1)}KB`);
    }

    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text();

    logger.info(`📥 [Navigator] Response: ${text.length} chars`);

    // Clean response
    text = text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    text = text.replace(/^```\s*/, '').replace(/```\s*$/i, '');

    const actions = JSON.parse(text);

    if (!Array.isArray(actions)) {
      throw new Error('Navigator did not return an array');
    }

    logger.info(`✅ [Navigator] Parsed ${actions.length} steps`);
    actions.forEach((action, idx) => {
      logger.info(`  ${idx + 1}. ${action.type}: ${action.description || ''}`);
    });

    return actions;

  } catch (error) {
    logger.error(`❌ [Navigator] Failed: ${error.message}`);
    throw error;
  }
}

/**
 * Execute a single navigation action
 */
async function executeAction(page, action) {
  logger.info(`🎬 [Navigator] ${action.type} - ${action.description || ''}`);

  try {
    switch (action.type) {
      case 'click':
        await page.click(action.selector, { timeout: 10000 });
        await page.waitForTimeout(1500);
        logger.info(`✅ Clicked: ${action.selector}`);
        return { success: true, action: 'click' };

      case 'select':
        try {
          await page.selectOption(action.selector, { label: action.value }, { timeout: 5000 });
        } catch (selectError) {
          logger.info(`  Trying custom dropdown...`);
          await page.click(action.selector);
          await page.waitForTimeout(500);
          const optionSelector = `${action.selector} option:has-text("${action.value}"), [role="option"]:has-text("${action.value}")`;
          await page.click(optionSelector, { timeout: 3000 });
        }
        await page.waitForTimeout(1000);
        logger.info(`✅ Selected "${action.value}" in ${action.selector}`);
        return { success: true, action: 'select', value: action.value };

      case 'fill':
        const value = replaceDynamicDates(action.value);
        await page.fill(action.selector, value, { timeout: 10000 });
        await page.waitForTimeout(500);
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
        await page.evaluate((dist) => window.scrollBy(0, dist), distance);
        await page.waitForTimeout(1000);
        logger.info(`✅ Scrolled ${distance}px`);
        return { success: true, action: 'scroll' };

      case 'extract':
        logger.info(`📊 Extract marker - will capture data`);
        return { success: true, action: 'extract', shouldExtract: true };

      default:
        logger.warn(`⚠️ Unknown action: ${action.type}`);
        return { success: false, error: 'Unknown action' };
    }

  } catch (error) {
    logger.error(`❌ Action failed: ${action.type} - ${error.message}`);
    return { success: false, error: error.message, action: action.type };
  }
}

/**
 * Execute full navigation workflow
 */
async function navigateAutonomously(page, instructions, options = {}) {
  if (!isAIAvailable()) {
    throw new Error('AI Navigator not available');
  }

  const { maxRetries = 1, takeScreenshot = true } = options;

  logger.info(`🤖 [Navigator] Starting autonomous navigation`);

  try {
    let screenshot = null;
    if (takeScreenshot) {
      logger.info(`📸 Capturing page state...`);
      screenshot = await page.screenshot({ fullPage: false, type: 'png' });
    }

    const actions = await parseNavigationSteps(instructions, page.url(), screenshot);

    if (!actions || actions.length === 0) {
      logger.warn(`⚠️ No actions generated`);
      return { success: false, error: 'No actions', shouldExtract: true };
    }

    const results = [];
    let shouldExtract = false;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      
      let result = await executeAction(page, action);
      
      // Retry once if failed
      if (!result.success && maxRetries > 0) {
        logger.warn(`⚠️ Retrying action...`);
        await page.waitForTimeout(2000);
        result = await executeAction(page, action);
      }

      results.push({ ...action, ...result });

      if (result.shouldExtract) {
        shouldExtract = true;
      }

      // Stop on critical failure
      if (!result.success && action.type !== 'wait') {
        logger.error(`❌ Critical action failed, stopping`);
        break;
      }
    }

    const successCount = results.filter(r => r.success).length;
    logger.info(`✅ [Navigator] Complete: ${successCount}/${results.length} succeeded`);

    return {
      success: successCount > 0,
      actions: results,
      shouldExtract
    };

  } catch (error) {
    logger.error(`❌ [Navigator] Failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      shouldExtract: true
    };
  }
}

module.exports = {
  isNavigatorAvailable: isAIAvailable,
  navigateAutonomously,
  parseNavigationSteps,
  executeAction
};