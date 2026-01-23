const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { DB_PATH } = require('./db-path');

(async () => {
  const [,, username, newPassword] = process.argv;
  if (!username || !newPassword) {
    console.log('Usage: node reset-password.js <username> <newPassword>');
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      console.error(`User not found: ${username}`);
      process.exit(1);
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    const stmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
    const info = stmt.run(hash, user.id);
    console.log(`✅ Password updated for user '${username}' (rows changed: ${info.changes})`);
  } catch (e) {
    console.error('Error updating password:', e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();
