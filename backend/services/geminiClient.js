/**
 * Gemini AI Client - Centralized initialization and configuration
 * Single source of truth for Google Generative AI setup
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini AI
let geminiModel = null;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';

if (process.env.GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({ model: GEMINI_MODEL });
    logger.info(`✅ Google Gemini AI initialized (${GEMINI_MODEL})`);
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

module.exports = {
  getGeminiModel,
  isGeminiAvailable,
  GEMINI_MODEL
};
