const test = require('node:test');
const assert = require('node:assert');
const { unwrapMistakenJsonFormWrapper } = require('../adapters/rest');

test('unwraps mistaken {"sort=&page=1&..."} wrapper', () => {
  const raw =
    'sort=&page=1&pageSize=10&group=&filter=&PermitType=PERS&StructureClass=007&StartDate=8%2F4%2F2025&EndDate=3%2F28%2F2026';
  const wrapped = `{"${raw}"}`;
  assert.strictEqual(unwrapMistakenJsonFormWrapper(wrapped), raw);
});

test('leaves correct form string unchanged', () => {
  const raw = 'sort=&page=1&pageSize=10';
  assert.strictEqual(unwrapMistakenJsonFormWrapper(raw), raw);
});
