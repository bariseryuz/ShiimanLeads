/**
 * AI Services - Main Export
 * Unified interface for all AI capabilities
 */

const logger = require('../../utils/logger');

// Import geminiClient first (safe)
let geminiClient;
try {
  geminiClient = require('./geminiClient');
} catch (err) {
  logger.error('Failed to load geminiClient:', err.message);
  module.exports = {
    isAIAvailable: () => false,
    navigateAutonomously: async () => { throw new Error('AI not available'); },
    parseNavigationSteps: async () => { throw new Error('AI not available'); },
    executeAction: async () => { throw new Error('AI not available'); },
    extractFromScreenshot: async () => { throw new Error('AI not available'); }
  };
  return;
}

// Export isAIAvailable immediately
const isAIAvailable = geminiClient.isAIAvailable;

// Load other AI services conditionally
let navigateAutonomously = null;
let parseNavigationSteps = null;
let executeAction = null;
let extractFromScreenshot = null;

if (isAIAvailable()) {
  try {
    const navigator = require('./navigator');
    const extractor = require('./extractor');
    
    navigateAutonomously = navigator.navigateAutonomously;
    parseNavigationSteps = navigator.parseNavigationSteps;
    executeAction = navigator.executeAction;
    extractFromScreenshot = extractor.extractFromScreenshot;
    
    logger.info('✅ AI services loaded successfully');
  } catch (err) {
    logger.error('Failed to load AI services:', err.message);
  }
}

module.exports = {
  isAIAvailable,
  navigateAutonomously: navigateAutonomously || (async () => {
    throw new Error('AI Navigator not available');
  }),
  parseNavigationSteps: parseNavigationSteps || (async () => {
    throw new Error('AI Navigator not available');
  }),
  executeAction: executeAction || (async () => {
    throw new Error('AI Navigator not available');
  }),
  extractFromScreenshot: extractFromScreenshot || (async () => {
    throw new Error('AI Extractor not available');
  })
};