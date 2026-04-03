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

  // Billing / subscription state (Paddle)
  db.exec(`CREATE TABLE IF NOT EXISTS billing_accounts (
    user_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'paddle',
    plan_key TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'inactive', -- active|past_due|canceled|inactive
    paddle_customer_id TEXT,
    paddle_subscription_id TEXT,
    current_period_end DATETIME,
    grace_period_ends_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Alert preferences
  db.exec(`CREATE TABLE IF NOT EXISTS notification_settings (
    user_id INTEGER PRIMARY KEY,
    instant_email_enabled INTEGER DEFAULT 0,
    digest_email_enabled INTEGER DEFAULT 1,
    digest_frequency TEXT DEFAULT 'daily', -- daily|weekly
    digest_time_utc TEXT DEFAULT '13:00', -- HH:MM
    last_digest_sent_at DATETIME,
    webhook_enabled INTEGER DEFAULT 0,
    webhook_url TEXT,
    slack_webhook_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // User sources (custom per-user source configurations)
  db.exec(`CREATE TABLE IF NOT EXISTS user_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_data TEXT NOT NULL,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Source runs (health + history)
  db.exec(`CREATE TABLE IF NOT EXISTS source_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    source_name TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running', -- running|success|failure|stopped
    records_found INTEGER DEFAULT 0,
    records_inserted INTEGER DEFAULT 0,
    error_message TEXT,
    error_type TEXT,
    duration_ms INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(source_id) REFERENCES user_sources(id)
  )`);

  // Per-source health summary (broken detection)
  db.exec(`CREATE TABLE IF NOT EXISTS source_health (
    source_id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    consecutive_failures INTEGER DEFAULT 0,
    last_status TEXT, -- success|failure
    last_success_at DATETIME,
    last_failure_at DATETIME,
    last_error_message TEXT,
    is_broken INTEGER DEFAULT 0,
    broken_since DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(source_id) REFERENCES user_sources(id)
  )`);

  // Audit trail (who changed what, and when scans ran)
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    actor_user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    before_json TEXT,
    after_json TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
 * Phase 1: add columns to existing DBs without breaking current installs (IF NOT EXISTS column).
 */
function migratePhase1Columns(db) {
  const hasColumn = (table, col) => {
    try {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all();
      return rows.some(r => r.name === col);
    } catch {
      return false;
    }
  };
  const add = (table, col, ddl) => {
    if (hasColumn(table, col)) return;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
      logger.info(`Migration: ${table}.${col} added`);
    } catch (e) {
      logger.warn(`Migration: ${table}.${col} failed: ${e.message}`);
    }
  };

  add('users', 'industry', 'TEXT');
  add('users', 'target_audience', 'TEXT');
  add('users', 'positive_signals', 'TEXT');
  add('users', 'negative_signals', 'TEXT');

  add('user_sources', 'frequency', 'TEXT');
  add('user_sources', 'is_active', 'INTEGER DEFAULT 1');
  add('user_sources', 'last_run_at', 'TEXT');

  add('leads', 'fingerprint', 'TEXT');
  add('leads', 'priority_score', 'INTEGER');
  add('leads', 'ai_summary', 'TEXT');
  add('leads', 'status', "TEXT DEFAULT 'New'");

  // Phase 3: Signal Brain (Gemini scoring output)
  add('leads', 'contact_name', 'TEXT');
}

/**
 * Indexes for Phase 1 (safe to run repeatedly).
 */
function createPhase1Indexes(db) {
  const stmts = [
    'CREATE INDEX IF NOT EXISTS idx_leads_user_fingerprint ON leads(user_id, fingerprint)'
  ];
  stmts.forEach(sql => {
    try {
      db.exec(sql);
      logger.info(`✅ Created index: ${sql.split('IF NOT EXISTS ')[1]?.split(' ON ')[0] || 'phase1'}`);
    } catch (err) {
      logger.warn(`⚠️  Phase1 index: ${err.message}`);
    }
  });
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
    { name: 'idx_source_reliability_source', sql: 'CREATE INDEX IF NOT EXISTS idx_source_reliability_source ON source_reliability(source_id)' },
    { name: 'idx_source_runs_user', sql: 'CREATE INDEX IF NOT EXISTS idx_source_runs_user ON source_runs(user_id, started_at DESC)' },
    { name: 'idx_source_runs_source', sql: 'CREATE INDEX IF NOT EXISTS idx_source_runs_source ON source_runs(user_id, source_id, started_at DESC)' },
    { name: 'idx_audit_log_user', sql: 'CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at DESC)' }
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
  createIndexes,
  migratePhase1Columns,
  createPhase1Indexes
};