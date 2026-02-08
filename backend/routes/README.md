# Backend Routes

This directory contains all Express route handlers extracted from the monolithic `index.js`.

## Route Files

### 🔐 auth.js (✅ Complete)
**Authentication & Registration Routes**
- `POST /login` - User authentication with bcrypt
- `POST /logout` - Session destruction  
- `GET /signup`, `POST /signup` - User registration
- `GET /api/me` - Current user info

### 🔧 scrape.js
**Scraping Control Routes**
- `POST /api/scrape/now` - Trigger manual scraping for all user sources
- `POST /api/scrape/stop` - Stop ongoing scraping
- `GET /api/scrape/progress` - Get scraping progress
- `POST /api/scrape/:id` - Scrape a single source by ID

**Dependencies:** Requires `scrapeForUser()` function (will be in services/scraper in Phase 5)

### 📊 leads.js
**Lead Management Routes**
- `GET /api/leads` - Fetch leads from all user sources (supports filtering by source_id, search query, date range)
- `GET /api/leads.raw` - Legacy raw array response from main leads table
- `DELETE /api/leads/clear` - Clear all leads for current user

**Features:** Dynamic table querying, search across all text columns, date filtering

### 🌐 sources.js
**Source CRUD Operations**
- `GET /api/sources` - Get all unique source names
- `GET /api/sources/mine` - Get user's configured sources
- `GET /api/sources/:id` - Get specific source by ID
- `POST /api/sources/add` - Add new source
- `PUT /api/sources/:id` - Update source
- `DELETE /api/sources/:id` - Delete source
- `GET /api/sources/:id/sample` - Get sample data for field mapping
- `POST /api/sources/:id/mappings` - Save field mappings

**Aliases (backward compatibility):**
- `GET /api/my-sources`
- `POST /api/my-sources`
- `PUT /api/my-sources/:id`
- `DELETE /api/my-sources/:id`

**Dependencies:** Requires `createSourceTable()`, `createNotification()`, `loadSources()`, `scrapeForUser()` functions

### 📸 screenshots.js
**Screenshot Viewer Routes**
- `GET /api/screenshots` - List all screenshots with metadata
- `GET /api/screenshots/view/:filename` - View screenshot
- `GET /api/screenshots/download/:filename` - Download screenshot
- `DELETE /api/screenshots/:filename` - Delete screenshot

**Security:** Includes directory traversal protection, requires authentication

### 👤 profile.js
**User Profile Routes**
- `GET /api/profile` - Get current user's profile
- `PUT /api/profile` - Update profile (company_name, phone, website)

**Note:** Username and email cannot be changed via profile update

### 👮 admin.js
**Admin-Only Routes**
- `GET /api/admin/users` - Get all users
- `GET /api/admin/sources/:userId` - Get sources for specific user
- `POST /api/admin/sources/:userId` - Add source for any user
- `DELETE /api/admin/sources/:userId/:sourceId` - Delete source for any user

**Authorization:** All routes require admin role

### 📈 stats.js
**Statistics & Notifications**
- `GET /api/stats` - Dashboard statistics (totalLeads, activeSources, recentLeads, leadsBySource)
- `GET /api/metrics` - Detailed metrics with recent activity charts
- `GET /api/notifications` - Get notifications for current user
- `POST /api/notifications/:id/read` - Mark notification as read
- `POST /api/notifications/mark-all-read` - Mark all notifications as read

## Architecture Notes

### Temporary Dependencies
Some routes reference functions that will be extracted in Phase 5 (Services):
- `scrapeForUser()` - Main scraping orchestrator (→ services/scraper/)
- `createSourceTable()` - Dynamic table creation (→ services/db/)
- `createNotification()` - Notification system (→ services/notifications/)
- `loadSources()` - Source loading (→ services/sources/)

These are temporarily referenced from parent context (index.js) until Phase 5 extraction.

### Middleware Usage
- `requireAuth` - from middleware/auth.js (user authentication)
- `requireAdmin` - from middleware/auth.js (admin authorization)
- `express.json()` - Body parser for POST/PUT routes

### Database Access
All routes use promisified database wrappers:
- `dbGet()` - Single row query
- `dbAll()` - Multiple rows query
- `dbRun()` - INSERT/UPDATE/DELETE operations
- `db` - Direct better-sqlite3 instance for prepared statements

## Integration

Each route file exports an Express Router that can be mounted in index.js:

```javascript
const authRoutes = require('./routes/auth');
const scrapeRoutes = require('./routes/scrape');
const leadsRoutes = require('./routes/leads');
const sourcesRoutes = require('./routes/sources');
const screenshotsRoutes = require('./routes/screenshots');
const profileRoutes = require('./routes/profile');
const adminRoutes = require('./routes/admin');
const statsRoutes = require('./routes/stats');

app.use('/api/auth', authRoutes);
app.use('/api/scrape', scrapeRoutes.router);
app.use('/api/leads', leadsRoutes);
app.use('/api/sources', sourcesRoutes.router);
app.use('/api/screenshots', screenshotsRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/admin', adminRoutes.router);
app.use('/api', statsRoutes); // stats, metrics, notifications
```

## Progress

✅ **Phase 4: Routes Extraction Complete** (8/8 route files)
- [x] auth.js - Authentication routes
- [x] scrape.js - Scraping control
- [x] leads.js - Lead management
- [x] sources.js - Source CRUD
- [x] screenshots.js - Screenshot viewer
- [x] profile.js - User profiles
- [x] admin.js - Admin operations
- [x] stats.js - Statistics & notifications

**Next:** Phase 5 - Extract services layer (scraper, AI, leads, scheduler)
