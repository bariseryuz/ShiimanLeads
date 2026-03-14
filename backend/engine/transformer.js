/**
 * Engine: Transformer (Field Mapping)
 * Maps API field names to your internal schema. Sector-agnostic.
 * mapping: { "EST_COST_AMT": "budget", "ZIP_CODE": "location" }
 */

/**
 * @param {Object} rawData - One record from the API (e.g. attributes object or flat object)
 * @param {Object} mapping - API key -> your key, e.g. { EST_COST: "budget", ADDR: "address" }
 * @returns {Object} Clean lead with your field names; includes _raw for debugging
 */
function transformer(rawData, mapping) {
  if (!rawData || typeof rawData !== 'object') return rawData;
  if (!mapping || Object.keys(mapping).length === 0) {
    return { ...rawData, _raw: rawData };
  }

  const clean = {};
  Object.keys(mapping).forEach(apiKey => {
    const myKey = mapping[apiKey];
    if (rawData[apiKey] !== undefined) {
      clean[myKey] = rawData[apiKey];
    }
  });
  clean._raw = rawData;
  return clean;
}

module.exports = transformer;
