/**
 * When primary Serper queries under-yield URLs, run a bounded "self-correction" pass:
 * broader news, filetype hints, Socrata/SODA language, contractor signals.
 * Does not loop forever — caller caps total Serper calls.
 */

/**
 * @param {string} brief
 * @param {object} intent - parseBriefWithGemini shape
 * @returns {string[]}
 */
function buildFallbackDiscoveryQueries(brief, intent) {
  const geo = String(intent?.geography || '').trim() || 'United States';
  const st = String(intent?.state_code || '').trim();
  const y = new Date().getFullYear();
  const shortBrief = String(brief || '')
    .slice(0, 80)
    .replace(/\s+/g, ' ')
    .trim();

  return [
    `${geo} commercial construction development news ${y} ${st}`,
    `${geo} "building permit" OR permit issued ${y} filetype:json OR site:data.`,
    `${geo} Socrata OR "SODA" OR open data portal permit ${st}`,
    `${geo} general contractor new construction project ${y}`,
    shortBrief.length > 20 ? `${shortBrief.slice(0, 60)} ${geo} permit` : `${geo} active issued permit commercial`
  ]
    .map(q => q.trim())
    .filter(q => q.length > 12 && q.length < 220);
}

module.exports = { buildFallbackDiscoveryQueries };
