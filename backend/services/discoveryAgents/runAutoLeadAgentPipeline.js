/**
 * Multi-agent orchestration for POST /api/discover/auto-leads
 *
 * Implemented with @langchain/langgraph (StateGraph): three nodes + conditional routing.
 * Agent A = find | Agent C = verify (plan) | Agent B = read
 *
 * Same API keys as before (GEMINI + SERPER); LangGraph manages flow, not credentials.
 */

const logger = require('../../utils/logger');
const { runAgentFind } = require('./agentFind');
const { runAgentVerifyPlan } = require('./agentVerifyShape');
const { runAgentRead } = require('./agentRead');
const { AGENT_FIND, AGENT_READ, AGENT_VERIFY } = require('./agentConstants');

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
 * Build once: Find → (if URLs) Verify → Read → END; if no URLs Find → END.
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
        manifest: Annotation(),
        collected: Annotation(),
        urlsAttempted: Annotation(),
        noUrls: Annotation()
      });

      async function nodeFind(state) {
        logger.info(`[langgraph] node ${AGENT_FIND}`);
        const discovery = await runAgentFind(state.brief);
        const noUrls = !discovery.candidate_sources?.length;
        return { discovery, noUrls };
      }

      async function nodeVerify(state) {
        logger.info(`[langgraph] node ${AGENT_VERIFY} (plan)`);
        const manifest = await runAgentVerifyPlan(state.brief);
        return { manifest };
      }

      async function nodeRead(state) {
        logger.info(`[langgraph] node ${AGENT_READ}`);
        const { collected, urlsAttempted } = await runAgentRead({
          brief: state.brief,
          userId: state.userId,
          req: state.req,
          manifest: state.manifest,
          candidates: state.discovery.candidate_sources,
          maxLeads: state.maxLeads,
          maxSites: state.maxSites
        });
        return { collected, urlsAttempted };
      }

      const graph = new StateGraph(AutoLeadState)
        .addNode('find', nodeFind)
        .addNode('verify', nodeVerify)
        .addNode('read', nodeRead)
        .addEdge(START, 'find')
        .addConditionalEdges(
          'find',
          state => (state.noUrls ? 'end' : 'verify'),
          { end: END, verify: 'verify' }
        )
        .addEdge('verify', 'read')
        .addEdge('read', END);

      return graph.compile();
    })();
  }
  return compiledGraphPromise;
}

/**
 * @param {{ userId: number, brief: string, req: import('express').Request, maxLeads?: number, maxSites?: number }} opts
 */
async function runAutoLeadAgentPipeline(opts) {
  const b = String(opts.brief || '').trim();
  const maxLeads = Math.min(50, Math.max(1, parseInt(opts.maxLeads, 10) || 15));
  const maxSites = Math.min(5, Math.max(1, parseInt(opts.maxSites, 10) || 3));

  logger.info(
    `[agent-pipeline] LangGraph — ${AGENT_FIND} → ${AGENT_VERIFY} → ${AGENT_READ} | maxLeads=${maxLeads} maxSites=${maxSites}`
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
    return {
      success: true,
      mode: 'auto_leads',
      orchestration: 'langgraph',
      agent_pipeline: [`${AGENT_FIND} (stopped: no URLs)`],
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

  const manifest = final.manifest;
  const collected = Array.isArray(final.collected) ? final.collected : [];
  const urlsAttempted = Array.isArray(final.urlsAttempted) ? final.urlsAttempted : [];

  const leads = dedupeLeads(collected, maxLeads);

  const note = !leads.length && urlsAttempted.length
    ? 'Search ran but no rows were extracted. Try different wording, or use “Extract to my format” on a specific URL.'
    : null;

  return {
    success: true,
    mode: 'auto_leads',
    orchestration: 'langgraph',
    agent_pipeline: [AGENT_FIND, `${AGENT_VERIFY} (plan+filter)`, AGENT_READ],
    intent: discovery.intent,
    search_queries_used: discovery.search_queries_used,
    search_queries_expanded: discovery.search_queries_expanded,
    results_pooled: discovery.results_pooled,
    candidate_sources: discovery.candidate_sources,
    urls_attempted: urlsAttempted,
    leads,
    field_schema: manifest.field_schema,
    strict_match_rules: manifest.strict_match_rules,
    strict_filter_applied: true,
    note,
    preview_note: discovery.preview_note,
    disclaimer: discovery.disclaimer
  };
}

module.exports = { runAutoLeadAgentPipeline, dedupeLeads };
