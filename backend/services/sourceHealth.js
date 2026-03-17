const { dbGet, dbRun, dbAll } = require('../db');
const logger = require('../utils/logger');
const { createNotification } = require('./notifications');
const { sendMail } = require('./mailer');

const CONSECUTIVE_FAILURES_THRESHOLD = parseInt(process.env.SOURCE_BROKEN_THRESHOLD || '3', 10);

async function ensureSourceHealth(sourceId, userId) {
  await dbRun(
    `INSERT OR IGNORE INTO source_health (source_id, user_id) VALUES (?, ?)`,
    [sourceId, userId]
  );
}

/**
 * Call at start of each source run. Returns runId to pass to recordRunEnd.
 */
async function recordRunStart(userId, sourceId, sourceName) {
  await ensureSourceHealth(sourceId, userId);
  const result = await dbRun(
    `INSERT INTO source_runs (user_id, source_id, source_name, status) VALUES (?, ?, ?, 'running')`,
    [userId, sourceId, sourceName || null]
  );
  return result?.lastID;
}

/**
 * Call at end of each source run (success or failure).
 */
async function recordRunEnd(runId, { success, recordsFound = 0, recordsInserted = 0, errorMessage, errorType }) {
  if (!runId) return;
  const endedAt = new Date().toISOString();
  const status = success ? 'success' : 'failure';
  const run = await dbGet('SELECT user_id, source_id, source_name FROM source_runs WHERE id = ?', [runId]);
  if (!run) return;

  const startedAt = await dbGet('SELECT started_at FROM source_runs WHERE id = ?', [runId]).then(r => r?.started_at);
  const durationMs = startedAt ? Math.round(new Date(endedAt) - new Date(startedAt)) : null;

  await dbRun(
    `UPDATE source_runs SET ended_at = ?, status = ?, records_found = ?, records_inserted = ?, error_message = ?, error_type = ?, duration_ms = ? WHERE id = ?`,
    [endedAt, status, recordsFound, recordsInserted, errorMessage || null, errorType || null, durationMs, runId]
  );

  await updateHealthAndNotifyIfBroken(run.user_id, run.source_id, run.source_name, success, errorMessage);
}

async function updateHealthAndNotifyIfBroken(userId, sourceId, sourceName, success, errorMessage) {
  await ensureSourceHealth(sourceId, userId);
  const row = await dbGet('SELECT * FROM source_health WHERE source_id = ?', [sourceId]);
  const now = new Date().toISOString();
  let consecutiveFailures = row?.consecutive_failures || 0;
  let isBroken = row?.is_broken || 0;
  let brokenSince = row?.broken_since;

  if (success) {
    consecutiveFailures = 0;
    isBroken = 0;
    brokenSince = null;
    await dbRun(
      `UPDATE source_health SET consecutive_failures = 0, last_status = 'success', last_success_at = ?, last_failure_at = last_failure_at, last_error_message = NULL, is_broken = 0, broken_since = NULL, updated_at = ? WHERE source_id = ?`,
      [now, now, sourceId]
    );
  } else {
    consecutiveFailures += 1;
    await dbRun(
      `UPDATE source_health SET consecutive_failures = ?, last_status = 'failure', last_failure_at = ?, last_error_message = ?, updated_at = ? WHERE source_id = ?`,
      [consecutiveFailures, now, errorMessage || null, now, sourceId]
    );
    if (consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      if (!row?.is_broken) {
        brokenSince = now;
        await dbRun(
          `UPDATE source_health SET is_broken = 1, broken_since = ? WHERE source_id = ?`,
          [brokenSince, sourceId]
        );
        await createNotification(userId, 'source_broken', `Source "${sourceName}" has failed ${consecutiveFailures} times in a row. Please check the source or contact support.`);
        const user = await dbGet('SELECT email FROM users WHERE id = ?', [userId]);
        if (user?.email) {
          await sendMail(
            user.email,
            `[Shiiman Leads] Source "${sourceName}" is not working`,
            `The source "${sourceName}" has failed ${consecutiveFailures} times. Last error: ${errorMessage || 'Unknown'}. Please check your source configuration or contact support.`
          );
        }
      }
    }
  }
}

async function getSourceHealthForUser(userId) {
  const rows = await dbAll(
    `SELECT sh.*, us.source_data FROM source_health sh
     LEFT JOIN user_sources us ON us.id = sh.source_id AND us.user_id = sh.user_id
     WHERE sh.user_id = ?`,
    [userId]
  );
  return rows.map(r => {
    let name = r.source_id;
    try {
      const data = r.source_data ? JSON.parse(r.source_data) : {};
      name = data.name || name;
    } catch (_) {}
    return {
      source_id: r.source_id,
      source_name: name,
      consecutive_failures: r.consecutive_failures,
      last_status: r.last_status,
      last_success_at: r.last_success_at,
      last_failure_at: r.last_failure_at,
      last_error_message: r.last_error_message,
      is_broken: !!r.is_broken,
      broken_since: r.broken_since
    };
  });
}

module.exports = {
  recordRunStart,
  recordRunEnd,
  getSourceHealthForUser
};
