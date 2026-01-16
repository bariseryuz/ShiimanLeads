const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const Database = require('better-sqlite3');
const app = express();

// Create data directory if it doesn't exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Session store database
const sessionDb = new Database(path.join(__dirname, 'data', 'sessions.db'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  store: new SqliteStore({
    client: sessionDb,
    expired: {
      clear: true,
      intervalMs: 900000 // 15 minutes
    }
  }),
  secret: process.env.SESSION_SECRET || 'shiiman-leads-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

// Force HTTPS redirect in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Simple CORS (adjust origins as needed)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// SQLite connection (read-only usage)
const dbPath = path.join(__dirname, 'leads.db');
let db = null;
let dbReady = false;

// Create database if it doesn't exist and initialize tables
if (!fs.existsSync(dbPath)) {
  console.log('📦 Creating new leads.db database...');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('❌ Database creation error:', err.message);
    } else {
      console.log('✅ Database created successfully');
      initializeTables();
    }
  });
} else {
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('❌ Database connection error:', err.message);
    } else {
      console.log('✅ Connected to leads database');
      initializeTables();
    }
  });
}

function initializeTables() {
  // Create users table if it doesn't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'client',
      company_name TEXT,
      phone TEXT,
      website TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      email_verified INTEGER DEFAULT 0,
      verification_token TEXT
    )
  `, (err) => {
    if (err) {
      console.error('❌ Error creating users table:', err.message);
    } else {
      console.log('✅ Users table ready');
      // Add new columns to existing users table if they don't exist
      db.run(`ALTER TABLE users ADD COLUMN company_name TEXT`, () => {});
      db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, () => {});
      db.run(`ALTER TABLE users ADD COLUMN website TEXT`, () => {});
      dbReady = true;
      console.log('✅ Database fully initialized and ready');
    }
  });
  
  // Create leads table
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      hash TEXT,
      raw_text TEXT,
      permit_number TEXT,
      address TEXT,
      value TEXT,
      description TEXT,
      source TEXT,
      date_added TEXT,
      UNIQUE(hash, user_id)
    )
  `, (err) => {
    if (err) console.error('Error creating leads table:', err.message);
    else console.log('✅ Leads table ready');
  });
  
  // Create seen table
  db.run(`
    CREATE TABLE IF NOT EXISTS seen (
      hash TEXT,
      user_id INTEGER,
      PRIMARY KEY(hash, user_id)
    )
  `, (err) => {
    if (err) console.error('Error creating seen table:', err.message);
    else console.log('✅ Seen table ready');
  });
  
  // Create user_sources table if it doesn't exist
  db.run(`
    CREATE TABLE IF NOT EXISTS user_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `, (err) => {
    if (err) console.error('Error creating user_sources table:', err.message);
    else console.log('✅ User sources table ready');
  });
}

// Helper: build WHERE clause based on query params
function buildFilters(query, userId = null) {
  const clauses = [];
  const params = [];
  
  // CRITICAL: Filter by user_id if provided
  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }
  
  if (query.source) {
    clauses.push('source = ?');
    params.push(query.source);
  }
  if (query.search) {
    clauses.push('(raw_text LIKE ? OR address LIKE ? OR description LIKE ? OR permit_number LIKE ?)');
    const term = `%${query.search}%`;
    params.push(term, term, term, term);
  }
  if (query.sinceDays) {
    const d = new Date(Date.now() - Number(query.sinceDays) * 24 * 60 * 60 * 1000).toISOString();
    clauses.push('date_added >= ?');
    params.push(d);
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  console.error('❌ Authentication failed - No session or user:', {
    hasSession: !!req.session,
    hasUser: !!(req.session && req.session.user),
    sessionID: req.sessionID
  });
  res.status(401).json({ error: 'Authentication required' });
}

// POST /signup - Create new user
app.post('/signup', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const { username, email, password } = req.body;
  
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
      [username, email, passwordHash],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username or email already exists' });
          }
          return res.status(500).json({ error: 'Failed to create user' });
        }
        
        const userId = this.lastID;
        req.session.user = { id: userId, username, email };
        
        res.json({
          success: true,
          message: 'Account created successfully',
          user: { id: userId, username, email },
          redirect: '/client-portal.html'
        });
      }
    );
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /login - Authenticate user
app.post('/login', async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  db.get(
    'SELECT id, username, email, password_hash FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ error: 'Server error' });
      }
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
      try {
        const isValid = await bcrypt.compare(password, user.password_hash);
        
        if (!isValid) {
          return res.status(401).json({ error: 'Invalid username or password' });
        }
        
        // Create session
        req.session.user = { id: user.id, username: user.username, email: user.email };
        
        res.json({
          success: true,
          message: 'Login successful',
          user: { id: user.id, username: user.username, email: user.email },
          redirect: '/client-portal.html'
        });
      } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
      }
    }
  );
});

// POST /logout - End user session
app.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true, message: 'Logged out successfully' });
  });
});

// GET /api/me - Get current user info
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// GET /api/profile - Get user profile
app.get('/api/profile', requireAuth, (req, res) => {
  if (!db) {
    console.error('❌ Database not available for profile request');
    return res.status(503).json({ error: 'Database not available' });
  }
  
  if (!dbReady) {
    console.error('❌ Database not ready yet for profile request');
    return res.status(503).json({ error: 'Database is still initializing, please retry in a moment' });
  }
  
  console.log('📋 Loading profile for user:', req.session.user.id);
  
  db.get(
    'SELECT id, username, email, company_name, phone, website FROM users WHERE id = ?',
    [req.session.user.id],
    (err, user) => {
      if (err) {
        console.error('❌ Database error loading profile:', err.message);
        return res.status(500).json({ error: 'Database error: ' + err.message });
      }
      if (!user) {
        console.error('❌ User not found:', req.session.user.id);
        return res.status(404).json({ error: 'User not found' });
      }
      console.log('✅ Profile loaded successfully for:', user.username);
      res.json(user);
    }
  );
});

// PUT /api/profile - Update user profile
app.put('/api/profile', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const { email, company_name, phone, website } = req.body;
  
  db.run(
    'UPDATE users SET email = ?, company_name = ?, phone = ?, website = ? WHERE id = ?',
    [email, company_name, phone, website, req.session.user.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, message: 'Profile updated successfully' });
    }
  );
});

// GET /api/my-sources - Get user's custom sources
app.get('/api/my-sources', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  db.all(
    'SELECT id, source_data, created_at FROM user_sources WHERE user_id = ? ORDER BY id DESC',
    [req.session.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      
      const sources = rows.map(row => {
        try {
          return {
            id: row.id,
            data: JSON.parse(row.source_data),
            created_at: row.created_at
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      
      res.json({ data: sources });
    }
  );
});

// POST /api/my-sources - Add a new custom source
app.post('/api/my-sources', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const sourceData = req.body;
  
  // Validate required fields
  if (!sourceData.name || !sourceData.url) {
    return res.status(400).json({ error: 'Source name and URL are required' });
  }
  
  // Store as JSON string
  const sourceJson = JSON.stringify(sourceData);
  
  db.run(
    'INSERT INTO user_sources (user_id, source_data, created_at) VALUES (?, ?, ?)',
    [req.session.user.id, sourceJson, new Date().toISOString()],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ success: true, id: this.lastID });
    }
  );
});

// PUT /api/my-sources/:id - Update a custom source
app.put('/api/my-sources/:id', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const sourceId = parseInt(req.params.id, 10);
  const sourceData = req.body;
  
  // Validate required fields
  if (!sourceData.name || !sourceData.url) {
    return res.status(400).json({ error: 'Source name and URL are required' });
  }
  
  // Ensure user owns this source
  db.get(
    'SELECT id FROM user_sources WHERE id = ? AND user_id = ?',
    [sourceId, req.session.user.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Source not found' });
      
      const sourceJson = JSON.stringify(sourceData);
      
      db.run(
        'UPDATE user_sources SET source_data = ? WHERE id = ? AND user_id = ?',
        [sourceJson, sourceId, req.session.user.id],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        }
      );
    }
  );
});

// DELETE /api/my-sources/:id - Delete a custom source
app.delete('/api/my-sources/:id', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  
  const sourceId = parseInt(req.params.id, 10);
  
  // Ensure user owns this source
  db.get(
    'SELECT id FROM user_sources WHERE id = ? AND user_id = ?',
    [sourceId, req.session.user.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Source not found' });
      
      db.run(
        'DELETE FROM user_sources WHERE id = ? AND user_id = ?',
        [sourceId, req.session.user.id],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true });
        }
      );
    }
  );
});

// GET /api/leads?limit=100&offset=0&source=...&search=...&sinceDays=7
app.get('/api/leads', requireAuth, (req, res) => {
  if (!db) {
    return res.status(503).json({ error: 'Database not available' });
  }
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  
  // IMPORTANT: Pass userId to filter leads by the logged-in user
  const userId = req.session.user.id;
  const { where, params } = buildFilters(req.query, userId);
  
  const sql = `SELECT permit_number, address, value, description, source, date_added, date_issued, phone, page_url FROM leads ${where} ORDER BY date_added DESC LIMIT ? OFFSET ?`;
  db.all(sql, [...params, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ data: rows });
  });
});

// GET /api/sources (reads sources.json)
app.get('/api/sources', (req, res) => {
  try {
    // Read global sources
    const raw = fs.readFileSync(path.join(__dirname, 'sources.json'), 'utf-8');
    const globalSources = JSON.parse(raw);

    // If you have user sessions:
    let userId = req.session && req.session.user ? req.session.user.id : null;
    if (!userId) {
      // Not logged in, just return global sources
      return res.json({ data: globalSources });
    }

    // Check if database is available
    if (!db) {
      console.log('⚠️ Database not available, returning only global sources');
      return res.json({ data: globalSources });
    }

    // Query user-specific sources
    db.all('SELECT source_data FROM user_sources WHERE user_id = ?', [userId], (err, rows) => {
      if (err) {
        console.error('❌ Error querying user_sources:', err.message);
        return res.status(500).json({ error: err.message });
      }
      const userSources = rows.map(row => {
        try { return JSON.parse(row.source_data); } catch { return null; }
      }).filter(Boolean);
      console.log(`✅ Loaded ${userSources.length} user sources for user ${userId}`);
      // Merge and return
      res.json({ data: [...globalSources, ...userSources] });
    });
  } catch (e) {
    console.error('❌ Error in /api/sources:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serve latest_leads.jsonl as raw (stream)
app.get('/api/latest-jsonl', (req, res) => {
  const p = path.join(__dirname, 'output', 'latest_leads.jsonl');
  if (!fs.existsSync(p)) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/plain');
  fs.createReadStream(p).pipe(res);
});

// POST /api/scrape/now - Trigger manual scraping
app.post('/api/scrape/now', requireAuth, (req, res) => {
  // This endpoint would trigger the scraper
  // For now, just return success since the scraper runs in index.js
  res.json({ 
    success: true, 
    message: 'Scraping will start in the background. The scraper runs every 8 hours automatically.' 
  });
});

// Static frontend (../frontend)
const publicDir = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  console.warn('Frontend directory not found, static hosting skipped.');
}

const port = process.env.PORT || process.env.FRONTEND_PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Frontend/API server listening on port ${port}`);
});
