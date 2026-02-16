/**
 * AI Navigator - Agent 1 (Quota Protected)
 */
const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { NAVIGATION_SYSTEM_PROMPT, buildNavigationPrompt } = require('../../prompts/navigation');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function parseNavigationSteps(instructions, pageUrl, screenshot) {
  if (!isAIAvailable()) throw new Error('Gemini API not configured');

  const RPM_COOLDOWN = 4500; // Mandatory delay for 2026 Free Tier

  try {
    // 🛡️ QUOTA PROTECTION
    logger.info(`⏳ [Navigator Quota] Cooling down ${RPM_COOLDOWN}ms...`);
    await sleep(RPM_COOLDOWN);

    const model = getGeminiModel('navigation');
    const userPrompt = buildNavigationPrompt(instructions, pageUrl);

    const parts = [{ text: NAVIGATION_SYSTEM_PROMPT }, { text: userPrompt }];

    if (screenshot && Buffer.isBuffer(screenshot)) {
      parts.push({
        inlineData: { mimeType: 'image/png', data: screenshot.toString('base64') }
      });
    }

    const result = await model.generateContent(parts);
    const response = await result.response;
    let text = response.text().trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');

    return JSON.parse(text);
  } catch (error) {
    logger.error(`❌ [Navigator] Failed: ${error.message}`);
    // If we hit 429 here, wait longer and return empty to let the scraper try legacy mode
    if (error.message.includes('429')) await sleep(15000);
    return [];
  }
}

// Keep your existing executeAction and navigateAutonomously functions below
module.exports = { parseNavigationSteps };