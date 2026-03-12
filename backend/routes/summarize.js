const express = require('express');
const router = express.Router();
const Alsummarize = require('../services/ai/Alsummarize');
const logger = require('../utils/logger');

/**
 * POST /api/summarize/instant
 * Immediately summarize a single lead and return text.
 * THIS POWERS THE YELLOW ANALYZE BUTTON.
 */
router.post('/instant', async (req, res) => {
  try {
    const { lead, template, maxTokens } = req.body;
    
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'Lead object required' });
    }

    logger.info(`[API] Instant AI Summary requested for lead`);

    // Call service directly
    const summary = await Alsummarize.summarizeLead(
        lead, 
        template || 'default', 
        maxTokens || 1024
    );
    
    res.json({ 
        success: true,
        summary: summary 
    });
    
  } catch (error) {
    logger.error(`[API] Error in instant summarize: ${error.message}`);
    res.status(500).json({ error: error.message || 'Instant summarization failed' });
  }
});

module.exports = router;