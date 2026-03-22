/**
 * Engine: Hydrator (Date & Token Calculator)
 * Replaces dynamic tokens in query params with real values at scrape time.
 * Sector-agnostic: doesn't care if it's permits, jobs, or real estate.
 */

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

/**
 * Hydrate a string: replace {{TODAY}}, {{DAYS_AGO_N}}, {{DATE_365_DAYS_AGO}}, etc.
 */
function hydrateString(val) {
  if (typeof val !== 'string') return val;
  const now = new Date();

  val = val.replace(/\{\{TODAY\}\}/g, formatDate(now));
  val = val.replace(/\{\{DATE_TODAY\}\}/g, formatDate(now));

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  val = val.replace(/\{\{YESTERDAY\}\}/g, formatDate(yesterday));
  val = val.replace(/\{\{DATE_YESTERDAY\}\}/g, formatDate(yesterday));

  // {{DAYS_AGO_N}} e.g. {{DAYS_AGO_30}}
  val = val.replace(/\{\{DAYS_AGO_(\d+)\}\}/g, (_, n) => {
    const d = new Date();
    d.setDate(d.getDate() - parseInt(n, 10));
    return formatDate(d);
  });

  // Legacy names
  val = val.replace(/\{\{DATE_365_DAYS_AGO\}\}/g, () => {
    const d = new Date();
    d.setDate(d.getDate() - 365);
    return formatDate(d);
  });
  val = val.replace(/\{\{DATE_30_DAYS_AGO\}\}/g, () => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return formatDate(d);
  });
  val = val.replace(/\{\{DATE_7_DAYS_AGO\}\}/g, () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return formatDate(d);
  });

  return val;
}

/**
 * Hydrate params (recursively for nested objects). Mutates and returns the same object.
 * @param {Object} params - e.g. { where: "Date > '{{DAYS_AGO_30}}'", startDate: "{{TODAY}}" }
 * @returns {Object} same object with string values hydrated
 */
function hydrator(params) {
  if (!params || typeof params !== 'object') return params;
  const hydrated = { ...params };

  Object.keys(hydrated).forEach(key => {
    const val = hydrated[key];
    if (typeof val === 'string') {
      hydrated[key] = hydrateString(val);
    } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      hydrated[key] = hydrator(val);
    }
  });

  return hydrated;
}

module.exports = hydrator;
module.exports.hydrateString = hydrateString;
