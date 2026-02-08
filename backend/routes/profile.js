const express = require('express');
const router = express.Router();
const { db, dbRun } = require('../db');
const logger = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');

/**
 * GET /api/profile
 * Get current user's profile
 */
router.get('/', requireAuth, (req, res) => {
  if (!req.session || !req.session.user) {
    logger.error('❌ Profile request - No session or user');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  logger.info(`📋 Fetching profile for user ID: ${req.session.user.id}`);
  
  try {
    if (!db) {
      logger.error('❌ Database is null');
      return res.status(500).json({ error: 'Database not initialized' });
    }
    
    const user = db.prepare('SELECT id, username, email, company_name, phone, website, created_at FROM users WHERE id = ?').get(req.session.user.id);
    
    if (!user) {
      logger.error(`❌ User not found in database: ${req.session.user.id}`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    logger.info(`✅ Profile loaded for: ${user.username}`);
    res.json(user);
  } catch (error) {
    logger.error(`❌ Error fetching profile: ${error.message}`);
    logger.error(`❌ Stack trace: ${error.stack}`);
    res.status(500).json({ error: 'Failed to fetch profile: ' + error.message });
  }
});

/**
 * PUT /api/profile
 * Update current user's profile
 */
router.put('/', requireAuth, express.json(), async (req, res) => {
  if (!req.session || !req.session.user) {
    logger.error('❌ Profile update - No session or user');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const userId = req.session.user.id;
  const { company_name, phone, website } = req.body;
  
  logger.info(`📝 Updating profile for user ID: ${userId}`);
  logger.info(`📝 Data: company_name="${company_name}", phone="${phone}", website="${website}"`);
  
  try {
    if (!db) {
      logger.error('❌ Database is null');
      return res.status(500).json({ error: 'Database not initialized' });
    }
    
    // Update profile fields (username and email cannot be changed via profile update)
    await dbRun(
      'UPDATE users SET company_name = ?, phone = ?, website = ? WHERE id = ?',
      [company_name || null, phone || null, website || null, userId]
    );
    
    // Fetch updated user data
    const user = db.prepare('SELECT id, username, email, company_name, phone, website, created_at FROM users WHERE id = ?').get(userId);
    
    if (!user) {
      logger.error(`❌ User not found after update: ${userId}`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    logger.info(`✅ Profile updated successfully for: ${user.username}`);
    res.json({ success: true, user });
  } catch (error) {
    logger.error(`❌ Error updating profile: ${error.message}`);
    logger.error(`❌ Stack trace: ${error.stack}`);
    res.status(500).json({ error: 'Failed to update profile: ' + error.message });
  }
});

module.exports = router;
