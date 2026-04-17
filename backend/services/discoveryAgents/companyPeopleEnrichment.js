const logger = require('../../utils/logger');
const { hasSerper, googleSearchOrganic } = require('../serperSearch');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
const { isNonPhysicalAddress } = require('./deterministicVerify');
const { readPageTextDetailed, readMultiplePagesWithDiagnostics } = require('./pageReader');

const PLACEHOLDER_RE = /^(missing|unknown|not found(?: yet)?|n\/?a|na|null|undefined|none|not publicly(?: stated)?|unavailable|tbd)$/i;

const AGGREGATOR_HOST_RE = /(^|\.)(yelp|tripadvisor|opentable|resy|toasttab|facebook|instagram|twitter|x|linkedin|yellowpages|mapquest|wikipedia|foursquare|zomato|ubereats|grubhub|doordash|postmates|eater|timeout|thrillist|seatgeek|google|bing|duckduckgo|pinterest|reddit|youtube|tiktok|nextdoor|angi|bbb|crunchbase|bloomberg|forbes|indeed|glassdoor|monster|ziprecruiter|builtin|owler|zoominfo|rocketreach)\.(com|net|org|co|io|us)$/i;

const TEAM_LINK_RE = /\b(about|team|leadership|people|founder|founders|management|contact|staff|our[\s-]?story|owner|chef|executive|board|partner|principal|bio|who[\s-]?we[\s-]?are|meet[\s-]?(?:the[\s-]?)?team)\b/i;

const PERSON_PATH_RE = /\/(about|team|leadership|people|founder|founders|management|staff|bio|our-?story|our-?team|meet-?the-?team|leaders|executives|who-?we-?are|owner|chef)(\/|$)/i;

function isUsefulValue(v) {
  const s = String(v || '').trim();
  return !!s && !PLACEHOLDER_RE.test(s);
}

function isLikelyAddress(v) {
  const s = String(v || '').trim();
  if (!isUsefulValue(s)) return false;
  if (/^(lead_?id|record_?id|id)\s*:/i.test(s)) return false;
  return /\d/.test(s) || /\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway)\b/i.test(s);
}

function parseJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

function tokensFromName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !/^(the|inc|llc|corp|co|group|holdings|company|ltd|restaurant|restaurants|cafe|bar|grill|bistro)$/.test(t))
    .slice(0, 6);
}

function pickLeadText(lead) {
  const project = String(lead.project_name || lead.lead_title || '').trim();
  const location = String(lead.location || lead.address || '').trim();
  const company = String(lead.company_name || lead.key_contact_or_firm || '').trim();
  return { project, location, company };
}

/**
 * Step 1: Find the official website for a business via Serper.
 * Filters aggregator/social hosts; scores by name-token match in hostname.
 */
async function findOfficialSite({ name, location }) {
  if (!hasSerper()) return null;
  const query = [name && `"${name}"`, location && `"${location}"`].filter(Boolean).join(' ').trim() || name;
  if (!query) return null;
  let rows = [];
  try {
    rows = await googleSearchOrganic(query, { num: 8, timeoutMs: 9000 });
  } catch (e) {
    logger.debug(`[enrich.findOfficialSite] ${e.message}`);
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const nameTokens = tokensFromName(name);
  const scored = [];
  for (const r of rows) {
    const host = hostOf(r.link);
    if (!host) continue;
    if (AGGREGATOR_HOST_RE.test(host)) continue;
    let score = 0;
    for (const t of nameTokens) {
      if (host.includes(t)) score += 4;
    }
    if (host.split('.').length <= 3) score += 1;
    const path = (() => { try { return new URL(r.link).pathname; } catch { return ''; } })();
    if (path === '/' || path === '') score += 2;
    if (/about|team|home/.test(String(r.title || '').toLowerCase())) score += 1;
    scored.push({ ...r, host, _score: score });
  }
  scored.sort((a, b) => b._score - a._score);
  const best = scored[0];
  if (!best || best._score <= 0) return null;
  return best;
}

/**
 * Step 2: Crawl the official site — homepage + best About/Team/Leadership inner pages.
 */
async function crawlOfficialSite(hit) {
  if (!hit || !hit.link) return { pages: [], diagnostics: null };
  const home = await readPageTextDetailed(hit.link);
  if (!home.ok) return { pages: [], diagnostics: { attempted: 1, readable: 0, failed: 1, failures: [{ url: hit.link, reason: home.reason }] } };
  const baseHost = hostOf(hit.link);
  const candidates = (home.links || [])
    .filter(l => {
      const h = hostOf(l.url);
      if (!h || h !== baseHost) return false;
      const hay = (l.url + ' ' + l.anchor).toLowerCase();
      return TEAM_LINK_RE.test(hay) || PERSON_PATH_RE.test(l.url);
    });
  // Rank: path match > anchor match > generic
  const ranked = candidates
    .map(l => {
      let s = 0;
      if (PERSON_PATH_RE.test(l.url)) s += 3;
      if (TEAM_LINK_RE.test(l.anchor)) s += 2;
      if (/\bfounder|ceo|chief|owner|principal\b/i.test(l.anchor)) s += 3;
      return { ...l, _score: s };
    })
    .sort((a, b) => b._score - a._score);
  const picks = ranked.slice(0, 3).map(l => ({ url: l.url, title: l.anchor || 'Team page' }));
  let innerPages = [];
  let innerDiag = { attempted: 0, readable: 0, failed: 0, failures: [] };
  if (picks.length) {
    const innerOut = await readMultiplePagesWithDiagnostics(picks, picks.length);
    innerPages = innerOut.pages || [];
    innerDiag = innerOut.diagnostics || innerDiag;
  }
  const pages = [
    { url: hit.link, title: hit.title || 'Homepage', text: home.text || '' },
    ...innerPages.map(p => ({ url: p.url, title: p.title, text: p.text }))
  ];
  return {
    pages,
    diagnostics: {
      attempted: 1 + innerDiag.attempted,
      readable: 1 + innerDiag.readable,
      failed: innerDiag.failed,
      failures: innerDiag.failures
    }
  };
}

/**
 * Step 3: Ask Gemini to extract key people from the crawled company text.
 */
async function extractPeopleFromCrawl({ brief, lead, pages }) {
  if (!isAIAvailable() || !pages || !pages.length) return null;
  const model = getGeminiModel('discovery');
  const context = pages.map((p, i) =>
    `--- Page ${i + 1}: ${p.title} (${p.url}) ---\n${String(p.text || '').slice(0, 3800)}\n`
  ).join('\n');
  const prompt =
    'You are extracting real, verifiable information about a company from its own website pages.\n' +
    'Return ONLY JSON with this shape:\n' +
    '{"company_name":"","company_summary":"","website":"","key_people":[{"name":"","role":"","source_url":""}],"best_contact_path":"","confidence":"high|medium|low"}\n\n' +
    'Rules:\n' +
    '- Use only names/roles that appear in the provided page text.\n' +
    '- Never invent people. If no named person appears, key_people must be [].\n' +
    '- Prefer leadership roles: Founder, Co-founder, Owner, CEO, President, Managing Partner, Executive Chef, Principal, Managing Director, Head of..., Director of...\n' +
    '- source_url must be one of the provided page URLs where that person actually appears.\n' +
    '- company_summary: max 25 words, plain language, what the company does.\n' +
    '- best_contact_path: one practical sentence on how to reach the right person.\n\n' +
    `USER BRIEF:\n${String(brief || '').slice(0, 800)}\n\n` +
    `LEAD CONTEXT:\n${JSON.stringify({
      company_name: lead.company_name || lead.key_contact_or_firm || '',
      project_name: lead.project_name || lead.lead_title || '',
      address: lead.address || '',
      location: lead.location || ''
    }).slice(0, 800)}\n\n` +
    `PAGE CONTENT:\n${context.slice(0, 16000)}`;
  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const obj = parseJson(raw);
    if (!obj || typeof obj !== 'object') return null;
    const people = (Array.isArray(obj.key_people) ? obj.key_people : [])
      .filter(x => x && typeof x === 'object' && String(x.name || '').trim())
      .slice(0, 4)
      .map(x => ({
        name: String(x.name || '').trim().slice(0, 120),
        role: String(x.role || '').trim().slice(0, 120),
        source_url: String(x.source_url || '').trim().slice(0, 320)
      }));
    return {
      company_name: String(obj.company_name || '').trim().slice(0, 180),
      company_summary: String(obj.company_summary || '').trim().slice(0, 240),
      website: String(obj.website || '').trim().slice(0, 320),
      key_people: people,
      best_contact_path: String(obj.best_contact_path || '').trim().slice(0, 200),
      enrichment_confidence: ['high', 'medium', 'low'].includes(String(obj.confidence || '').toLowerCase())
        ? String(obj.confidence || '').toLowerCase()
        : 'low'
    };
  } catch (e) {
    logger.warn(`[enrich.extractPeopleFromCrawl] ${e.message}`);
    return null;
  }
}

/**
 * Step 4: news-risk signal (generic, keeps old behavior).
 */
async function fetchNewsRisk(base) {
  if (!hasSerper() || !base) return { flag: 'low', note: '', snippets: [] };
  try {
    const rows = await googleSearchOrganic(
      `${base} (lawsuit OR litigation OR bankruptcy OR closed OR shutdown OR recall OR controversy)`,
      { num: 5, timeoutMs: 9000 }
    );
    const snippets = (rows || []).map(r => ({
      title: String(r.title || '').slice(0, 220),
      link: String(r.link || '').slice(0, 300),
      snippet: String(r.snippet || '').slice(0, 300)
    }));
    return { flag: 'low', note: '', snippets };
  } catch (e) {
    logger.debug(`[enrich.fetchNewsRisk] ${e.message}`);
    return { flag: 'low', note: '', snippets: [] };
  }
}

async function enrichOneLead(lead, brief, intent) {
  if (!isAIAvailable() || !hasSerper()) return null;
  const { project, location, company } = pickLeadText(lead);
  // Prefer company/brand name over project name for official-site discovery.
  const nameForSite = (company && !/^not publicly stated$/i.test(company)) ? company : project;
  const locationHint = location || String(lead.address || '').trim();

  let site = null;
  let crawl = { pages: [], diagnostics: null };
  let crawled = null;

  if (nameForSite) {
    site = await findOfficialSite({ name: nameForSite, location: locationHint });
    if (site) {
      logger.info(`[enrich] official site for "${nameForSite}" → ${site.host}`);
      crawl = await crawlOfficialSite(site);
      if (crawl.pages && crawl.pages.length) {
        crawled = await extractPeopleFromCrawl({ brief, lead, pages: crawl.pages });
      }
    } else {
      logger.info(`[enrich] no confident official site for "${nameForSite}"`);
    }
  }

  // Construction-aware physical-site snippet fallback (only when needed).
  const currentAddress = String(lead.address || '').trim();
  const needsPhysicalSiteFallback = isNonPhysicalAddress(currentAddress);
  let sitePooled = [];
  if (needsPhysicalSiteFallback) {
    const base = [nameForSite, locationHint].filter(Boolean).join(' ');
    try {
      const siteRows = await googleSearchOrganic(
        `${base} site address OR job site address OR physical address`,
        { num: 6, timeoutMs: 9000 }
      );
      sitePooled = (siteRows || []).map(r => ({
        title: String(r.title || '').slice(0, 220),
        link: String(r.link || '').slice(0, 300),
        snippet: String(r.snippet || '').slice(0, 320)
      }));
    } catch (e) {
      logger.debug(`[enrich] site fallback: ${e.message}`);
    }
  }

  // News / risk signal (kept lightweight).
  const risk = await fetchNewsRisk([nameForSite, locationHint].filter(Boolean).join(' '));

  // If crawl found nothing, fall back to a snippet-based pass so we still return *something*.
  if (!crawled || !crawled.key_people || crawled.key_people.length === 0) {
    const fallback = await snippetBasedFallback({ brief, intent, lead, riskSnippets: risk.snippets, sitePooled });
    if (fallback) {
      return {
        ...fallback,
        website: fallback.website || (site ? site.link : ''),
        crawl_diagnostics: crawl.diagnostics || null
      };
    }
  }

  if (!crawled) return null;

  // Infer physical address from site snippets if needed.
  let physicalSiteAddress = '';
  if (needsPhysicalSiteFallback && sitePooled.length) {
    const guess = sitePooled
      .map(r => r.snippet)
      .find(s => isLikelyAddress(s));
    if (guess) physicalSiteAddress = String(guess).slice(0, 220);
  }

  return {
    company_name: crawled.company_name || company,
    company_summary: crawled.company_summary || '',
    physical_site_address: physicalSiteAddress,
    key_people: crawled.key_people,
    best_contact_path: crawled.best_contact_path,
    news_risk_flag: risk.flag || 'low',
    news_risk_note: risk.note || '',
    enrichment_confidence: crawled.enrichment_confidence || 'low',
    website: crawled.website || (site ? site.link : ''),
    crawl_diagnostics: crawl.diagnostics || null
  };
}

async function snippetBasedFallback({ brief, intent, lead, riskSnippets, sitePooled }) {
  if (!isAIAvailable()) return null;
  const { project, location, company } = pickLeadText(lead);
  const base = [project || company, location].filter(Boolean).join(' ').trim();
  if (!base) return null;
  const pooled = [];
  try {
    const rows = await googleSearchOrganic(`${base} founder OR owner OR CEO OR "about us"`, { num: 6, timeoutMs: 9000 });
    for (const r of rows || []) {
      pooled.push({
        title: String(r.title || '').slice(0, 220),
        link: String(r.link || '').slice(0, 300),
        snippet: String(r.snippet || '').slice(0, 300)
      });
    }
  } catch (e) {
    logger.debug(`[enrich.snippetFallback] ${e.message}`);
  }
  if (!pooled.length) return null;
  const model = getGeminiModel('discovery');
  const prompt =
    'Return ONLY JSON with this shape:\n' +
    '{"company_name":"","company_summary":"","physical_site_address":"","key_people":[{"name":"","role":"","source_url":""}],"best_contact_path":"","news_risk_flag":"low|medium|high","news_risk_note":"","confidence":"high|medium|low"}\n' +
    'Rules:\n' +
    '- Use only the provided snippets/links.\n' +
    '- Never invent person names.\n' +
    '- If no reliable name appears, key_people must be [].\n' +
    '- company_summary: max 25 words.\n\n' +
    `Brief:\n${String(brief || '').slice(0, 800)}\n\n` +
    `Lead:\n${JSON.stringify(lead).slice(0, 1200)}\n\n` +
    `Search snippets:\n${JSON.stringify(pooled.slice(0, 10), null, 2)}\n\n` +
    `Site snippets:\n${JSON.stringify((sitePooled || []).slice(0, 6), null, 2)}\n\n` +
    `Risk snippets:\n${JSON.stringify((riskSnippets || []).slice(0, 5), null, 2)}`;
  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const obj = parseJson(raw);
    if (!obj || typeof obj !== 'object') return null;
    const people = (Array.isArray(obj.key_people) ? obj.key_people : [])
      .filter(x => x && typeof x === 'object' && String(x.name || '').trim())
      .slice(0, 3)
      .map(x => ({
        name: String(x.name || '').trim().slice(0, 120),
        role: String(x.role || '').trim().slice(0, 120),
        source_url: String(x.source_url || '').trim().slice(0, 320)
      }));
    return {
      company_name: String(obj.company_name || company || '').trim().slice(0, 180),
      company_summary: String(obj.company_summary || '').trim().slice(0, 240),
      physical_site_address: String(obj.physical_site_address || '').trim().slice(0, 220),
      key_people: people,
      best_contact_path: String(obj.best_contact_path || '').trim().slice(0, 200),
      news_risk_flag: ['low', 'medium', 'high'].includes(String(obj.news_risk_flag || '').toLowerCase())
        ? String(obj.news_risk_flag || '').toLowerCase()
        : 'low',
      news_risk_note: String(obj.news_risk_note || '').trim().slice(0, 240),
      enrichment_confidence: ['high', 'medium', 'low'].includes(String(obj.confidence || '').toLowerCase())
        ? String(obj.confidence || '').toLowerCase()
        : 'low'
    };
  } catch (e) {
    logger.warn(`[enrich.snippetFallback.ai] ${e.message}`);
    return null;
  }
}

async function enrichLeadsWithCompanyPeople({ brief, intent, leads, maxLeads = 5 }) {
  const rows = Array.isArray(leads) ? leads : [];
  if (!rows.length) return { leads: rows, enrichment_rows: [] };
  const out = rows.map(r => ({ ...r }));
  const enrichment_rows = [];
  const n = Math.min(Math.max(1, maxLeads), out.length);

  for (let i = 0; i < n; i++) {
    let e = null;
    try {
      e = await enrichOneLead(out[i], brief, intent);
    } catch (err) {
      logger.warn(`[enrich] lead ${i}: ${err.message}`);
    }
    if (!e) continue;
    out[i] = {
      ...out[i],
      ...(isUsefulValue(e.company_name) ? { company_name: e.company_name } : {}),
      ...(e.company_summary ? { company_summary: e.company_summary } : {}),
      ...(isLikelyAddress(e.physical_site_address)
        ? {
            address: e.physical_site_address,
            needs_site_verification: false,
            site_verification_reason: 'Resolved by physical-site enrichment fallback.'
          }
        : {}),
      ...(e.best_contact_path ? { best_contact_path: e.best_contact_path } : {}),
      ...(e.news_risk_flag ? { news_risk_flag: e.news_risk_flag } : {}),
      ...(e.news_risk_note ? { news_risk_note: e.news_risk_note } : {}),
      ...(e.website ? { company_website: e.website } : {}),
      ...(e.key_people && e.key_people.length ? { key_people: e.key_people } : {}),
      ...(e.key_people && e.key_people.length && !isUsefulValue(out[i].key_contact_or_firm)
        ? { key_contact_or_firm: `${e.key_people[0].name}${e.key_people[0].role ? ` (${e.key_people[0].role})` : ''}` }
        : {})
    };
    enrichment_rows.push({
      index: i,
      company_name: e.company_name || 'Not found',
      company_website: e.website || '',
      key_people: e.key_people || [],
      news_risk_flag: e.news_risk_flag || 'low',
      confidence: e.enrichment_confidence || 'low',
      crawl_diagnostics: e.crawl_diagnostics || null
    });
  }

  return { leads: out, enrichment_rows };
}

module.exports = { enrichLeadsWithCompanyPeople };
