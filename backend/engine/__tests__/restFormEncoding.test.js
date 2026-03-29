/**
 * Form POST: manifest.body string must be sent as-is (after hydrateString) with Content-Type form.
 */
const test = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

test('executeRestRequest sends form string body and charset header', async () => {
  const { executeRestRequest } = require('../adapters/rest');
  const orig = axios.request;
  let captured;
  axios.request = async (cfg) => {
    captured = cfg;
    return { status: 200, data: { Data: [] } };
  };
  try {
    await executeRestRequest('https://example.com/api', {
      method: 'POST',
      post_body_format: 'form',
      body: 'sort=&page=1&PermitType=PERS'
    });
    assert.strictEqual(captured.method, 'post');
    assert.strictEqual(captured.data, 'sort=&page=1&PermitType=PERS');
    assert.ok(String(captured.headers['Content-Type'] || '').includes('application/x-www-form-urlencoded'));
  } finally {
    axios.request = orig;
  }
});
