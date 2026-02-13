const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Database (MUST be in /data/ for Railway volume persistence!)
  DB_PATH: process.env.SQLITE_DB_PATH || (isProduction 
    ? '/app/backend/data/shiiman-leads.db'  // Railway: In volume
    : path.join(__dirname, '..', 'data', 'shiiman-leads.db')),  // Local: backend/data/
  
  SESSIONS_DB_PATH: process.env.SQLITE_SESSIONS_DB_PATH || (isProduction
    ? '/app/backend/data/sessions.db'  // Railway: In volume
    : path.join(__dirname, '..', 'data', 'sessions.db')),  // Local: backend/data/
  
  SCREENSHOTS_DIR: isProduction
    ? '/app/backend/data/screenshots'  // Railway: In volume
    : path.join(__dirname, '..', 'data', 'screenshots'),  // Local: backend/data/
  
  // Proxy
  PROXY_ENABLED: process.env.PROXY_ENABLED === 'true',
  PROXY_URLS: process.env.PROXY_URLS 
    ? process.env.PROXY_URLS.split(',').map(p => p.trim()).filter(Boolean)
    : [],
  
  // Google Gemini AI
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  
  // Playwright (fallback to legacy Puppeteer env vars if set)
  PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS
    ? process.env.PLAYWRIGHT_HEADLESS !== 'false'
    : process.env.PUPPETEER_HEADLESS !== 'false',
  PLAYWRIGHT_EXECUTABLE_PATH: process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH,
  // Legacy Puppeteer env vars (deprecated)
  PUPPETEER_HEADLESS: process.env.PUPPETEER_HEADLESS !== 'false',
  PUPPETEER_EXECUTABLE_PATH: process.env.PUPPETEER_EXECUTABLE_PATH,
  
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
