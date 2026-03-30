const test = require('node:test');
const assert = require('node:assert');
const { extractRowsFromApiJson } = require('../jsonResponseRows');

test('ASP.NET d string unwraps to Data rows', () => {
  const inner = { Data: [{ PermitNo: '1', Addr: 'A' }], Total: 1 };
  const data = { d: JSON.stringify(inner) };
  const rows = extractRowsFromApiJson(data);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].PermitNo, '1');
});

test('Capital Data still works', () => {
  const rows = extractRowsFromApiJson({ Data: [{ x: 1 }] });
  assert.strictEqual(rows.length, 1);
});
