/**
 * AI SERVICES BRIDGE - PRODUCTION READY
 * Centralized interface connecting the Scraper to Gemini AI Agents.
 */

const geminiClient = require('./geminiClient');
const extractor = require('./extractor');
const navigator = require('./navigator');
const logger = require('../../utils/logger');

/**
 * Check if Gemini API is configured correctly in environment variables.
 * Fixed: Exported as a function to match Scraper expectations.
 */
const isAIAvailable = () => {
  try {
    return geminiClient.isAIAvailable();
  } catch (err) {
    logger.error('❌ AI Bridge: Error checking availability:', err.message);
    return false;
  }
};

/**
 * Exported functions for use in legacyScraper.js
 */
module.exports = {
  // Status check
  isAIAvailable,
  
  // Agent 2: Data Extraction from Screenshots
  extractFromScreenshot: extractor.extractFromScreenshot,
  
  // Agent 1: Autonomous Navigation & Actions
  navigateAutonomously: navigator.navigateAutonomously,
  executeAction: navigator.executeAction,
  parseNavigationSteps: navigator.parseNavigationSteps
};