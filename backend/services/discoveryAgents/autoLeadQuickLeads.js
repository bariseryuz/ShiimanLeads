const logger = require('../../utils/logger');
const { getGeminiModel, isAIAvailable } = require('../ai/geminiClient');
const { readMultiplePagesWithDiagnostics } = require('./pageReader');

let _lastReadDiagnostics = null;

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

function splitTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 3)
    .slice(0, 12);
}

function extractEvidenceConstraints(brief) {
  const b = String(brief || '').toLowerCase();
  const includeTerms = [];
  const excludeTerms = [];
  const proofSignals = [];

  const usingMatch = b.match(/\b(?:uses?|using|with)\s+([^,.!?]{2,80})/i);
  if (usingMatch && usingMatch[1]) includeTerms.push(usingMatch[1].trim());

  const excludeMatch = b.match(/\b(?:besides|except|other than|not)\s+([^,.!?]{2,80})/i);
  if (excludeMatch && excludeMatch[1]) excludeTerms.push(excludeMatch[1].trim());

  if (/\brecipe|recipes\b/.test(b)) proofSignals.push('recipe');
  if (/\bmenu|menus\b/.test(b)) proofSignals.push('menu');
  if (/\bingredient|ingredients\b/.test(b)) proofSignals.push('ingredient');

  return {
    includeTerms: includeTerms.slice(0, 6),
    excludeTerms: excludeTerms.slice(0, 6),
    includeTokens: includeTerms.flatMap(splitTokens).slice(0, 12),
    excludeTokens: excludeTerms.flatMap(splitTokens).slice(0, 10),
    proofTokens: proofSignals.flatMap(splitTokens).slice(0, 8)
  };
}

const PLATFORM_PROVIDER_RE = /\b(socrata|arcgis|esri|tyler\s*tech|opendata\s*soft|accela)\b/i;

function sanitizeCompany(raw) {
  const c = String(raw || 'Not publicly stated').trim().slice(0, 180);
  return PLATFORM_PROVIDER_RE.test(c) ? 'Not publicly stated' : c;
}

function mapLeadFromAI(x, i, sources) {
  if (!x || typeof x !== 'object') return null;
  const src = Array.isArray(sources) ? sources : [];
  const allowed = new Set(src.map(s => s.url || s.source_url));
  const rawUrl = String(x.source_url || '').trim();
  const safeUrl = allowed.has(rawUrl) ? rawUrl : String(src[i]?.url || src[0]?.url || '').trim();
  const completenessRaw = String(x.data_completeness || '').toLowerCase().trim();
  const completeness = ['high', 'medium', 'low'].includes(completenessRaw) ? completenessRaw : 'low';
  return {
    lead_title: String(x.lead_title || x.project_name || '').trim().slice(0, 180) || 'Opportunity',
    project_name: String(x.project_name || x.lead_title || '').trim().slice(0, 180) || 'Opportunity',
    project_snapshot: String(x.project_snapshot || x.why_opportunity || '').trim().slice(0, 120) || 'Details on source page',
    location: String(x.location || 'See source').trim().slice(0, 140),
    address: String(x.address || 'Not publicly stated').trim().slice(0, 220),
    company_name: sanitizeCompany(x.company_name || x.key_contact_or_firm),
    permit_or_record_id: String(x.permit_or_record_id || 'Not publicly stated').trim().slice(0, 120),
    status_or_phase: String(x.status_or_phase || 'Not publicly stated').trim().slice(0, 120),
    estimated_value_usd: String(x.estimated_value_usd || 'Not publicly stated').trim().slice(0, 120),
    key_contact_or_firm: sanitizeCompany(x.key_contact_or_firm),
    why_opportunity: String(x.why_opportunity || '').trim().slice(0, 360) || 'Relevant to your search.',
    evidence: String(x.evidence || x.why_opportunity || '').trim().slice(0, 300) || 'Found on source page.',
    recommended_next_step: String(x.recommended_next_step || 'Review the source page and reach out to the decision maker.').trim().slice(0, 220),
    source_title: String(x.source_title || 'Source').trim().slice(0, 180),
    source_url: safeUrl,
    missing_fields: String(x.missing_fields || '').trim().slice(0, 220),
    data_completeness: completeness
  };
}

function passesEvidenceConstraints(lead, constraints, mode = 'strict') {
  if (!lead || typeof lead !== 'object') return false;
  const c = constraints || {};
  const includeTokens = Array.isArray(c.includeTokens) ? c.includeTokens : [];
  const excludeTokens = Array.isArray(c.excludeTokens) ? c.excludeTokens : [];
  const proofTokens = Array.isArray(c.proofTokens) ? c.proofTokens : [];
  if (!includeTokens.length && !excludeTokens.length && !proofTokens.length) return true;

  const evidenceBlob = [
    lead.lead_title,
    lead.project_name,
    lead.project_snapshot,
    lead.why_opportunity,
    lead.evidence
  ].join(' ').toLowerCase();

  for (const token of excludeTokens) {
    if (token && evidenceBlob.includes(token)) return false;
  }
  const includeHit = includeTokens.length
    ? includeTokens.some(t => t && evidenceBlob.includes(t))
    : true;
  const proofHit = proofTokens.length
    ? proofTokens.some(t => t && evidenceBlob.includes(t))
    : true;
  if (mode === 'strict') {
    if (!includeHit) return false;
    if (!proofHit) return false;
  } else {
    if (!(includeHit || proofHit)) return false;
  }
  return true;
}

function briefKeywordSet(brief) {
  const STOP = new Set([
    'the','and','for','with','from','into','that','this','these','those',
    'find','leads','lead','please','want','need','give','show','list',
    'looking','look','real','some','any','new','just','also','what','where',
    'near','about','using','have','has','had','your','our','their','there',
    'you','they','them','can','will','would','should','could','more','less',
    'all','only','one','two','three','many','per','than','then','been','being',
    'make','made','help','are','was','were','who','whom','which','why','how'
  ]);
  const words = String(brief || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
  return Array.from(new Set(words)).slice(0, 20);
}

function rankLinksByRelevance(links, intentTokens) {
  if (!Array.isArray(links) || !links.length) return [];
  const toks = (intentTokens || []).map(t => String(t || '').toLowerCase()).filter(Boolean);
  if (!toks.length) return [];
  const scored = [];
  for (const l of links) {
    if (!l || !l.url || !l.anchor) continue;
    const hay = `${l.anchor} ${l.url}`.toLowerCase();
    let score = 0;
    for (const t of toks) {
      if (!t) continue;
      if (hay.includes(t)) score += t.length >= 5 ? 3 : 2;
    }
    if (/\b(contact|directory|list|top|best|near|in\s+\w+)\b/.test(hay)) score += 1;
    if (l.anchor.length >= 20) score += 1;
    if (score > 0) scored.push({ link: l, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.link);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const u = String(it?.url || '').trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(it);
  }
  return out;
}

async function extractLeadsFromContext({ brief, sourceContext, allowedSources, constraints, desiredCount }) {
  if (!sourceContext || !sourceContext.trim()) return [];
  const model = getGeminiModel('discovery');
  const prompt =
    'You are a lead research assistant. The user described what they are looking for. ' +
    'I visited several web pages and extracted their text content for you below.\n\n' +
    'Your job: read through the page content carefully and find real, specific opportunities that match what the user wants. ' +
    'Extract concrete details you can see in the text: company names, project names, addresses, people mentioned, values, statuses.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":"high|medium|low"}]}\n\n' +
    'Rules:\n' +
    `- Return up to ${desiredCount} leads.\n` +
    '- Only use facts visible in the page text. Do not invent names, addresses, or numbers.\n' +
    '- company_name must be a real company/person from the text, not a platform name.\n' +
    '- evidence must quote or closely paraphrase a specific passage from the page.\n' +
    '- Leads must satisfy the user intent evidence requirements below.\n' +
    '- If a field is not in the text, use "Not publicly stated".\n' +
    '- source_url must be one of the provided source URLs.\n\n' +
    `EVIDENCE REQUIREMENTS:\n${JSON.stringify({
      must_include_terms: constraints.includeTerms,
      must_exclude_terms: constraints.excludeTerms,
      required_proof_signals: constraints.proofTokens
    }, null, 2)}\n\n` +
    `USER REQUEST:\n${String(brief || '').slice(0, 2000)}\n\n` +
    `PAGE CONTENT:\n${sourceContext.slice(0, 18000)}`;
  try {
    const result = await model.generateContent(prompt);
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const arr = Array.isArray(o?.leads) ? o.leads : [];
    const mappedBase = arr.map((x, i) => mapLeadFromAI(x, i, allowedSources)).filter(Boolean);
    const strict = mappedBase
      .filter(x => passesEvidenceConstraints(x, constraints, 'strict'))
      .slice(0, desiredCount);
    if (strict.length) return strict;
    const soft = mappedBase
      .filter(x => passesEvidenceConstraints(x, constraints, 'soft'))
      .slice(0, desiredCount)
      .map(x => ({
        ...x,
        data_completeness: x.data_completeness === 'high' ? 'medium' : 'low',
        missing_fields: x.missing_fields || 'Partial evidence match; refine required proof terms for stricter matching.'
      }));
    return soft;
  } catch (e) {
    logger.warn(`[autoLeadQuickLeads] extractLeadsFromContext: ${e.message}`);
    return [];
  }
}

function buildContextFromPages(pages, snippetSources) {
  let ctx = '';
  if (pages && pages.length) {
    ctx = pages.map((p, i) =>
      `--- Source ${i + 1}: ${p.title || 'Source'} (${p.url}) ---\n${String(p.text || '').slice(0, 3800)}\n`
    ).join('\n');
  }
  if (snippetSources && snippetSources.length) {
    ctx += '\n--- Additional sources (snippet only) ---\n';
    ctx += snippetSources.slice(0, 4).map(s =>
      `${s.title || 'Source'} (${s.url}): ${String(s.snippet || '').slice(0, 300)}`
    ).join('\n');
  }
  return ctx;
}

function mergeDiagnostics(a, b) {
  const base = a || { attempted: 0, readable: 0, failed: 0, failures: [] };
  const add = b || { attempted: 0, readable: 0, failed: 0, failures: [] };
  return {
    attempted: (base.attempted || 0) + (add.attempted || 0),
    readable: (base.readable || 0) + (add.readable || 0),
    failed: (base.failed || 0) + (add.failed || 0),
    failures: [...(base.failures || []), ...(add.failures || [])]
  };
}

async function buildAutoLeadQuickLeads({ brief, sources, targetLeads, intent }) {
  const src = Array.isArray(sources) ? sources : [];
  if (!src.length) return [];
  const desiredCount = Math.min(25, Math.max(1, parseInt(targetLeads, 10) || 3));
  const constraints = extractEvidenceConstraints(brief);

  if (!isAIAvailable()) {
    logger.warn('[autoLeadQuickLeads] AI not available, returning empty');
    return [];
  }

  const intentTokens = Array.from(new Set([
    ...briefKeywordSet(brief),
    ...(constraints.includeTokens || []),
    ...(constraints.proofTokens || [])
  ]));

  // PHASE A: Read top sources.
  const firstBatchMax = Math.min(6, src.length);
  logger.info(`[autoLeadQuickLeads] PhaseA reading ${firstBatchMax} pages from ${src.length} candidates`);
  const phaseA = await readMultiplePagesWithDiagnostics(src, firstBatchMax);
  const pagesA = Array.isArray(phaseA?.pages) ? phaseA.pages : [];
  let diag = phaseA?.diagnostics || { attempted: firstBatchMax, readable: pagesA.length, failed: Math.max(0, firstBatchMax - pagesA.length), failures: [] };
  logger.info(`[autoLeadQuickLeads] PhaseA readable=${pagesA.length}`);

  const readUrls = new Set(pagesA.map(p => p.url));
  const unreadFirstBatch = src.slice(0, firstBatchMax).filter(s => !readUrls.has(s.url));

  const ctxA = buildContextFromPages(pagesA, unreadFirstBatch);
  let leads = [];
  if (ctxA.trim()) {
    leads = await extractLeadsFromContext({
      brief,
      sourceContext: ctxA,
      allowedSources: src,
      constraints,
      desiredCount
    });
    if (leads.length) {
      logger.info(`[autoLeadQuickLeads] PhaseA produced ${leads.length} leads`);
      _lastReadDiagnostics = diag;
      return leads;
    }
  }

  // PHASE B: Follow relevant inner links from pages we already read.
  const innerCandidates = [];
  for (const p of pagesA) {
    const ranked = rankLinksByRelevance(p.links, intentTokens);
    for (const l of ranked.slice(0, 4)) {
      innerCandidates.push({ url: l.url, title: l.anchor, from: p.url });
    }
  }
  const innerUnique = dedupeByUrl(innerCandidates)
    .filter(l => !readUrls.has(l.url))
    .slice(0, 6);

  if (innerUnique.length) {
    logger.info(`[autoLeadQuickLeads] PhaseB following ${innerUnique.length} inner links`);
    const phaseB = await readMultiplePagesWithDiagnostics(innerUnique, innerUnique.length);
    const pagesB = Array.isArray(phaseB?.pages) ? phaseB.pages : [];
    diag = mergeDiagnostics(diag, phaseB?.diagnostics);
    pagesB.forEach(p => readUrls.add(p.url));
    logger.info(`[autoLeadQuickLeads] PhaseB readable=${pagesB.length}`);

    // Treat inner pages as additional sources so mapLeadFromAI accepts their URLs.
    const combinedSources = [
      ...src,
      ...pagesB.map(p => ({ url: p.url, title: p.title, snippet: '' }))
    ];
    const ctxB = buildContextFromPages([...pagesA, ...pagesB], unreadFirstBatch);
    if (ctxB.trim()) {
      leads = await extractLeadsFromContext({
        brief,
        sourceContext: ctxB,
        allowedSources: combinedSources,
        constraints,
        desiredCount
      });
      if (leads.length) {
        logger.info(`[autoLeadQuickLeads] PhaseB produced ${leads.length} leads`);
        _lastReadDiagnostics = diag;
        return leads;
      }
    }
  }

  // PHASE C: Try the next batch of search sources we haven't touched yet.
  const remaining = src.slice(firstBatchMax).filter(s => !readUrls.has(s.url));
  if (remaining.length) {
    const nextMax = Math.min(6, remaining.length);
    logger.info(`[autoLeadQuickLeads] PhaseC reading ${nextMax} more pages`);
    const phaseC = await readMultiplePagesWithDiagnostics(remaining, nextMax);
    const pagesC = Array.isArray(phaseC?.pages) ? phaseC.pages : [];
    diag = mergeDiagnostics(diag, phaseC?.diagnostics);
    pagesC.forEach(p => readUrls.add(p.url));
    logger.info(`[autoLeadQuickLeads] PhaseC readable=${pagesC.length}`);

    const allPages = [...pagesA, ...pagesC];
    const unreadAll = src.filter(s => !readUrls.has(s.url)).slice(0, 6);
    const ctxC = buildContextFromPages(allPages, unreadAll);
    if (ctxC.trim()) {
      leads = await extractLeadsFromContext({
        brief,
        sourceContext: ctxC,
        allowedSources: src,
        constraints,
        desiredCount
      });
      if (leads.length) {
        logger.info(`[autoLeadQuickLeads] PhaseC produced ${leads.length} leads`);
        _lastReadDiagnostics = diag;
        return leads;
      }
    }
  }

  _lastReadDiagnostics = diag;

  // PHASE D: Snippet-only last resort.
  logger.info('[autoLeadQuickLeads] PhaseD snippet-only fallback');
  const model = getGeminiModel('discovery');
  const snippetPrompt =
    'You are a lead research assistant. I could not fully read the source pages, but here are search result snippets.\n' +
    'Find the best opportunities matching the user request from these snippets.\n\n' +
    'Return ONLY valid JSON:\n' +
    '{"leads":[{"lead_title":"","project_name":"","project_snapshot":"","location":"","address":"","company_name":"","permit_or_record_id":"","status_or_phase":"","estimated_value_usd":"","key_contact_or_firm":"","why_opportunity":"","evidence":"","recommended_next_step":"","source_title":"","source_url":"","missing_fields":"","data_completeness":"high|medium|low"}]}\n\n' +
    `Return up to ${desiredCount} leads. Only use facts from snippets. Do not invent.\n` +
    `Apply evidence requirements:\n${JSON.stringify({
      must_include_terms: constraints.includeTerms,
      must_exclude_terms: constraints.excludeTerms,
      required_proof_signals: constraints.proofTokens
    }, null, 2)}\n\n` +
    `USER REQUEST:\n${String(brief || '').slice(0, 2000)}\n\n` +
    `SNIPPETS:\n${JSON.stringify(src.slice(0, 8), null, 2)}`;
  try {
    const result = await model.generateContent(snippetPrompt);
    const raw = (await result.response).text();
    const o = parseJson(raw);
    const arr = Array.isArray(o?.leads) ? o.leads : [];
    const mappedBase = arr.map((x, i) => mapLeadFromAI(x, i, src)).filter(Boolean);
    const strict = mappedBase
      .filter(x => passesEvidenceConstraints(x, constraints, 'strict'))
      .slice(0, desiredCount);
    if (strict.length) return strict;
    const soft = mappedBase
      .filter(x => passesEvidenceConstraints(x, constraints, 'soft'))
      .slice(0, desiredCount)
      .map(x => ({
        ...x,
        data_completeness: x.data_completeness === 'high' ? 'medium' : 'low',
        missing_fields: x.missing_fields || 'Partial evidence match from snippet-only fallback.'
      }));
    if (soft.length) return soft;
  } catch (e) {
    logger.warn(`[autoLeadQuickLeads] snippet AI: ${e.message}`);
  }

  return [];
}

function getLastQuickLeadReadDiagnostics() {
  return _lastReadDiagnostics;
}

module.exports = { buildAutoLeadQuickLeads, getLastQuickLeadReadDiagnostics };
