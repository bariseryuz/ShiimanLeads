const session = require('express-session');
const config = require('../config/environment');

/**
 * Session configuration middleware
 */
const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: config.NODE_ENV === 'production'
  }
});

/**
 * Authentication middleware - requires user to be logged in
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.id) {
    return res.status(401).json({ error: 'Unauthorized - Please log in' });
  }
  next();
}

/**
 * Admin authentication middleware - requires admin role
 */
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.id) {
    return res.status(401).json({ error: 'Unauthorized - Please log in' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden - Admin access required' });
  }
  next();
}

/**
 * Attach user info to request object
 */
async function attachUser(req, res, next) {
  if (req.session && req.session.user && req.session.user.id) {
    try {
      const { dbGet } = require('../db');
      const user = await dbGet('SELECT id, username, email, role FROM users WHERE id = ?', [req.session.user.id]);
      if (!user) {
        // Stale session user - clear session
        req.session.destroy(() => {});
        req.user = null;
      } else {
        req.user = user;
      }
    } catch (err) {
      req.user = null;
    }
  }
  next();
}

module.exports = {
  sessionMiddleware,
  requireAuth,
  requireAdmin,
  attachUser
};
