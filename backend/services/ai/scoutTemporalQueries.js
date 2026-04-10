/**
 * Agent A — "Scout" temporal / project-phase search queries (not one generic keyword).
 * Targets high-signal web results: local business press, crane/project pipelines, large permits,
 * glazing / interior phases — generalized beyond a single geography.
 */

/**
 * @param {{ geography?: string, state_code?: string, geography_kind?: string }} intent
 * @returns {string[]}
 */
function regionalBusinessNewsSite(intent) {
  const st = String(intent.state_code || '').toUpperCase();
  const g = String(intent.geography || '').toLowerCase();
  if (st === 'HI' || g.includes('hawaii') || g.includes('honolulu') || g.includes('oahu')) {
    return 'pacificbusinessnews.com';
  }
  if (st === 'TX' || g.includes('texas') || g.includes('austin') || g.includes('dallas')) {
    return 'bizjournals.com';
  }
  if (st === 'CA' || g.includes('california') || g.includes('los angeles') || g.includes('san francisco')) {
    return 'bizjournals.com';
  }
  if (st === 'NY' || g.includes('new york')) {
    return 'crainsnewyork.com';
  }
  return 'constructiondive.com';
}

/**
 * "Sweet spot" framing: projects moving from shell → interior (fenestration / treatments often lag topping out).
 * These strings are search queries only — Serper runs them.
 *
 * @param {object} intent - from parseBriefWithGemini
 * @returns {string[]}
 */
function buildScoutTemporalQueries(intent) {
  const geo = String(intent.geography || '').trim() || 'United States';
  const city = geo.split(',')[0].trim() || geo;
  const st = String(intent.state_code || '').trim();
  const y = new Date().getFullYear();
  const site = regionalBusinessNewsSite(intent);

  const queries = [
    `site:${site} "crane watch" OR "project pipeline" OR development ${city} ${y}`,
    `${geo} building permit commercial valuation million OR "$50" million ${y - 1} ${y}`,
    `${city} "topped out" OR groundbreaking OR tower ${st || ''} ${y}`,
    `${geo} luxury condo OR multifamily high-rise construction ${y}`,
    `${geo} glazing OR "curtain wall" OR storefront permit ${y}`,
    `${geo} interior build-out OR tenant improvement permit commercial ${y}`
  ];

  return [...new Set(queries.map(q => String(q || '').trim()).filter(q => q.length > 8 && q.length < 200))].slice(
    0,
    7
  );
}

module.exports = { buildScoutTemporalQueries, regionalBusinessNewsSite };
