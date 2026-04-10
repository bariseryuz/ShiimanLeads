const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isProduction = process.env.NODE_ENV === 'production';

const backendRoot = path.join(__dirname, '..');

/**
 * Relative paths in SQLITE_* must not depend on process.cwd() (npm/node may start
 * from repo root or backend/). Anchor to backend/ so cron + API always use one DB.
 */
function resolveSqlitePath(envKey, fallbackAbsolute) {
  const raw = process.env[envKey];
  if (raw && String(raw).trim()) {
    const p = String(raw).trim();
    if (path.isAbsolute(p)) return path.normalize(p);
    return path.normalize(path.join(backendRoot, p));
  }
  return fallbackAbsolute;
}

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Database (MUST be in /data/ for Railway volume persistence!)
  DB_PATH: resolveSqlitePath('SQLITE_DB_PATH', isProduction 
    ? '/app/backend/data/shiiman-leads.db'  // Railway: In volume
    : path.join(backendRoot, 'data', 'shiiman-leads.db')),  // Local: backend/data/
  
  SESSIONS_DB_PATH: resolveSqlitePath('SQLITE_SESSIONS_DB_PATH', isProduction
    ? '/app/backend/data/sessions.db'  // Railway: In volume
    : path.join(backendRoot, 'data', 'sessions.db')),  // Local: backend/data/
  
  SCREENSHOTS_DIR: isProduction
    ? '/app/backend/data/screenshots'  // Railway: In volume
    : path.join(__dirname, '..', 'data', 'screenshots'),  // Local: backend/data/
  
  // Proxy (REST adapter: first URL when source useProxy=true). Prefer PROXY_URLS; PROXY_URL is a single-URL alias.
  PROXY_ENABLED: process.env.PROXY_ENABLED === 'true',
  PROXY_URLS: (() => {
    const list = process.env.PROXY_URLS;
    if (list && list.trim()) return list.split(',').map(p => p.trim()).filter(Boolean);
    const single = process.env.PROXY_URL && String(process.env.PROXY_URL).trim();
    return single ? [single] : [];
  })(),
  
  // Google Gemini AI
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  
  // White-label / sales: PRODUCT_PUBLIC_NAME, PRODUCT_TAGLINE, PRODUCT_SALES_EMAIL, SUPPORT_EMAIL — see config/productIdentity.js and GET /api/product
  // Gemini: GEMINI_MODEL_JSON / GEMINI_MODEL_PROSE; RAG embeddings: GEMINI_EMBEDDING_MODEL (default gemini-embedding-001)
  // NL discovery: NL_INTENT_MAX_SERPER (default 8) caps parallel Serper calls after expert query expansion — see services/ai/nlLeadIntent.js
  // Multi-agent auto-leads: @langchain/langgraph orchestrates Find → Verify → Read; same GEMINI_API_KEY + SERPER_API_KEY (optional split keys for billing only).
  // AUTO_LEADS_QUICK_ONLY=true — server default: Find + assistant “quick read” prose only (skip verify/read / browser extract). Client can also send JSON { quickOnly: true }.
  // AUTO_LEADS_SALES_SHAPE=true — after rows are returned, optional Gemini pass to sales_intelligence.sales_rows (project, phase, why_lead). No Street View / guaranteed GC names.
  // NL discovery: NL_INTENT_MAX_SERPER (default 10), NL_INTENT_MIN_POOL (default 8 → triggers fallback queries), NL_INTENT_FALLBACK_QUERIES (default 4).
  // Playwright: PLAYWRIGHT_PROXY_LIST / PLAYWRIGHT_PROXY_SERVER — use US residential or geo-near portals when sites block DC IPs; getChromium() uses playwright-extra + stealth when installed.
  // RAG (lead-gen prompts): RAG_ENABLED (default on), RAG_TOP_K — see services/ai/rag/leadGenRag.js
  // Playwright (browser): also reads PLAYWRIGHT_PROXY_LIST, PLAYWRIGHT_PROXY_SERVER, HTTPS_PROXY, HTTP_PROXY in stealth.js
  PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS !== 'false',
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  PLAYWRIGHT_CHROMIUM_ARGS: process.env.PLAYWRIGHT_CHROMIUM_ARGS,
  
  // Session
  SESSION_SECRET: process.env.SESSION_SECRET || 'your-secret-key-here-change-in-production',
  
  // Timings
  DEFAULT_TIMINGS: {
    networkIdleTimeout: 10000,
    jsRenderWait: 3000,
    afterScrollWait: 5000,
    betweenScrollWait: 500,
    pageLoadWait: 5000,
    betweenSourcesWait: 2000
  }
};
