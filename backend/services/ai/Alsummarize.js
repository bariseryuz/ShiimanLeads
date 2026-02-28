const logger = require('../../utils/logger');
const { geminiClient } = require('./geminiClient');

/**
 * AIL Summarizer - Processes leads and generates AI-powered summaries
 * Handles:
 * - Single lead summarization
 * - Batch lead summarization
 * - Summary storage and retrieval
 * - Template-based prompts
 */

class AISummarizer {
  constructor() {
    this.summaryCache = new Map(); // jobId -> { status, result, timestamp }
    this.jobs = new Map(); // Track in-progress and completed jobs
  }

  /**
   * Create a new summarization job
   * @param {string} userId - User ID
   * @param {Array} leads - Array of lead objects to summarize
   * @param {Object} options - { template, maxTokens, dateRange }
   * @returns {string} jobId
   */
  createJob(userId, leads, options = {}) {
    if (!leads || leads.length === 0) {
      throw new Error('No leads provided for summarization');
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const template = options.template || 'default';
    const maxTokens = options.maxTokens || 2048;

    this.jobs.set(jobId, {
      id: jobId,
      userId,
      leads: JSON.parse(JSON.stringify(leads)), // Deep copy
      status: 'queued', // queued, processing, completed, failed
      template,
      maxTokens,
      dateRange: options.dateRange || null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      result: null,
      error: null,
      estimatedCost: this.estimateCost(leads.length, maxTokens)
    });

    logger.info(`[AIL] Created job ${jobId} for user ${userId} (${leads.length} leads)`);
    return jobId;
  }

  /**
   * Get job status and result
   * @param {string} jobId - Job ID
   * @returns {Object} Job detail
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Process a job: generate summaries
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Summarization result
   */
  async processJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    job.status = 'processing';
    job.startedAt = new Date();

    try {
      const summaries = [];

      for (const lead of job.leads) {
        try {
          const summary = await this.summarizeLead(lead, job.template, job.maxTokens);
          summaries.push({
            lead: lead,
            summary: summary,
            createdAt: new Date()
          });
        } catch (e) {
          logger.error(`[AIL] Failed to summarize lead: ${e.message}`);
          summaries.push({
            lead: lead,
            summary: null,
            error: e.message,
            createdAt: new Date()
          });
        }
      }

      job.result = {
        summaries: summaries,
        totalLeads: job.leads.length,
        successCount: summaries.filter(s => s.summary).length,
        failureCount: summaries.filter(s => s.error).length
      };
      job.status = 'completed';
      job.completedAt = new Date();

      logger.info(`[AIL] Job ${jobId} completed: ${job.result.successCount}/${job.result.totalLeads} summaries`);
      return job.result;
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      job.completedAt = new Date();
      logger.error(`[AIL] Job ${jobId} failed: ${e.message}`);
      throw e;
    }
  }

  /**
   * Summarize a single lead using AI
   * @param {Object} lead - Lead data
   * @param {string} template - Prompt template name
   * @param {number} maxTokens - Max tokens in response
   * @returns {Promise<string>} Summary text
   */
  async summarizeLead(lead, template = 'default', maxTokens = 2048) {
    const prompt = this.buildPrompt(lead, template);

    try {
      const response = await geminiClient.generateText(prompt, {
        maxOutputTokens: maxTokens,
        temperature: 0.7
      });

      return response.trim();
    } catch (e) {
      logger.error(`[AIL] Gemini API error: ${e.message}`);
      throw new Error(`AI summarization failed: ${e.message}`);
    }
  }

  /**
   * Build a prompt from lead data using template
   * @param {Object} lead - Lead object
   * @param {string} template - Template name
   * @returns {string} Formatted prompt
   */
  buildPrompt(lead, template = 'default') {
    const leadJson = JSON.stringify(lead, null, 2);

    const templates = {
      default: `Analyze and summarize the following lead in 2-3 sentences. Focus on key details like business type, contact info, and potential.\n\nLead Data:\n${leadJson}`,
      
      business: `Provide a business analysis summary of this lead. Include: industry, company size (if available), business potential, and recommended next steps.\n\nLead Data:\n${leadJson}`,
      
      contact: `Create a contact profile summary for this lead. Include: name, role, company, contact methods, and interaction history if available.\n\nLead Data:\n${leadJson}`,
      
      opportunity: `Assess the sales opportunity. Rate potential (High/Medium/Low) and suggest engagement strategy based on lead data.\n\nLead Data:\n${leadJson}`
    };

    return templates[template] || templates.default;
  }

  /**
   * Estimate API cost based on lead count and tokens
   * @param {number} leadCount - Number of leads
   * @param {number} maxTokens - Max tokens per lead
   * @returns {Object} Cost estimate
   */
  estimateCost(leadCount, maxTokens) {
    // Gemini pricing estimate (per 1M tokens)
    const inputCostPer1M = 0.075; // $
    const outputCostPer1M = 0.3;  // $

    const estimatedInputTokens = leadCount * 500; // ~500 tokens per lead
    const estimatedOutputTokens = leadCount * (maxTokens * 0.3); // Assume 30% of max used

    const inputCost = (estimatedInputTokens / 1e6) * inputCostPer1M;
    const outputCost = (estimatedOutputTokens / 1e6) * outputCostPer1M;
    const totalCost = inputCost + outputCost;

    return {
      estimatedInputTokens,
      estimatedOutputTokens,
      inputCost: inputCost.toFixed(4),
      outputCost: outputCost.toFixed(4),
      totalCost: totalCost.toFixed(4),
      currency: 'USD'
    };
  }

  /**
   * Get all jobs for a user
   * @param {string} userId - User ID
   * @returns {Array} User's jobs (last 20, sorted by date)
   */
  getUserJobs(userId) {
    return Array.from(this.jobs.values())
      .filter(j => j.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
  }

  /**
   * Filter leads by date range
   * @param {Array} leads - Lead array
   * @param {Object} dateRange - { startDate, endDate } (ISO strings)
   * @returns {Array} Filtered leads
   */
  filterByDateRange(leads, dateRange) {
    if (!dateRange || !dateRange.startDate || !dateRange.endDate) {
      return leads;
    }

    const start = new Date(dateRange.startDate);
    const end = new Date(dateRange.endDate);

    return leads.filter(lead => {
      // Try common date fields
      const dateFields = ['date', 'created_at', 'createdAt', 'date_issued', 'capturedAt', 'timestamp'];
      for (const field of dateFields) {
        if (lead[field]) {
          const leadDate = new Date(lead[field]);
          if (!isNaN(leadDate.getTime()) && leadDate >= start && leadDate <= end) {
            return true;
          }
        }
      }
      return false;
    });
  }
}

module.exports = new AISummarizer();
