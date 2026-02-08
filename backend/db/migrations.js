const logger = require('../utils/logger');

/**
 * Run database migrations to add missing columns to existing databases
 */
function runMigrations(db) {
  logger.info('🔄 Running database migrations...');

  // Leads table migrations
  const leadsMigrations = [
    { column: 'source_id', type: 'INTEGER' },
    { column: 'created_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
    { column: 'updated_at', type: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
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
    { column: 'ai_confidence', type: 'REAL' },
    { column: 'ai_validated', type: 'INTEGER DEFAULT 0' },
    { column: 'company_name', type: 'TEXT' },
    { column: 'link', type: 'TEXT' }
  ];

  leadsMigrations.forEach(({ column, type }) => {
    try {
      db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${type}`);
      logger.info(`✅ Added column: leads.${column}`);
    } catch (err) {
      // Column already exists, ignore
    }
  });

  // Users table migrations
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

  // Inquiries table migrations
  try {
    db.exec('ALTER TABLE inquiries ADD COLUMN ip TEXT');
    logger.info('✅ Added column: inquiries.ip');
  } catch (err) {
    // Column already exists
  }

  logger.info('✅ Migrations completed');
}

module.exports = {
  runMigrations
};
