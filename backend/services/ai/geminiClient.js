/**
 * GEMINI CLIENT - Production Ready 2026
 * Handles connection to Google Generative AI
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../utils/logger');

// Resilient Key Check: Look for both possible naming conventions
const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

// Initialize the AI instance
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;

/**
 * Configure the model with 2026 optimized settings
 */
function getGeminiModel(purpose = 'extraction') {
  if (!genAI) {
    logger.error('❌ AI Client: Attempted to call Gemini but API_KEY is missing');
    throw new Error('GEMINI_API_KEY is missing from environment variables');
  }

  // 2026 Flash Lite: The cheapest, most efficient model for vision scraping
  const modelName = "gemini-2.0-flash-lite";

  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,      // Low temperature = higher accuracy for data scraping
      maxOutputTokens: 8192, 
      responseMimeType: "application/json", // Critical: Forces Gemini to return valid JSON
    },
    // Safety settings set to BLOCK_NONE to prevent false-positive blocks of 
    // commercial website screenshots (common in real estate/permit scraping)
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
    ]
  });
}

/**
 * Clean Export with Status Check
 */
module.exports = { 
  genAI, 
  getGeminiModel, 
  isAIAvailable: () => {
    const available = !!genAI;
    if (!available) {
      logger.warn('⚠️ AI Service Status: NOT AVAILABLE (Check Railway Env Vars)');
    }
    return available;
  } 
};