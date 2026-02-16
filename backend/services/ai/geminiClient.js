const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../utils/logger');

const genAI = process.env.GOOGLE_API_KEY ? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY) : null;

function getGeminiModel(purpose = 'extraction') {
  if (!genAI) throw new Error('GEMINI_API_KEY is missing');

  // Use the 2026 "Lite" model for the absolute lowest cost in Turkey
  const modelName = "gemini-2.0-flash-lite";

  return genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1, // Low temp for high accuracy scraping
      maxOutputTokens: 2048,
      responseMimeType: "application/json", // Forces Gemini to return valid JSON
    },
    // Prevent AI from blocking content due to safety false-positives
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
    ]
  });
}

module.exports = { genAI, getGeminiModel, isAIAvailable: () => !!genAI };