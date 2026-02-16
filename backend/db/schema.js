const logger = require('../utils/logger');

/**
 * Initialize all database tables
 */
function createTables(db) {
  logger.info('📊 Creating database tables...');

  // ✅ UNIVERSAL leads table - works with ANY data type
  db.exec(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    unique_id TEXT NOT NULL,
    source_name TEXT,
    
    -- All scraped data stored as JSON (universal!)
    raw_data TEXT NOT NULL,
    
    -- Metadata
    is_new INTEGER DEFAULT 1,
    seen_count INTEGER DEFAULT 1,
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(user_id, source_id, unique_id)
  )`);

  // Users table
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'client',
    company_name TEXT,
    phone TEXT,
    website TEXT,
    created_at TEXT,    
    email_verified INTEGER DEFAULT 0,
    verification_token TEXT
  )`);

  // User sources (custom per-user source configurations)
  db.exec(`CREATE TABLE IF NOT EXISTS user_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_data TEXT NOT NULL,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Inquiries (contact form submissions)
  db.exec(`CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    company TEXT,
    message TEXT,
    created_at TEXT,
    ip TEXT
  )`);

  // Notifications
  db.exec(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Source reliability tracking
  db.exec(`CREATE TABLE IF NOT EXISTS source_reliability (
    source_id INTEGER PRIMARY KEY,
    source_name TEXT,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    last_success DATETIME,
    last_failure DATETIME,
    confidence_score REAL DEFAULT 100.0,
    avg_leads_per_run REAL DEFAULT 0,
    total_leads INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  logger.info('✅ Tables created successfully');
}

/**
 * Create database indexes for performance
 */
function createIndexes(db) {
  logger.info('📇 Creating database indexes...');

  const indexes = [
    { name: 'idx_leads_user', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id)' },
    { name: 'idx_leads_source', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(user_id, source_id)' },
    { name: 'idx_leads_created', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC)' },
    { name: 'idx_leads_unique', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_unique ON leads(unique_id)' },
    { name: 'idx_notifications_user', sql: 'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)' },
    { name: 'idx_user_sources_user', sql: 'CREATE INDEX IF NOT EXISTS idx_user_sources_user ON user_sources(user_id)' },
    { name: 'idx_source_reliability_source', sql: 'CREATE INDEX IF NOT EXISTS idx_source_reliability_source ON source_reliability(source_id)' }
  ];

  indexes.forEach(({ name, sql }) => {
    try {
      db.exec(sql);
      logger.info(`✅ Created index: ${name}`);
    } catch (err) {
      logger.warn(`⚠️  Could not create ${name}: ${err.message}`);
    }
  });

  logger.info('✅ Indexes creation completed');
}

module.exports = {
  createTables,
  createIndexes
};