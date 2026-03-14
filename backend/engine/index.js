/**
 * Engine: Universal Pipeline Orchestrator (Switchboard)
 * Fetch → Transform → Validate. Sector-agnostic; chooses adapter by source.type.
 */

const transformer = require('./transformer');
const validator = require('./validator');
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
    const manifest = source;
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

    for (const rawItem of rawLeads) {
      const dataToMap = rawItem.attributes || rawItem;
      const cleanLead = transformer(dataToMap, fieldMapping);
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
 * Check if this source should use the new Engine (has manifest-style config).
 * @param {Object} source - Parsed source object
 * @returns {boolean}
 */
function shouldUseEngine(source) {
  if (!source) return false;
  return !!(
    source.query_params ||
    source.where_clause ||
    (source.manifest && (source.manifest.query_params || source.manifest.where_clause || source.manifest.filters))
  );
}

module.exports = { runUniversalPipeline, shouldUseEngine };
