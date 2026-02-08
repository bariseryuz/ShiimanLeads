const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../db');
const logger = require('../utils/logger');
const { scrapeForUser } = require('../legacyScraper'); // Import from legacy scraper

// Import progress tracking from services
const {
  getProgress,
  updateProgress,
  setShouldStop
} = require('../services/scraper/progress');

/**
 * POST /api/scrape/now
 * Trigger manual scraping for all user sources
 */
router.post('/now', async (req, res) => {
  try {
    // Accept userId from request body (from server.js) or session
    const userId = req.body.userId || req.session?.user?.id || 1;
    
    // Get user's sources WITH their IDs
    const sourceRows = await dbAll('SELECT id, source_data FROM user_sources WHERE user_id = ?', [userId]);
    if (!sourceRows.length) {
      return res.json({ success: true, message: 'No sources configured to scrape', leadsFound: 0 });
    }
    
    const userSources = sourceRows.map(row => {
      try {
        const sourceData = JSON.parse(row.source_data);
        sourceData._sourceId = row.id; // Attach source ID for table saving
        
        // Ensure method field is set based on usePuppeteer flag
        if (sourceData.usePuppeteer === true && !sourceData.method) {
          sourceData.method = 'puppeteer';
        }
        // Also set usePuppeteer if method is puppeteer
        if (sourceData.method === 'puppeteer' && sourceData.usePuppeteer !== true) {
          sourceData.usePuppeteer = true;
        }
        // Default to puppeteer if useAI is enabled (AI extraction needs screenshots)
        if (sourceData.useAI === true && !sourceData.usePuppeteer) {
          sourceData.usePuppeteer = true;
          sourceData.method = 'puppeteer';
        }
        
        return sourceData;
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    
    if (!userSources.length) {
      return res.json({ success: true, message: 'No valid sources found', leadsFound: 0 });
    }
    
    logger.info(`Manual scrape triggered by user ${userId} for ${userSources.length} sources`);
    
    // Scrape in background and respond immediately
    scrapeForUser(userId, userSources).then((newLeads) => {
      logger.info(`Manual scrape completed for user ${userId}: ${newLeads} new leads`);
    }).catch((err) => {
      logger.error(`Manual scrape error for user ${userId}: ${err.message}`);
    });
    
    res.json({ 
      success: true, 
      message: `Scraping started for ${userSources.length} source(s). Check back in a few moments.`,
      sourcesCount: userSources.length
    });
  } catch (e) {
    logger.error(`Manual scrape error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/scrape/stop
 * Stop ongoing scraping for current user
 */
router.post('/stop', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    
    logger.info(`🛑 Stop request received from user ${userId}`);
    
    // Set the stop flag
    setShouldStop(userId, true);
    
    // Update progress to show stopped status
    updateProgress(userId, { 
      status: 'stopped',
      currentSource: 'Stopped by user'
    });
    
    res.json({ 
      success: true, 
      message: 'Scraping will stop after current source completes'
    });
  } catch (e) {
    logger.error(`Stop scrape error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/scrape/progress
 * Get scraping progress for current user
 */
router.get('/progress', (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const progress = getProgress(userId);
    
    if (!progress) {
      return res.json({ 
        success: true, 
        progress: null,
        message: 'No active scraping session'
      });
    }
    
    res.json({ 
      success: true, 
      progress: {
        status: progress.status,
        currentSource: progress.currentSource,
        completedSources: progress.completedSources,
        totalSources: progress.totalSources,
        leadsFound: progress.leadsFound,
        errors: progress.errors,
        startTime: progress.startTime,
        endTime: progress.endTime,
        elapsedTime: Date.now() - progress.startTime
      }
    });
  } catch (e) {
    logger.error(`Progress error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/scrape/:id
 * Scrape a single source by ID
 */
router.post('/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    
    // Get the specific source WITH its ID
    const sourceRow = await dbGet('SELECT id, source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!sourceRow) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    const sourceConfig = JSON.parse(sourceRow.source_data);
    sourceConfig._sourceId = sourceRow.id; // Attach source ID for table saving
    logger.info(`Manual scrape triggered for source "${sourceConfig.name}" (ID: ${sourceId}) by user ${userId}`);
    
    // Scrape in background and respond immediately
    scrapeForUser(userId, [sourceConfig]).then((newLeads) => {
      logger.info(`Manual scrape completed for source "${sourceConfig.name}": ${newLeads} new leads`);
    }).catch((err) => {
      logger.error(`Manual scrape error for source "${sourceConfig.name}": ${err.message}`);
    });
    
    res.json({ 
      success: true, 
      message: `Scraping started for "${sourceConfig.name}". Check back in a few moments.`,
      sourceName: sourceConfig.name
    });
  } catch (e) {
    logger.error(`Single source scrape error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
