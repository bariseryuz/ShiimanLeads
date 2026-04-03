const { db, sessionDb, dbGet, dbAll, dbRun } = require('./connection');
const { createTables, createIndexes, migratePhase1Columns, createPhase1Indexes } = require('./schema');
const logger = require('../utils/logger');

// Initialize database on first import
function initializeDatabase() {
  try {
    createTables(db);
    migratePhase1Columns(db);
    createIndexes(db);
    createPhase1Indexes(db);
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