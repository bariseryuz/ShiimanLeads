const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini AI
let geminiModel = null;
if (process.env.GEMINI_API_KEY) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  logger.info('✅ Google Gemini AI initialized (gemini-3-flash-preview)');
} else {
  logger.warn('⚠️ GEMINI_API_KEY not found - AI extraction disabled');
}

// AI generation config — allow controlling "thinking level" via env
const AI_THINKING_LEVEL = String(process.env.AI_THINKING_LEVEL || 'low').toLowerCase();

/**
 * Build generation configuration for Gemini
 * @returns {object} Generation config
 */
function buildGenConfig() {
  const base = { responseMimeType: 'application/json' };
  if (AI_THINKING_LEVEL === 'low') {
    return { ...base, temperature: 0.2, topP: 0.8, maxOutputTokens: 8192 };
  }
  if (AI_THINKING_LEVEL === 'medium') {
    return { ...base, temperature: 0.5, topP: 0.9, maxOutputTokens: 12288 };
  }
  // high
  return { ...base, temperature: 0.7, topP: 0.95, maxOutputTokens: 16384 };
}

/**
 * Extract lead data from screenshot or text using Google Gemini AI
 * @param {Buffer|string} input - Screenshot buffer or text
 * @param {string} sourceName - Source name for context
 * @param {object} fieldSchema - Field schema from source configuration
 * @param {boolean} isRetry - Whether this is a retry attempt
 * @returns {Promise<object|array>} Extracted lead data
 */
async function extractLeadWithAI(input, sourceName, fieldSchema = null, isRetry = false) {
  if (!geminiModel) {
    logger.warn('Google Gemini not configured, skipping AI extraction');
    return null;
  }

  try {
    const isScreenshot = Buffer.isBuffer(input) || (typeof input === 'object' && input.inlineData);
    let prompt = '';
    let content = [];

    // Build field schema prompt with defaults if missing
    if (!fieldSchema || Object.keys(fieldSchema).length === 0) {
      logger.warn(`⚠️ No fieldSchema provided for ${sourceName}, using default schema`);
      fieldSchema = {
        permit_number: { required: true },
        address: { required: false },
        construction_cost: { required: false },
        contractor_name: { required: false },
        company_name: { required: false },
        phone: { required: false },
        date_issued: { required: false },
        permit_type: { required: false }
      };
    }

    const schemaFields = fieldSchema;
    const fieldDescriptions = Object.entries(schemaFields)
      .map(([key, desc]) => `"${key}"`)
      .join(', ');

    // Check if this source uses permit_number for deduplication
    const hasPermitNumber = Object.keys(schemaFields).some(key => 
      key.toLowerCase().includes('permit') || key.toLowerCase() === 'number'
    );
    
    // Build context-specific critical instruction
    let criticalInstruction = '';
    if (hasPermitNumber) {
      criticalInstruction = `🚨 CRITICAL: ALWAYS extract "permit_number" or similar unique identifier (permit #, ID, number, etc.)
   This field is MANDATORY for deduplication - without it, the lead will be rejected.
   Look for: Permit Number, Permit #, Number, ID, Case Number, Application Number

`;
    }

    if (isScreenshot) {
      // Vision-based extraction
      prompt = `Extract data from this screenshot into JSON format.

${criticalInstruction}REQUIRED JSON FIELDS (use EXACTLY these keys, no modifications):
${fieldDescriptions}

FIELD MATCHING INSTRUCTIONS:
🔍 Look CAREFULLY at the table column headers in the screenshot
🔍 Headers may be abbreviated or truncated (e.g., "Contr." = Contractor, "Val..." = Valuation)
🔍 Match field names by semantic meaning, not exact spelling
🔍 Extract data from matching columns for ALL visible rows
🔍 DO NOT extract by column position - match by HEADER NAME

CRITICAL RULES:
✅ CORRECT field names: ${fieldDescriptions}
❌ WRONG - DO NOT concatenate or modify field names
❌ DO NOT add descriptions to field names

EXTRACTION INSTRUCTIONS:
1. Read the table/list column headers in the screenshot
2. For each required field, find the matching column header by semantic meaning
3. Extract data from that column for all visible records
4. Extract ALL visible records from the screenshot (tables, lists, cards)
5. If a field is missing or empty, use empty string "" NOT null
6. Remove any commas from numbers (e.g., "178,132" → "178132")
7. Return a JSON array if multiple records, JSON object if single record

OUTPUT REQUIREMENTS:
⚠️ Return ONLY valid JSON - no explanations, no markdown, no text
⚠️ Start with [ or {, end with ] or }
⚠️ Use the EXACT field names shown above - do not modify them
⚠️ NO CODE BLOCKS (no triple backticks)
⚠️ Use "" for empty fields, NOT null

${isRetry ? '\n⚠️ RETRY: Previous extraction failed validation. Double-check field assignments!' : ''}`;

      // Prepare image data - MUST be Base64 encoded for Gemini Vision API
      let imageData;
      if (Buffer.isBuffer(input)) {
        logger.info(`✅ Input is Buffer, converting to Base64 (${input.length} bytes)`);
        imageData = {
          inlineData: {
            data: input.toString('base64'),
            mimeType: 'image/png'
          }
        };
      } else if (input && typeof input === 'object' && input.type === 'Buffer' && Array.isArray(input.data)) {
        // Handle serialized Buffer object { type: 'Buffer', data: [...] }
        logger.info(`✅ Input is serialized Buffer, converting to Base64`);
        const buffer = Buffer.from(input.data);
        imageData = {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType: 'image/png'
          }
        };
      } else if (input && typeof input === 'object' && input.inlineData) {
        // Already in correct format
        logger.info(`✅ Input already in inlineData format`);
        imageData = input;
      } else {
        // Try to convert whatever we got to Buffer
        logger.warn(`⚠️ Unexpected input type: ${typeof input}, attempting conversion`);
        const buffer = Buffer.from(input);
        imageData = {
          inlineData: {
            data: buffer.toString('base64'),
            mimeType: 'image/png'
          }
        };
      }

      content = [{ role: 'user', parts: [{ text: prompt }, imageData] }];
    } else {
      // Text-based extraction (fallback)
      const truncatedText = typeof input === 'string' ? input.substring(0, 6000) : String(input).substring(0, 6000);
      
      prompt = `Extract lead information from the following text:

${fieldDescriptions}

IMPORTANT:
- Use null for any missing fields
- Return ONLY a valid JSON object, no explanations

${isRetry ? 'RETRY ATTEMPT: Previous extraction had validation errors.' : ''}

Text to extract from:
${truncatedText}`;

      content = [{ role: 'user', parts: [{ text: prompt }] }];
    }

    const result = await geminiModel.generateContent({ contents: content, generationConfig: buildGenConfig() });
    const response = await result.response;
    const text = response.text();
    
    logger.info(`📝 Raw AI response length: ${text.length} chars`);
    
    // Clean up response (remove markdown and extract JSON)
    let cleanedText = text.trim();
    
    // Remove markdown code blocks
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.replace(/```\n?/g, '');
    }
    
    // Extract only JSON part
    const jsonStart = Math.min(
      cleanedText.indexOf('{') >= 0 ? cleanedText.indexOf('{') : Infinity,
      cleanedText.indexOf('[') >= 0 ? cleanedText.indexOf('[') : Infinity
    );
    const jsonEnd = Math.max(
      cleanedText.lastIndexOf('}'),
      cleanedText.lastIndexOf(']')
    );
    
    if (jsonStart < Infinity && jsonEnd > jsonStart) {
      cleanedText = cleanedText.substring(jsonStart, jsonEnd + 1);
    }
    
    cleanedText = cleanedText.trim();
    
    // Try to fix incomplete JSON arrays
    if (cleanedText.startsWith('[') && !cleanedText.endsWith(']')) {
      logger.warn(`⚠️ Incomplete JSON array detected, attempting to close it`);
      let openBraces = 0;
      for (const char of cleanedText) {
        if (char === '{') openBraces++;
        if (char === '}') openBraces--;
      }
      while (openBraces > 0) {
        cleanedText += '}';
        openBraces--;
      }
      cleanedText += ']';
    }
    
    // Parse JSON
    let extracted;
    try {
      extracted = JSON.parse(cleanedText);
    } catch (parseErr) {
      logger.error(`❌ Failed to parse AI response as JSON: ${parseErr.message}`);
      logger.error(`Cleaned text: ${cleanedText.substring(0, 500)}`);
      return null;
    }
    
    // Normalize to array
    if (!Array.isArray(extracted)) {
      extracted = [extracted];
    }
    
    logger.info(`✅ Successfully extracted ${extracted.length} record(s) from AI`);
    
    return extracted;
    
  } catch (error) {
    logger.error(`❌ AI extraction error: ${error.message}`);
    return null;
  }
}

/**
 * Check if Gemini AI is available
 * @returns {boolean} True if Gemini is configured
 */
function isGeminiAvailable() {
  return geminiModel !== null;
}

/**
 * Get the Gemini model instance
 * @returns {object|null} Gemini model or null
 */
function getGeminiModel() {
  return geminiModel;
}

module.exports = {
  extractLeadWithAI,
  buildGenConfig,
  isGeminiAvailable,
  getGeminiModel,
  geminiModel
};
