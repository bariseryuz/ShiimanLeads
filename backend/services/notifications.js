const { dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * Create a notification for a user
 * @param {number} userId - User ID
 * @param {string} type - Notification type (e.g., 'source_added', 'scrape_complete')
 * @param {string} message - Notification message
 */
async function createNotification(userId, type, message) {
  try {
    await dbRun(
      'INSERT INTO notifications (user_id, type, message, created_at, is_read) VALUES (?, ?, ?, ?, 0)',
      [userId, type, message, new Date().toISOString()]
    );
    logger.info(`📬 Notification created for user ${userId}: ${message}`);
  } catch (e) {
    logger.error(`Failed to create notification: ${e.message}`);
  }
}

module.exports = { createNotification };
