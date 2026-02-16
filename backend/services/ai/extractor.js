const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { buildExtractionPrompt } = require('../../prompts/extraction');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function extractFromScreenshot(screenshot, sourceName, fieldSchema) {
  if (!isAIAvailable()) throw new Error('AI not configured');

  const MAX_RETRIES = 3;
  const RPM_COOLDOWN = 4500; // 4.5s Heartbeat for Free Tier 15 RPM
  let retryCount = 0;

  let screenshotBuffer = Buffer.isBuffer(screenshot) ? screenshot : 
                         (screenshot?.compositeBuffer || screenshot?.tiles?.[0]?.buffer);

  if (!screenshotBuffer) {
    logger.error("❌ Screenshot buffer is empty");
    return [];
  }

  const model = getGeminiModel('extraction');
  const prompt = buildExtractionPrompt(fieldSchema || {}, sourceName);

  while (retryCount < MAX_RETRIES) {
    try {
      logger.info(`⏳ [Quota Protection] Waiting ${RPM_COOLDOWN}ms...`);
      await sleep(RPM_COOLDOWN);

      const result = await model.generateContent([
        { inlineData: { mimeType: 'image/png', data: screenshotBuffer.toString('base64') } },
        { text: prompt }
      ]);

      const response = await result.response;
      let text = response.text().trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
      
      let parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];

    } catch (error) {
      if (error.message.includes('429') || error.message.includes('quota')) {
        retryCount++;
        await sleep(retryCount * 15000); 
      } else {
        logger.error(`❌ [AI Error] ${error.message}`);
        return [];
      }
    }
  }
  return [];
}

module.exports = { isExtractorAvailable: isAIAvailable, extractFromScreenshot };