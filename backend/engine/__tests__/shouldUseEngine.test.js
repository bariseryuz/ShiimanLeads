/**
 * Ensures JSON + POST form sources always use Universal Engine / REST adapter (not legacy JSON path).
 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldUseEngine } = require('../index');

test('POST form body only (no query_params) uses engine', () => {
  assert.strictEqual(
    shouldUseEngine({
      type: 'json',
      method: 'POST',
      post_body_format: 'form',
      body: 'sort=&page=1&pageSize=10&PermitType=PERS'
    }),
    true
  );
});

test('empty query_params object still uses engine (saved JSON API default)', () => {
  assert.strictEqual(shouldUseEngine({ type: 'json', query_params: {} }), true);
});

test('legacy_arcgis never uses engine', () => {
  assert.strictEqual(shouldUseEngine({ type: 'legacy_arcgis', query_params: { f: 'json' } }), false);
});
