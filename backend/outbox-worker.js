const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const { DB_PATH, OUTBOX_JSONL: OUTPUT_FILE } = require('./db-path');
const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 5;

const db = new Database(DB_PATH);

async function appendLineAtomic(filePath, line) {
  // Ensure directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function processBatch() {
  const rows = db.prepare("SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 20").all();
  for (const row of rows) {
    try {
      // mark processing
      db.prepare("UPDATE outbox SET status='processing', updated_at=datetime('now') WHERE id=?").run(row.id);

      // attempt append
      await appendLineAtomic(OUTPUT_FILE, row.payload_json);

      // mark done
      db.prepare("UPDATE outbox SET status='done', updated_at=datetime('now') WHERE id=?").run(row.id);
      console.info(`Outbox: wrote id=${row.id}`);
    } catch (err) {
      console.warn(`Outbox: failed id=${row.id}: ${err.message}`);
      // increment attempts
      db.prepare("UPDATE outbox SET attempts=attempts+1, last_error=?, updated_at=datetime('now') WHERE id=?").run(err.message, row.id);
      const updated = db.prepare('SELECT attempts FROM outbox WHERE id=?').get(row.id);
      if (updated.attempts >= MAX_ATTEMPTS) {
        db.prepare("UPDATE outbox SET status='failed', updated_at=datetime('now') WHERE id=?").run(row.id);
        console.error(`Outbox: id=${row.id} marked failed after ${updated.attempts} attempts`);
      } else {
        // backoff small delay before next item
        await sleep(500 * updated.attempts);
      }
    }
  }
}

(async function loop() {
  console.info('Outbox worker started');
  while (true) {
    try {
      await processBatch();
    } catch (err) {
      console.error('Outbox worker error:', err.message);
    }
    await sleep(POLL_INTERVAL_MS);
  }
})();
