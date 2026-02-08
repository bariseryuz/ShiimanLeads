const express = require('express');
const router = express.Router();
const axios = require('axios');
const jp = require('jsonpath');
const puppeteer = require('puppeteer');
const { dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

// Will be imported from services in Phase 5
let createSourceTable, createNotification, loadSources, scrapeForUser;

function setHelpers(helpers) {
  createSourceTable = helpers.createSourceTable;
  createNotification = helpers.createNotification;
  loadSources = helpers.loadSources;
  scrapeForUser = helpers.scrapeForUser;
}

/**
 * GET /api/sources
 * Get all unique source names for the current user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    
    // Get all configured sources for the user
    const userSources = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sourceNames = new Set();
    
    userSources.forEach(row => {
      try {
        const data = JSON.parse(row.source_data);
        if (data.name) sourceNames.add(data.name);
      } catch (e) {}
    });
    
    // Also get sources that have leads (in case some were scraped)
    const leadsRows = await dbAll('SELECT DISTINCT source FROM leads WHERE user_id = ? ORDER BY source', [userId]);
    leadsRows.forEach(r => sourceNames.add(r.source));
    
    const uniqueSources = Array.from(sourceNames).map(name => ({ name }));
    res.json({ data: uniqueSources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/sources/mine
 * Get current user's configured sources (MUST come before /:id route)
 */
router.get('/mine', async (req, res) => {
  try {
    // Use user ID from session, or default to 1 if not logged in
    const userId = req.session?.user?.id || 1;
    const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sources = rows.map(row => {
      try {
        return {
          id: row.id,
          data: JSON.parse(row.source_data),
          created_at: row.created_at
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    res.json({ data: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/sources/:id
 * Get a specific source by ID (MUST come after /mine route)
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = req.params.id;
    
    const row = await dbGet('SELECT id, source_data, created_at FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    
    if (!row) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    const sourceData = JSON.parse(row.source_data);
    res.json({
      id: row.id,
      name: sourceData.name,
      url: sourceData.url,
      fieldSchema: sourceData.fieldSchema || {},
      method: sourceData.method,
      aiEnabled: sourceData.aiEnabled,
      created_at: row.created_at
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/sources/add
 * Add a new source for current user
 */
router.post('/add', express.json(), async (req, res) => {
  try {
    // Use user ID from session, or default to 1 if not logged in
    const userId = req.session?.user?.id || 1;
    const sourceData = req.body;
    
    // Validate required fields
    if (!sourceData.name || !sourceData.url) {
      return res.status(400).json({ error: 'Source name and URL are required' });
    }
    
    // Store as JSON string
    const sourceJson = JSON.stringify(sourceData);
    const result = await dbRun(
      'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
      [userId, sourceJson, new Date().toISOString()]
    );
    
    const newSourceId = result.lastID;
    
    // ✨ CREATE SOURCE-SPECIFIC TABLE
    const tableName = createSourceTable(newSourceId, sourceData.fieldSchema);
    logger.info(`✅ Created dedicated table: ${tableName} for "${sourceData.name}"`);
    
    // Create notification for source addition
    await createNotification(
      userId,
      'source_added',
      `✅ Added new source: ${sourceData.name} with table ${tableName}`
    );
    
    // Optional: Auto-scrape when source is added (controlled by env variable)
    const AUTO_SCRAPE_ON_ADD = process.env.AUTO_SCRAPE_ON_ADD === 'true';
    
    if (AUTO_SCRAPE_ON_ADD) {
      logger.info(`New source added by user ${userId}, triggering immediate scrape`);
      scrapeForUser(userId, [sourceData]).then((newLeads) => {
        logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
      }).catch((err) => {
        logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
      });
      res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
    } else {
      logger.info(`New source added by user ${userId}. Auto-scrape disabled - use "Scrape Now" to start.`);
      res.json({ success: true, id: result.lastID, message: 'Source added. Click "Scrape Now" to extract leads.' });
    }
  } catch (e) {
    logger.error(`Add source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/sources/:id
 * Update an existing source
 */
router.put('/:id', express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    const sourceData = req.body;
    
    // Validate required fields
    if (!sourceData.name || !sourceData.url) {
      return res.status(400).json({ error: 'Source name and URL are required' });
    }
    
    // Check ownership
    const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    const sourceJson = JSON.stringify(sourceData);
    await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', [sourceJson, sourceId, userId]);
    
    res.json({ success: true });
  } catch (e) {
    logger.error(`Update source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/sources/:id
 * Delete a source
 */
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    
    logger.info(`Delete request for source ${sourceId} by user ${userId}`);
    
    // Check ownership before deleting
    const existing = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!existing) {
      logger.warn(`Source ${sourceId} not found or access denied for user ${userId}`);
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    logger.info(`Deleting source ${sourceId} for user ${userId}`);
    await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    logger.info(`Successfully deleted source ${sourceId}`);
    res.json({ success: true });
  } catch (e) {
    logger.error(`Delete source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/my-sources
 * Alias for backward compatibility
 */
router.get('/api/my-sources', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sources = rows.map(row => {
      try {
        return {
          id: row.id,
          data: JSON.parse(row.source_data),
          created_at: row.created_at
        };
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    res.json({ data: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/my-sources/:id
 * Update a source (alias)
 */
router.put('/api/my-sources/:id', express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    const sourceData = req.body;
    
    if (!sourceData || !sourceData.name || !sourceData.url) {
      return res.status(400).json({ error: 'Missing required fields: name, url' });
    }
    
    await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', 
      [JSON.stringify(sourceData), sourceId, userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/my-sources/:id
 * Delete a source (alias)
 */
router.delete('/api/my-sources/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    
    // Get source name before deleting for notification
    const existing = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    let sourceName = 'Unknown';
    if (existing) {
      try {
        const data = JSON.parse(existing.source_data);
        sourceName = data.name || 'Unknown';
      } catch (e) {}
    }
    
    await dbRun('DELETE FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    
    // Create notification for source deletion
    await createNotification(
      userId,
      'source_deleted',
      `🗑️ Removed source: ${sourceName}`
    );
    
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/my-sources
 * Create a new source (alias for /api/sources/add)
 */
router.post('/api/my-sources', express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceData = req.body;
    
    // Validate required fields
    if (!sourceData.name || !sourceData.url) {
      return res.status(400).json({ error: 'Source name and URL are required' });
    }
    
    // Store as JSON string
    const sourceJson = JSON.stringify(sourceData);
    const result = await dbRun(
      'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
      [userId, sourceJson, new Date().toISOString()]
    );
    
    const newSourceId = result.lastID;
    
    // ✨ CREATE SOURCE-SPECIFIC TABLE
    const tableName = createSourceTable(newSourceId, sourceData.fieldSchema);
    logger.info(`✅ Created dedicated table: ${tableName} for "${sourceData.name}"`);
    
    // Create notification for source addition
    await createNotification(
      userId,
      'source_added',
      `✅ Added new source: ${sourceData.name} with table ${tableName}`
    );
    
    // Optional: Auto-scrape when source is added (controlled by env variable)
    const AUTO_SCRAPE_ON_ADD = process.env.AUTO_SCRAPE_ON_ADD === 'true';
    
    if (AUTO_SCRAPE_ON_ADD) {
      logger.info(`New source added by user ${userId}, triggering immediate scrape`);
      scrapeForUser(userId, [sourceData]).then((newLeads) => {
        logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
      }).catch((err) => {
        logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
      });
      res.json({ success: true, id: result.lastID, message: 'Source added and scraping started' });
    } else {
      logger.info(`New source added by user ${userId}. Auto-scrape disabled - use "Scrape Now" to start.`);
      res.json({ success: true, id: result.lastID, message: 'Source added. Click "Scrape Now" to extract leads.' });
    }
  } catch (e) {
    logger.error(`Add source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/sources/:id/sample
 * Get sample data from a source for field mapping
 */
router.get('/:id/sample', async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    
    // Get source config
    const sourceRow = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!sourceRow) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    const sourceConfig = JSON.parse(sourceRow.source_data);
    logger.info(`Fetching sample data for source: ${sourceConfig.name}`);
    
    // Fetch sample data based on source type
    let sampleData = [];
    
    if (sourceConfig.type === 'json') {
      let url = sourceConfig.url;
      let response;
      
      if (sourceConfig.method === 'POST' && sourceConfig.params) {
        // For POST requests, send params in body
        const sampleParams = { ...sourceConfig.params };
        // Try to limit records for sample
        if (sampleParams.pageSize) sampleParams.pageSize = '10';
        if (sampleParams.resultRecordCount) sampleParams.resultRecordCount = 10;
        
        response = await axios.post(url, sampleParams, {
          headers: {
            'Content-Type': 'application/json',
            ...(sourceConfig.headers || {})
          }
        });
      } else if (sourceConfig.params) {
        // For GET requests, add params to URL
        const sampleParams = { ...sourceConfig.params };
        
        // Try to limit records for sample (different APIs use different params)
        if (sampleParams['$limit']) {
          // Socrata API
          sampleParams['$limit'] = '10';
        } else if (sampleParams.resultRecordCount) {
          // ArcGIS API
          sampleParams.resultRecordCount = 10;
        } else if (sampleParams.limit) {
          // Generic limit
          sampleParams.limit = '10';
        }
        
        const params = new URLSearchParams();
        Object.entries(sampleParams).forEach(([key, value]) => {
          params.append(key, String(value));
        });
        url = `${url}?${params.toString()}`;
        
        response = await axios.get(url, {
          headers: sourceConfig.headers || {}
        });
      } else {
        response = await axios.get(url, {
          headers: sourceConfig.headers || {}
        });
      }
      
      let jsonData = response.data;
      
      // Apply JSONPath if specified
      if (sourceConfig.jsonPath) {
        const result = jp.query(jsonData, sourceConfig.jsonPath);
        if (Array.isArray(result) && result.length > 0) {
          jsonData = result;
        }
      }
      
      // Get first 10 records for better sampling
      if (Array.isArray(jsonData)) {
        sampleData = jsonData.slice(0, 10);
      } else if (jsonData.features && Array.isArray(jsonData.features)) {
        // ArcGIS format - flatten attributes like we do in scraper
        sampleData = jsonData.features.slice(0, 10).map(f => {
          const item = f.attributes || f;
          // Flatten: merge attributes into top level
          return item.attributes ? {...item, ...item.attributes} : item;
        });
      } else if (jsonData.Data && Array.isArray(jsonData.Data)) {
        sampleData = jsonData.Data.slice(0, 10);
      }
      
    } else if (sourceConfig.type === 'html') {
      // For HTML sources, use Puppeteer to get sample
      const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 180000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(90000);
      page.setDefaultNavigationTimeout(90000);
      await page.goto(sourceConfig.url, { waitUntil: 'networkidle2', timeout: 30000 });
      
      const selector = sourceConfig.selector || 'table tr, .result, .item';
      const elements = await page.$$(selector);
      
      // Extract text from first 10 elements
      for (let i = 0; i < Math.min(10, elements.length); i++) {
        const text = await page.evaluate(el => el.textContent, elements[i]);
        sampleData.push({ _text: text.trim() });
      }
      
      await browser.close();
    }
    
    // Get available field names from first record
    const availableFields = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
    
    res.json({ 
      success: true, 
      sampleData,
      availableFields,
      sourceName: sourceConfig.name
    });
    
  } catch (e) {
    logger.error(`Fetch sample data error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/sources/:id/mappings
 * Save field mappings for a source
 */
router.post('/:id/mappings', express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id || 1;
    const sourceId = parseInt(req.params.id, 10);
    const { fieldMappings } = req.body;
    
    if (!fieldMappings || typeof fieldMappings !== 'object') {
      return res.status(400).json({ error: 'Field mappings are required' });
    }
    
    // Get existing source config
    const sourceRow = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!sourceRow) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    const sourceConfig = JSON.parse(sourceRow.source_data);
    sourceConfig.fieldMappings = fieldMappings;
    
    // Update source with new mappings
    await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', 
      [JSON.stringify(sourceConfig), sourceId, userId]);
    
    logger.info(`Saved field mappings for source ${sourceConfig.name} (user ${userId})`);
    
    res.json({ success: true, message: 'Field mappings saved successfully' });
    
  } catch (e) {
    logger.error(`Save field mappings error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, setHelpers };
