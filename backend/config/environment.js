const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  // Server
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Database
  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'shiiman-leads.db'),
  
  // Proxy
  PROXY_ENABLED: process.env.PROXY_ENABLED === 'true',
  PROXY_URLS: process.env.PROXY_URLS 
    ? process.env.PROXY_URLS.split(',').map(p => p.trim()).filter(Boolean)
    : [],
  
  // Google Gemini AI
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  
  // Puppeteer
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
