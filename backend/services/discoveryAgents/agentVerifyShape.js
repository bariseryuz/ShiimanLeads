/**
 * Agent C — VERIFY / SHAPE: turn the user brief into field_schema + strict rules,
 * then filter raw rows so only on-brief leads remain.
 * Runs BEFORE read (manifest drives Playwright) and DURING read (per-batch filter).
 */

const logger = require('../../utils/logger');
const { buildManifestFromBrief } = require('../ai/deepExtractManifest');
const { filterLeadsToBrief } = require('../ai/deepExtractFilter');
const { AGENT_VERIFY } = require('./agentConstants');

/**
 * @param {string} brief
 */
async function runAgentVerifyPlan(brief) {
  const b = String(brief || '').trim();
  logger.info(`[agent:${AGENT_VERIFY}] plan — field_schema + strict_match_rules`);
  const manifest = await buildManifestFromBrief(b);
  logger.info(`[agent:${AGENT_VERIFY}] plan done — ${Object.keys(manifest.field_schema || {}).length} schema keys`);
  return manifest;
}

/**
 * @param {string} brief
 * @param {string} strictRules
 * @param {object[]} rows
 */
async function runAgentVerifyFilterBatch(brief, strictRules, rows) {
  return filterLeadsToBrief(brief, strictRules, rows);
}

module.exports = {
  runAgentVerifyPlan,
  runAgentVerifyFilterBatch
};
