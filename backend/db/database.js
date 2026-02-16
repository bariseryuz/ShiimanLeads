const { db, sessionDb, dbGet, dbAll, dbRun } = require('./connection');
const { createTables, createIndexes } = require('./schema');
const logger = require('../utils/logger');

// Initialize database on first import
function initializeDatabase() {
  try {
    createTables(db);
    createIndexes(db);
    logger.info('✅ Database initialized successfully');
  } catch (err) {
    logger.error(`❌ Database initialization failed: ${err.message}`);
    throw err;
  }
}

// Auto-initialize
initializeDatabase();

module.exports = {
  db,
  sessionDb,
  dbGet,
  dbAll,
  dbRun
};