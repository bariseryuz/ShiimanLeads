const { db, dbGet, dbAll, dbRun } = require('./connection');
const { createTables, createIndexes } = require('./schema');
const { runMigrations } = require('./migrations');
const logger = require('../utils/logger');

// Initialize database on first import
function initializeDatabase() {
  try {
    createTables(db);
    createIndexes(db);
    runMigrations(db);
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
  dbGet,
  dbAll,
  dbRun
};
