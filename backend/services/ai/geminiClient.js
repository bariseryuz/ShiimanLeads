/**
 * Shared Gemini API Client
 * Single source of truth for Gemini configuration
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../utils/logger');

if (!process.env.GEMINI_API_KEY) {
  logger.warn('⚠️ GEMINI_API_KEY not set - AI features disabled');
}

const genAI = process.env.GEMINI_API_KEY 
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

/**
 * Get Gemini model with consistent configuration
 * @param {string} purpose - 'navigation' or 'extraction'
 * @returns {Object} Gemini model instance
 */
function getGeminiModel(purpose = 'extraction') {
  if (!genAI) {
    throw new Error('Gemini API not configured - set GEMINI_API_KEY');
  }

  const modelConfigs = {
    navigation: {
      // ✅ CHANGED: gemini-2.5-flash → gemini-2.0-flash-exp (99% cheaper!)
      model: process.env.GEMINI_NAVIGATOR_MODEL || 'gemini-2.0-flash-exp',
      config: {
        temperature: 0.1,      // Low - precise actions
        maxOutputTokens: 2048, // ✅ REDUCED: 8192 → 2048 (navigation needs less)
        topP: 0.95,
        topK: 40,
        responseMimeType: 'text/plain'  // ✅ ADDED: Plain text for code
      }
    },
    extraction: {
      // ✅ CHANGED: gemini-2.5-flash → gemini-2.0-flash-exp (99% cheaper!)
      model: process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.0-flash-exp',
      config: {
        temperature: 0.1,      // Low - accurate data
        maxOutputTokens: 8192, // ✅ REDUCED: 16384 → 8192 (enough for 20 records)
        topP: 0.95,
        topK: 40,
        responseMimeType: 'application/json'  // ✅ ADDED: Force JSON output
      }
    }
  };

  const config = modelConfigs[purpose] || modelConfigs.extraction;
  
  logger.info(`🤖 Using ${config.model} for ${purpose}`);

  return genAI.getGenerativeModel({
    model: config.model,
    generationConfig: config.config,
    // ✅ ADDED: Safety settings (prevent blocking legitimate content)
    safetySettings: [
      {
        category: 'HARM_CATEGORY_HARASSMENT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_HATE_SPEECH',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        threshold: 'BLOCK_NONE'
      },
      {
        category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        threshold: 'BLOCK_NONE'
      }
    ]
  });
}

/**
 * Check if AI is available
 */
function isAIAvailable() {
  return !!genAI;
}

/**
 * Get model info for debugging
 */
function getModelInfo(purpose = 'extraction') {
  const modelConfigs = {
    navigation: {
      model: process.env.GEMINI_NAVIGATOR_MODEL || 'gemini-2.0-flash-exp'
    },
    extraction: {
      model: process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.0-flash-exp'
    }
  };
  
  return {
    purpose,
    model: modelConfigs[purpose]?.model || 'gemini-2.0-flash-exp',
    available: isAIAvailable(),
    apiKeyPresent: !!process.env.GEMINI_API_KEY
  };
}

module.exports = {
  genAI,
  getGeminiModel,
  isAIAvailable,
  getModelInfo  // ✅ ADDED: For debugging
};