/**
 * Primary flow: user types lead details only → multi-agent pipeline → leads.
 *
 * Implementation: services/discoveryAgents/runAutoLeadAgentPipeline.js
 * (Agent A Find → Agent C Verify/Shape plan → Agent B Read → dedupe)
 */

const { runAutoLeadAgentPipeline } = require('./discoveryAgents/runAutoLeadAgentPipeline');

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
async function fetchLeadsFromBriefOnly(opts) {
  const b = String(opts.brief || '').trim();
  if (b.length < 12) {
    throw new Error('Describe the leads you want (location, record type, filters) in at least one sentence.');
  }

  return runAutoLeadAgentPipeline(opts);
}

module.exports = { fetchLeadsFromBriefOnly };
