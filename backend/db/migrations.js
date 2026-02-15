const logger = require('../utils/logger');

/**
 * Run database migrations to add missing columns to existing databases
 */
function runMigrations(db) {
  logger.info('🔄 Running database migrations...');

  // ============================================================================
  // MIGRATION 1: Add missing columns to leads table
  // ============================================================================
  
  const leadsMigrations = [
    { column: 'unique_id', type: 'TEXT' },
    { column: 'source_name', type: 'TEXT' },
    { column: 'raw_data', type: 'TEXT' },
    { column: 'estimated_value', type: 'TEXT' },
    { column: 'source_id', type: 'INTEGER' },
    { column: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { column: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { column: 'primary_id', type: 'TEXT' },
    { column: 'title', type: 'TEXT' },
    { column: 'data', type: 'TEXT' },
    { column: 'date_issued', type: 'TEXT' },
    { column: 'phone', type: 'TEXT' },
    { column: 'page_url', type: 'TEXT' },
    { column: 'application_date', type: 'TEXT' },
    { column: 'owner_name', type: 'TEXT' },
    { column: 'contractor_name', type: 'TEXT' },
    { column: 'contractor_address', type: 'TEXT' },
    { column: 'contractor_city', type: 'TEXT' },
    { column: 'contractor_state', type: 'TEXT' },
    { column: 'contractor_zip', type: 'TEXT' },
    { column: 'contractor_phone', type: 'TEXT' },
    { column: 'square_footage', type: 'TEXT' },
    { column: 'units', type: 'TEXT' },
    { column: 'floors', type: 'TEXT' },
    { column: 'parcel_number', type: 'TEXT' },
    { column: 'permit_type', type: 'TEXT' },
    { column: 'permit_subtype', type: 'TEXT' },
    { column: 'work_description', type: 'TEXT' },
    { column: 'purpose', type: 'TEXT' },
    { column: 'city', type: 'TEXT' },
    { column: 'state', type: 'TEXT' },
    { column: 'zip_code', type: 'TEXT' },
    { column: 'latitude', type: 'TEXT' },
    { column: 'longitude', type: 'TEXT' },
    { column: 'status', type: 'TEXT' },
    { column: 'record_type', type: 'TEXT' },
    { column: 'project_name', type: 'TEXT' },
    { column: 'is_new', type: 'INTEGER DEFAULT 1' },
    { column: 'extracted_data', type: 'TEXT' },
    { column: 'canonical_hash', type: 'TEXT' },
    { column: 'dedup_hash', type: 'TEXT' },
    { column: 'raw', type: 'TEXT' },
    { column: 'ai_confidence', type: 'REAL' },
    { column: 'ai_validated', type: 'INTEGER DEFAULT 0' },
    { column: 'company_name', type: 'TEXT' },
    { column: 'link', type: 'TEXT' },
    { column: 'seen_count', type: 'INTEGER DEFAULT 1' },
    { column: 'last_seen_at', type: 'DATETIME' },
    { column: 'screenshot_path', type: 'TEXT' }  // For screenshot feature
  ];

  leadsMigrations.forEach(({ column, type }) => {
    try {
      db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${type}`);
      logger.info(`✅ Added column: leads.${column}`);
    } catch (err) {
      // Column already exists, ignore
    }
  });

  // ============================================================================
  // MIGRATION 2: Remove problematic UNIQUE constraints
  // ============================================================================
  
  try {
    logger.info('🔄 Checking for hardcoded UNIQUE constraints...');
    
    // Check if the problematic index exists
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='index' 
      AND tbl_name='leads' 
      AND name LIKE '%permit%'
    `).all();
    
    if (indexes.length > 0) {
      logger.info('⚠️  Found hardcoded permit constraint, removing...');
      
      // Drop problematic indexes
      indexes.forEach(idx => {
        try {
          db.exec(`DROP INDEX IF EXISTS ${idx.name}`);
          logger.info(`✅ Dropped index: ${idx.name}`);
        } catch (err) {
          logger.warn(`⚠️  Could not drop index ${idx.name}: ${err.message}`);
        }
      });
    }
    
  } catch (err) {
    logger.warn(`⚠️  Could not check indexes: ${err.message}`);
  }

  // ============================================================================
  // MIGRATION 3: Create universal deduplication index
  // ============================================================================
  
  try {
    // Create universal unique constraint (works for ANY source)
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_user_source_canonical 
      ON leads(user_id, source_id, canonical_hash)
    `);
    logger.info('✅ Created universal deduplication index: idx_leads_user_source_canonical');
  } catch (err) {
    if (!err.message.includes('already exists')) {
      logger.warn(`⚠️  Could not create universal index: ${err.message}`);
    }
  }

  // ============================================================================
  // MIGRATION 4: Create performance indexes
  // ============================================================================
  
  const performanceIndexes = [
    { name: 'idx_leads_user_id', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)' },
    { name: 'idx_leads_source_id', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_source_id ON leads(source_id)' },
    { name: 'idx_leads_created_at', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at)' },
    { name: 'idx_leads_is_new', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_is_new ON leads(is_new)' },
    { name: 'idx_leads_canonical_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_canonical_hash ON leads(canonical_hash)' },
    { name: 'idx_leads_dedup_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_dedup_hash ON leads(dedup_hash)' }
  ];

  performanceIndexes.forEach(({ name, sql }) => {
    try {
      db.exec(sql);
      logger.info(`✅ Created performance index: ${name}`);
    } catch (err) {
      if (!err.message.includes('already exists')) {
        logger.warn(`⚠️  Could not create index ${name}: ${err.message}`);
      }
    }
  });

  // ============================================================================
  // MIGRATION 5: Users table migrations
  // ============================================================================
  
  const usersMigrations = [
    { column: 'company_name', type: 'TEXT' },
    { column: 'phone', type: 'TEXT' },
    { column: 'website', type: 'TEXT' }
  ];

  usersMigrations.forEach(({ column, type }) => {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
      logger.info(`✅ Added column: users.${column}`);
    } catch (err) {
      // Column already exists, ignore
    }
  });

  // ============================================================================
  // MIGRATION 6: Inquiries table migrations
  // ============================================================================
  
  try {
    db.exec('ALTER TABLE inquiries ADD COLUMN ip TEXT');
    logger.info('✅ Added column: inquiries.ip');
  } catch (err) {
    // Column already exists
  }

  // ============================================================================
  // MIGRATION 7: Clean up duplicate canonical_hash values (one-time)
  // ============================================================================
  
  try {
    logger.info('🔄 Checking for duplicate canonical_hash values...');
    
    const duplicates = db.prepare(`
      SELECT canonical_hash, COUNT(*) as count
      FROM leads
      WHERE canonical_hash IS NOT NULL
      GROUP BY canonical_hash
      HAVING count > 1
    `).all();
    
    if (duplicates.length > 0) {
      logger.warn(`⚠️  Found ${duplicates.length} duplicate hash groups, keeping newest records...`);
      
      // Keep only the newest record for each hash
      db.exec(`
        DELETE FROM leads
        WHERE id NOT IN (
          SELECT MAX(id)
          FROM leads
          WHERE canonical_hash IS NOT NULL
          GROUP BY user_id, source_id, canonical_hash
        )
        AND canonical_hash IS NOT NULL
      `);
      
      logger.info('✅ Cleaned up duplicate records');
    }
  } catch (err) {
    logger.warn(`⚠️  Could not clean up duplicates: ${err.message}`);
  }

  logger.info('✅ Migrations completed');
}

module.exports = {
  runMigrations
};