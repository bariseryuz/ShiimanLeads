const Database = require('better-sqlite3');
const config = require('../config/environment');
const logger = require('../utils/logger');

// Initialize database connection
const db = new Database(config.DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

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
  dbGet,
  dbAll,
  dbRun
};
