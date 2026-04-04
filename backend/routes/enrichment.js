/**
 * AI Enrichment page — pillar insights, map preview URL, intro email regen.
 */
const express = require('express');
const axios = require('axios');
const logger = require('../utils/logger');
const { generatePillarInsights, generateIntroEmail } = require('../services/ai/enrichmentPillars');

const router = express.Router();

function requireSession(req, res, next) {
  if (!req.session?.user?.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

/**
 * POST /api/enrichment/pillars
 * Body: { lead: object }
 */
router.post('/pillars', requireSession, async (req, res) => {
  try {
    const { lead } = req.body;
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead object required' });
    }
    const insights = await generatePillarInsights(lead);
    res.json({ success: true, insights });
  } catch (e) {
    logger.error(`[enrichment/pillars] ${e.message}`);
    res.status(500).json({ error: e.message || 'Failed to generate insights' });
  }
});

/**
 * POST /api/enrichment/intro-email
 * Body: { lead: object, prior?: object } — regenerate intro only
 */
router.post('/intro-email', requireSession, async (req, res) => {
  try {
    const { lead, prior } = req.body;
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead object required' });
    }
    const out = await generateIntroEmail(lead, prior);
    res.json({ success: true, ...out });
  } catch (e) {
    logger.error(`[enrichment/intro-email] ${e.message}`);
    res.status(500).json({ error: e.message || 'Failed' });
  }
});

/**
 * GET /api/enrichment/map-preview?address=...
 * Returns Street View (if GOOGLE_MAPS_API_KEY) or OSM static map via Nominatim geocode.
 */
router.get('/map-preview', requireSession, async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address || address.length < 3) {
    return res.status(400).json({ error: 'address query required' });
  }

  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_STATIC_MAPS_KEY;
  if (googleKey) {
    const u = new URL('https://maps.googleapis.com/maps/api/streetview');
    u.searchParams.set('size', '640x360');
    u.searchParams.set('location', address);
    u.searchParams.set('key', googleKey);
    return res.json({
      source: 'streetview',
      url: u.toString(),
      attribution: '© Google Street View'
    });
  }

  try {
    const nom = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: address, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'ShiimanLeads/1.0 (https://shiiman-leads; map-preview)' },
      timeout: 12000
    });
    const hit = nom.data && nom.data[0];
    if (!hit || hit.lat == null || hit.lon == null) {
      return res.json({ source: 'none', url: null, message: 'Could not geocode address' });
    }
    const lat = hit.lat;
    const lon = hit.lon;
    const staticUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=18&size=640x360&maptype=mapnik`;
    return res.json({
      source: 'osm',
      url: staticUrl,
      lat,
      lon,
      attribution: '© OpenStreetMap contributors'
    });
  } catch (e) {
    logger.warn(`[enrichment/map-preview] ${e.message}`);
    return res.json({ source: 'none', url: null, message: 'Map preview unavailable' });
  }
});

module.exports = router;
