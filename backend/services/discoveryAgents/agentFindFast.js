/**
 * Fast scout for quick-only mode.
 * Goal: return candidate source snippets quickly (no deep query expansion, no browser).
 */

const { hasSerper, googleSearchOrganic, dedupeSearchResults, normalizeUrlKey } = require('../serperSearch');
const { sortCandidateSources } = require('../candidateUrlSort');
const { parseBriefWithGemini, buildSerperQueries, buildMachineParameters } = require('../ai/nlLeadIntent');

function uniq(items, max = 12) {
  return [...new Set((Array.isArray(items) ? items : []).map(x => String(x || '').trim()).filter(Boolean))].slice(0, max);
}

function extractOfferFromBrief(brief) {
  const b = String(brief || '').trim();
  if (!b) return '';
  const m1 = b.match(/\b(?:i\s+sell|we\s+sell|i\s+offer|we\s+offer|my\s+service\s+is|our\s+service\s+is)\s+([^,.!?]{3,80})/i);
  if (m1 && m1[1]) return String(m1[1]).trim();
  const m2 = b.match(/\b(?:looking\s+to\s+sell|want\s+to\s+sell)\s+([^,.!?]{3,80})/i);
  if (m2 && m2[1]) return String(m2[1]).trim();
  return '';
}

function splitPhraseTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .slice(0, 8);
}

function buildEvidenceHintsFromBrief(brief) {
  const b = String(brief || '').toLowerCase();
  const includeTerms = [];
  const excludeTerms = [];
  const proofSignals = [];

  const usingMatch = b.match(/\b(?:uses?|using|with)\s+([^,.!?]{2,80})/i);
  if (usingMatch && usingMatch[1]) includeTerms.push(usingMatch[1].trim());

  const forMatch = b.match(/\bfor\s+([^,.!?]{2,80})/i);
  if (forMatch && /recipe|menu|ingredient|dish|drink|dessert/i.test(forMatch[1])) {
    includeTerms.push(forMatch[1].trim());
  }

  const excludeMatch = b.match(/\b(?:besides|except|other than|not)\s+([^,.!?]{2,80})/i);
  if (excludeMatch && excludeMatch[1]) excludeTerms.push(excludeMatch[1].trim());

  if (/\brecipe|recipes\b/.test(b)) proofSignals.push('recipe');
  if (/\bmenu|menus\b/.test(b)) proofSignals.push('menu');
  if (/\bingredient|ingredients\b/.test(b)) proofSignals.push('ingredient');
  if (/\bcoffee bean|coffee beans\b/.test(b)) proofSignals.push('coffee bean');

  const includeTokens = uniq(includeTerms.flatMap(splitPhraseTokens), 12);
  const excludeTokens = uniq(excludeTerms.flatMap(splitPhraseTokens), 10);
  const proofTokens = uniq(proofSignals.flatMap(splitPhraseTokens), 10);

  return {
    includeTerms: uniq(includeTerms, 6),
    excludeTerms: uniq(excludeTerms, 6),
    includeTokens,
    excludeTokens,
    proofTokens
  };
}

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildBuyerIntentProfile(brief, intent) {
  const b = String(brief || '').toLowerCase();
  const offer = extractOfferFromBrief(brief) || String(intent?.asset_or_use || '').trim();
  const offerLower = String(offer || '').toLowerCase();

  const companyTypes = [];
  const demandSignals = [];
  const siteTargets = [];

  if (/lead gen|lead generation|appointment setting|cold email|outreach/.test(`${b} ${offerLower}`)) {
    companyTypes.push(
      'marketing agency',
      'real estate brokerage',
      'solar installer',
      'roofing company',
      'law firm',
      'med spa',
      'b2b saas',
      'recruiting agency'
    );
    demandSignals.push(
      'needs more leads',
      'book more appointments',
      'hiring sales reps',
      'expanding to new markets',
      'performance marketing budget'
    );
    siteTargets.push(
      'clutch.co',
      'linkedin.com/company',
      'indeed.com',
      'wellfound.com',
      'crunchbase.com',
      'g2.com'
    );
  } else if (/seo|ads|ppc|marketing/.test(`${b} ${offerLower}`)) {
    companyTypes.push('local business', 'ecommerce brand', 'startup', 'agency');
    demandSignals.push('looking for growth', 'hiring marketing manager', 'paid ads spend');
    siteTargets.push('linkedin.com/company', 'indeed.com', 'crunchbase.com');
  } else if (/restaurant|caf[eé]|bakery|bar|bistro|menu|recipe|ingredient|food/i.test(`${b} ${offerLower}`)) {
    companyTypes.push('restaurant', 'cafe', 'bakery', 'bar', 'food business');
    demandSignals.push('menu update', 'new dish', 'seasonal menu', 'ingredient sourcing');
    siteTargets.push('yelp.com', 'tripadvisor.com', 'doordash.com', 'grubhub.com', 'restaurantji.com');
  } else {
    companyTypes.push(
      String(intent?.asset_or_use || '').trim() || 'business',
      'company',
      'agency',
      'vendor'
    );
    demandSignals.push(
      String(intent?.trigger_or_record || '').trim() || 'growth signal',
      'expansion',
      'hiring',
      'new contracts'
    );
    siteTargets.push('linkedin.com/company', 'clutch.co', 'crunchbase.com');
  }

  const offerToken = offer ? offer.replace(/\s+/g, ' ').trim().slice(0, 60) : 'lead generation service';
  const queryStems = uniq([
    `"${offerToken}" buyer`,
    `"${offerToken}" companies`,
    `${offerToken} best fit clients`,
    `companies that need ${offerToken}`,
    ...companyTypes.slice(0, 4).map(c => `${c} looking for leads`)
  ], 8);

  return {
    offer: offerToken,
    companyTypes: uniq(companyTypes, 8),
    demandSignals: uniq(demandSignals, 8),
    siteTargets: uniq(siteTargets, 8),
    queryStems
  };
}

function classifySearchMode(brief, intent) {
  const b = normalizeText(brief);
  const trigger = normalizeText(intent?.trigger_or_record || '');
  const asset = normalizeText(intent?.asset_or_use || '');
  const recordLike = /\b(permit|permits|constr\w*|project|develop\w*|bid|rfp|issued|inspection|license|violation|planning|zoning|arcgis|featureserver|mapserver|socrata|open data)\b/.test(
    `${b} ${trigger} ${asset}`
  );
  const sellingLike = /\b(i sell|we sell|i offer|we offer|lead gen|lead generation|appointment setting|cold email|outreach|clients for)\b/.test(
    b
  );
  if (recordLike && !sellingLike) return 'record_hunt';
  return 'buyer_intent';
}

function fallbackIntentFromBrief(brief) {
  const b = String(brief || '').trim();
  const NUMBER_WORDS = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };
  const minMatch = b.match(/(?:over|above|>=?)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s*(k|m|million))?/i);
  let minVal = null;
  if (minMatch) {
    const raw = parseFloat(String(minMatch[1] || '').replace(/,/g, ''));
    const unit = String(minMatch[2] || '').toLowerCase();
    if (Number.isFinite(raw)) {
      minVal = /m|million/.test(unit) ? raw * 1000000 : /k/.test(unit) ? raw * 1000 : raw;
    }
  }
  const countDigitMatch = b.match(/\b(?:find|give|get|show|return)\s+(\d{1,2})\b/i) || b.match(/\b(\d{1,2})\s+leads?\b/i);
  const countWordMatch = b.match(/\b(?:find|give|get|show|return)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i) ||
    b.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+leads?\b/i);
  const requestedLeadCount = countDigitMatch
    ? parseInt(countDigitMatch[1], 10)
    : (countWordMatch ? NUMBER_WORDS[String(countWordMatch[1]).toLowerCase()] : null);
  const st = b.match(/\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY|DC)\b/i);
  const triggerHint = /permit|constr\w*|project|bid|develop\w*/i.test(b)
    ? 'building permit'
    : (/agency|client|customer|company|software|saas|lead gen|prospect/i.test(b)
      ? 'buyer intent signal'
      : 'business signal');
  return {
    lead_count: Math.min(25, Math.max(1, requestedLeadCount || 3)),
    geography: st ? `United States (${String(st[1]).toUpperCase()})` : 'United States',
    geography_kind: st ? 'state' : 'unknown',
    state_code: st ? String(st[1]).toUpperCase() : '',
    asset_or_use: '',
    trigger_or_record: triggerHint,
    min_project_value_usd: minVal,
    wants_contact_info: /contact|owner|contractor|gc|manager|people/i.test(b),
    keywords_for_search: []
  };
}

function buildFastQueries(brief) {
  const b = String(brief || '').trim().replace(/\s+/g, ' ');
  if (!b) return [];
  return [
    `${b} potential clients OR opportunities OR signals`,
    `${b} site:gov OR site:org OR site:com`
  ].map(q => q.slice(0, 220));
}

function buildFastQueriesFromIntent(intent, brief, opts = {}) {
  const nonTechnical = opts.nonTechnical === true;
  const buyerProfile = opts.buyerProfile || null;
  const searchMode = String(opts.searchMode || '');
  const evidenceHints = opts.evidenceHints || null;
  const i = intent && typeof intent === 'object' ? intent : {};
  const geo = String(i.geography || '').trim();
  const trigger = String(i.trigger_or_record || 'building permit').trim();
  const vertical = String(i.asset_or_use || '').trim();
  const minVal = i.min_project_value_usd != null && Number.isFinite(Number(i.min_project_value_usd))
    ? Math.floor(Number(i.min_project_value_usd))
    : null;
  const valToken = minVal ? `>${minVal}` : '';
  const intentQueries = buildSerperQueries(i)
    .map(q => String(q || '').trim())
    .filter(q => q.length > 4);

  const targeted = (nonTechnical
    ? (searchMode === 'record_hunt'
      ? [
          [geo, vertical || 'commercial', trigger, 'issued', 'new records', valToken].filter(Boolean).join(' '),
          [geo, trigger, 'open data', 'site:gov'].filter(Boolean).join(' '),
          [geo, 'DOB permits', 'multifamily', 'site:gov OR site:nyc.gov'].filter(Boolean).join(' '),
          [geo, 'building permit database', 'project address', 'valuation'].filter(Boolean).join(' '),
          [geo, 'developer project announcement', vertical || 'multifamily'].filter(Boolean).join(' ')
        ]
      : [
          [geo, vertical || 'business', trigger, 'potential clients', valToken].filter(Boolean).join(' '),
          [geo, trigger, 'buyer intent', 'decision maker'].filter(Boolean).join(' '),
          [geo, 'companies', 'hiring', 'agency', 'vendor'].filter(Boolean).join(' '),
          [geo, 'new opportunities', 'lead list', 'qualified prospects'].filter(Boolean).join(' '),
          ...(buyerProfile
            ? [
                [geo, buyerProfile.offer, 'target companies', buyerProfile.companyTypes[0] || 'business'].filter(Boolean).join(' '),
                [geo, buyerProfile.companyTypes[1] || 'company', buyerProfile.demandSignals[0] || 'needs leads'].filter(Boolean).join(' '),
                [geo, buyerProfile.queryStems[0] || 'companies that need lead generation'].filter(Boolean).join(' '),
                [geo, buyerProfile.queryStems[1] || 'buyer intent', buyerProfile.siteTargets[0] ? `site:${buyerProfile.siteTargets[0]}` : ''].filter(Boolean).join(' ')
              ]
            : [])
        ])
    : [
        [geo, vertical, trigger, valToken, 'open data API FeatureServer Socrata'].filter(Boolean).join(' '),
        [geo, trigger, 'site:gov data portal json'].filter(Boolean).join(' '),
        [geo, vertical || 'commercial', '"resource" ".json" site:data.*.gov permits valuation'].filter(Boolean).join(' '),
        [geo, '"dev.socrata.com/foundry"', '"resource" ".json"'].filter(Boolean).join(' '),
        [geo, trigger, '"FeatureServer" "query?f=json"'].filter(Boolean).join(' '),
        [geo, trigger, '"Open Data" "JSON API"'].filter(Boolean).join(' ')
      ])
    .map(q => q.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const rawFallback = buildFastQueries(brief);
  const evidenceQueries = [];
  if (searchMode !== 'record_hunt' && evidenceHints) {
    const include = (evidenceHints.includeTerms || [])[0] || (evidenceHints.proofTokens || [])[0] || '';
    const exclude = (evidenceHints.excludeTerms || [])[0] || '';
    const proof = (evidenceHints.proofTokens || []).slice(0, 2).join(' ');
    if (include) {
      evidenceQueries.push(
        [geo, vertical || 'business', include, 'menu OR recipes OR ingredients'].filter(Boolean).join(' ')
      );
      evidenceQueries.push(
        [geo, vertical || 'business', include, 'site:*.com'].filter(Boolean).join(' ')
      );
    }
    if (include || proof) {
      evidenceQueries.push(
        [geo, vertical || 'business', proof || include, '"about" OR "menu" OR "our ingredients"'].filter(Boolean).join(' ')
      );
    }
    if (exclude) {
      evidenceQueries.push(
        [geo, vertical || 'business', include || 'target business', `-"${exclude}"`].filter(Boolean).join(' ')
      );
    }
  }
  return [...new Set([...targeted, ...intentQueries, ...evidenceQueries, ...rawFallback])].slice(0, 8).map(q => q.slice(0, 220));
}

function isLowSignalArticle(link, title) {
  const u = String(link || '').toLowerCase();
  const t = String(title || '').toLowerCase();
  if (/medium\.com|substack\.com|wordpress|blogspot|wixsite/.test(u)) return true;
  if (/github\.com|observablehq\.com|npmjs\.com|stackoverflow\.com/.test(u)) return true;
  if (/wikipedia\.org|reddit\.com|quora\.com/.test(u)) return true;
  if (/dev\.socrata\.com\/foundry\//.test(u)) return true;
  if (/\/foundry\//.test(u) && /socrata/.test(u)) return true;
  if (/\/docs?\//.test(u) || /\/documentation\//.test(u) || /\/api\//.test(u) && /(guide|docs|reference)/.test(u)) return true;
  if (/\/about($|[/?#])/.test(u) && /(data\.|opendata|hub\.arcgis)/.test(u)) return true;
  if (/\.pdf($|\?)/.test(u)) return true;
  if (/\/(report|whitepaper|ebook|brochure)\//.test(u)) return true;
  if (/\/(blog|news|article|guide|insight|press-release)\//.test(u)) return true;
  if (/(guide|tutorial|how to|introduction|quickstart|api key|sdk|reference|swagger|cost per sq ft|tips|market report|quarterly report|pipeline report)/.test(t)) return true;
  return false;
}

function hasProjectSignal(result, brief) {
  const blob = `${String(result?.title || '')} ${String(result?.snippet || '')} ${String(result?.link || '')}`.toLowerCase();
  const baseSignals = /\b(project|construction|permit|development|building|contractor|owner|applicant|gc|architect|bid|proposal|issued|active|client|customer|company|agency|vendor|buyer|decision maker|prospect|hiring|rfp|request for proposal|growth|pipeline|appointments|qualified leads|demand gen|outbound|inbound|booked calls)\b/;
  if (baseSignals.test(blob)) return true;
  const b = String(brief || '').toLowerCase();
  const tokens = b.split(/[^a-z0-9]+/).filter(x => x.length > 3).slice(0, 8);
  return tokens.some(tok => blob.includes(tok));
}

function scoreResultForBuyerIntent(result, brief, buyerProfile, evidenceHints) {
  const blob = `${String(result?.title || '')} ${String(result?.snippet || '')} ${String(result?.link || '')}`.toLowerCase();
  let score = 0;
  if (hasProjectSignal(result, brief)) score += 2;
  if (buyerProfile) {
    for (const d of buyerProfile.siteTargets || []) {
      if (d && String(result?.link || '').toLowerCase().includes(String(d).toLowerCase())) score += 3;
    }
    for (const c of buyerProfile.companyTypes || []) {
      const token = String(c || '').toLowerCase();
      if (token && blob.includes(token)) score += 2;
    }
    for (const s of buyerProfile.demandSignals || []) {
      const token = String(s || '').toLowerCase();
      if (token && blob.includes(token)) score += 2;
    }
    const offer = String(buyerProfile.offer || '').toLowerCase();
    if (offer && blob.includes(offer)) score += 2;
  }
  if (evidenceHints) {
    const includeTokens = Array.isArray(evidenceHints.includeTokens) ? evidenceHints.includeTokens : [];
    const excludeTokens = Array.isArray(evidenceHints.excludeTokens) ? evidenceHints.excludeTokens : [];
    const proofTokens = Array.isArray(evidenceHints.proofTokens) ? evidenceHints.proofTokens : [];
    for (const token of includeTokens.slice(0, 8)) {
      if (token && blob.includes(token)) score += 2;
    }
    for (const token of proofTokens.slice(0, 6)) {
      if (token && blob.includes(token)) score += 1;
    }
    for (const token of excludeTokens.slice(0, 6)) {
      if (token && blob.includes(token)) score -= 4;
    }
  }
  return score;
}

function isOffTopicForRecordHunt(result) {
  const blob = `${String(result?.title || '')} ${String(result?.snippet || '')} ${String(result?.link || '')}`.toLowerCase();
  return /\b(staffing|employment agency|recruitment agency|temporary staffing|jobs board|job posting|headhunter|job recruiter|find a job|career)\b/.test(blob);
}

function isGovOrDataSource(result) {
  const link = String(result?.link || '').toLowerCase();
  const title = String(result?.title || '').toLowerCase();
  const snippet = String(result?.snippet || '').toLowerCase();
  if (/\.gov(\/|$)/.test(link) || /site:gov/.test(link)) return true;
  if (/featureserver|mapserver|arcgis|socrata|opendata|open data|\/resource\//.test(`${link} ${title} ${snippet}`)) return true;
  return false;
}

async function runAgentFindFast(brief, opts = {}) {
  const nonTechnical = opts.nonTechnical === true;
  let intent = null;
  try {
    intent = await parseBriefWithGemini(brief);
  } catch (e) {
    intent = fallbackIntentFromBrief(brief);
  }
  const searchMode = classifySearchMode(brief, intent);
  const buyerProfile = nonTechnical ? buildBuyerIntentProfile(brief, intent) : null;
  const evidenceHints = nonTechnical ? buildEvidenceHintsFromBrief(brief) : null;
  const machineParameters = buildMachineParameters(intent);
  const queries = buildFastQueriesFromIntent(intent, brief, { nonTechnical, buyerProfile, searchMode, evidenceHints });
  if (!hasSerper() || !queries.length) {
    return {
      intent: { mode: 'fast', ...(intent || {}) },
      machine_parameters: machineParameters,
      search_queries_used: [],
      results_pooled: 0,
      candidate_sources: [],
      preview_note: 'Fast mode needs SERPER_API_KEY.',
      disclaimer: 'Quick mode gives a fast web-style summary and may miss details.'
    };
  }

  const maxCalls = Math.min(5, parseInt(process.env.AUTO_LEADS_FAST_SERPER_CALLS || '5', 10) || 5);
  const useQueries = queries.slice(0, Math.min(maxCalls, queries.length));
  const all = [];
  const results = await Promise.allSettled(
    useQueries.map(q => googleSearchOrganic(q, { num: 8 }))
  );
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const q = useQueries[i];
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const r of res.value) {
      all.push({ ...r, sourceQuery: q });
    }
  }

  let deduped = dedupeSearchResults(all)
    .filter(r => /^https?:\/\//i.test(String(r.link || '')))
    .filter(r => !isLowSignalArticle(r.link, r.title));
  if (searchMode === 'record_hunt') {
    deduped = deduped
      .filter(r => !isOffTopicForRecordHunt(r))
      .map(r => {
        const textBlob = `${String(r.title || '')} ${String(r.snippet || '')}`.toLowerCase();
        let score = 0;
        if (isGovOrDataSource(r)) score += 4;
        if (/\b(permit|constr\w*|project|issued|zoning|inspection|contract|tender|rfp)\b/.test(textBlob)) score += 2;
        if (/\b(staffing|recruit|jobs?)\b/.test(textBlob)) score -= 6;
        return { ...r, _recordScore: score };
      })
      .sort((a, b) => (b._recordScore || 0) - (a._recordScore || 0));
  }
  const prioritized = nonTechnical
    ? deduped
        .map(r => ({ ...r, _score: scoreResultForBuyerIntent(r, brief, buyerProfile, evidenceHints) }))
        .filter(r => r._score > 0)
        .sort((a, b) => b._score - a._score)
    : deduped;
  const pool = prioritized.length ? prioritized : deduped;

  const uniqByUrl = new Map();
  for (const r of pool) {
    const k = normalizeUrlKey(r.link);
    if (!uniqByUrl.has(k)) uniqByUrl.set(k, r);
  }

  const candidate_sources = sortCandidateSources(
    [...uniqByUrl.values()].slice(0, 8).map(r => ({
      title: r.title || 'Source',
      url: r.link,
      snippet: String(r.snippet || '').slice(0, 400),
      sourceQuery: r.sourceQuery
    }))
  );

  return {
    intent: { mode: 'fast', ...(intent || {}) },
    machine_parameters: machineParameters,
    search_queries_used: useQueries,
    results_pooled: pool.length,
    candidate_sources,
    preview_note: candidate_sources.length ? null : 'Fast scout found weak sources; try adding what you sell + who should buy + location.',
    disclaimer: 'Quick mode is a fast, chat-style web summary. Use full extract only when you need strict structured output.'
  };
}

module.exports = { runAgentFindFast };

