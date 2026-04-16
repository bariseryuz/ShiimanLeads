/**
 * Deterministic verification layer - hard rule checks that run AFTER the AI filter.
 * No LLM calls; pure logic. Each lead gets a confidence score + rejection reasons.
 */

const logger = require('../../utils/logger');

const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts',
  MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana',
  NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey',
  NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota',
  OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island',
  SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas',
  UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia'
};

const STATE_LOOKUP = new Map();
for (const [code, name] of Object.entries(US_STATES)) {
  STATE_LOOKUP.set(code.toLowerCase(), name);
  STATE_LOOKUP.set(name, code.toLowerCase());
}

function flattenToString(row) {
  if (!row || typeof row !== 'object') return '';
  const vals = [];
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) vals.push(flattenToString(v));
    else vals.push(String(v));
  }
  return vals.join(' ').toLowerCase();
}

function extractNumericValue(row) {
  if (!row || typeof row !== 'object') return null;
  const valKeys = /estimated_value_usd|valuation|est_cost|const_cost|project_value|declared_value|total_valuation|job_value|building_value|improvement_value|construction_cost|total_val|permit_valuation|cost|fee|amount|value/i;
  for (const [k, v] of Object.entries(row)) {
    if (!valKeys.test(k)) continue;
    if (v == null || v === '' || /not publicly/i.test(String(v))) continue;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,\s]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (row.attributes && typeof row.attributes === 'object') return extractNumericValue(row.attributes);
  if (row.properties && typeof row.properties === 'object') return extractNumericValue(row.properties);
  return null;
}

function extractStatusField(row) {
  if (!row || typeof row !== 'object') return null;
  const statusKeys = /status|phase|status_or_phase|permit_status|application_status|state|disposition/i;
  for (const [k, v] of Object.entries(row)) {
    if (!statusKeys.test(k)) continue;
    if (v == null || v === '' || /not publicly/i.test(String(v))) continue;
    return String(v).trim().toLowerCase();
  }
  if (row.attributes && typeof row.attributes === 'object') return extractStatusField(row.attributes);
  if (row.properties && typeof row.properties === 'object') return extractStatusField(row.properties);
  return null;
}

const BAD_STATUSES = /\b(expired|withdrawn|void(ed)?|closed|cancelled|canceled|denied|rejected|revoked|inactive|superseded)\b/i;
const GOOD_STATUSES = /\b(issued|active|approved|in.?review|under.?review|pending|open|finaled|complete[d]?|in.?progress)\b/i;
const NON_PHYSICAL_PATTERNS = [
  /\bP\.?O\.?\s?Box\b/i,
  /\bRegistered\sAgent\b/i,
  /\bc\/o\b/i,
  /\bLegal\sDept\b/i,
  /\bCorporation\sService\b/i,
  /\bSuite\s\d+\b/i,
  /\bSte\.?\s?\d+\b/i
];
const PLACEHOLDER_VALUE_RE =
  /^(not publicly(?: stated)?|unknown|n\/?a|na|null|undefined|none|-|\.+|not found(?: yet)?|missing|not available|tbd|to be determined|unavailable|no data)$/i;
const GENERIC_NON_COMPANY_RE =
  /\b(project manager|decision maker|buyer|owner rep|contact|lead|opportunity|construction manager)\b/i;
const ADDRESS_SIGNAL_RE =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|parkway|trl|trail)\b/i;

function isNonPhysicalAddress(address) {
  const a = String(address || '').trim();
  if (!a) return false;
  return NON_PHYSICAL_PATTERNS.some(re => re.test(a));
}

function checkGeography(row, intent) {
  if (!intent) return { pass: true, reason: 'No intent to check against' };
  const geo = String(intent.geography || '').toLowerCase().trim();
  const stateCode = String(intent.state_code || '').toLowerCase().trim();
  if (!geo && !stateCode) return { pass: true, reason: 'No geography constraint in brief' };

  const blob = flattenToString(row);
  const geoTokens = geo.split(/[,\s]+/).filter(t => t.length > 2);
  const stateName = STATE_LOOKUP.get(stateCode) || '';

  if (stateCode && blob.includes(stateCode)) return { pass: true, reason: `State code "${stateCode}" found` };
  if (stateName && blob.includes(stateName)) return { pass: true, reason: `State name "${stateName}" found` };
  for (const tok of geoTokens) {
    if (blob.includes(tok)) return { pass: true, reason: `Geography token "${tok}" found` };
  }
  return { pass: false, reason: `No geography match for "${geo || stateCode}" in row data` };
}

function checkValueThreshold(row, intent) {
  if (!intent) return { pass: true, reason: 'No intent' };
  const minVal = intent.min_project_value_usd;
  const maxVal = intent.max_project_value_usd;
  const hasMin = minVal != null && Number.isFinite(Number(minVal)) && Number(minVal) > 0;
  const hasMax = maxVal != null && Number.isFinite(Number(maxVal)) && Number(maxVal) > 0;
  if (!hasMin && !hasMax) {
    return { pass: true, reason: 'No value threshold in brief' };
  }
  const actual = extractNumericValue(row);
  if (actual == null) {
    return { pass: true, soft_flag: true, reason: 'Value field missing - cannot verify threshold bound(s); kept with flag' };
  }
  if (hasMin && actual < Number(minVal)) {
    return { pass: false, reason: `Value $${actual.toLocaleString()} below minimum $${Number(minVal).toLocaleString()}` };
  }
  if (hasMax && actual > Number(maxVal)) {
    return { pass: false, reason: `Value $${actual.toLocaleString()} above maximum $${Number(maxVal).toLocaleString()}` };
  }
  if (hasMin && hasMax) {
    return {
      pass: true,
      reason: `Value $${actual.toLocaleString()} within range $${Number(minVal).toLocaleString()}-$${Number(maxVal).toLocaleString()}`
    };
  }
  if (hasMin) {
    return { pass: true, reason: `Value $${actual.toLocaleString()} meets minimum $${Number(minVal).toLocaleString()}` };
  }
  return { pass: true, reason: `Value $${actual.toLocaleString()} meets maximum $${Number(maxVal).toLocaleString()}` };
}

function checkStatus(row, intent) {
  const status = extractStatusField(row);
  if (!status) return { pass: true, reason: 'No status field present' };

  const briefText = String(intent?.trigger_or_record || '').toLowerCase();
  const wantsHistorical = /historical|expired|closed|all status/i.test(briefText);
  if (wantsHistorical) return { pass: true, reason: 'User requested historical/all statuses' };

  if (BAD_STATUSES.test(status)) {
    return { pass: false, reason: `Bad status: "${status}" (expired/void/closed/denied)` };
  }
  if (GOOD_STATUSES.test(status)) {
    return { pass: true, reason: `Good status: "${status}"` };
  }
  return { pass: true, soft_flag: true, reason: `Unknown status: "${status}" - kept with flag` };
}

function checkClientEssentials(row) {
  if (!row || typeof row !== 'object') return { pass: false, reason: 'Row is null/empty' };

  const get = keys => {
    for (const k of keys) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) continue;
      const v = row[k];
      if (v == null || v === '') continue;
      const s = String(v).trim();
      if (!s || PLACEHOLDER_VALUE_RE.test(s)) continue;
      return s;
    }
    return '';
  };

  const address = get(['address', 'site_address', 'project_address', 'property_address', 'worksite_address']);
  let company = get(['company_name', 'owner_name', 'contractor_name', 'applicant_name', 'developer', 'business_name']);
  const keyContact = get(['key_contact_or_firm']);
  if (!company && keyContact && !GENERIC_NON_COMPANY_RE.test(keyContact) && !PLACEHOLDER_VALUE_RE.test(keyContact)) {
    company = keyContact;
  }
  if (/\b(socrata|arcgis|esri|tyler\s*tech|opendata\s*soft|accela)\b/i.test(company)) {
    company = '';
  }
  const detail = get(['project_snapshot', 'why_opportunity', 'project_name', 'lead_title', 'description']);

  const hasDetail = detail && detail.split(/\s+/).filter(Boolean).length >= 3;
  const actionableAddress = !!address && (/\d/.test(address) || ADDRESS_SIGNAL_RE.test(address));
  if (!address || !company) {
    return { pass: false, reason: 'Missing client essentials (address and company are both required)' };
  }
  if (!actionableAddress) {
    return { pass: false, reason: 'Address is too vague/non-actionable (needs site-level street detail)' };
  }
  if (isNonPhysicalAddress(address)) {
    return { pass: true, soft_flag: true, reason: 'Address appears non-physical (PO Box/registered-agent style); enrichment fallback required' };
  }
  if (hasDetail) return { pass: true, reason: 'Client essentials present (address + company + project detail)' };
  return { pass: true, soft_flag: true, reason: 'Address + company present; project detail is thin' };
}

function pickPrimaryAddress(row) {
  if (!row || typeof row !== 'object') return '';
  const keys = ['address', 'site_address', 'project_address', 'property_address', 'worksite_address'];
  for (const k of keys) {
    const v = row[k];
    if (v == null || v === '') continue;
    const s = String(v).trim();
    if (!s || PLACEHOLDER_VALUE_RE.test(s)) continue;
    return s;
  }
  return '';
}

function checkFieldCompleteness(row) {
  if (!row || typeof row !== 'object') return { pass: false, reason: 'Row is null/empty', populated: 0 };

  let populated = 0;
  const NOT_USEFUL = PLACEHOLDER_VALUE_RE;
  const GIS_KEYS = /^(objectid|globalid|fid|oid|shape_|st_area|st_length|x|y|z|latitude|longitude|lat|lon)/i;

  for (const [k, v] of Object.entries(row)) {
    if (GIS_KEYS.test(k)) continue;
    if (v == null || v === '') continue;
    const s = String(v).trim();
    if (s.length < 2 || NOT_USEFUL.test(s)) continue;
    if (typeof v === 'object') continue;
    populated++;
  }

  if (populated >= 3) return { pass: true, reason: `${populated} useful fields populated`, populated };
  if (populated >= 1) return { pass: true, soft_flag: true, reason: `Only ${populated} useful field(s) - sparse`, populated };
  return { pass: false, reason: 'Zero useful fields populated', populated: 0 };
}

function isDuplicateOf(row, existingSignatures) {
  const sig = JSON.stringify(row).slice(0, 3000);
  if (existingSignatures.has(sig)) return true;
  existingSignatures.add(sig);
  return false;
}

function computeConfidence(checks) {
  const hardFails = checks.filter(c => !c.pass).length;
  const softFlags = checks.filter(c => c.pass && c.soft_flag).length;
  const completeness = checks.find(c => c.populated != null);
  const populated = completeness ? completeness.populated : 0;

  if (hardFails >= 2) return 0;
  if (hardFails === 1) return Math.max(15, 40 - softFlags * 5);

  let score = 85;
  if (populated >= 5) score += 10;
  else if (populated >= 3) score += 5;
  score -= softFlags * 8;
  return Math.max(10, Math.min(100, score));
}

function confidenceLabel(score) {
  if (score >= 85) return 'high';
  if (score >= 60) return 'medium';
  if (score >= 35) return 'low';
  return 'very_low';
}

function runDeterministicVerify(leads, opts = {}) {
  const intent = opts.intent || null;
  const strict = opts.strict !== false;
  const requireClientEssentials = !!opts.requireClientEssentials;
  const rows = Array.isArray(leads) ? leads : [];

  const verified = [];
  const rejected = [];
  const existingSignatures = new Set();

  for (const row of rows) {
    if (isDuplicateOf(row, existingSignatures)) {
      rejected.push({ row, reasons: ['Duplicate of earlier row'], confidence: 0, confidence_label: 'very_low' });
      continue;
    }

    const geoCheck = checkGeography(row, intent);
    const valCheck = checkValueThreshold(row, intent);
    const statusCheck = checkStatus(row, intent);
    const essentialsCheck = requireClientEssentials
      ? checkClientEssentials(row)
      : { pass: true, reason: 'Client essentials check disabled' };
    const fieldCheck = checkFieldCompleteness(row);

    const allChecks = [geoCheck, valCheck, statusCheck, essentialsCheck, fieldCheck];
    const hardFails = allChecks.filter(c => !c.pass);
    const reasons = allChecks.map(c => c.reason);
    let confidence = computeConfidence(allChecks);
    if (!essentialsCheck.pass) confidence = 0;
    const label = confidenceLabel(confidence);

    const enrichedRow = { ...row };
    const primaryAddress = pickPrimaryAddress(enrichedRow);
    const needsSiteVerification = !!primaryAddress && isNonPhysicalAddress(primaryAddress);
    enrichedRow.needs_site_verification = needsSiteVerification;
    if (needsSiteVerification) {
      enrichedRow.site_verification_reason = 'Address appears to be PO Box/registered-agent/non-jobsite.';
    }
    enrichedRow._verification = {
      confidence,
      confidence_label: label,
      checks: reasons,
      hard_fails: hardFails.map(c => c.reason),
      passed: hardFails.length === 0,
      hide_card: !essentialsCheck.pass
    };

    if (hardFails.length > 0 && strict) {
      rejected.push({ row: enrichedRow, reasons: hardFails.map(c => c.reason), confidence, confidence_label: label });
    } else {
      verified.push(enrichedRow);
    }
  }

  const stats = {
    total_input: rows.length,
    verified_count: verified.length,
    rejected_count: rejected.length,
    avg_confidence: verified.length
      ? Math.round(verified.reduce((s, r) => s + (r._verification?.confidence || 0), 0) / verified.length)
      : 0,
    high_confidence_count: verified.filter(r => (r._verification?.confidence || 0) >= 85).length,
    site_verification_needed_count: verified.filter(r => r.needs_site_verification === true).length,
    checks_applied: [
      'geography',
      'value_threshold',
      'status',
      ...(requireClientEssentials ? ['client_essentials'] : []),
      'field_completeness',
      'duplicate'
    ]
  };

  logger.info(
    `[deterministic-verify] ${stats.verified_count}/${stats.total_input} passed (avg confidence ${stats.avg_confidence}%, ` +
    `${stats.high_confidence_count} high, ${stats.rejected_count} rejected${strict ? ', strict mode' : ''})`
  );

  return { verified, rejected, stats };
}

function verifyQuickLeads(leads, opts = {}) {
  return runDeterministicVerify(leads, {
    ...opts,
    strict: true,
    requireClientEssentials: true
  });
}

module.exports = {
  runDeterministicVerify,
  verifyQuickLeads,
  checkGeography,
  checkValueThreshold,
  checkStatus,
  isNonPhysicalAddress,
  checkClientEssentials,
  checkFieldCompleteness,
  computeConfidence,
  confidenceLabel
};
