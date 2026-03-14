/**
 * Engine: Validator (Logic Engine / Rule Engine)
 * Checks if a lead meets the user's rules. Math and logic only; sector-agnostic.
 * rules: [ { field, operator, value } ]
 */

/**
 * @param {Object} lead - One normalized lead (your field names)
 * @param {Array} rules - [ { field: "budget", operator: ">", value: 50000 }, ... ]
 * @returns {boolean} true if lead passes all rules (or no rules)
 */
function validator(lead, rules) {
  if (!rules || rules.length === 0) return true;

  return rules.every(rule => {
    const actual = lead[rule.field];
    const target = rule.value;

    switch (rule.operator) {
      case '>':
        return parseFloat(actual) > parseFloat(target);
      case '<':
        return parseFloat(actual) < parseFloat(target);
      case '>=':
        return parseFloat(actual) >= parseFloat(target);
      case '<=':
        return parseFloat(actual) <= parseFloat(target);
      case '==':
      case 'equals':
        return String(actual) === String(target);
      case '!=':
      case 'not_equals':
        return String(actual) !== String(target);
      case 'contains':
        return String(actual || '').toLowerCase().includes(String(target || '').toLowerCase());
      case 'in':
        return Array.isArray(target) && target.includes(actual);
      case 'between':
        const [min, max] = Array.isArray(target) ? target : [target, target];
        const num = parseFloat(actual);
        return num >= parseFloat(min) && num <= parseFloat(max);
      case 'days_ago':
        if (actual == null) return false;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - parseInt(target, 10));
        const leadDate = new Date(actual);
        return !isNaN(leadDate.getTime()) && leadDate >= cutoff;
      default:
        return true;
    }
  });
}

module.exports = validator;
