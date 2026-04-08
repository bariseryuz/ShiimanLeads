/**
 * Stealth Configuration for Playwright
 * Makes browser automation undetectable by government sites
 */

const logger = require('../../utils/logger');

/** Round-robin index for PLAYWRIGHT_PROXY_LIST */
let proxyRoundRobin = 0;

/**
 * Parse proxy URLs from env (comma, newline, semicolon, or pipe separated).
 * Example: http://user:pass@host:8080,http://host2:8080
 * @returns {string[]}
 */
function parseProxyListFromEnv() {
  const raw = process.env.PLAYWRIGHT_PROXY_LIST || process.env.PROXY_ROTATION_URLS || '';
  if (!String(raw).trim()) return [];
  return String(raw)
    .split(/[\n,;|]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Next proxy for this browser launch (rotation across list).
 * Playwright: https://playwright.dev/docs/network#http-proxy
 * @returns {{ server: string, username?: string, password?: string } | null}
 */
function getNextProxyFromList() {
  const list = parseProxyListFromEnv();
  if (!list.length) return null;
  const idx = proxyRoundRobin % list.length;
  proxyRoundRobin += 1;
  logger.debug(`Playwright proxy rotation: ${idx + 1}/${list.length}`);
  return parseProxyServerObject(list[idx]);
}

/**
 * Single proxy from env (system proxy, Clash, corporate gateway).
 * Uses PLAYWRIGHT_PROXY_SERVER, then HTTPS_PROXY, then HTTP_PROXY.
 */
function getProxyFromStandardEnv() {
  const raw =
    process.env.PLAYWRIGHT_PROXY_SERVER ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    '';
  const s = String(raw).trim();
  if (!s) return null;
  return parseProxyServerObject(s);
}

/** Parse "http://user:pass@host:port" into Playwright proxy object */
function parseProxyServerObject(serverUrl) {
  try {
    const u = new URL(serverUrl);
    const out = { server: `${u.protocol}//${u.host}` };
    if (u.username) {
      out.username = decodeURIComponent(u.username);
      out.password = decodeURIComponent(u.password || '');
    }
    return out;
  } catch {
    return { server: serverUrl };
  }
}

function maskProxyForLog(proxy) {
  if (!proxy || !proxy.server) return '';
  return String(proxy.server).replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

/**
 * Proxy for Chromium: rotating list wins; else standard env (HTTPS_PROXY, etc.).
 */
function getProxyForLaunch() {
  const fromList = getNextProxyFromList();
  if (fromList) return fromList;
  return getProxyFromStandardEnv();
}

/**
 * Get stealth launch options for Playwright
 * @returns {Object} Chromium launch options
 */
function getStealthLaunchOptions() {
  const opts = {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  };
  const proxy = getProxyForLaunch();
  if (proxy) {
    opts.proxy = proxy;
    logger.info(`Playwright proxy: ${maskProxyForLog(proxy)}`);
  }
  return opts;
}

/**
 * Get stealth context options
 * @returns {Object} Browser context options
 */
function getStealthContextOptions() {
  return {
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  };
}

/**
 * Inject stealth scripts into page to hide automation
 * @param {Object} page - Playwright page object
 */
async function injectStealthScripts(page) {
  await page.addInitScript(() => {
    // Remove webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
    
    // Add chrome object (real browsers have this)
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {}
    };
    
    // Override permissions query
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    // Make languages more realistic
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
    
    // Add fake plugins to look like real browser
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ]
    });
    
    // Override toString to hide proxy
    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function() {
      if (this === window.navigator.permissions.query) {
        return 'function query() { [native code] }';
      }
      return originalToString.call(this);
    };
    
    // Make it look like we have real hardware
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8
    });
    
    // Add realistic device memory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8
    });
    
    // Hide automation in stack traces
    const originalError = Error.prepareStackTrace;
    Error.prepareStackTrace = (error, stack) => {
      if (originalError) return originalError(error, stack);
      return error.stack;
    };
    
    // Override Notification permission
    Object.defineProperty(Notification, 'permission', {
      get: () => 'default'
    });
  });
}

/**
 * Setup stealth browser with all protections
 * @param {Object} chromium - Playwright chromium object
 * @returns {Promise<Object>} { browser, context, page }
 */
async function createStealthBrowser(chromium) {
  const browser = await chromium.launch(getStealthLaunchOptions());
  const context = await browser.newContext(getStealthContextOptions());
  const page = await context.newPage();
  await injectStealthScripts(page);
  return { browser, context, page };
}

module.exports = {
  getStealthLaunchOptions,
  getStealthContextOptions,
  injectStealthScripts,
  createStealthBrowser,
  getNextProxyForLaunch: getProxyForLaunch,
  getProxyForLaunch,
  parseProxyListFromEnv
};
