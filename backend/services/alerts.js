const { dbGet, dbRun, dbAll } = require('../db');
const logger = require('../utils/logger');
const { sendMail } = require('./mailer');
const axios = require('axios');
const {
  buildHotLeadCard,
  slackHotLeadMessage,
  discordHotLeadEmbed
} = require('./hotLeadPayload');

async function ensureNotificationSettings(userId) {
  await dbRun(
    `INSERT OR IGNORE INTO notification_settings (user_id) VALUES (?)`,
    [userId]
  );
  return dbGet('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);
}

async function getNotificationSettings(userId) {
  const row = await dbGet('SELECT * FROM notification_settings WHERE user_id = ?', [userId]);
  return row || await ensureNotificationSettings(userId);
}

/**
 * Called when a new lead is inserted. Sends instant email and/or webhook/Slack if enabled.
 */
async function onNewLead({ userId, sourceName, leadCount = 1, leadPreview }) {
  try {
    const settings = await getNotificationSettings(userId);
    if (!settings) return;

    const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
    const toEmail = user?.email;
    const appName = process.env.APP_NAME || 'Shiiman Leads';

    if (settings.instant_email_enabled && toEmail) {
      const subject = `[${appName}] New lead${leadCount > 1 ? 's' : ''} from ${sourceName}`;
      const text = `You have ${leadCount} new lead(s) from source "${sourceName}".\n\n${leadPreview || 'View your dashboard for details.'}\n\n— ${appName}`;
      await sendMail(toEmail, subject, text);
    }

    const webhookUrl = settings.webhook_url || settings.slack_webhook_url;
    if ((settings.webhook_enabled || settings.slack_webhook_url) && webhookUrl) {
      const payload = settings.slack_webhook_url
        ? { text: `New lead${leadCount > 1 ? 's' : ''} from *${sourceName}* (${leadCount}). ${leadPreview || ''}` }
        : { event: 'new_lead', userId, sourceName, leadCount, leadPreview };
      try {
        await axios.post(webhookUrl, payload, { timeout: 5000 });
      } catch (e) {
        logger.warn(`Alert webhook failed: ${e.message}`);
      }
    }
  } catch (e) {
    logger.error(`Alerts onNewLead error: ${e.message}`);
  }
}

/**
 * Send digest of new leads since last_digest_sent_at. Called by cron.
 */
async function runDigestForUser(userId) {
  try {
    const settings = await getNotificationSettings(userId);
    if (!settings || !settings.digest_email_enabled) return;
    const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
    if (!user?.email) return;

    const since = settings.last_digest_sent_at || new Date(0).toISOString();
    const rows = await dbAll(
      `SELECT id, source_name, raw_data, created_at FROM leads WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 100`,
      [userId, since]
    );
    if (rows.length === 0) return;

    const bySource = {};
    rows.forEach(r => {
      bySource[r.source_name] = (bySource[r.source_name] || 0) + 1;
    });
    const summary = Object.entries(bySource).map(([name, c]) => `${name}: ${c}`).join('\n');
    const subject = `[Shiiman Leads] Digest: ${rows.length} new lead(s)`;
    const text = `Your lead digest:\n\n${rows.length} new lead(s) since last digest.\n\nBy source:\n${summary}\n\nLog in to your dashboard to view them.`;
    await sendMail(user.email, subject, text);
    await dbRun('UPDATE notification_settings SET last_digest_sent_at = ? WHERE user_id = ?', [new Date().toISOString(), userId]);
  } catch (e) {
    logger.error(`Digest for user ${userId} error: ${e.message}`);
  }
}

/**
 * Run digest for all users who are due (daily or weekly based on digest_frequency).
 */
async function runDigestForAllDue() {
  const now = new Date();
  const rows = await dbAll('SELECT user_id, digest_frequency, last_digest_sent_at, digest_email_enabled FROM notification_settings WHERE digest_email_enabled = 1');
  for (const row of rows) {
    if (row.digest_frequency === 'weekly') {
      const last = row.last_digest_sent_at ? new Date(row.last_digest_sent_at) : null;
      if (last && (now - last) < 7 * 24 * 60 * 60 * 1000) continue;
    }
    await runDigestForUser(row.user_id);
  }
}

/**
 * Phase 3 / 5–6 hook: lead scored above threshold (Signal Brain).
 * Sends structured webhook payload for automation; optional extra email via HIGH_PRIORITY_INSTANT_EMAIL=true.
 */
async function onHighPrioritySignal({
  userId,
  leadId,
  sourceName,
  score,
  reason,
  contactName,
  companyName,
  leadPreview,
  enrichedEmail,
  linkedinUrl
}) {
  try {
    const settings = await getNotificationSettings(userId);
    if (!settings) return;

    const user = await dbGet('SELECT email, username FROM users WHERE id = ?', [userId]);
    const toEmail = user?.email;
    const appName = process.env.APP_NAME || 'Shiiman Leads';

    const cardPayload = buildHotLeadCard({
      contactName,
      companyName,
      sourceName,
      score,
      reason,
      leadId,
      leadPreview,
      enrichedEmail,
      linkedinUrl
    });

    const legacyPayload = {
      event: 'high_priority_lead',
      userId,
      leadId,
      sourceName,
      score,
      reason,
      contactName: contactName || null,
      companyName: companyName || null,
      leadPreview: leadPreview || null,
      card: cardPayload.card
    };

    const postHotLead = async (url, body) => {
      await axios.post(url, body, {
        timeout: 8000,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const slackUrl = String(settings.slack_webhook_url || '').trim();
    const genericUrl = String(settings.webhook_url || '').trim();

    if (slackUrl) {
      try {
        await postHotLead(slackUrl, slackHotLeadMessage(cardPayload));
      } catch (e) {
        logger.warn(`Slack hot-lead webhook failed: ${e.message}`);
      }
    }

    if (genericUrl && settings.webhook_enabled && genericUrl !== slackUrl) {
      try {
        const u = genericUrl;
        if (u.includes('discord.com/api/webhooks') || u.includes('discordapp.com/api/webhooks')) {
          await postHotLead(genericUrl, discordHotLeadEmbed(cardPayload));
        } else {
          await postHotLead(genericUrl, legacyPayload);
        }
      } catch (e) {
        logger.warn(`Hot-lead webhook (generic) failed: ${e.message}`);
      }
    }

    if (String(process.env.HIGH_PRIORITY_INSTANT_EMAIL || '').toLowerCase() === 'true' && settings.instant_email_enabled && toEmail) {
      const subject = `[${appName}] High-priority lead (${score}/10) — ${sourceName}`;
      const text =
        `Score: ${score}/10\n\nReason: ${reason || '—'}\nContact: ${contactName || '—'}\n\n${leadPreview || ''}\n\n— ${appName}`;
      await sendMail(toEmail, subject, text);
    }

    logger.info(`[SignalBrain] High-priority lead ${leadId} (score ${score}) user ${userId}`);
  } catch (e) {
    logger.error(`onHighPrioritySignal error: ${e.message}`);
  }
}

module.exports = {
  ensureNotificationSettings,
  getNotificationSettings,
  onNewLead,
  onHighPrioritySignal,
  runDigestForUser,
  runDigestForAllDue
};
