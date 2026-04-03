/**
 * Phase 6 — Hot Lead cards for Slack, Discord, and generic (Zapier/Make) webhooks.
 */

function buildHotLeadCard({
  contactName,
  companyName,
  sourceName,
  score,
  reason,
  leadId,
  leadPreview,
  enrichedEmail,
  linkedinUrl
}) {
  const name = contactName || '—';
  const company = companyName || '—';
  const aiScoreLabel = score != null ? `${score}/10` : '—';
  return {
    event: 'hot_lead',
    version: 1,
    card: {
      name,
      company,
      source: sourceName || '—',
      aiScore: score,
      aiScoreLabel,
      reason: reason || '—',
      leadId,
      leadPreview: leadPreview || null,
      enrichedEmail: enrichedEmail || null,
      linkedinUrl: linkedinUrl || null
    }
  };
}

/** Slack incoming webhook: blocks + fallback text */
function slackHotLeadMessage(cardPayload) {
  const c = cardPayload.card;
  const text = `*Hot lead* (${c.aiScoreLabel}) — ${c.source}\n*${c.name}* · ${c.company}\n${c.reason}`;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔥 Hot lead', emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Name*\n${c.name}` },
        { type: 'mrkdwn', text: `*Company*\n${c.company}` },
        { type: 'mrkdwn', text: `*AI score*\n${c.aiScoreLabel}` },
        { type: 'mrkdwn', text: `*Source*\n${c.source}` }
      ]
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Reason*\n${String(c.reason).slice(0, 2000)}` }
    }
  ];
  if (c.enrichedEmail || c.linkedinUrl) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [c.enrichedEmail ? `📧 ${c.enrichedEmail}` : '', c.linkedinUrl ? `LinkedIn: ${c.linkedinUrl}` : '']
            .filter(Boolean)
            .join(' · ')
        }
      ]
    });
  }
  return { text, blocks };
}

/** Discord incoming webhook */
function discordHotLeadEmbed(cardPayload) {
  const c = cardPayload.card;
  return {
    embeds: [
      {
        title: '🔥 Hot lead',
        color: 0xe01e5a,
        fields: [
          { name: 'Name', value: String(c.name).slice(0, 1024), inline: true },
          { name: 'Company', value: String(c.company).slice(0, 1024), inline: true },
          { name: 'AI score', value: c.aiScoreLabel, inline: true },
          { name: 'Source', value: String(c.source).slice(0, 1024), inline: false },
          { name: 'Reason', value: String(c.reason).slice(0, 1024), inline: false }
        ],
        footer: { text: `Lead ID ${c.leadId}` }
      }
    ]
  };
}

module.exports = {
  buildHotLeadCard,
  slackHotLeadMessage,
  discordHotLeadEmbed
};
