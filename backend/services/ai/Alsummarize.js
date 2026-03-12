const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');

/**
 * AIL Summarizer - Processes leads and generates AI-powered summaries
 * Optimized for the "Instant Analyze" button.
 */
class AISummarizer {
  constructor() {
    // Memory-heavy job tracking removed to keep server lean
  }

  /**
   * Summarize a single lead using AI
   * This is what your Yellow Lightning Bolt button calls.
   */
  async summarizeLead(lead, template = 'default', maxTokens = 2048) {
    if (!isAIAvailable()) {
      throw new Error('AI service not available - check GEMINI_API_KEY');
    }

    const prompt = this.buildPrompt(lead, template);

    try {
      const model = getGeminiModel('summarize');
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      return text.trim();
    } catch (e) {
      logger.error(`[AIL] Gemini API error: ${e.message}`);
      throw new Error(`AI summarization failed: ${e.message}`);
    }
  }

  /**
   * Build a prompt from lead data using template
   */
  buildPrompt(lead, template = 'default') {
    const leadJson = JSON.stringify(lead, null, 2);

    const templates = {
      default: `Analyze and summarize the following lead in 2-3 sentences. Focus on key details like business type, contact info, and potential value.\n\nLead Data:\n${leadJson}`,
      
      business: `Provide a business analysis summary of this lead. Include: industry, company size (if available), business potential, and recommended next steps.\n\nLead Data:\n${leadJson}`,
      
      contact: `Create a contact profile summary for this lead. Include: name, role, company, and contact methods.\n\nLead Data:\n${leadJson}`,
      
      opportunity: `Assess the sales opportunity. Rate potential (High/Medium/Low) and suggest engagement strategy based on lead data.\n\nLead Data:\n${leadJson}`
    };

    return templates[template] || templates.default;
  }
}

module.exports = new AISummarizer();