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
      
      // Try to parse JSON with error handling
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseError) {
        logger.error(`❌ [AI Error] ${parseError.message}`);
        logger.error(`   Raw AI response (first 500 chars): ${text.substring(0, 500)}`);
        logger.error(`   Response length: ${text.length} chars`);
        
        // Try aggressive recovery for truncated responses
        try {
          let fixed = text;
          
          // For arrays: find last complete object and discard incomplete tail
          if (text.trim().startsWith('[')) {
            // Find the last complete '},' or '}'
            const lastCompleteObject = text.lastIndexOf('},');
            if (lastCompleteObject > 0) {
              // Cut off incomplete data after last complete object
              fixed = text.substring(0, lastCompleteObject + 1) + ']';
              logger.info(`   🔧 Truncated at last complete object (recovered ${lastCompleteObject} chars)`);
            } else {
              // No complete object found, try to salvage what we can
              const firstObjectEnd = text.indexOf('},');
              if (firstObjectEnd > 0) {
                fixed = text.substring(0, firstObjectEnd + 1) + ']';
                logger.info(`   🔧 Recovered first complete object only`);
              } else {
                // Complete failure - close whatever we have
                fixed = text.replace(/,\s*([}\]])/g, '$1');
                fixed = fixed.replace(/"[^"]*$/g, '"');
                if (!fixed.endsWith(']')) fixed += ']';
              }
            }
          } else {
            // Single object - try basic fixes
            fixed = text.replace(/,\s*([}\]])/g, '$1');
            fixed = fixed.replace(/"[^"]*$/g, '"');
            if (!fixed.endsWith('}')) fixed += '}';
          }
          
          parsed = JSON.parse(fixed);
          logger.info(`   ✅ Recovered ${Array.isArray(parsed) ? parsed.length : 1} items from truncated response`);
        } catch (fixError) {
          logger.error(`   ❌ Could not recover: ${fixError.message}`);
          return [];
        }
      }
      
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