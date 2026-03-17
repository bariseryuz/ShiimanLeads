const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const config = require('../config/environment');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '../data/backups');
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP || '7', 10);

async function runBackup() {
  const dbPath = config.DB_PATH || path.join(__dirname, '../data/shiiman-leads.db');
  if (!fs.existsSync(dbPath)) {
    logger.warn('Backup skipped: DB file not found at ' + dbPath);
    return;
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  const name = `shiiman-leads-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(dbPath, dest);
  logger.info('Backup created: ' + dest);

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('shiiman-leads-') && f.endsWith('.db'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  while (files.length > BACKUP_KEEP) {
    const old = files.pop();
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, old.name));
      logger.info('Old backup removed: ' + old.name);
    } catch (e) {
      logger.warn('Could not remove old backup: ' + e.message);
    }
  }
}

module.exports = { runBackup };
