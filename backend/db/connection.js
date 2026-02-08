const Database = require('better-sqlite3');
const config = require('../config/environment');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

console.log('\n🔧 Initializing database connection...');
console.log('📁 Environment:', config.NODE_ENV);
console.log('📁 DB Path:', config.DB_PATH);
console.log('📁 Sessions DB Path:', config.SESSIONS_DB_PATH);
console.log('📁 Screenshots Dir:', config.SCREENSHOTS_DIR);

// Ensure data directory exists
const dataDir = path.dirname(config.DB_PATH);
if (!fs.existsSync(dataDir)) {
  console.log('📁 Creating data directory:', dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
}

// Create screenshots directory
if (!fs.existsSync(config.SCREENSHOTS_DIR)) {
  console.log('📁 Creating screenshots directory:', config.SCREENSHOTS_DIR);
  fs.mkdirSync(config.SCREENSHOTS_DIR, { recursive: true });
}

// Initialize database connection
const db = new Database(config.DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize sessions database
const sessionDb = new Database(config.SESSIONS_DB_PATH);
sessionDb.pragma('journal_mode = WAL');

console.log('✅ Database connected:', config.DB_PATH);
console.log('✅ Sessions database:', config.SESSIONS_DB_PATH);

// Check for existing data
try {
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const sourceCount = db.prepare('SELECT COUNT(*) as count FROM user_sources').get();
  const leadCount = db.prepare('SELECT COUNT(*) as count FROM leads').get();
  
  console.log(`📊 Existing data: ${userCount.count} users, ${sourceCount.count} sources, ${leadCount.count} leads`);
  
  if (userCount.count === 0) {
    console.log('⚠️ No users found - database may be new or empty');
  }
} catch (error) {
  console.log('ℹ️ Database tables not created yet (this is normal on first run)');
}

logger.info(`📂 Database connected: ${config.DB_PATH}`);

// Promisified query wrappers
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const result = db.prepare(sql).get(params);
      resolve(result);
    } catch (err) {
      logger.error(`dbGet error: ${err.message}`);
      reject(err);
    }
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const results = db.prepare(sql).all(params);
      resolve(results);
    } catch (err) {
      logger.error(`dbAll error: ${err.message}`);
      reject(err);
    }
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    try {
      const result = db.prepare(sql).run(params);
      resolve(result);
    } catch (err) {
      logger.error(`dbRun error: ${err.message}`);
      reject(err);
    }
  });
}

module.exports = {
  db,
  sessionDb,
  dbGet,
  dbAll,
  dbRun
};
