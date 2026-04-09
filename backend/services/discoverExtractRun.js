/**
 * Shared: one URL + brief → Playwright scrape → leads (+ optional strict filter).
 * Used by POST /discover/extract-now and POST /discover/auto-leads.
 */

const { buildManifestFromBrief } = require('./ai/deepExtractManifest');
const { filterLeadsToBrief } = require('./ai/deepExtractFilter');
const { createUserSourceCore } = require('./createUserSourceCore');
const { scrapeForUser } = require('../legacyScraper');
const { dbAll } = require('../db');
const { deleteUserSourceCascade } = require('./deleteUserSourceCascade');
/**
 * @param {{ userId: number, brief: string, url: string, maxLeads: number, deleteAfter: boolean, req: import('express').Request, manifest?: object }} opts
 */
async function runExtractNowForUrl(opts) {
  const { userId, brief, url, maxLeads, deleteAfter, req } = opts;
  const manifest = opts.manifest || (await buildManifestFromBrief(brief));

  let host = 'site';
  try {
    host = new URL(url).hostname.replace(/^www\./i, '') || 'site';
  } catch {
    /* ignore */
  }

  const nav = [
    manifest.navigation_instructions,
    'STRICT OUTPUT: Only extract rows that match the user criteria; use null for missing cells.',
    `USER INTENT (for filtering columns): ${brief.slice(0, 1500)}`
  ].filter(Boolean);

  const sourceData = {
    name: `Extract ${host}`.slice(0, 200),
    url,
    method: 'playwright',
    usePlaywright: true,
    useAI: true,
    type: 'html',
    fieldSchema: manifest.field_schema,
    aiPrompt: nav.join('\n\n'),
    discoveryKeyword: brief.slice(0, 200),
    fromDiscovery: true,
    deepExtractOneShot: true,
    extractionLimits: {
      maxTotalRows: maxLeads,
      maxPages: 3,
      maxRowsPerPage: Math.min(50, maxLeads + 5)
    }
  };

  const created = await createUserSourceCore({
    userId,
    sourceData,
    req,
    skipAutoScrape: true,
    skipNotification: true
  });
  const sourceId = created.id;

  const toScrape = { ...sourceData, id: sourceId, _sourceId: sourceId };
  await scrapeForUser(userId, [toScrape], {
    maxTotalRows: maxLeads,
    maxPages: 3,
    maxRowsPerPage: Math.min(50, maxLeads + 5)
  });

  let rows = await dbAll(
    'SELECT id, raw_data, created_at FROM leads WHERE user_id = ? AND source_id = ? ORDER BY id DESC LIMIT ?',
    [userId, sourceId, Math.min(100, maxLeads * 2)]
  );

  const parsed = rows
    .map(r => {
      let data = {};
      if (r.raw_data) {
        try {
          data = JSON.parse(r.raw_data);
        } catch {
          data = { _raw: r.raw_data };
        }
      }
      return { lead_id: r.id, created_at: r.created_at, ...data };
    })
    .filter(obj => obj && typeof obj === 'object');

  const { leads: filtered, applied: strictFilterApplied } = await filterLeadsToBrief(
    brief,
    manifest.strict_match_rules,
    parsed
  );
  const leads = filtered.slice(0, maxLeads);
  const note =
    parsed.length > 0 && leads.length === 0 && strictFilterApplied
      ? 'Strict filter matched no rows against your brief. Try a broader brief or verify the page shows qualifying records.'
      : null;

  if (deleteAfter) {
    await deleteUserSourceCascade(userId, sourceId);
  }

  return {
    manifest,
    sourceId: deleteAfter ? null : sourceId,
    strictFilterApplied,
    leads,
    note,
    deleteAfter,
    rawRowCount: parsed.length
  };
}

module.exports = { runExtractNowForUrl };
