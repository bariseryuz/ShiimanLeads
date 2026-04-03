/**
 * ATS (Greenhouse / Lever / Workable) public job board URL helpers.
 * Use from Playwright flows: open URL → parse listing cards for title + posted date.
 * Does not scrape by itself — provides stable entry points from a company domain or slug.
 */

/**
 * @param {string} domainOrHost - e.g. "acme.com" or "https://www.acme.com"
 * @returns {string|null} first label of hostname (heuristic slug)
 */
function slugFromDomain(domainOrHost) {
  if (!domainOrHost || typeof domainOrHost !== 'string') return null;
  try {
    const s = domainOrHost.trim();
    const host = new URL(s.includes('://') ? s : `https://${s}`).hostname.replace(/^www\./i, '');
    const parts = host.split('.');
    if (parts.length < 2) return null;
    return parts[0].toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Known ATS board URL patterns (public pages).
 * @param {string} slug - company board slug (often matches domain prefix; user may override)
 */
function atsBoardUrls(slug) {
  const s = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '');
  if (!s) return { lever: null, greenhouse: null, workable: null };
  return {
    lever: `https://jobs.lever.co/${s}`,
    greenhouse: `https://boards.greenhouse.io/${s}`,
    workable: `https://apply.workable.com/${s}`
  };
}

/**
 * Convenience: domain → ATS URLs to try (in order: Lever, Greenhouse, Workable).
 */
function atsUrlsFromCompanyDomain(domainOrHost) {
  const slug = slugFromDomain(domainOrHost);
  if (!slug) return [];
  const u = atsBoardUrls(slug);
  return [u.lever, u.greenhouse, u.workable].filter(Boolean);
}

/**
 * Rough check: does text look like a recent job post (for priority bump in app logic, not legal proof).
 * @param {string} text - snippet from page or JSON
 * @returns {boolean}
 */
function textMentionsRecentPosting(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return (
    /\b(just now|today|yesterday|hours?\s+ago|1\s*day|2\s*days?|posted)\b/.test(t) ||
    /\b\d+\s*(hours?|days?)\s*ago\b/.test(t)
  );
}

module.exports = {
  slugFromDomain,
  atsBoardUrls,
  atsUrlsFromCompanyDomain,
  textMentionsRecentPosting
};
