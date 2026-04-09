/**
 * POST /api/ai/ask — Gemini prose (Gemini-app style), not JSON pipelines.
 */

const express = require('express');
const router = express.Router();
const { generateProseAnswer, isAIAvailable } = require('../services/ai/geminiClient');
const logger = require('../utils/logger');

const MAX_PROMPT = 12000;
const MAX_CONTEXT = 24000;

function requireSessionUser(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

router.post('/ask', express.json({ limit: '512kb' }), requireSessionUser, async (req, res) => {
  try {
    if (!isAIAvailable()) {
      return res.status(503).json({ error: 'AI not configured (GEMINI_API_KEY)' });
    }
    const prompt = req.body && req.body.prompt != null ? String(req.body.prompt) : '';
    const context = req.body && req.body.context != null ? String(req.body.context) : '';
    if (prompt.trim().length < 2) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const answer = await generateProseAnswer(prompt.slice(0, MAX_PROMPT), {
      context: context.slice(0, MAX_CONTEXT)
    });
    res.json({ success: true, answer });
  } catch (e) {
    logger.error(`POST /api/ai/ask: ${e.message}`);
    res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

module.exports = router;
