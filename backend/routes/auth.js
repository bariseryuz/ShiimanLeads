const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { dbGet, dbRun } = require('../db');
const logger = require('../utils/logger');
const router = express.Router();

// GET /login - Serve login page
router.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../frontend/login.html'));
});

// POST /login - Handle login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    logger.info(`🔐 Login attempt: username="${username}"`);
    
    if (!username || !password) {
      logger.warn(`⚠️ Missing credentials in login request`);
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [String(username)]);
    
    if (!user) {
      logger.warn(`❌ User not found: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    logger.info(`👤 User found: ${user.username} (ID: ${user.id}, Role: ${user.role})`);
    
    let passwordValid = false;
    try {
      passwordValid = await bcrypt.compare(String(password), user.password_hash || '');
    } catch (bcryptErr) {
      logger.error(`❌ Bcrypt error: ${bcryptErr.message}`);
      return res.status(500).json({ error: 'Authentication error' });
    }
    
    if (!passwordValid) {
      logger.warn(`❌ Wrong password for user: ${username}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    logger.info(`✅ Password correct for user: ${user.username}`);
    
    const sessionData = {
      id: user.id,
      username: user.username,
      role: user.role
    };
    
    logger.info(`📝 Setting session.user: ${JSON.stringify(sessionData)}`);
    req.session.user = sessionData;
    
    req.session.save((err) => {
      if (err) {
        logger.error(`❌ Session save error: ${err.message}`);
        return res.status(500).json({ error: 'Session save failed' });
      }
      
      logger.info(`✅ Session saved! User ${user.username} logged in.`);
      
      res.json({ 
        success: true, 
        redirect: '/client-portal.html',
        user: { 
          id: user.id,
          username: user.username, 
          email: user.email,
          role: user.role,
          name: user.username
        }
      });
    });
    
  } catch (e) {
    logger.error(`💥 Login error: ${e.message}`);
    logger.error(e.stack);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

// POST /logout - Handle logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// GET /signup - Serve signup page
router.get('/signup', (req, res) => {
  if (req.session?.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../../frontend/signup.html'));
});

// POST /signup - Handle signup
router.post('/signup', async (req, res) => {
  const { username, email, password, confirmPassword } = req.body || {};
  try {
    const trimmedUsername = String(username || '').trim();
    const trimmedEmail = String(email || '').trim().toLowerCase();
    const trimmedPassword = String(password || '').trim();
    const trimmedConfirmPassword = String(confirmPassword || '').trim();
    
    if (!trimmedUsername || !trimmedEmail || !trimmedPassword) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (trimmedPassword !== trimmedConfirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    
    const existing = await dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [trimmedUsername, trimmedEmail]);
    if (existing) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(trimmedPassword, 10);
    
    await dbRun('INSERT INTO users (username, email, password_hash, role, created_at, email_verified, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?)', 
      [trimmedUsername, trimmedEmail, hash, 'client', new Date().toISOString(), 1, verificationToken]); // Auto-verified
    
    logger.info(`✅ User created: ${trimmedUsername}`);
    res.json({ success: true, message: 'Account created! You can login now.', redirect: '/login.html' });
    
  } catch (e) {
    logger.error(`Signup error: ${e.message}`);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// GET /api/me - Get current user info
router.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.session.user });
});

module.exports = router;
