/**
 * LogicEngine (The Brain) - Rule evaluation only; sector-agnostic.
 * Same logic as validator.js; this file supports the blueprint API: rule.op, rule.val.
 * Use validator.js directly for rule.operator / rule.value.
 */

const validator = require('./validator');

/**
 * Normalize rules from blueprint shape (op, val) to engine shape (operator, value).
 */
function normalizeRules(rules) {
  if (!rules || !Array.isArray(rules)) return [];
  return rules.map(r => ({
    field: r.field,
    operator: r.operator || r.op,
    value: r.value !== undefined ? r.value : r.val
  }));
}

/**
 * @param {Object} lead - One lead
 * @param {Array} rules - [ { field, op, val } ] or [ { field, operator, value } ]
 * @returns {boolean} true if lead passes all rules
 */
function evaluate(lead, rules) {
  return validator(lead, normalizeRules(rules));
}

module.exports = { evaluate };
module.exports.validator = validator;
