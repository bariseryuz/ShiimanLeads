const express = require('express');
const router = express.Router();

/** RFC 9116 — mount under app.use('/.well-known', router) */
router.get('/security.txt', (req, res) => {
  res.type('text/plain; charset=utf-8');
  const contact = process.env.SECURITY_CONTACT_EMAIL || process.env.SMTP_USER || 'security@example.com';
  const policy = process.env.SECURITY_POLICY_URL || '/terms.html';
  const appUrl = (process.env.APP_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
  res.send(
    `Contact: mailto:${contact}\n` +
      `Preferred-Languages: en\n` +
      `Policy: ${appUrl}${policy}\n`
  );
});

module.exports = router;
