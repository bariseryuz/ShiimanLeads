/**
 * Phase 5 — Lead enrichment (Hunter.io domain search when API key is set).
 * Triggered asynchronously after a high-priority (hot) lead is identified.
 */

const axios = require('axios');
const { dbRun } = require('../db');
const logger = require('../utils/logger');

function pickCompanyName(data) {
  if (!data || typeof data !== 'object') return '';
  const keys = [
    'company',
    'company_name',
    'business_name',
    'Contractor',
    'contractor_name',
    'applicant',
    'owner',
    'name'
  ];
  for (const k of keys) {
    const v = data[k];
    if (v != null && String(v).trim()) return String(v).trim().slice(0, 200);
  }
  return '';
}

function extractDomainFromLead(data) {
  if (!data || typeof data !== 'object') return null;
  const candidates = [data.website, data.url, data.web, data.site, data.homepage];
  for (const u of candidates) {
    if (!u || typeof u !== 'string') continue;
    const s = u.trim();
    if (!s.includes('.')) continue;
    try {
      const url = new URL(s.startsWith('http') ? s : `https://${s}`);
      const host = url.hostname.replace(/^www\./i, '');
      if (host && !host.includes(' ') && host.includes('.')) return host;
    } catch {
      /* continue */
    }
  }
  return null;
}

function pickDecisionMakerEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const priority = [
    /chief|ceo|cfo|coo|owner|president|founder/i,
    /facilities|office manager|general manager|director/i,
    /manager|head of/i
  ];
  for (const re of priority) {
    const hit = emails.find(e => e.position && re.test(String(e.position)));
    if (hit) return hit;
  }
  return emails[0];
}

/**
 * Hunter.io domain search — returns { email, linkedin } or null
 */
async function hunterDomainSearch(domain) {
  const key = process.env.HUNTER_API_KEY;
  if (!key || !domain) return null;
  const url = 'https://api.hunter.io/v2/domain-search';
  const { data } = await axios.get(url, {
    params: { domain, api_key: key, limit: 10 },
    timeout: 15000,
    validateStatus: s => s < 500
  });
  if (data?.errors?.length) {
    logger.debug(`[Hunter] ${domain}: ${JSON.stringify(data.errors)}`);
    return null;
  }
  if (!data || data.data == null) return null;
  const emails = data.data.emails || [];
  const best = pickDecisionMakerEmail(emails);
  if (!best || !best.value) return null;
  return {
    email: String(best.value).trim(),
    linkedin: best.linkedin ? String(best.linkedin).trim() : null
  };
}

async function enrichLeadFromHunter({ userId, leadId, rawData }) {
  const domain = extractDomainFromLead(rawData);
  if (!domain) {
    try {
      await dbRun(
        `UPDATE leads SET enrichment_status = ?, enrichment_provider = ? WHERE id = ? AND user_id = ?`,
        ['skipped', 'hunter', leadId, userId]
      );
    } catch (e) {
      logger.debug(`Enrichment skip update: ${e.message}`);
    }
    return;
  }

  try {
    const found = await hunterDomainSearch(domain);
    if (!found) {
      await dbRun(
        `UPDATE leads SET enrichment_status = ?, enrichment_provider = ? WHERE id = ? AND user_id = ?`,
        ['skipped', 'hunter', leadId, userId]
      );
      return;
    }
    await dbRun(
      `UPDATE leads SET enriched_email = ?, linkedin_url = ?, enrichment_status = ?, enrichment_provider = ? WHERE id = ? AND user_id = ?`,
      [found.email, found.linkedin || null, 'ok', 'hunter', leadId, userId]
    );
    logger.info(`[Enrichment] Lead ${leadId}: ${found.email} (${domain})`);
  } catch (e) {
    logger.warn(`[Enrichment] Lead ${leadId}: ${e.message}`);
    try {
      await dbRun(
        `UPDATE leads SET enrichment_status = ?, enrichment_provider = ? WHERE id = ? AND user_id = ?`,
        ['error', 'hunter', leadId, userId]
      );
    } catch (_) {}
  }
}

function enqueueEnrichmentForHotLead({ userId, leadId, data }) {
  if (String(process.env.ENABLE_LEAD_ENRICHMENT || '').toLowerCase() !== 'true') return;
  if (!process.env.HUNTER_API_KEY) return;
  setImmediate(() => {
    enrichLeadFromHunter({ userId, leadId, rawData: data }).catch(err =>
      logger.warn(`[Enrichment] async: ${err.message}`)
    );
  });
}

module.exports = {
  pickCompanyName,
  extractDomainFromLead,
  enrichLeadFromHunter,
  enqueueEnrichmentForHotLead
};
