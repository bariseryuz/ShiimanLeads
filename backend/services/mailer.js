/**
 * Send email to a specific recipient (for user alerts). Uses same SMTP as app.
 */
let mailTransport = null;

function getMailTransport() {
  if (mailTransport) return mailTransport;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nodemailer = require('nodemailer');
      mailTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
    } catch (e) {
      return null;
    }
  }
  return mailTransport;
}

async function sendMail(to, subject, text) {
  const transport = getMailTransport();
  if (!transport) return false;
  try {
    await transport.sendMail({
      from: `Shiiman Leads <${process.env.SMTP_USER}>`,
      to,
      subject,
      text
    });
    return true;
  } catch (err) {
    require('../utils/logger').warn('Mail send failed: ' + err.message);
    return false;
  }
}

module.exports = { getMailTransport, sendMail };
