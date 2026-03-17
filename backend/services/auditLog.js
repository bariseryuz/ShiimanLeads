const { dbRun } = require('../db');
const logger = require('../utils/logger');

function safeJson(val) {
  if (val === undefined || val === null) return null;
  try {
    return typeof val === 'string' ? val : JSON.stringify(val);
  } catch {
    return null;
  }
}

/**
 * Write an audit log entry. Call from routes (source CRUD, scrape start/stop).
 */
async function log({ userId, actorUserId, action, entityType, entityId, before, after, req }) {
  const ip = req?.ip || req?.connection?.remoteAddress || null;
  const userAgent = req?.get?.('user-agent') || null;
  const actor = actorUserId ?? userId;
  try {
    await dbRun(
      `INSERT INTO audit_log (user_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId || null, actor || null, action, entityType || null, entityId ? String(entityId) : null, safeJson(before), safeJson(after), ip, userAgent]
    );
  } catch (e) {
    logger.error(`Audit log failed: ${e.message}`);
  }
}

module.exports = { log };
