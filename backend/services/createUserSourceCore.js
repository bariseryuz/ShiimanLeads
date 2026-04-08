/**
 * Shared insert path for user_sources (used by /api/sources and /api/discover/monitor).
 */

const { dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const { createSourceTable } = require('./sourceTable');
const { createNotification } = require('./notifications');
const { log: auditLog } = require('./auditLog');
const { scrapeForUser } = require('../legacyScraper');

/**
 * @param {{ userId: number, sourceData: object, req: import('express').Request, skipAutoScrape?: boolean, skipNotification?: boolean }} opts
 * @returns {Promise<{ success: boolean, id: number, message: string }>}
 */
async function createUserSourceCore({ userId, sourceData, req, skipAutoScrape = false, skipNotification = false }) {
  if (!userId) {
    const err = new Error('Not authenticated');
    err.status = 401;
    throw err;
  }
  if (!sourceData || !sourceData.name || !sourceData.url) {
    const err = new Error('Source name and URL are required');
    err.status = 400;
    throw err;
  }

  const userExists = await dbGet('SELECT id FROM users WHERE id = ?', [userId]);
  if (!userExists) {
    const err = new Error('Session expired - please log in again');
    err.status = 401;
    throw err;
  }

  const sourceJson = JSON.stringify(sourceData);
  const result = await dbRun(
    'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
    [userId, sourceJson, new Date().toISOString()]
  );

  const newSourceId = result.lastID;

  const schemaForTable =
    sourceData.fieldSchema ||
    (sourceData.field_mapping && Object.keys(sourceData.field_mapping).length
      ? Object.fromEntries(Object.values(sourceData.field_mapping).map(k => [k, k]))
      : undefined);
  const tableName = createSourceTable(newSourceId, schemaForTable);
  logger.info(`✅ Created dedicated table: ${tableName} for "${sourceData.name}"`);
  if (!skipNotification) {
    await createNotification(
      userId,
      'source_added',
      `✅ Added new source: ${sourceData.name} with table ${tableName}`
    );
  }
  await auditLog({
    userId,
    actorUserId: userId,
    action: 'source.created',
    entityType: 'source',
    entityId: newSourceId,
    after: sourceData,
    req
  });

  const AUTO_SCRAPE_ON_ADD =
    !skipAutoScrape && String(process.env.AUTO_SCRAPE_ON_ADD || '').trim().toLowerCase() === 'true';
  const toScrape = { ...sourceData, id: newSourceId, _sourceId: newSourceId };
  if (AUTO_SCRAPE_ON_ADD) {
    logger.info(`New source added by user ${userId}, triggering immediate scrape`);
    scrapeForUser(userId, [toScrape])
      .then(newLeads => {
        logger.info(`Immediate scrape completed for user ${userId}: ${newLeads} new leads from new source`);
      })
      .catch(err => {
        logger.error(`Immediate scrape error for user ${userId}: ${err.message}`);
      });
  } else {
    logger.info(`New source added by user ${userId}. Auto-scrape disabled - use "Scrape Now" to start.`);
  }

  return {
    success: true,
    id: newSourceId,
    message: AUTO_SCRAPE_ON_ADD
      ? 'Source added and scraping started'
      : 'Source added. Click "Scrape Now" to extract leads.'
  };
}

module.exports = { createUserSourceCore };
