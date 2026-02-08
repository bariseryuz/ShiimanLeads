const bcrypt = require('bcrypt');
const { dbGet, dbAll, dbRun } = require('../db');
const logger = require('../utils/logger');

/**
 * User Model
 * Handles user authentication and management
 */
class User {
  /**
   * Find user by ID
   * @param {number} id - User ID
   * @returns {Promise<Object|null>} User object or null
   */
  static async findById(id) {
    return await dbGet('SELECT id, username, email, role, company_name, phone, website FROM users WHERE id = ?', [id]);
  }

  /**
   * Find user by username
   * @param {string} username - Username
   * @returns {Promise<Object|null>} User object or null
   */
  static async findByUsername(username) {
    return await dbGet('SELECT * FROM users WHERE username = ?', [username]);
  }

  /**
   * Find user by email
   * @param {string} email - Email address
   * @returns {Promise<Object|null>} User object or null
   */
  static async findByEmail(email) {
    return await dbGet('SELECT * FROM users WHERE email = ?', [email]);
  }

  /**
   * Get all users
   * @returns {Promise<Array>} Array of users
   */
  static async findAll() {
    return await dbAll('SELECT id, username, email, role, company_name, phone, website FROM users');
  }

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @param {string} userData.username - Username
   * @param {string} userData.password - Plain text password (will be hashed)
   * @param {string} userData.email - Email address
   * @param {string} userData.role - User role ('admin' or 'user')
   * @returns {Promise<Object>} Created user object
   */
  static async create({ username, password, email, role = 'user' }) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await dbRun(
      'INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)',
      [username, hashedPassword, email, role]
    );
    return await User.findById(result.lastInsertRowid);
  }

  /**
   * Verify user password
   * @param {string} username - Username
   * @param {string} password - Plain text password
   * @returns {Promise<Object|null>} User object if password is correct, null otherwise
   */
  static async verifyPassword(username, password) {
    const user = await User.findByUsername(username);
    if (!user) return null;
    
    const match = await bcrypt.compare(password, user.password);
    if (!match) return null;
    
    // Return user without password field
    delete user.password;
    return user;
  }

  /**
   * Update user profile
   * @param {number} id - User ID
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>} Updated user object
   */
  static async update(id, updates) {
    const allowedFields = ['email', 'company_name', 'phone', 'website'];
    const fields = Object.keys(updates).filter(k => allowedFields.includes(k));
    
    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }
    
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    values.push(id);
    
    await dbRun(`UPDATE users SET ${setClause} WHERE id = ?`, values);
    return await User.findById(id);
  }

  /**
   * Update user password
   * @param {number} id - User ID
   * @param {string} newPassword - New plain text password
   * @returns {Promise<boolean>} True if successful
   */
  static async updatePassword(id, newPassword) {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, id]);
    logger.info(`Password updated for user ID ${id}`);
    return true;
  }

  /**
   * Delete user (admin only)
   * @param {number} id - User ID
   * @returns {Promise<boolean>} True if successful
   */
  static async delete(id) {
    // Don't allow deleting the last admin
    const admins = await dbAll('SELECT id FROM users WHERE role = ?', ['admin']);
    const user = await User.findById(id);
    
    if (user.role === 'admin' && admins.length === 1) {
      throw new Error('Cannot delete the last admin user');
    }
    
    await dbRun('DELETE FROM users WHERE id = ?', [id]);
    logger.info(`User ${id} deleted`);
    return true;
  }

  /**
   * Count total users
   * @returns {Promise<number>} Total user count
   */
  static async count() {
    const result = await dbGet('SELECT COUNT(*) as count FROM users');
    return result.count;
  }
}

module.exports = User;
