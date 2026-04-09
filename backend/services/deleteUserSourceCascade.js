/**
 * Delete a user source and all DB rows that reference it (SQLite FKs are enforced).
 * Order: leads → source_runs → source_health → source_reliability → optional source_N table → user_sources
 */

const { db, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * @param {number} userId
 * @param {number} sourceId
 */
async function deleteUserSourceCascade(userId, sourceId) {
  const uid = parseInt(userId, 10);
  const sid = parseInt(sourceId, 10);
  if (!Number.isFinite(uid) || !Number.isFinite(sid)) {
    throw new Error('Invalid user or source id');
  }

  await dbRun('DELETE FROM leads WHERE user_id = ? AND source_id = ?', [uid, sid]);
  await dbRun('DELETE FROM source_runs WHERE user_id = ? AND source_id = ?', [uid, sid]);
  await dbRun('DELETE FROM source_health WHERE user_id = ? AND source_id = ?', [uid, sid]);
  await dbRun('DELETE FROM source_reliability WHERE source_id = ?', [sid]);

  const tableName = `source_${sid}`;
  if (/^source_\d+$/.test(tableName)) {
    try {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    } catch (e) {
      logger.warn(`[deleteUserSourceCascade] DROP ${tableName}: ${e.message}`);
    }
  }

  await dbRun('DELETE FROM user_sources WHERE user_id = ? AND id = ?', [uid, sid]);
}

module.exports = { deleteUserSourceCascade };
