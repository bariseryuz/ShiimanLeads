const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('./geminiClient');

/**
 * AI Summarizer - Processes leads and generates AI-powered summaries
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
      default:
        `Summarize this lead in plain English (like Google Gemini would): readable, specific, and short.\n` +
        `Use 2–4 short paragraphs or a few tight bullets if that reads better. No JSON.\n` +
        `Cover what matters for a salesperson: what happened, where, rough scale/value if present, and why it might matter.\n\n` +
        `Lead data:\n${leadJson}`,

      business:
        `Give a business-focused summary of this lead in clear prose (no JSON).\n` +
        `Include: industry signal, scale hints from the data, commercial potential, and 1–2 suggested next steps.\n\n` +
        `Lead data:\n${leadJson}`,

      contact:
        `Write a concise contact-oriented profile in natural language (no JSON).\n` +
        `Include names, roles, companies, and any contact channels visible in the data; say what is missing.\n\n` +
        `Lead data:\n${leadJson}`,

      opportunity:
        `Assess the sales opportunity in readable prose (no JSON).\n` +
        `Give an explicit High/Medium/Low style judgment in words, why, and a short engagement angle grounded in the fields below.\n\n` +
        `Lead data:\n${leadJson}`
    };

    return templates[template] || templates.default;
  }
}

module.exports = new AISummarizer();