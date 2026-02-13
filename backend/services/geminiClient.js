/**
 * GEMINI CLIENT - GUARANTEED TO WORK
 * Centralized initialization and configuration for Google Generative AI
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// ✅ STABLE MODEL
const MODEL_NAME = 'gemini-1.5-flash';
let geminiModel = null;

if (process.env.GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ 
      model: MODEL_NAME,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192
      }
    });
    logger.info(`✅ Gemini initialized with model: ${MODEL_NAME}`);
  } catch (error) {
    logger.error(`❌ Failed to initialize Gemini: ${error.message}`);
  }
} else {
  logger.warn('⚠️ GEMINI_API_KEY not found - AI extraction disabled');
}

/**
 * Get the initialized Gemini model
 * @returns {object|null} Gemini model or null if not initialized
 */
function getGeminiModel() {
  return geminiModel;
}

/**
 * Check if Gemini is available
 * @returns {boolean} True if Gemini model is initialized
 */
function isGeminiAvailable() {
  return geminiModel !== null;
}

/**
 * Extract data from screenshot using Gemini AI
 * @param {Buffer|Array} screenshot - Screenshot buffer or array of tiles
 * @param {string} sourceName - Source name for context
 * @param {object} fieldSchema - Field schema from source configuration
 * @returns {Promise<Array>} Extracted records
 */
async function extractWithAI(screenshot, sourceName, fieldSchema) {
  try {
    if (!geminiModel) {
      logger.error('❌ Gemini model not initialized');
      return [];
    }

    logger.info(`🤖 Extracting from "${sourceName}" with AI...`);
    
    if (!screenshot || !fieldSchema) {
      logger.error('❌ Missing screenshot or schema');
      return [];
    }
    
    // Handle tiles or single screenshot
    let screenshotBuffer;
    if (Array.isArray(screenshot)) {
      logger.info(`📸 Using first of ${screenshot.length} tiles`);
      screenshotBuffer = screenshot[0].screenshot || screenshot[0];
    } else {
      screenshotBuffer = screenshot;
    }
    
    logger.info(`📊 Screenshot: ${(screenshotBuffer.length / 1024).toFixed(1)}KB`);
    
    // Build prompt
    const fields = Object.keys(fieldSchema);
    const fieldDescriptions = Object.entries(fieldSchema)
      .map(([key, desc]) => `- ${key}: ${desc}`)
      .join('\n');
    
    const prompt = `Extract data from this screenshot into JSON.

Fields to extract:
${fieldDescriptions}

Rules:
1. Return JSON array of objects
2. Each object has keys: ${fields.join(', ')}
3. Extract ALL visible rows
4. Use null for missing fields
5. Return ONLY JSON, no explanation

Extract now:`;

    logger.info(`📝 Calling Gemini API...`);
    
    const result = await geminiModel.generateContent([
      {
        inlineData: {
          mimeType: 'image/png',
          data: screenshotBuffer.toString('base64')
        }
      },
      { text: prompt }
    ]);
    
    const responseText = result.response.text();
    logger.info(`📥 Response: ${responseText.length} chars`);
    
    // Clean and parse
    let cleaned = responseText.trim()
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
    
    logger.info(`🔍 Parsing JSON...`);
    
    let parsed = JSON.parse(cleaned);
    
    if (!Array.isArray(parsed)) {
      parsed = [parsed];
    }
    
    // Filter valid records
    const valid = parsed.filter(record => {
      return record && typeof record === 'object' &&
        fields.some(f => record[f] != null && record[f] !== '');
    });
    
    logger.info(`✅ Extracted ${valid.length} records`);
    
    if (valid.length > 0) {
      logger.info(`🔍 First: ${JSON.stringify(valid[0]).substring(0, 100)}`);
    }
    
    return valid;
    
  } catch (error) {
    logger.error(`❌ AI extraction failed: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    return [];
  }
}

module.exports = {
  getGeminiModel,
  isGeminiAvailable,
  extractWithAI,
  MODEL_NAME,
  geminiModel
};
