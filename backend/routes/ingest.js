/**
 * Inbound lead ingest (Zapier, Make, custom scripts) using API tokens.
 * POST /api/ingest/leads — Authorization: Bearer <token> or X-API-Key
 */

const express = require('express');
const router = express.Router();
const { dbGet } = require('../db');
const logger = require('../utils/logger');
const { insertLeadIfNew } = require('../services/leadInsertion');
const { verifyIngestToken, touchIngestToken } = require('../services/ingestTokenService');
const { assertIngestBatchAllowance, incrementUsage } = require('../services/usageMeter');
const { requireAuth } = require('../middleware/auth');
const {
  createIngestToken,
  listIngestTokens,
  deleteIngestToken
} = require('../services/ingestTokenService');
const { requirePaid } = require('../middleware/billing');

function extractApiToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const k = req.get('x-api-key');
  if (k) return String(k).trim();
  return null;
}

router.post('/leads', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const raw = extractApiToken(req);
    if (!raw) {
      return res.status(401).json({
        error: 'Provide Authorization: Bearer <token> or X-API-Key header',
        hint: 'Create a token in Profile → API & usage'
      });
    }
    const verified = await verifyIngestToken(raw);
    if (!verified) {
      return res.status(401).json({ error: 'Invalid or revoked API token' });
    }
    const userId = verified.userId;

    const body = req.body || {};
    const sourceId = parseInt(body.source_id ?? body.sourceId, 10);
    const leads = body.leads;
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return res.status(400).json({ error: 'source_id is required (number)' });
    }
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'leads must be a non-empty array of objects' });
    }
    if (leads.length > 500) {
      return res.status(400).json({ error: 'Maximum 500 leads per request' });
    }

    await assertIngestBatchAllowance(userId, leads.length, null);

    const row = await dbGet('SELECT id, source_data FROM user_sources WHERE id = ? AND user_id = ?', [
      sourceId,
      userId
    ]);
    if (!row) {
      return res.status(404).json({ error: 'source_id not found for this account' });
    }

    let sourceData;
    try {
      sourceData = JSON.parse(row.source_data);
    } catch {
      return res.status(500).json({ error: 'Source configuration is invalid' });
    }
    const sourceName = String(sourceData.name || 'Inbound').slice(0, 200);
    const sourceUrl = String(sourceData.url || 'ingest://api').slice(0, 500);

    const primaryIdField =
      sourceData.primary_id_field ||
      sourceData.primaryIdField ||
      (sourceData.field_mapping && Object.keys(sourceData.field_mapping)[0]) ||
      'id';

    let inserted = 0;
    for (const lead of leads) {
      if (lead == null || typeof lead !== 'object' || Array.isArray(lead)) continue;
      const ok = await insertLeadIfNew({
        raw: JSON.stringify(lead),
        sourceName,
        lead,
        userId,
        sourceId,
        sourceUrl,
        primaryIdField
      });
      if (ok) inserted += 1;
    }

    await incrementUsage(userId, 'ingest', leads.length);
    await touchIngestToken(verified.tokenId);

    res.json({
      success: true,
      source_id: sourceId,
      received: leads.length,
      inserted,
      duplicates_or_skipped: leads.length - inserted
    });
  } catch (e) {
    const code = e.status && typeof e.status === 'number' ? e.status : 500;
    if (code >= 400 && code < 500) {
      return res.status(code).json({ error: e.message, code: e.code, details: e.details });
    }
    logger.error(`POST /api/ingest/leads: ${e.message}`);
    res.status(500).json({ error: e.message || 'Ingest failed' });
  }
});

router.get('/tokens', requireAuth, requirePaid, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const rows = await listIngestTokens(userId);
    res.json({ success: true, tokens: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tokens', requireAuth, requirePaid, express.json(), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const label = req.body && req.body.label != null ? String(req.body.label) : 'default';
    const created = await createIngestToken(userId, label);
    res.json({
      success: true,
      id: created.id,
      label: created.label,
      token: created.token,
      warning: 'Copy this token now. It will not be shown again.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tokens/:id', requireAuth, requirePaid, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const ok = await deleteIngestToken(userId, id);
    if (!ok) return res.status(404).json({ error: 'Token not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
