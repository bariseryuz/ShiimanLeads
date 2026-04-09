/**
 * Agent A — FIND: intent + web search + ranked candidate URLs.
 * Not a single "search box" step: Serper + query expansion + Gemini URL pick.
 */

const logger = require('../../utils/logger');
const { runNlLeadIntentDiscovery } = require('../ai/nlLeadIntent');
const { sortCandidateSources } = require('../candidateUrlSort');
const { AGENT_FIND } = require('./agentConstants');

/**
 * @param {string} brief
 */
async function runAgentFind(brief) {
  const b = String(brief || '').trim();
  logger.info(`[agent:${AGENT_FIND}] start (intent + search + URL ranking)`);

  const discovery = await runNlLeadIntentDiscovery(b);
  const candidate_sources = sortCandidateSources(discovery.candidate_sources || []);

  logger.info(
    `[agent:${AGENT_FIND}] done — ${candidate_sources.length} candidate URL(s), pooled ${discovery.results_pooled || 0} search hits`
  );

  return {
    ...discovery,
    candidate_sources
  };
}

module.exports = { runAgentFind };
