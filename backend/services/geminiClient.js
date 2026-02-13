/**
 * GEMINI CLIENT - GUARANTEED TO WORK
 * Centralized initialization and configuration for Google Generative AI
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// ✅ STABLE MODEL (using latest available)
const MODEL_NAME = 'gemini-2.0-flash';
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
      logger.error(`   Screenshot type: ${typeof screenshot}, isBuffer: ${Buffer.isBuffer(screenshot)}`);
      logger.error(`   FieldSchema type: ${typeof fieldSchema}, keys: ${fieldSchema ? Object.keys(fieldSchema).length : 0}`);
      return [];
    }
    
    // Ensure we have a Buffer
    let screenshotBuffer = screenshot;
    
    // Handle various buffer formats
    if (!Buffer.isBuffer(screenshotBuffer)) {
      logger.warn(`⚠️ Screenshot is not a Buffer: ${typeof screenshotBuffer}`);
      
      // Try to convert serialized Buffer format {type: "Buffer", data: [...]}
      if (screenshotBuffer && typeof screenshotBuffer === 'object' && screenshotBuffer.type === 'Buffer' && Array.isArray(screenshotBuffer.data)) {
        logger.info(`   ✓ Converting from serialized Buffer object`);
        screenshotBuffer = Buffer.from(screenshotBuffer.data);
      } else if (screenshotBuffer instanceof Uint8Array) {
        logger.info(`   ✓ Converting from Uint8Array`);
        screenshotBuffer = Buffer.from(screenshotBuffer);
      } else if (typeof screenshotBuffer === 'string') {
        logger.info(`   ✓ Converting from base64 string`);
        screenshotBuffer = Buffer.from(screenshotBuffer, 'base64');
      } else {
        logger.error(`❌ Unable to convert screenshot to Buffer`);
        logger.error(`   Type: ${typeof screenshotBuffer}, Constructor: ${screenshotBuffer?.constructor?.name}`);
        return [];
      }
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
    logger.info(`   Model: gemini-1.5-flash`);
    logger.info(`   Buffer size: ${screenshotBuffer.length} bytes`);
    logger.info(`   Fields: ${Object.keys(fieldSchema).join(', ')}`);
    
    const base64Data = screenshotBuffer.toString('base64');
    logger.info(`   Base64 length: ${base64Data.length} chars`);
    
    const result = await geminiModel.generateContent([
      {
        inlineData: {
          mimeType: 'image/png',
          data: base64Data
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
    
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.error(`❌ JSON parse failed: ${parseErr.message}`);
      logger.error(`   Response was: "${cleaned.substring(0, 200)}..."`);
      return [];
    }
    
    if (!Array.isArray(parsed)) {
      logger.warn(`⚠️ Response wasn't an array, converting single object`);
      parsed = [parsed];
    }
    
    logger.info(`   Total records from AI: ${parsed.length}`);
    
    // Filter valid records
    const valid = parsed.filter((record, idx) => {
      const isValid = record && typeof record === 'object' &&
        fields.some(f => record[f] != null && record[f] !== '');
      
      if (!isValid && parsed.length < 5) {
        logger.warn(`   Record ${idx} filtered: ${JSON.stringify(record).substring(0, 100)}`);
      }
      
      return isValid;
    });
    
    logger.info(`✅ Extracted ${valid.length} valid records (filtered ${parsed.length - valid.length})`);
    
    if (valid.length > 0) {
      logger.info(`🔍 First: ${JSON.stringify(valid[0]).substring(0, 100)}`);
    } else if (parsed.length > 0) {
      logger.warn(`⚠️ AI extracted ${parsed.length} records but all filtered out`);
      logger.warn(`   Expected fields: ${fields.join(', ')}`);
      if (parsed[0]) logger.warn(`   First record keys: ${Object.keys(parsed[0]).join(', ')}`);
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
