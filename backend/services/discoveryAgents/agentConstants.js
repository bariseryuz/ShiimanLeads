/**
 * Logical pipeline roles (not separate “personas” — no conflicting identities).
 * Each role = one module + one job-specific Gemini prompt where needed.
 * Find = search URLs | Verify = manifest + row filter rules | Read = fetch / browser extract.
 * Same API keys; roles avoid mixing instructions (search vs scrape vs shape).
 */
module.exports = {
  AGENT_FIND: 'find',
  AGENT_READ: 'read',
  AGENT_VERIFY: 'verify'
};
