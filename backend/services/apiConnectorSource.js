/**
 * Normalizes a simplified "API connector" payload into engine-compatible source_data (type json).
 */

function normalizeConnectorSource(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = String(b.name || '').trim().slice(0, 200);
  const url = String(b.apiUrl || b.url || '').trim();
  if (!name || !url) {
    const err = new Error('name and apiUrl (or url) are required');
    err.status = 400;
    throw err;
  }

  const httpMethod = String(b.httpMethod || b.http_method || b.method || 'GET').toUpperCase();
  const authType = String(b.authType || 'none').toLowerCase();
  const token = b.apiToken != null ? String(b.apiToken) : b.bearerToken != null ? String(b.bearerToken) : '';

  const headers = { ...(typeof b.headers === 'object' && b.headers ? b.headers : {}) };
  if (authType === 'bearer' && token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (authType === 'header' && token && b.authHeaderName) {
    headers[String(b.authHeaderName)] = token;
  }

  const query_params =
    b.query_params && typeof b.query_params === 'object' ? b.query_params : b.params && typeof b.params === 'object' ? b.params : {};

  const field_mapping =
    b.field_mapping && typeof b.field_mapping === 'object'
      ? b.field_mapping
      : b.fieldMapping && typeof b.fieldMapping === 'object'
        ? b.fieldMapping
        : {};

  const primary =
    b.primary_id_field ||
    b.primaryIdField ||
    (field_mapping && Object.keys(field_mapping).length ? Object.keys(field_mapping)[0] : null) ||
    'id';

  const sourceData = {
    name,
    url,
    type: 'json',
    method: httpMethod,
    query_params,
    headers,
    field_mapping,
    primary_id_field: String(primary).slice(0, 120),
    usePlaywright: false,
    connectorPreset: true,
    ...(b.body !== undefined ? { body: b.body } : {}),
    ...(b.post_body_format ? { post_body_format: b.post_body_format } : {})
  };

  return sourceData;
}

module.exports = { normalizeConnectorSource };
