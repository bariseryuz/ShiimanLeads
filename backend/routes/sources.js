const express = require('express');
const router = express.Router();
const axios = require('axios');
const jp = require('jsonpath');
const { getChromium } = require('../services/scraper/stealth');
const { dbAll, dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');

// Import required services
const { createSourceTable } = require('../services/sourceTable');
const { createUserSourceCore } = require('../services/createUserSourceCore');
const { loadSources } = require('../services/scraper/helpers');
const { discoverEndpoint } = require('../services/endpointDiscovery');
const { METHODS_WITH_BODY } = require('../engine/adapters/rest');
const { requirePaid, enforceSourceLimit, allowUnpaidScrape } = require('../middleware/billing');
const { log: auditLog } = require('../services/auditLog');
const { deleteUserSourceCascade } = require('../services/deleteUserSourceCascade');

function envBool(name) {
  const v = process.env[name];
  if (v == null || !String(v).trim()) return false;
  return String(v).trim().toLowerCase() === 'true';
}

function getAutoScrapeScheduleHint() {
  return {
    enabled: envBool('AUTO_SCRAPE_ENABLED'),
    cronExpression: String(process.env.AUTO_SCRAPE_INTERVAL || '0 */8 * * *').trim(),
    timezone: String(process.env.AUTO_SCRAPE_TIMEZONE || '').trim() || null
  };
}

function formatRunRow(row) {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    recordsFound: row.records_found,
    recordsInserted: row.records_inserted,
    errorMessage: row.error_message,
    errorType: row.error_type,
    durationMs: row.duration_ms
  };
}

function formatHealthRow(row) {
  return {
    sourceId: row.source_id,
    consecutiveFailures: row.consecutive_failures,
    lastStatus: row.last_status,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastErrorMessage: row.last_error_message,
    isBroken: !!row.is_broken,
    brokenSince: row.broken_since
  };
}

/**
 * GET /api/sources
 * Get all unique source names for the current user
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    // Get all configured sources for the user
    const userSources = await dbAll('SELECT source_data FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sourceNames = new Set();
    
    userSources.forEach(row => {
      try {
        const data = JSON.parse(row.source_data);
        if (data.name) sourceNames.add(data.name);
      } catch (e) {
        logger.error(`Failed to parse source_data for row id ${row.id}: ${e.message}`);
      }
    });
    
    // Also get sources that have leads (in case some were scraped)
    const leadsRows = await dbAll('SELECT DISTINCT source_name AS source FROM leads WHERE user_id = ? ORDER BY source_name', [userId]);
    leadsRows.forEach(r => r.source && sourceNames.add(r.source));
    
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
/**
 * POST /api/sources/connectors
 * Simplified JSON API source (Zillow-style feeds, partner APIs). Requires plan with apiConnector.
 * Body: { name, apiUrl, httpMethod?, authType?, apiToken?, headers?, query_params?, field_mapping?, primary_id_field? }
 */
router.post('/connectors', requirePaid, enforceSourceLimit, express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { getPlanConfig } = require('../config/plans');
    const { getBillingPlanKey } = require('../services/usageMeter');
    const planKey = await getBillingPlanKey(userId);
    const plan = getPlanConfig(planKey);
    if (!allowUnpaidScrape() && !plan.apiConnector) {
      return res.status(402).json({
        error: 'API connectors are not included in your plan. Upgrade to Starter or higher.',
        code: 'PLAN_FEATURE'
      });
    }
    const { normalizeConnectorSource } = require('../services/apiConnectorSource');
    const sourceData = normalizeConnectorSource(req.body);
    const result = await createUserSourceCore({ userId, sourceData, req });
    res.json(result);
  } catch (e) {
    logger.error(`POST /connectors: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/mine', async (req, res) => {
  try {
    // Use user ID from session, or default to 1 if not logged in
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const includeActivity =
      req.query.includeActivity === '1' ||
      req.query.includeActivity === 'true' ||
      req.query.includeActivity === 'yes';
    const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sources = rows.map(row => {
      try {
        return {
          id: row.id,
          data: JSON.parse(row.source_data),
          created_at: row.created_at
        };
      } catch (e) {
        logger.error(`Failed to parse source_data for source id ${row.id}: ${e.message}`);
        logger.error(`   Raw data (first 200 chars): ${row.source_data.substring(0, 200)}`);
        return null;
      }
    }).filter(Boolean);

    if (includeActivity && sources.length) {
      const ids = sources.map(s => s.id);
      const placeholders = ids.map(() => '?').join(',');
      const schedule = getAutoScrapeScheduleHint();

      const healthRows = await dbAll(
        `SELECT * FROM source_health WHERE user_id = ? AND source_id IN (${placeholders})`,
        [userId, ...ids]
      );
      const healthById = {};
      for (const h of healthRows) {
        healthById[h.source_id] = formatHealthRow(h);
      }

      const runLists = await Promise.all(
        ids.map(id =>
          dbAll(
            `SELECT * FROM source_runs WHERE user_id = ? AND source_id = ? ORDER BY started_at DESC LIMIT 25`,
            [userId, id]
          )
        )
      );
      const runsById = {};
      ids.forEach((id, i) => {
        runsById[id] = (runLists[i] || []).map(formatRunRow);
      });

      for (const s of sources) {
        s.activity = {
          health: healthById[s.id] || null,
          runs: runsById[s.id] || [],
          schedule
        };
      }
    }

    res.json({ data: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/sources/discover-endpoint
 * Universal: given a URL, find the data API endpoint (ArcGIS, _Get*, or from page XHR).
 */
router.post('/discover-endpoint', express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const { url, probeManifest } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required', endpointUrl: null, type: 'unknown', hint: 'Send { "url": "https://..." }.' });
    }
    const result =
      probeManifest && typeof probeManifest === 'object'
        ? await discoverEndpoint(url.trim(), { probeManifest, logger })
        : await discoverEndpoint(url.trim(), logger);
    res.json({
      endpointUrl: result.endpointUrl,
      type: result.type,
      hint: result.hint,
      rowCount: result.rowCount,
      candidates: result.candidates,
      probeResults: result.probeResults,
      aiSuggestion: result.aiSuggestion,
      apiGuides: result.apiGuides
    });
  } catch (e) {
    logger.error(`Discover endpoint error: ${e.message}`);
    res.status(500).json({
      error: e.message,
      endpointUrl: null,
      type: 'unknown',
      hint: 'Endpoint discovery failed.'
    });
  }
});

/**
 * GET /api/sources/:id
 * Get a specific source by ID (MUST come after /mine route)
 */
router.get('/:id', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const sourceId = req.params.id;
    
    const row = await dbGet('SELECT id, source_data, created_at FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    
    if (!row) {
      return res.status(404).json({ error: 'Source not found' });
    }
    
    let sourceData;
    try {
      sourceData = JSON.parse(row.source_data);
    } catch (parseError) {
      logger.error(`Failed to parse source ${sourceId}: ${parseError.message}`);
      logger.error(`   Raw data (first 200 chars): ${row.source_data.substring(0, 200)}`);
      return res.status(500).json({ error: 'Source data is corrupted - please delete and recreate this source' });
    }
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
router.post('/add', requirePaid, enforceSourceLimit, express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    const result = await createUserSourceCore({ userId, sourceData: req.body, req });
    res.json(result);
  } catch (e) {
    logger.error(`Add source error: ${e.message}`);
    res.status(e.status || 500).json({ error: e.message });
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
    
    const existing = await dbGet('SELECT id, source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    const before = existing.source_data ? JSON.parse(existing.source_data) : null;
    const sourceJson = JSON.stringify(sourceData);
    await dbRun('UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?', [sourceJson, sourceId, userId]);
    await auditLog({ userId, actorUserId: userId, action: 'source.updated', entityType: 'source', entityId: sourceId, before, after: sourceData, req });

    // Ensure source table has columns for engine field_mapping if present
    if (sourceData.field_mapping && Object.keys(sourceData.field_mapping).length) {
      const schemaForTable = sourceData.fieldSchema || Object.fromEntries(Object.values(sourceData.field_mapping).map(k => [k, k]));
      try {
        createSourceTable(sourceId, schemaForTable);
      } catch (tableErr) {
        logger.warn(`Could not update source table columns: ${tableErr.message}`);
      }
    }
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
    
    const existing = await dbGet('SELECT id, source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!existing) {
      logger.warn(`Source ${sourceId} not found or access denied for user ${userId}`);
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    const before = existing.source_data ? JSON.parse(existing.source_data) : null;
    logger.info(`Deleting source ${sourceId} for user ${userId}`);
    await deleteUserSourceCascade(userId, sourceId);
    await auditLog({ userId, actorUserId: userId, action: 'source.deleted', entityType: 'source', entityId: sourceId, before, req });
    logger.info(`Successfully deleted source ${sourceId}`);
    res.json({ success: true });
  } catch (e) {
    logger.error(`Delete source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /my-sources
 * Get all user sources with full data (alias, same as POST route for /my-sources endpoint)
 */
router.get('/my-sources', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const rows = await dbAll('SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC', [userId]);
    const sources = rows.map(row => {
      try {
        return {
          id: row.id,
          data: JSON.parse(row.source_data),
          created_at: row.created_at
        };
      } catch (e) {
        logger.error(`Failed to parse source_data for source id ${row.id}: ${e.message}`);
        logger.error(`   Raw data (first 200 chars): ${row.source_data.substring(0, 200)}`);
        return null;
      }
    }).filter(Boolean);
    res.json({ data: sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * NOTE: Duplicate PUT and DELETE routes removed - handled by single routes above at /:id
 */

/**
 * POST / (when mounted at /api/my-sources) OR POST /my-sources (when mounted at /api/sources)
 * Create a new source
 */
router.post('/', requirePaid, enforceSourceLimit, express.json(), async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const result = await createUserSourceCore({ userId, sourceData: req.body, req });
    res.json(result);
  } catch (e) {
    logger.error(`Add source error: ${e.message}`);
    if (e.status === 401 && req.session) {
      req.session.destroy(() => {});
    }
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * GET /api/sources/:id/sample
 * Get sample data from a source for field mapping
 */
router.get('/:id/sample', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const sourceId = parseInt(req.params.id, 10);
    
    // Get source config
    const sourceRow = await dbGet('SELECT source_data FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!sourceRow) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    let sourceConfig;
    try {
      sourceConfig = JSON.parse(sourceRow.source_data);
    } catch (parseError) {
      logger.error(`Failed to parse source ${sourceId}: ${parseError.message}`);
      logger.error(`   Raw data (first 200 chars): ${sourceRow.source_data.substring(0, 200)}`);
      return res.status(500).json({ error: 'Source data is corrupted - please delete and recreate this source' });
    }
    logger.info(`Fetching sample data for source: ${sourceConfig.name}`);
    
    // Fetch sample data based on source type
    let sampleData = [];
    
    if (sourceConfig.type === 'json') {
      let url = sourceConfig.url;
      let response;
      const sampleQuery = sourceConfig.params || sourceConfig.query_params;

      const httpMethod = (sourceConfig.method || 'GET').toUpperCase();
      if (METHODS_WITH_BODY.includes(httpMethod) && sampleQuery) {
        const sampleParams = { ...sampleQuery };
        if (sampleParams.pageSize) sampleParams.pageSize = '10';
        if (sampleParams.resultRecordCount) sampleParams.resultRecordCount = 10;

        response = await axios.request({
          method: httpMethod.toLowerCase(),
          url,
          data: sampleParams,
          headers: {
            'Content-Type': 'application/json',
            ...(sourceConfig.headers || {})
          }
        });
      } else if (sampleQuery) {
        // For GET requests, add params to URL
        const sampleParams = { ...sampleQuery };
        
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
      // For HTML sources, use Playwright to get sample
      const browser = await getChromium().launch(getStealthLaunchOptions());
      const context = await browser.newContext(getStealthContextOptions());
      const page = await context.newPage();
      await injectStealthScripts(page);
      page.setDefaultTimeout(90000);
      page.setDefaultNavigationTimeout(90000);
      await page.goto(sourceConfig.url, { waitUntil: 'networkidle', timeout: 90000 });
      
      const selector = sourceConfig.selector || 'table tr, .result, .item';
      const elements = await page.$$(selector);
      
      // Extract text from first 10 elements
      for (let i = 0; i < Math.min(10, elements.length); i++) {
        const text = await page.evaluate(el => el.textContent, elements[i]);
        sampleData.push({ _text: text.trim() });
      }
      
      await context.close();
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
    
    let sourceConfig;
    try {
      sourceConfig = JSON.parse(sourceRow.source_data);
    } catch (parseError) {
      logger.error(`Failed to parse source ${sourceId}: ${parseError.message}`);
      logger.error(`   Raw data (first 200 chars): ${sourceRow.source_data.substring(0, 200)}`);
      return res.status(500).json({ error: 'Source data is corrupted - please delete and recreate this source' });
    }
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

/**
 * GET /api/sources/:id/diagnose
 * Diagnose why a source might not be extracting all columns
 * Shows fieldSchema configuration, table structure, and sample data
 */
router.get('/:id/diagnose', async (req, res) => {
  try {
    const userId = req.session?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const sourceId = req.params.id;
    
    // Verify ownership
    const source = await dbGet('SELECT id FROM user_sources WHERE id = ? AND user_id = ?', [sourceId, userId]);
    if (!source) {
      return res.status(404).json({ error: 'Source not found or access denied' });
    }
    
    const { diagnoseSource } = require('../services/scraper/diagnostics');
    const report = await diagnoseSource(sourceId);
    
    res.json(report);
  } catch (e) {
    logger.error(`Diagnose source error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
