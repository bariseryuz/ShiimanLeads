# 📊 Models

Data access layer for the application. Provides a clean interface to interact with the database.

## 📁 Structure

```
models/
├── index.js      - Central export for all models
├── User.js       - User authentication and management
├── Source.js     - Source configuration management
└── Lead.js       - Lead data access and queries
```

## 🎯 Models

### User.js

User authentication and profile management.

**Methods:**
- `findById(id)` - Find user by ID
- `findByUsername(username)` - Find user by username
- `findByEmail(email)` - Find user by email
- `findAll()` - Get all users
- `create({ username, password, email, role })` - Create new user (hashes password)
- `verifyPassword(username, password)` - Verify login credentials
- `update(id, updates)` - Update user profile (email, company_name, phone, website)
- `updatePassword(id, newPassword)` - Update password (hashes)
- `delete(id)` - Delete user (prevents deleting last admin)
- `count()` - Count total users

**Example:**
```javascript
const { User } = require('./models');

// Create user
const user = await User.create({
  username: 'john',
  password: 'secret123',
  email: 'john@example.com',
  role: 'user'
});

// Verify login
const authenticatedUser = await User.verifyPassword('john', 'secret123');
if (authenticatedUser) {
  console.log('Login successful');
}

// Update profile
await User.update(user.id, {
  company_name: 'ACME Corp',
  phone: '555-1234'
});
```

### Source.js

Source configuration and management.

**Methods:**
- `findById(id)` - Find source by ID (returns parsed JSON)
- `findByUserId(userId)` - Get all sources for a user
- `create(userId, sourceData)` - Create new source
- `update(id, sourceData)` - Update source configuration
- `delete(id)` - Delete source
- `getReliability(sourceId)` - Get reliability stats for source
- `getUserSourcesReliability(userId)` - Get all sources with reliability stats
- `countByUserId(userId)` - Count sources for user
- `validate(sourceData)` - Validate source configuration

**Example:**
```javascript
const { Source } = require('./models');

// Create source
const source = await Source.create(userId, {
  name: 'Phoenix Permits',
  url: 'https://phoenix.gov/permits',
  usePuppeteer: true,
  useAI: true,
  requestsPerMinute: 10,
  fieldSchema: ['permit_number', 'address', 'contractor_name']
});

// Validate before creating
const validation = Source.validate(sourceData);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}

// Get sources with reliability
const sourcesWithStats = await Source.getUserSourcesReliability(userId);
sourcesWithStats.forEach(s => {
  console.log(`${s.name}: ${s.reliability?.confidence_score}% reliable`);
});
```

### Lead.js

Lead data access and queries.

**Methods:**
- `findById(id)` - Find lead by ID
- `findByUserId(userId, options)` - Find leads with filters and pagination
  - Options: `limit`, `offset`, `newOnly`, `source`, `orderBy`, `order`
- `findBySourceTable(sourceId, options)` - Get leads from source-specific table
- `countByUserId(userId, options)` - Count leads (with filters)
- `markAllAsRead(userId)` - Mark all leads as read
- `deleteAllByUserId(userId)` - Delete all leads for user
- `delete(id)` - Delete single lead
- `getStats(userId)` - Get statistics (total, new, by source, last 30 days)
- `search(userId, keyword, options)` - Search leads by keyword
- `exists(hash, userId)` - Check if lead exists (for deduplication)
- `getUniqueSources(userId)` - Get list of unique source names

**Example:**
```javascript
const { Lead } = require('./models');

// Get new leads with pagination
const newLeads = await Lead.findByUserId(userId, {
  newOnly: true,
  limit: 50,
  offset: 0,
  orderBy: 'date_added',
  order: 'DESC'
});

// Get statistics
const stats = await Lead.getStats(userId);
console.log(`Total: ${stats.total}, New: ${stats.newCount}`);
console.log('By source:', stats.bySource);

// Search leads
const results = await Lead.search(userId, 'construction', { limit: 20 });

// Check if lead exists (deduplication)
const leadHash = generateLeadHash(leadData);
const exists = await Lead.exists(leadHash, userId);
if (!exists) {
  // Insert new lead
}
```

## 🔧 Usage Patterns

### Import models:
```javascript
// Import all models
const { User, Source, Lead } = require('./models');

// Or import individually
const User = require('./models/User');
```

### Error handling:
```javascript
try {
  const user = await User.create({ username: 'test', ... });
} catch (error) {
  console.error('Failed to create user:', error.message);
}
```

### Transactions:
Models use the database layer's transaction support:
```javascript
const { db } = require('./db');

// Manual transaction
db.transaction(() => {
  User.create({ ... });
  Source.create(userId, { ... });
})();
```

## 📋 Database Schema Reference

### users table:
- id (INTEGER PRIMARY KEY)
- username (TEXT UNIQUE)
- password (TEXT) - bcrypt hashed
- email (TEXT UNIQUE)
- role (TEXT) - 'admin' or 'user'
- company_name (TEXT)
- phone (TEXT)
- website (TEXT)

### user_sources table:
- id (INTEGER PRIMARY KEY)
- user_id (INTEGER)
- source_data (TEXT) - JSON string

### leads table:
- id (INTEGER PRIMARY KEY)
- user_id (INTEGER)
- source (TEXT)
- permit_number (TEXT)
- address (TEXT)
- value (TEXT)
- description (TEXT)
- phone (TEXT)
- email (TEXT)
- company_name (TEXT)
- page_url (TEXT)
- date_added (DATETIME)
- is_new (INTEGER) - 0 or 1
- dedup_hash (TEXT)
- extracted_data (TEXT) - JSON string
- raw (TEXT)
- ... (36 total columns for various lead types)

### source_reliability table:
- id (INTEGER PRIMARY KEY)
- source_id (INTEGER)
- source_name (TEXT)
- total_scrapes (INTEGER)
- successful_scrapes (INTEGER)
- failed_scrapes (INTEGER)
- total_leads_found (INTEGER)
- average_leads_per_scrape (REAL)
- last_scrape_at (DATETIME)
- last_success_at (DATETIME)
- confidence_score (REAL) - 0-100

## 🔗 Dependencies

- **Database**: db/index.js (dbGet, dbAll, dbRun)
- **Utils**: logger.js, services/leadInsertion.js (generateLeadHash)
- **External**: bcrypt (password hashing)

---

**Status**: ✅ Complete - All models extracted and documented
