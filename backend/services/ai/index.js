/**
 * AI SERVICES - MAIN EXPORT (Fixed & Simplified)
 * This file connects your scraper to the Gemini AI logic.
 */

const logger = require('../../utils/logger');
const geminiClient = require('./geminiClient');
const extractor = require('./extractor');
const navigator = require('./navigator');

// Check if we have an API Key via the client
const AI_READY = geminiClient.isAIAvailable();

if (AI_READY) {
  logger.info('✅ AI services initialized and ready for extraction');
} else {
  logger.warn('⚠️ AI services NOT ready - Check GEMINI_API_KEY in Railway settings');
}

module.exports = {
  // Check if AI is turned on
  isAIAvailable: () => AI_READY,
  
  // The function that analyzes the screenshots
  extractFromScreenshot: extractor.extractFromScreenshot,
  
  // The functions that handle clicking/navigation
  navigateAutonomously: navigator.navigateAutonomously,
  parseNavigationSteps: navigator.parseNavigationSteps,
  executeAction: navigator.executeAction
};