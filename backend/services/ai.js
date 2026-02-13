/**
 * AI Extraction Service - Simplified wrapper around Gemini Client
 * Uses the optimized extraction from geminiClient.js
 */

const logger = require('../utils/logger');
const { extractWithAI: geminiExtractWithAI, isGeminiAvailable } = require('./geminiClient');

/**
 * Extract lead data from screenshot using Google Gemini AI
 * @param {Buffer|Array} input - Screenshot buffer or array of tiles
 * @param {string} sourceName - Source name for context
 * @param {object} fieldSchema - Field schema from source configuration
 * @param {boolean} isRetry - Whether this is a retry attempt (optional)
 * @returns {Promise<Array>} Extracted records
 */
async function extractLeadWithAI(input, sourceName, fieldSchema = null, isRetry = false) {
  if (!isGeminiAvailable()) {
    logger.warn('Google Gemini not configured, skipping AI extraction');
    logger.warn('⚠️ Set GEMINI_API_KEY in .env to enable AI extraction');
    return [];
  }

  // Use the optimized extractWithAI from geminiClient
  const results = await geminiExtractWithAI(input, sourceName, fieldSchema || {});
  return results || [];
}

module.exports = {
  extractLeadWithAI,
  isGeminiAvailable
};
