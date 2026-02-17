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
          parsed = JSON.parse(fixed);
          const itemCount = Array.isArray(parsed) ? parsed.length : 1;
          logger.info(`   ✅ Successfully recovered ${itemCount} ${itemCount === 1 ? 'record' : 'records'} from truncated response`);
        } catch (fixError) {
          logger.error(`   ❌ Recovery failed: ${fixError.message}`);
          logger.error(`   Returning empty array to allow scraping to continue`);
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