const { db, sessionDb, dbGet, dbAll, dbRun } = require('./connection');
const { createTables, createIndexes } = require('./schema');
const { runMigrations } = require('./migrations');
const logger = require('../utils/logger');

// Initialize database on first import
function initializeDatabase() {
  try {
    createTables(db);
    runMigrations(db);  // Run migrations BEFORE creating indexes
    createIndexes(db);   // Create indexes AFTER migrations add columns
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
