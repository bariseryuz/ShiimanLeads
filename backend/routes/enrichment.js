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

async function geocodeAddress(address) {
  const nom = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: address, format: 'json', limit: 1 },
    headers: { 'User-Agent': 'ShiimanLeads/1.0 (https://shiiman-leads; map-preview)' },
    timeout: 12000
  });
  const hit = nom.data && nom.data[0];
  if (!hit || hit.lat == null || hit.lon == null) return null;
  return { lat: hit.lat, lon: hit.lon };
}

function osmStaticMapUrl(lat, lon) {
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=18&size=640x360&maptype=mapnik`;
}

/** Geocode + fetch OSM static map image bytes (fallback when Street View fails). */
async function fetchOsmMapImageBuffer(address) {
  const g = await geocodeAddress(address);
  if (!g) return null;
  const staticUrl = osmStaticMapUrl(g.lat, g.lon);
  const img = await axios.get(staticUrl, { responseType: 'arraybuffer', timeout: 15000, validateStatus: () => true });
  if (img.status !== 200 || !String(img.headers['content-type'] || '').startsWith('image/')) return null;
  return { buffer: Buffer.from(img.data), contentType: img.headers['content-type'], lat: g.lat, lon: g.lon };
}

/**
 * GET /api/enrichment/map-preview?address=...
 * Returns JSON with a same-origin image URL (see streetview-image) so the browser does not
 * call Google with your API key directly — IP-restricted keys and referrer rules break <img> otherwise.
 */
router.get('/map-preview', requireSession, async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address || address.length < 3) {
    return res.status(400).json({ error: 'address query required' });
  }

  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_STATIC_MAPS_KEY;
  if (googleKey) {
    const proxyPath =
      '/api/enrichment/streetview-image?address=' + encodeURIComponent(address);
    return res.json({
      source: 'streetview',
      url: proxyPath,
      proxy: true,
      attribution: '© Google Street View'
    });
  }

  try {
    const g = await geocodeAddress(address);
    if (!g) {
      return res.json({ source: 'none', url: null, message: 'Could not geocode address' });
    }
    return res.json({
      source: 'osm',
      url: osmStaticMapUrl(g.lat, g.lon),
      lat: g.lat,
      lon: g.lon,
      attribution: '© OpenStreetMap contributors'
    });
  } catch (e) {
    logger.warn(`[enrichment/map-preview] ${e.message}`);
    return res.json({ source: 'none', url: null, message: 'Map preview unavailable' });
  }
});

/**
 * GET /api/enrichment/streetview-image?address=...
 * Proxies Google Street View Static API server-side (key never sent to browser).
 * Falls back to OSM map image if Google returns non-image (403, wrong API, no coverage).
 */
router.get('/streetview-image', requireSession, async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address || address.length < 3) {
    return res.status(400).send('address required');
  }

  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_STATIC_MAPS_KEY;
  if (!googleKey) {
    return res.status(503).send('GOOGLE_MAPS_API_KEY not configured');
  }

  const u = new URL('https://maps.googleapis.com/maps/api/streetview');
  u.searchParams.set('size', '640x360');
  u.searchParams.set('location', address);
  u.searchParams.set('key', googleKey);

  try {
    const response = await axios.get(u.toString(), {
      responseType: 'arraybuffer',
      timeout: 20000,
      validateStatus: () => true
    });

    const ct = String(response.headers['content-type'] || '');
    const okImage = response.status === 200 && ct.startsWith('image/');

    if (okImage) {
      res.set('Content-Type', ct);
      res.set('Cache-Control', 'private, max-age=3600');
      return res.send(Buffer.from(response.data));
    }

    const preview = Buffer.from(response.data).toString('utf8').slice(0, 200);
    logger.warn(
      `[streetview-image] Google returned status=${response.status} content-type=${ct} preview=${preview}`
    );

    const osm = await fetchOsmMapImageBuffer(address);
    if (osm) {
      res.set('Content-Type', osm.contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Map-Fallback', 'osm');
      return res.send(osm.buffer);
    }

    return res.status(502).send('Street View unavailable for this address');
  } catch (e) {
    logger.error(`[streetview-image] ${e.message}`);
    try {
      const osm = await fetchOsmMapImageBuffer(address);
      if (osm) {
        res.set('Content-Type', osm.contentType);
        res.set('X-Map-Fallback', 'osm');
        return res.send(osm.buffer);
      }
    } catch (_) {}
    return res.status(502).send('Map preview failed');
  }
});

module.exports = router;
