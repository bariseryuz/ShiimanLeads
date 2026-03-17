const crypto = require('crypto');

function parsePaddleSignatureHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const parts = headerValue.split(';').map(p => p.trim()).filter(Boolean);
  const out = {};
  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k && v) out[k] = v;
  }
  if (!out.ts || !out.h1) return null;
  const ts = Number(out.ts);
  if (!Number.isFinite(ts)) return null;
  return { ts, h1: out.h1 };
}

function timingSafeEqualHex(aHex, bHex) {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifyPaddleWebhook({ signatureHeader, rawBody, secret, toleranceSeconds = 300 }) {
  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'missing_or_invalid_signature_header' };
  if (!secret) return { ok: false, reason: 'missing_secret' };
  if (!rawBody) return { ok: false, reason: 'missing_raw_body' };

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.ts) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const signedPayload = `${parsed.ts}:${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  if (!timingSafeEqualHex(computed, parsed.h1)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

module.exports = {
  verifyPaddleWebhook
};

