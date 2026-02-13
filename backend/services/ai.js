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
    // Increased temperature for better vision analysis (was 0.2)
    return { ...base, temperature: 0.4, topP: 0.85, maxOutputTokens: 8192 };
  }
  if (AI_THINKING_LEVEL === 'medium') {
    return { ...base, temperature: 0.6, topP: 0.9, maxOutputTokens: 12288 };
  }
  // high
  return { ...base, temperature: 0.8, topP: 0.95, maxOutputTokens: 16384 };
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
    logger.warn('⚠️ Set GEMINI_API_KEY in .env to enable AI extraction');
    return null;
  }

  try {
    const isScreenshot = Buffer.isBuffer(input) || (typeof input === 'object' && input.inlineData);
    logger.info(`🤖 AI extraction mode: ${isScreenshot ? 'VISION (screenshot)' : 'TEXT'}`);
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
      // Build dynamic column matching hints based on actual fieldSchema
      const columnHints = Object.keys(schemaFields).map(fieldName => {
        const lower = fieldName.toLowerCase();
        if (lower.includes('permit') && (lower.includes('num') || lower === 'permit_' || lower === 'permit')) {
          return `🔍 "Permit #", "Permit Number", "Permit No", "Number", "ID" → use "${fieldName}"`;
        } else if (lower.includes('address') || lower.includes('location') || lower.includes('street')) {
          return `🔍 "Address", "Location", "Street" → use "${fieldName}"`;
        } else if (lower.includes('cost') || lower.includes('value') || lower.includes('amount')) {
          return `🔍 "Cost", "Construction Cost", "Value", "Amount" → use "${fieldName}"`;
        } else if (lower.includes('contractor') || lower.includes('builder') || lower.includes('company')) {
          return `🔍 "Contractor", "Builder", "Company" → use "${fieldName}"`;
        } else if (lower.includes('phone') || lower.includes('contact')) {
          return `🔍 "Phone", "Contact", "Tel" → use "${fieldName}"`;
        } else if (lower.includes('type') || lower.includes('category')) {
          return `🔍 "Type", "Category", "Class" → use "${fieldName}"`;
        } else if (lower.includes('date') || lower.includes('issued') || lower.includes('applied')) {
          return `🔍 "Date", "Issued", "Applied", "Entered" → use "${fieldName}"`;
        } else if (lower.includes('city')) {
          return `🔍 "City" → use "${fieldName}"`;
        } else if (lower.includes('state')) {
          return `🔍 "State" → use "${fieldName}"`;
        } else if (lower.includes('parce') || lower.includes('parcel')) {
          return `🔍 "Parcel", "Parce", "Parcel Number" → use "${fieldName}"`;
        } else if (lower.includes('description') || lower.includes('subtype')) {
          return `🔍 Column headers with "${fieldName.replace(/_/g, ' ')}" → use "${fieldName}"`;
        }
        return `🔍 Any column matching "${fieldName.replace(/_/g, ' ')}" → use "${fieldName}"`;
      }).join('\n');
      
      // Vision-based extraction
      prompt = `You are looking at a screenshot of a DATA TABLE with multiple rows and columns.

🎯 YOUR TASK: Extract EVERY SINGLE ROW of data from this table (minimum 5-20 rows expected)

${criticalInstruction}📋 OUTPUT FIELD NAMES (use EXACTLY these keys):
${fieldDescriptions}

🔍 TABLE STRUCTURE RECOGNITION:
1. HEADER ROW: First row contains column names (do NOT extract this as data)
2. DATA ROWS: All rows BELOW the header are data (extract EVERY one of these)
3. COUNT the visible data rows - you should extract that many JSON objects

⚠️ CRITICAL EXTRACTION RULES:
✅ Extract AT LEAST 5-10 rows (if table shows more, extract ALL of them)
✅ Each data row → 1 JSON object in your output array
✅ SKIP the header row (column names) - only extract actual data cells
✅ If you see 20 rows of data, return 20 JSON objects
✅ Empty cells should be "" (not null, not dashes, not missing)

📊 COLUMN MAPPING (Match table column headers to these field names):
${columnHints}

📖 STEP-BY-STEP INSTRUCTIONS:
1. IDENTIFY: Locate the table and identify the header row (column names)
2. COUNT: Count how many DATA rows are visible below the header
3. EXTRACT: For EACH data row, read values from left to right
4. MAP: Match each column value to the closest field name from list above
5. OUTPUT: Return JSON array with one object per data row

🎨 HTML TABLE STRUCTURE (what you're looking at):
- <thead> or first row = HEADERS (column names) → SKIP THIS
- <tbody> or remaining rows = DATA (actual records) → EXTRACT ALL OF THESE
- Each <tr> in tbody = one JSON object in your output array

🚫 COMMON MISTAKES TO AVOID:
❌ Only extracting 1 row when table shows 10+ rows
❌ Extracting header row as data
❌ Stopping after first row
❌ Missing rows at the bottom of the table

✅ CORRECT BEHAVIOR:
✓ Look at entire screenshot from top to bottom
✓ Find ALL table rows with data (not just the first one)
✓ Return JSON array with 5-20 objects (depends on table size)
✓ Each object represents ONE row from the table

📤 OUTPUT FORMAT:
⚠️ Return ONLY valid JSON array starting with [ and ending with ]
⚠️ NO explanations, NO code blocks, NO markdown, NO extra text
⚠️ Minimum 5 objects in array (unless table has fewer rows)

EXAMPLE (if table has 3 data rows, return 3 objects):
[
  {${Object.keys(schemaFields).slice(0, 3).map(k => `"${k}": "actual value from row 1"`).join(', ')}},
  {${Object.keys(schemaFields).slice(0, 3).map(k => `"${k}": "actual value from row 2"`).join(', ')}},
  {${Object.keys(schemaFields).slice(0, 3).map(k => `"${k}": "actual value from row 3"`).join(', ')}}
]

${isRetry ? '\n⚠️⚠️⚠️ RETRY ATTEMPT: Your previous response only returned 1 row but the table has MULTIPLE rows.\n🔥 Extract ALL visible data rows, not just the first one! Count them and return that many objects.' : ''}`;

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
    
    logger.info(`📝 Raw AI response length: ${text.length} chars`);    logger.info(`\ud83d\udd0d AI response preview: ${text.substring(0, 200)}...`);    
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
      logger.info(`✅ Successfully parsed AI response as JSON`);
    } catch (parseErr) {
      logger.error(`❌ Failed to parse AI response as JSON: ${parseErr.message}`);
      logger.error(`Cleaned text (first 500 chars): ${cleanedText.substring(0, 500)}`);
      logger.error(`Full cleaned text length: ${cleanedText.length}`);
      return null;
    }
    
    // Normalize to array
    if (!Array.isArray(extracted)) {
      extracted = [extracted];
    }
    
    // Store original data before normalization (for source-specific tables)
    const originalExtracted = JSON.parse(JSON.stringify(extracted));
    
    // Normalize field names - map any variation to standard names
    extracted = extracted.map(record => {
      const normalized = {};
      
      // Define field name variations and their target names
      const fieldMappings = {
        'permit_number': ['permit_number', 'permit_no', 'permit#', 'number', 'id', 'case_number', 'application_number'],
        'address': ['address', 'location', 'street', 'street_address', 'adress_details', 'address_details'],
        'construction_cost': ['construction_cost', 'cost', 'value', 'amount', 'contract_amount', 'valuation', 'cost_estimate'],
        'contractor_name': ['contractor_name', 'contractor', 'builder', 'company_name', 'company', 'business_name', 'general_contractor'],
        'permit_type': ['permit_type', 'type', 'category', 'permit_class', 'permit_category'],
        'phone': ['phone', 'phone_number', 'contact_phone', 'mobile', 'phone#'],
        'date_issued': ['date_issued', 'issued_date', 'date', 'approval_date', 'effective_date'],
        'company_name': ['company_name', 'company', 'business_name', 'contractor_name']
      };
      
      // For each extracted field, try to normalize it
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '' || value === '-') {
          continue; // Skip empty fields
        }
        
        const normalizedKey = key.toLowerCase().replace(/\s+/g, '_').replace(/[#]/g, '');
        let targetKey = key; // PRESERVE original key name by default
        
        // Try to find a matching standard field
        for (const [target, variations] of Object.entries(fieldMappings)) {
          if (variations.some(v => normalizedKey.includes(v.replace(/_/g, '')) || v.replace(/_/g, '').includes(normalizedKey))) {
            targetKey = target;
            break;
          }
        }
        
        normalized[targetKey] = String(value).trim();
      }
      
      return normalized;
    });
    
    logger.info(`✅ Successfully extracted ${extracted.length} record(s) from AI`);
    
    // Log field stats AFTER normalization
    if (extracted.length > 0) {
      const normalizedStats = {};
      extracted.forEach(record => {
        Object.keys(record).forEach(field => {
          if (!normalizedStats[field]) normalizedStats[field] = { populated: 0, empty: 0 };
          if (record[field] && record[field] !== '' && record[field] !== 'N/A') {
            normalizedStats[field].populated++;
          } else {
            normalizedStats[field].empty++;
          }
        });
      });
      
      logger.info(`📊 Field statistics (AFTER normalization):`);
      Object.entries(normalizedStats).forEach(([field, stats]) => {
        const populationRate = Math.round((stats.populated / extracted.length) * 100);
        logger.info(`   ${field}: ${populationRate}% filled (${stats.populated}/${extracted.length})`);
      });
      
      // Log first record after normalization
      logger.info(`🔍 FIRST EXTRACTED RECORD (after normalization):`);
      logger.info(JSON.stringify(extracted[0], null, 2));
    }
    
    // Log field population stats
    if (extracted.length > 0) {
      const fieldStats = {};
      extracted.forEach(record => {
        Object.keys(record).forEach(field => {
          if (!fieldStats[field]) fieldStats[field] = { populated: 0, empty: 0 };
          if (record[field] && record[field] !== '' && record[field] !== 'N/A') {
            fieldStats[field].populated++;
          } else {
            fieldStats[field].empty++;
          }
        });
      });
      
      logger.info(`📊 Field extraction statistics (before normalization):`);
      Object.entries(fieldStats).forEach(([field, stats]) => {
        const populationRate = Math.round((stats.populated / extracted.length) * 100);
        logger.info(`   ${field}: ${populationRate}% filled (${stats.populated}/${extracted.length})`);
      });
      
      // Log first extracted record raw
      logger.info(`🔍 FIRST EXTRACTED RECORD (before normalization):`);
      logger.info(JSON.stringify(extracted[0], null, 2));
    }
    
    // Attach original data to each normalized record for source table insertion
    extracted.forEach((normalizedRecord, index) => {
      normalizedRecord._original = originalExtracted[index];
    });
    
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
