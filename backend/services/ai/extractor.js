/**
 * AI Extractor - Agent 2
 * Handles data extraction from screenshots
 */

const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');
const { buildExtractionPrompt } = require('./prompts/extraction');

/**
 * Extract structured data from screenshot
 */
async function extractFromScreenshot(screenshot, sourceName, fieldSchema) {
  if (!isAIAvailable()) {
    throw new Error('Gemini API not configured');
  }

  try {
    logger.info(`🤖 [Extractor] Extracting from "${sourceName}"`);

    // Handle different screenshot formats
    let screenshotBuffer;
    if (Buffer.isBuffer(screenshot)) {
      screenshotBuffer = screenshot;
    } else if (screenshot?.compositeBuffer) {
      screenshotBuffer = screenshot.compositeBuffer;
      logger.info(`📸 Using composite: ${(screenshotBuffer.length / 1024).toFixed(1)}KB`);
    } else if (screenshot?.tiles?.[0]?.buffer) {
      screenshotBuffer = screenshot.tiles[0].buffer;
      logger.warn(`⚠️ Using first tile only`);
    } else {
      throw new Error('Invalid screenshot format');
    }

    logger.info(`📊 Screenshot: ${(screenshotBuffer.length / 1024).toFixed(1)}KB`);

    const model = getGeminiModel('extraction');
    const prompt = buildExtractionPrompt(fieldSchema, sourceName);

    logger.info(`📝 [Extractor] Calling Gemini...`);
    logger.info(`   Fields: ${Object.keys(fieldSchema).join(', ')}`);

    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: 'image/png',
          data: screenshotBuffer.toString('base64')
        }
      },
      { text: prompt }
    ]);

    const response = await result.response;
    let text = response.text();

    logger.info(`📥 [Extractor] Response: ${text.length} chars`);

    // Clean response
    text = text.trim();
    text = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    text = text.replace(/^```\s*/, '').replace(/```\s*$/i, '');

    logger.info(`🔍 Parsing JSON...`);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      logger.error(`❌ JSON parse failed: ${parseErr.message}`);
      logger.error(`   Response: ${text.substring(0, 500)}...`);
      
      // Try to fix truncated JSON
      logger.info(`🔧 Attempting to fix truncated JSON...`);
      try {
        const lastComplete = text.lastIndexOf('},');
        if (lastComplete > 0) {
          const fixed = text.substring(0, lastComplete + 1) + '\n]';
          parsed = JSON.parse(fixed);
          logger.info(`✅ Recovered ${parsed.length} records`);
        } else {
          return [];
        }
      } catch (fixErr) {
        logger.error(`❌ Failed to fix JSON: ${fixErr.message}`);
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      logger.warn(`⚠️ Not an array, wrapping`);
      parsed = [parsed];
    }

    // Validate records
    const fields = Object.keys(fieldSchema);
    const valid = parsed.filter(record => {
      return record && typeof record === 'object' &&
        fields.some(f => record[f] != null && record[f] !== '');
    });

    logger.info(`✅ [Extractor] Extracted ${valid.length} valid records`);

    if (valid.length > 0) {
      logger.info(`🔍 First: ${JSON.stringify(valid[0]).substring(0, 150)}...`);
    }

    return valid;

  } catch (error) {
    logger.error(`❌ [Extractor] Failed: ${error.message}`);
    return [];
  }
}

module.exports = {
  isExtractorAvailable: isAIAvailable,
  extractFromScreenshot
};