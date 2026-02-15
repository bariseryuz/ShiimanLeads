const logger = require('../utils/logger');

/**
 * Initialize all database tables
 */
function createTables(db) {
  logger.info('📊 Creating database tables...');

  // Unified leads table
  db.exec(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    unique_id TEXT NOT NULL,
    source_name TEXT,
    hash TEXT,
    primary_id TEXT,
    title TEXT,
    data TEXT,
    raw_text TEXT,
    raw_data TEXT,
    permit_number TEXT,
    address TEXT,
    value TEXT,
    estimated_value TEXT,
    description TEXT,
    source TEXT,
    date_added TEXT,
    date_issued TEXT,
    phone TEXT,
    page_url TEXT,
    application_date TEXT,
    owner_name TEXT,
    contractor_name TEXT,
    company_name TEXT,
    contractor_address TEXT,
    contractor_city TEXT,
    contractor_state TEXT,
    contractor_zip TEXT,
    contractor_phone TEXT,
    square_footage TEXT,
    units TEXT,
    floors TEXT,
    parcel_number TEXT,
    permit_type TEXT,
    permit_subtype TEXT,
    work_description TEXT,
    purpose TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    latitude TEXT,
    longitude TEXT,
    status TEXT,
    record_type TEXT,
    project_name TEXT,
    is_new INTEGER DEFAULT 1,
    seen_count INTEGER DEFAULT 1,
    last_seen_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    link TEXT,
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

  // Note: 'seen' table doesn't exist in current schema, using dedup_hash from leads
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_dedup ON leads(dedup_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_user ON leads(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(user_id, source_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_permit ON leads(permit_number)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_contractor ON leads(contractor_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_date ON leads(date_added DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_user_sources_user ON user_sources(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source_reliability_source ON source_reliability(source_id)`);

  logger.info('✅ Indexes created successfully');
}

module.exports = {
  createTables,
  createIndexes
};
