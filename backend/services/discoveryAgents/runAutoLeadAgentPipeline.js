/**
 * Multi-agent orchestration for POST /api/discover/auto-leads
 *
 * Implemented with @langchain/langgraph (StateGraph): find → read → verify (post-read).
 * Agent A = find (scout queries) | Agent B = read | Agent C = verify (post-read quality gate).
 * api_hunter is a stubborn JSON/Serper fallback between read and verify when rows are empty.
 *
 * Same API keys as before (GEMINI + SERPER); LangGraph manages flow, not credentials.
 */

const logger = require('../../utils/logger');
const { runAgentFind } = require('./agentFind');
const { runAgentVerifyPlan, runAgentVerifyFilterBatch } = require('./agentVerifyShape');
const { runAgentRead } = require('./agentRead');
const { AGENT_FIND, AGENT_READ, AGENT_VERIFY, AGENT_API_HUNTER } = require('./agentConstants');
const { buildAutoLeadQuickRead } = require('./autoLeadQuickRead');
const { runAgentApiHunter } = require('./agentApiHunter');
const { enrichSalesIntelligenceTable } = require('./salesIntelligenceEnrichment');

function dedupeLeads(rows, maxLeads) {
  const seen = new Set();
  const out = [];
  for (const L of rows) {
    if (!L || typeof L !== 'object') continue;
    const sig = JSON.stringify(L).slice(0, 2500);
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(L);
    if (out.length >= maxLeads) break;
  }
  return out;
}

/** @type {Promise<import('@langchain/langgraph').CompiledStateGraph> | null} */
let compiledGraphPromise = null;

/**
 * Build once: Find → (if URLs) Read → Verify; if Read=0 rows then api_hunter then Verify.
 * If no URLs: Find → END.
 * Uses dynamic import because @langchain/langgraph is ESM-only.
 */
function getCompiledAutoLeadGraph() {
  if (!compiledGraphPromise) {
    compiledGraphPromise = (async () => {
      const { StateGraph, Annotation, START, END } = await import('@langchain/langgraph');

      const AutoLeadState = Annotation.Root({
        brief: Annotation(),
        userId: Annotation(),
        req: Annotation(),
        maxLeads: Annotation(),
        maxSites: Annotation(),
        discovery: Annotation(),
        preManifest: Annotation(),
        manifest: Annotation(),
        collected: Annotation(),
        verified: Annotation(),
        strictFilterApplied: Annotation(),
        urlsAttempted: Annotation(),
        noUrls: Annotation(),
        hunterRan: Annotation()
      });

      async function nodeFind(state) {
        logger.info(`[langgraph] node ${AGENT_FIND}`);
        const discovery = await runAgentFind(state.brief);
        const noUrls = !discovery.candidate_sources?.length;
        return { discovery, noUrls };
      }

      async function nodeRead(state) {
        logger.info(`[langgraph] node ${AGENT_READ}`);
        const preManifest = await runAgentVerifyPlan(state.brief);
        const { collected, urlsAttempted } = await runAgentRead({
          brief: state.brief,
          userId: state.userId,
          req: state.req,
          manifest: preManifest,
          candidates: state.discovery.candidate_sources,
          maxLeads: state.maxLeads,
          maxSites: state.maxSites,
          intent: state.discovery.intent
        });
        const rows = Array.isArray(collected) ? collected : [];
        return { preManifest, collected: rows, urlsAttempted, hunterRan: false };
      }

      async function nodeApiHunter(state) {
        const rows = Array.isArray(state.collected) ? state.collected : [];
        if (rows.length) {
          return {};
        }
        logger.info(`[langgraph] node ${AGENT_API_HUNTER} (stubborn JSON / Serper)`);
        const maxSites = Math.min(12, parseInt(state.maxSites, 10) + 5);
        const { collected, urlsAttempted } = await runAgentApiHunter({
          brief: state.brief,
          manifest: state.preManifest,
          candidates: state.discovery.candidate_sources,
          maxLeads: state.maxLeads,
          maxSites,
          intent: state.discovery.intent
        });
        const prev = Array.isArray(state.urlsAttempted) ? state.urlsAttempted : [];
        const merged = [...prev, ...(urlsAttempted || [])];
        return {
          collected: Array.isArray(collected) ? collected : [],
          urlsAttempted: merged,
          hunterRan: true
        };
      }

      async function nodeVerify(state) {
        logger.info(`[langgraph] node ${AGENT_VERIFY} (post-read filter/shape)`);
        const manifest = state.preManifest || (await runAgentVerifyPlan(state.brief));
        const rows = Array.isArray(state.collected) ? state.collected : [];
        if (!rows.length) {
          return { manifest, verified: [], strictFilterApplied: true };
        }
        const { leads: filtered, applied } = await runAgentVerifyFilterBatch(
          state.brief,
          manifest.strict_match_rules,
          rows
        );
        return {
          manifest,
          verified: Array.isArray(filtered) ? filtered : [],
          strictFilterApplied: !!applied
        };
      }

      const graph = new StateGraph(AutoLeadState)
        .addNode('find', nodeFind)
        .addNode('read', nodeRead)
        .addNode('api_hunter', nodeApiHunter)
        .addNode('verify', nodeVerify)
        .addEdge(START, 'find')
        .addConditionalEdges(
          'find',
          state => (state.noUrls ? 'end' : 'read'),
          { end: END, read: 'read' }
        )
        .addConditionalEdges(
          'read',
          state => {
            const n = Array.isArray(state.collected) ? state.collected.length : 0;
            return n > 0 ? 'verify' : 'hunt';
          },
          { verify: 'verify', hunt: 'api_hunter' }
        )
        .addEdge('api_hunter', 'verify')
        .addEdge('verify', END);

      return graph.compile();
    })();
  }
  return compiledGraphPromise;
}

/**
 * @param {{
 *   userId: number,
 *   brief: string,
 *   req: import('express').Request,
 *   maxLeads?: number,
 *   maxSites?: number,
 *   quickOnly?: boolean
 * }} opts
 */
async function runAutoLeadAgentPipeline(opts) {
  const b = String(opts.brief || '').trim();
  const maxLeads = Math.min(50, Math.max(1, parseInt(opts.maxLeads, 10) || 15));
  const maxSites = Math.min(5, Math.max(1, parseInt(opts.maxSites, 10) || 3));
  const quickOnly =
    opts.quickOnly === true ||
    String(process.env.AUTO_LEADS_QUICK_ONLY || '').toLowerCase() === 'true';

  /** Find + conversational brief only — no verify/read (no browser row extract). */
  if (quickOnly) {
    logger.info(
      `[agent-pipeline] quick_only — ${AGENT_FIND} + assistant prose (skip ${AGENT_VERIFY}/${AGENT_READ})`
    );
    const discovery = await runAgentFind(b);
    const noUrls = !discovery.candidate_sources?.length;
    const candidate_sources = noUrls ? [] : discovery.candidate_sources;
    const quick_read = await buildAutoLeadQuickRead({
      brief: b,
      intent: discovery.intent,
      candidate_sources,
      leads: [],
      urls_attempted: [],
      noSearchHits: noUrls
    });
    return {
      success: true,
      mode: 'auto_leads',
      orchestration: 'quick_only',
      agent_pipeline: [AGENT_FIND, 'assistant_quick_read'],
      quick_only: true,
      ...(quick_read ? { quick_read } : {}),
      intent: discovery.intent,
      search_queries_used: discovery.search_queries_used,
      search_queries_expanded: discovery.search_queries_expanded,
      results_pooled: discovery.results_pooled,
      candidate_sources,
      urls_attempted: [],
      leads: [],
      field_schema: null,
      strict_match_rules: null,
      strict_filter_applied: false,
      note: noUrls
        ? discovery.preview_note ||
          'No candidate URLs from search. Set SERPER_API_KEY and try a more specific location or record type.'
        : 'Fast answer only — no spreadsheet rows or browser extract this run. Turn off “Fast answer” for full extraction.',
      preview_note: discovery.preview_note,
      disclaimer: discovery.disclaimer
    };
  }

  logger.info(
    `[agent-pipeline] LangGraph — ${AGENT_FIND} → ${AGENT_READ} → ${AGENT_VERIFY} | maxLeads=${maxLeads} maxSites=${maxSites}`
  );

  const graph = await getCompiledAutoLeadGraph();

  /** @type {any} */
  const final = await graph.invoke({
    brief: b,
    userId: opts.userId,
    req: opts.req,
    maxLeads,
    maxSites
  });

  const discovery = final.discovery;

  if (final.noUrls || !discovery?.candidate_sources?.length) {
    const quick_read = await buildAutoLeadQuickRead({
      brief: b,
      intent: discovery.intent,
      candidate_sources: [],
      leads: [],
      urls_attempted: [],
      noSearchHits: true
    });
    return {
      success: true,
      mode: 'auto_leads',
      orchestration: 'langgraph',
      agent_pipeline: [`${AGENT_FIND} (stopped: no URLs)`],
      quick_only: false,
      ...(quick_read ? { quick_read } : {}),
      intent: discovery.intent,
      search_queries_used: discovery.search_queries_used,
      search_queries_expanded: discovery.search_queries_expanded,
      results_pooled: discovery.results_pooled,
      candidate_sources: [],
      urls_attempted: [],
      leads: [],
      field_schema: null,
      strict_match_rules: null,
      strict_filter_applied: false,
      note:
        discovery.preview_note ||
        'No candidate URLs from search. Set SERPER_API_KEY and try a more specific location or record type.',
      preview_note: discovery.preview_note,
      disclaimer: discovery.disclaimer
    };
  }

  const manifest = final.manifest || final.preManifest || { field_schema: null, strict_match_rules: null };
  const collectedRaw = Array.isArray(final.collected) ? final.collected : [];
  const verified = Array.isArray(final.verified) ? final.verified : [];
  const strictFilterApplied = final.strictFilterApplied !== false;
  const urlsAttempted = Array.isArray(final.urlsAttempted) ? final.urlsAttempted : [];
  const hunterRan = !!final.hunterRan;
  const useRawFallback = !verified.length && collectedRaw.length > 0;
  const leads = dedupeLeads(useRawFallback ? collectedRaw : verified, maxLeads);

  let note = !leads.length && urlsAttempted.length
    ? 'Search ran but no rows were extracted. Try different wording, or use “Extract to my format” on a specific URL.'
    : null;
  if (!leads.length && hunterRan) {
    note =
      'Read and API-Hunter exhausted embedded JSON/Socrata/ArcGIS probes for candidate URLs. Try a more specific portal link, or add the dataset as a JSON API source.';
  }
  if (useRawFallback) {
    note =
      'Rows were found, but strict verification had no exact matches. Showing best raw rows so your table is not empty.';
  }

  const quick_read = await buildAutoLeadQuickRead({
    brief: b,
    intent: discovery.intent,
    candidate_sources: discovery.candidate_sources,
    leads,
    urls_attempted: urlsAttempted,
    noSearchHits: false
  });

  const agent_pipeline = [AGENT_FIND, AGENT_READ];
  if (hunterRan) agent_pipeline.push(AGENT_API_HUNTER);
  agent_pipeline.push(`${AGENT_VERIFY} (post-read filter/shape)`);

  let sales_intelligence = null;
  if (String(process.env.AUTO_LEADS_SALES_SHAPE || '').toLowerCase() === 'true' && leads.length) {
    try {
      const si = await enrichSalesIntelligenceTable({ brief: b, intent: discovery.intent, leads });
      if (si?.sales_rows?.length) sales_intelligence = si;
    } catch (e) {
      logger.warn(`runAutoLeadAgentPipeline sales shape: ${e.message}`);
    }
  }

  return {
    success: true,
    mode: 'auto_leads',
    orchestration: 'langgraph',
    agent_pipeline,
    quick_only: false,
    ...(quick_read ? { quick_read } : {}),
    ...(sales_intelligence ? { sales_intelligence } : {}),
    intent: discovery.intent,
    search_queries_used: discovery.search_queries_used,
    search_queries_expanded: discovery.search_queries_expanded,
    results_pooled: discovery.results_pooled,
    candidate_sources: discovery.candidate_sources,
    urls_attempted: urlsAttempted,
    leads,
    field_schema: manifest.field_schema,
    strict_match_rules: manifest.strict_match_rules,
    strict_filter_applied: strictFilterApplied,
    verified_match_count: verified.length,
    raw_row_count: collectedRaw.length,
    note,
    preview_note: discovery.preview_note,
    disclaimer: discovery.disclaimer
  };
}

module.exports = { runAutoLeadAgentPipeline, dedupeLeads };
