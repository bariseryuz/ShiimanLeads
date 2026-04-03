const crypto = require('crypto');
const { dbGet, dbRun, dbAll } = require('../db');
const logger = require('../utils/logger');

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/**
 * @returns {Promise<{ id: number, token: string, label: string }>}
 */
async function createIngestToken(userId, label) {
  const raw = `shi_${crypto.randomBytes(32).toString('base64url')}`;
  const token_hash = hashToken(raw);
  const lbl = String(label || 'default').trim().slice(0, 80) || 'default';
  const now = new Date().toISOString();
  const result = await dbRun(
    'INSERT INTO ingest_tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)',
    [userId, token_hash, lbl, now]
  );
  logger.info(`Ingest token created for user ${userId} id=${result.lastID}`);
  return { id: result.lastID, token: raw, label: lbl };
}

/**
 * @param {string} rawToken
 * @returns {Promise<{ userId: number, tokenId: number } | null>}
 */
async function verifyIngestToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const h = hashToken(rawToken.trim());
  const row = await dbGet('SELECT id, user_id FROM ingest_tokens WHERE token_hash = ?', [h]);
  if (!row) return null;
  return { userId: row.user_id, tokenId: row.id };
}

async function touchIngestToken(tokenId) {
  try {
    await dbRun('UPDATE ingest_tokens SET last_used_at = ? WHERE id = ?', [new Date().toISOString(), tokenId]);
  } catch (e) {
    logger.warn(`touchIngestToken: ${e.message}`);
  }
}

async function listIngestTokens(userId) {
  return dbAll(
    'SELECT id, label, created_at, last_used_at FROM ingest_tokens WHERE user_id = ? ORDER BY id DESC',
    [userId]
  );
}

async function deleteIngestToken(userId, tokenId) {
  const r = await dbRun('DELETE FROM ingest_tokens WHERE id = ? AND user_id = ?', [tokenId, userId]);
  return r.changes > 0;
}

module.exports = {
  createIngestToken,
  verifyIngestToken,
  touchIngestToken,
  listIngestTokens,
  deleteIngestToken
};
