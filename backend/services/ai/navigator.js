/**
 * AI Navigator - Agent 1
 * Handles autonomous web navigation using Gemini 2.0 Flash Lite
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { NAVIGATION_SYSTEM_PROMPT, buildNavigationPrompt } = require('../../prompts/navigation');
const { replaceDynamicDates } = require('../scraper/helpers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Step 1: Ask Gemini to convert natural language instructions into JSON actions
 */
async function parseNavigationSteps(instructions, pageUrl, screenshot) {
  if (!isAIAvailable()) throw new Error('Gemini API not configured');
  const RPM_COOLDOWN = 4500; 

  try {
    const processedInstructions = replaceDynamicDates(instructions);
    logger.info(`⏳ [Navigator Quota] Throttling ${RPM_COOLDOWN}ms...`);
    await sleep(RPM_COOLDOWN);

    const model = getGeminiModel('navigation');
    const userPrompt = buildNavigationPrompt(processedInstructions, pageUrl);

    const parts = [{ text: NAVIGATION_SYSTEM_PROMPT }, { text: userPrompt }];

    if (screenshot && Buffer.isBuffer(screenshot)) {
      parts.push({
        inlineData: { mimeType: 'image/png', data: screenshot.toString('base64') }
      });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text().trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    
    // Try to parse JSON with error handling
    try {
      return JSON.parse(text);
    } catch (parseError) {
      logger.error(`❌ [Navigator] JSON Parse Failed: ${parseError.message}`);
      logger.error(`   Raw AI response (first 500 chars): ${text.substring(0, 500)}`);
      logger.error(`   Response length: ${text.length} chars`);
      
      // Pre-check: if response is obviously incomplete, try recovery
      const openBraces = (text.match(/{/g) || []).length;
      const closeBraces = (text.match(/}/g) || []).length;
      const isArray = text.trim().startsWith('[');
      
      logger.info(`   📊 Analysis: ${openBraces} open braces, ${closeBraces} close braces, isArray: ${isArray}`);
      
      // If extremely truncated (very few braces), return empty
      if (openBraces === 0 && closeBraces === 0) {
        logger.error(`   ❌ Response has no JSON structure at all`);
        return [];
      }
      
      // Try aggressive recovery for truncated responses
      try {
        let fixed = text;
        let recoverySuccess = false;
        
        // For arrays: find last complete object and discard incomplete tail
        if (isArray) {
          // Strategy 1: Find last complete '},' pattern
          const lastCompleteObject = text.lastIndexOf('},');
          if (lastCompleteObject > 0) {
            fixed = text.substring(0, lastCompleteObject + 1) + ']';
            logger.info(`   🔧 Strategy 1: Found complete object at position ${lastCompleteObject}`);
            recoverySuccess = true;
          } 
          
          // Strategy 2: Find ANY closing brace
          if (!recoverySuccess) {
            const matches = Array.from(text.matchAll(/}\s*,/g));
            if (matches.length > 0) {
              const lastMatch = matches[matches.length - 1];
              fixed = text.substring(0, lastMatch.index + 1) + ']';
              logger.info(`   🔧 Strategy 2: Found ${matches.length} brace patterns`);
              recoverySuccess = true;
            }
          }
          
          // Strategy 3: Look for ANY closing brace (even without comma)
          if (!recoverySuccess) {
            const lastBrace = text.lastIndexOf('}');
            if (lastBrace > 0) {
              fixed = text.substring(0, lastBrace + 1) + ']';
              logger.info(`   🔧 Strategy 3: Found closing brace at position ${lastBrace}`);
              recoverySuccess = true;
            }
          }
          
          // Strategy 4: If we found opening braces but no closing ones at all
          if (!recoverySuccess && openBraces > closeBraces) {
            fixed = text + '}]'.repeat(openBraces - closeBraces);
            logger.info(`   🔧 Strategy 4: Added ${openBraces - closeBraces} closing braces`);
            recoverySuccess = true;
          }
          
          // Strategy 5: Fallback - just close the array
          if (!recoverySuccess) {
            // Try to find ANY complete object and at least return that
            if (text.includes('{"') || text.includes("{'")) {
              fixed = text.replace(/,\s*([}\]])/g, '$1');
              fixed = fixed.replace(/"[^"]*$/, '"');
              if (!fixed.endsWith('}')) fixed += '}';
              if (!fixed.endsWith(']')) fixed += ']';
              logger.info(`   🔧 Strategy 5: Applied basic cleanup`);
              recoverySuccess = true;
            } else {
              logger.error(`   ❌ No recoverable structure found`);
              return [];
            }
          }
        } else {
          // Single object case
          fixed = text.replace(/,\s*([}\]])/g, '$1');
          fixed = fixed.replace(/"[^"]*$/, '"');
          if (!fixed.endsWith('}')) fixed += '}';
          logger.info(`   🔧 Single object recovery`);
        }
        
        // Attempt to parse the fixed JSON
        const parsed = JSON.parse(fixed);
        const itemCount = Array.isArray(parsed) ? parsed.length : 1;
        logger.info(`   ✅ Successfully recovered ${itemCount} ${itemCount === 1 ? 'action' : 'actions'} from truncated response`);
        return parsed;
      } catch (fixError) {
        logger.error(`   ❌ Recovery failed: ${fixError.message}`);
        logger.error(`   Returning empty array to allow scraping to continue`);
        return [];
      }
    }
  } catch (error) {
    logger.error(`❌ [Navigator] AI Request Failed: ${error.message}`);
    return [];
  }
}

/**
 * Step 2: Execute a single Playwright action on the page
 */
async function executeAction(page, action) {
  logger.info(`🎬 [Action] ${action.type.toUpperCase()} - ${action.description || 'Executing...'}`);

  try {
    switch (action.type) {
      case 'click':
        // Smart Click: Find element, scroll to it, and click
        await page.locator(action.selector).first().click({ timeout: 10000 });
        await page.waitForTimeout(1500);
        return { success: true };

      case 'fill':
        await page.fill(action.selector, replaceDynamicDates(action.value), { timeout: 10000 });
        return { success: true };

      case 'select':
        await page.selectOption(action.selector, { label: action.value });
        return { success: true };

      case 'wait':
        if (action.selector) await page.waitForSelector(action.selector, { timeout: 20000 });
        else await page.waitForTimeout(action.duration || 3000);
        return { success: true };

      case 'scroll':
        await page.evaluate((dist) => window.scrollBy(0, dist || 800), action.distance);
        await page.waitForTimeout(1000);
        return { success: true };

      case 'extract':
        return { success: true, shouldExtract: true };

      default:
        logger.warn(`⚠️ Unknown action type: ${action.type}`);
        return { success: false };
    }
  } catch (err) {
    logger.error(`❌ Action Failed: ${action.type} - ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Step 3: Main Orchestrator
 */
async function navigateAutonomously(page, instructions) {
  if (!isAIAvailable()) return { success: false, error: 'AI not configured' };

  try {
    logger.info(`🤖 [Navigator] Starting Autonomous Workflow`);
    const screenshot = await page.screenshot({ fullPage: false, type: 'png' });
    const actions = await parseNavigationSteps(instructions, page.url(), screenshot);

    if (!actions || actions.length === 0) return { success: false, shouldExtract: true };

    let finalShouldExtract = false;
    for (const action of actions) {
      const result = await executeAction(page, action);
      if (result.shouldExtract) finalShouldExtract = true;
      if (!result.success && action.type !== 'wait') break;
    }

    return { success: true, shouldExtract: finalShouldExtract };
  } catch (error) {
    logger.error(`❌ [Navigator] Workflow Crashed: ${error.message}`);
    return { success: false, error: error.message, shouldExtract: true };
  }
}

module.exports = {
  navigateAutonomously,
  parseNavigationSteps,
  executeAction
};