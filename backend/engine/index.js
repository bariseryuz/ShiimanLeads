/**
 * Engine: Universal Pipeline Orchestrator (Switchboard)
 * Fetch → Transform → Validate. Sector-agnostic; chooses adapter by source.type.
 */

const transformer = require('./transformer');
const validator = require('./validator');
const { sanitizeLead } = require('./sanitize');
const restAdapter = require('./adapters/rest');
const arcgisAdapter = require('./adapters/arcgis');
const aiVisionAdapter = require('./adapters/ai-vision');
const logger = require('../utils/logger');

/**
 * Run the universal pipeline for one source.
 * @param {Object} source - Parsed source: { url, type, name, id?, query_params?, params?, field_mapping?, fieldSchema?, filters?, where_clause?, rules?, ai_instructions?, aiPrompt?, field_schema?, limit? }
 * @returns {Promise<Array>} Processed leads (transformed + validated)
 */
async function runUniversalPipeline(source) {
  try {
    const manifest =
      source.manifest && typeof source.manifest === 'object' ? { ...source.manifest, ...source } : source;
    // Support legacy param names: params -> query_params for JSON
    if (!manifest.query_params && manifest.params && (source.type === 'json' || source.method === 'json')) {
      manifest.query_params = manifest.params;
    }
    if (!manifest.ai_instructions && manifest.aiPrompt) manifest.ai_instructions = manifest.aiPrompt;
    if (!manifest.field_schema && manifest.fieldSchema) manifest.field_schema = manifest.fieldSchema;

    let rawLeads = [];

    if (source.type === 'json' || source.method === 'json') {
      rawLeads = await restAdapter.fetch(source.url, manifest);
    } else if (source.type === 'arcgis') {
      rawLeads = await arcgisAdapter.fetch(source.url, manifest);
    } else if (source.type === 'html' || source.type === 'playwright' || (source.usePlaywright && (manifest.ai_instructions || manifest.aiPrompt))) {
      rawLeads = await aiVisionAdapter.fetch(source.url, manifest);
    } else {
      logger.warn(`[Engine] Unknown source type: ${source.type}, skipping`);
      return [];
    }

    const processedLeads = [];
    const fieldMapping = manifest.field_mapping || manifest.fieldSchema || {};
    const filters = manifest.filters || [];

    const doSanitize = manifest.sanitize !== false;

    for (const rawItem of rawLeads) {
      const dataToMap =
        rawItem && typeof rawItem === 'object' && rawItem.attributes != null ? rawItem.attributes : rawItem;
      let cleanLead = transformer(dataToMap, fieldMapping);
      if (doSanitize) cleanLead = sanitizeLead(cleanLead);
      if (
        cleanLead == null ||
        typeof cleanLead !== 'object' ||
        Array.isArray(cleanLead)
      ) {
        logger.warn(
          `[Engine] Skipped row: expected object after mapping, got ${cleanLead === null ? 'null' : Array.isArray(cleanLead) ? 'array' : typeof cleanLead}. ` +
            `Check API shape and field_mapping (ArcGIS rows should be objects or feature.attributes).`
        );
        continue;
      }
      if (validator(cleanLead, filters)) {
        processedLeads.push(cleanLead);
      }
    }

    logger.info(`[Engine] Processed ${processedLeads.length} valid leads for ${source.name || source.url}`);
    return processedLeads;
  } catch (err) {
    logger.error(`[Engine] Pipeline error: ${err.message}`);
    return [];
  }
}

/**
 * POST body present (My Sources: form string or JSON object). Empty object/string = false.
 * Ensures Phoenix-style `POST` + `body` + `post_body_format=form` always routes to REST adapter
 * even when `query_params` was omitted in stored JSON.
 */
function hasNonEmptyBody(m) {
  if (!m || m.body === undefined || m.body === null) return false;
  if (typeof m.body === 'string') return m.body.trim().length > 0;
  if (typeof m.body === 'object' && !Array.isArray(m.body)) return Object.keys(m.body).length > 0;
  return true;
}

/**
 * Check if this source should use the new Engine (has manifest-style config).
 * @param {Object} source - Parsed source object
 * @returns {boolean}
 */
function shouldUseEngine(source) {
  if (!source) return false;
  if (source.type === 'legacy_arcgis' || source.useLegacyArcgis === true) return false;
  const m = source.manifest && typeof source.manifest === 'object' ? { ...source.manifest, ...source } : source;
  return !!(
    m.query_params ||
    m.params ||
    hasNonEmptyBody(m) ||
    m.where_clause ||
    (Array.isArray(m.filters) && m.filters.length > 0)
  );
}

module.exports = { runUniversalPipeline, shouldUseEngine };
