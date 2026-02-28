const express = require('express');
const router = express.Router();
const Alsummarize = require('../../services/ai/Alsummarize');
const { Lead } = require('../../models');
const logger = require('../../utils/logger');

/**
 * GET /api/summarize/:jobId
 * Get status and results of a summarization job
 */
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = Alsummarize.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    logger.error(`Error retrieving job: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve job' });
  }
});

/**
 * POST /api/summarize
 * Create a new summarization job
 */
router.post('/', async (req, res) => {
  try {
    const { leads, template, maxTokens, dateRange } = req.body;
    const userId = req.user?.id || 'anonymous';

    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'Invalid leads array' });
    }

    // Create job
    const jobId = Alsummarize.createJob(userId, leads, {
      template: template || 'default',
      maxTokens: maxTokens || 1024,
      dateRange
    });

    // Start async processing (don't wait for it)
    Alsummarize.processJob(jobId)
      .then(() => logger.info(`[API] Job ${jobId} completed`))
      .catch(e => logger.error(`[API] Job ${jobId} failed: ${e.message}`));

    res.json({ jobId, status: 'queued' });
  } catch (error) {
    logger.error(`Error creating summarization job: ${error.message}`);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

/**
 * GET /api/summarize
 * List user's summarization jobs
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id || 'anonymous';
    const jobs = Alsummarize.getUserJobs(userId);

    res.json({ jobs, count: jobs.length });
  } catch (error) {
    logger.error(`Error listing jobs: ${error.message}`);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

module.exports = router;
