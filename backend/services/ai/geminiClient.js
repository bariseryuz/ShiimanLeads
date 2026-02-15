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
      model: process.env.GEMINI_NAVIGATOR_MODEL || 'gemini-2.5-flash',
      config: {
        temperature: 0.1,      // Low - precise actions
        maxOutputTokens: 8192, // Medium - action lists
        topP: 0.95,
        topK: 40
      }
    },
    extraction: {
      model: process.env.GEMINI_EXTRACTION_MODEL || 'gemini-2.5-flash',
      config: {
        temperature: 0.1,      // Low - accurate data
        maxOutputTokens: 16384, // High - large datasets
        topP: 0.95,
        topK: 40
      }
    }
  };

  const config = modelConfigs[purpose] || modelConfigs.extraction;
  
  logger.info(`🤖 Using ${config.model} for ${purpose}`);

  return genAI.getGenerativeModel({
    model: config.model,
    generationConfig: config.config
  });
}

/**
 * Check if AI is available
 */
function isAIAvailable() {
  return !!genAI;
}

module.exports = {
  genAI,
  getGeminiModel,
  isAIAvailable
};