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

/**
 * Satellite / roadmap image via Google Maps Static API (same key as Street View).
 * Enable "Maps Static API" in Google Cloud for this key.
 */
async function fetchGoogleStaticMapFromAddress(address, key) {
  const u = new URL('https://maps.googleapis.com/maps/api/staticmap');
  u.searchParams.set('center', address);
  u.searchParams.set('zoom', '18');
  u.searchParams.set('size', '640x360');
  u.searchParams.set('scale', '2');
  u.searchParams.set('maptype', 'satellite');
  u.searchParams.set('key', key);
  const response = await axios.get(u.toString(), {
    responseType: 'arraybuffer',
    timeout: 20000,
    validateStatus: () => true
  });
  const ct = String(response.headers['content-type'] || '');
  if (response.status === 200 && ct.startsWith('image/')) {
    return { buffer: Buffer.from(response.data), contentType: ct, source: 'google_static' };
  }
  const preview = Buffer.from(response.data).toString('utf8').slice(0, 180);
  logger.warn(`[enrichment] Google Static Map status=${response.status} ct=${ct} preview=${preview}`);
  return null;
}

function latLonToTileXY(lat, lon, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

/**
 * Single OSM map tile (no staticmap.openstreetmap.de — unreliable DNS on some hosts e.g. Railway).
 */
async function fetchOsmTileBuffer(lat, lon) {
  const z = 17;
  const { x, y } = latLonToTileXY(Number(lat), Number(lon), z);
  const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const img = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'ShiimanLeads/1.0 (enrichment map; +https://shiiman.com)' },
    validateStatus: () => true
  });
  if (img.status !== 200 || !String(img.headers['content-type'] || '').startsWith('image/')) return null;
  return { buffer: Buffer.from(img.data), contentType: img.headers['content-type'], source: 'osm_tile' };
}

/**
 * Fallback when Street View fails: Google Static Map → OSM tile (geocode + tile).
 */
async function fetchMapFallbackImage(address, googleKey) {
  if (googleKey) {
    const g = await fetchGoogleStaticMapFromAddress(address, googleKey);
    if (g) return g;
  }
  const geo = await geocodeAddress(address);
  if (!geo) return null;
  const t = await fetchOsmTileBuffer(geo.lat, geo.lon);
  if (t) return t;
  return null;
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
    const proxyPath = '/api/enrichment/osm-tile-image?address=' + encodeURIComponent(address);
    return res.json({
      source: 'osm',
      url: proxyPath,
      proxy: true,
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

    const fb = await fetchMapFallbackImage(address, googleKey);
    if (fb) {
      res.set('Content-Type', fb.contentType);
      res.set('Cache-Control', 'private, max-age=3600');
      res.set('X-Map-Fallback', fb.source || 'fallback');
      return res.send(fb.buffer);
    }

    return res.status(502).send('Street View unavailable for this address');
  } catch (e) {
    logger.error(`[streetview-image] ${e.message}`);
    try {
      const fb = await fetchMapFallbackImage(address, googleKey);
      if (fb) {
        res.set('Content-Type', fb.contentType);
        res.set('Cache-Control', 'private, max-age=3600');
        res.set('X-Map-Fallback', fb.source || 'fallback');
        return res.send(fb.buffer);
      }
    } catch (e2) {
      logger.warn(`[streetview-image] fallback error: ${e2.message}`);
    }
    return res.status(502).send('Map preview failed');
  }
});

/**
 * GET /api/enrichment/osm-tile-image?address=...
 * Proxies a single OSM tile (when no Google key — map-preview JSON points here).
 */
router.get('/osm-tile-image', requireSession, async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!address || address.length < 3) {
    return res.status(400).send('address required');
  }
  try {
    const geo = await geocodeAddress(address);
    if (!geo) return res.status(404).send('Could not geocode');
    const t = await fetchOsmTileBuffer(geo.lat, geo.lon);
    if (!t) return res.status(502).send('Tile unavailable');
    res.set('Content-Type', t.contentType);
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('X-Map-Source', 'osm_tile');
    return res.send(t.buffer);
  } catch (e) {
    logger.error(`[osm-tile-image] ${e.message}`);
    return res.status(502).send('Map preview failed');
  }
});

module.exports = router;
