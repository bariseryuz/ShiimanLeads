/**
 * Pop-up Prevention and Removal System
 * 
 * Handles cookie banners, modals, overlays, and chat widgets that interfere with scraping.
 * Uses three strategies:
 * 1. Block pop-up scripts before they load (preventive)
 * 2. Click "Accept/Close" buttons (interactive)
 * 3. Force remove overlays from DOM (aggressive)
 */

const logger = require('../../utils/logger');

/**
 * Block known pop-up and tracking scripts before they load
 * Call this BEFORE page.goto()
 * 
 * @param {Object} page - Puppeteer page object
 */
async function setupPopupBlocking(page) {
  logger.info(`🛡️ Setting up pop-up blocking...`);
  
  try {
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const url = request.url();
      const resourceType = request.resourceType();
      
      // Domains known for pop-ups, tracking, and chat widgets
      const blockedDomains = [
        // Chat widgets
        'intercom.io',
        'intercom.com',
        'drift.com',
        'drift.net',
        'hubspot.com',
        'livechatinc.com',
        'tawk.to',
        'zendesk.com',
        'crisp.chat',
        
        // Analytics & tracking (often trigger pop-ups)
        'google-analytics.com',
        'googletagmanager.com',
        'facebook.com',
        'facebook.net',
        'doubleclick.net',
        'hotjar.com',
        'mouseflow.com',
        'segment.com',
        'segment.io',
        
        // Cookie consent platforms
        'cookiebot.com',
        'onetrust.com',
        'trustarc.com',
        'quantcast.com',
        'cookiepro.com',
        'cookielaw.org',
        
        // Ad networks (often show modals)
        'googlesyndication.com',
        'adservice.google.com',
        'advertising.com'
      ];
      
      const shouldBlock = blockedDomains.some(domain => url.includes(domain));
      
      if (shouldBlock) {
        request.abort();
      } else {
        request.continue();
      }
    });
    
    logger.info(`✅ Pop-up blocking enabled (${blockedDomains.length} domains blocked)`);
  } catch (err) {
    logger.warn(`⚠️ Could not enable request interception: ${err.message}`);
  }
}

/**
 * Detect and click "Accept", "Close", "Dismiss" buttons
 * Tries multiple common selectors for various pop-up types
 * 
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<number>} Number of pop-ups closed
 */
async function closePopups(page) {
  logger.info(`🚫 Checking for pop-ups...`);
  
  let popupsClosed = 0;
  
  // Comprehensive list of selectors for common pop-up buttons
  const popupSelectors = [
    // === COOKIE CONSENT BANNERS ===
    'button[id*="accept" i]',
    'button[id*="cookie" i]',
    'button[class*="accept" i]',
    'button[class*="cookie" i]',
    'button[class*="consent" i]',
    'a[class*="accept" i]',
    'a[class*="cookie" i]',
    '[aria-label*="Accept" i]',
    '[aria-label*="Cookie" i]',
    '[aria-label*="Consent" i]',
    'button:contains("Accept")',
    'button:contains("Accept all")',
    'button:contains("Accept cookies")',
    'button:contains("I agree")',
    'button:contains("I understand")',
    'button:contains("Got it")',
    'button:contains("OK")',
    
    // Specific cookie platforms
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    '#cookie-accept',
    '#cookie-consent-accept',
    '.cc-accept',
    '.cc-allow',
    '.cookie-accept',
    
    // === GENERIC CLOSE BUTTONS ===
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    'button[title="Close"]',
    'button[title="close"]',
    'button.close',
    'button.modal-close',
    'button.popup-close',
    '[class*="close-button"]',
    '[class*="closeButton"]',
    '[class*="dismiss"]',
    '[data-dismiss="modal"]',
    '[aria-label*="Close" i]',
    '[aria-label*="Dismiss" i]',
    
    // === MODAL/DIALOG CLOSE BUTTONS ===
    '.modal button.close',
    '.popup button.close',
    '[role="dialog"] button[aria-label="Close"]',
    '[role="dialog"] button.close',
    '.ReactModal__Content button[aria-label="Close"]',
    '.MuiDialog-root button[aria-label="Close"]',
    
    // === NEWSLETTER/SUBSCRIPTION POP-UPS ===
    'button:contains("No thanks")',
    'button:contains("No, thanks")',
    'button:contains("Maybe later")',
    'button:contains("Skip")',
    'button:contains("Not now")',
    'a:contains("No thanks")',
    'a:contains("Skip")',
    '[aria-label*="dismiss" i]',
    '[aria-label*="skip" i]',
    '.newsletter-close',
    '.email-popup-close',
    
    // === ARCGIS HUB SPECIFIC (for your use case) ===
    'calcite-modal button[slot="primary"]',
    'calcite-modal button[appearance="solid"]',
    'calcite-modal [slot="header-trailing"] calcite-action',
    'calcite-alert button[slot="actions-end"]',
    'calcite-notice button[slot="actions-end"]',
    
    // === CHAT WIDGETS ===
    '#intercom-container .intercom-close',
    '#intercom-container button[aria-label="Close"]',
    '.drift-widget-controller-icon',
    '.drift-widget button[aria-label="Close"]',
    '#hubspot-messages-iframe-container button[aria-label="Close"]',
    '.zd-widget-btn-close',
    '.tawk-min-container',
    
    // === SURVEY/FEEDBACK POP-UPS ===
    '[class*="survey"] button[aria-label="Close"]',
    '[class*="feedback"] button[aria-label="Close"]',
    '.hotjar-button-close',
    
    // === AGE VERIFICATION ===
    'button:contains("Yes, I am 18+")',
    'button:contains("Enter")',
    'button:contains("I am over 18")',
    
    // === COMMON FRAMEWORKS ===
    // Bootstrap
    '.modal-header .close',
    '.modal-footer button[data-dismiss="modal"]',
    // Material UI
    '.MuiDialog-root .MuiIconButton-root',
    // Ant Design
    '.ant-modal-close',
    '.ant-modal-close-x',
    // Semantic UI
    '.ui.modal .close.icon'
  ];
  
  for (const selector of popupSelectors) {
    try {
      // Skip :contains() pseudo-selector (not native CSS, would need jQuery)
      if (selector.includes(':contains')) {
        continue;
      }
      
      // Check if element exists
      const elements = await page.$$(selector);
      
      if (elements.length > 0) {
        for (const element of elements) {
          // Check if element is actually visible
          const isVisible = await page.evaluate((el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 && 
              rect.height > 0 && 
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              style.opacity !== '0'
            );
          }, element);
          
          if (isVisible) {
            logger.info(`🎯 Found visible pop-up button: ${selector}`);
            
            try {
              await element.click();
              popupsClosed++;
              
              // Wait for animation to complete
              await new Promise(resolve => setTimeout(resolve, 500));
              
              logger.info(`✅ Clicked and closed pop-up (${selector})`);
            } catch (clickErr) {
              logger.warn(`⚠️ Could not click ${selector}: ${clickErr.message}`);
            }
          }
        }
      }
    } catch (err) {
      // Silently continue - element might have disappeared
      continue;
    }
  }
  
  // Special handling for :contains() selectors using page.evaluate
  try {
    const textBasedClose = await page.evaluate(() => {
      const texts = [
        'Accept', 'Accept all', 'I agree', 'Got it', 'OK',
        'No thanks', 'Maybe later', 'Skip', 'Close', 'Dismiss'
      ];
      
      let closed = 0;
      const buttons = Array.from(document.querySelectorAll('button, a'));
      
      for (const button of buttons) {
        const text = button.textContent.trim();
        if (texts.some(t => text === t || text.toLowerCase().includes(t.toLowerCase()))) {
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          
          if (rect.width > 0 && rect.height > 0 && 
              style.visibility !== 'hidden' && 
              style.display !== 'none') {
            button.click();
            closed++;
            console.log(`Clicked text-based button: "${text}"`);
          }
        }
      }
      
      return closed;
    });
    
    popupsClosed += textBasedClose;
  } catch (err) {
    // Ignore
  }
  
  // Press ESC key (closes many modals)
  try {
    await page.keyboard.press('Escape');
    await new Promise(resolve => setTimeout(resolve, 300));
    logger.info(`⌨️ Pressed ESC key`);
  } catch (err) {
    // Ignore
  }
  
  if (popupsClosed > 0) {
    logger.info(`✅ Successfully closed ${popupsClosed} pop-up(s)`);
  } else {
    logger.info(`ℹ️ No pop-ups detected`);
  }
  
  return popupsClosed;
}

/**
 * Forcefully remove pop-up overlays and modals from the DOM
 * This is the "nuclear option" for stubborn pop-ups
 * 
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<number>} Number of elements removed
 */
async function removePopupElements(page) {
  logger.info(`🗑️ Removing pop-up elements from DOM...`);
  
  const removed = await page.evaluate(() => {
    let removedCount = 0;
    
    // Selectors for elements to forcefully remove
    const selectors = [
      // Generic modals and overlays
      '.modal',
      '.popup',
      '.overlay',
      '.backdrop',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[class*="backdrop"]',
      '[class*="overlay"]',
      
      // Cookie consent
      '#cookie-banner',
      '#cookie-consent',
      '[id*="cookie" i]',
      '[class*="cookie-banner"]',
      '[class*="cookie-consent"]',
      '[class*="cookie-notice"]',
      '.cc-window',
      '.cc-banner',
      
      // Specific platforms
      'calcite-modal',
      'calcite-popover',
      'calcite-alert',
      
      // Common frameworks
      '.ReactModal__Overlay',
      '.MuiDialog-root',
      '.MuiBackdrop-root',
      '.ant-modal-mask',
      '.ant-modal-wrap',
      '.fade.modal',
      
      // Chat widgets
      '#intercom-container',
      '#drift-widget',
      '#drift-frame-controller',
      '#hubspot-messages-iframe-container',
      '.zd-widget',
      '.tawk-container',
      '#crisp-chatbox',
      
      // Newsletter/email pop-ups
      '[class*="newsletter"]',
      '[class*="email-popup"]',
      '[class*="subscribe-modal"]',
      
      // Survey/feedback
      '[class*="survey"]',
      '[class*="feedback-widget"]',
      '#kampyle_button'
    ];
    
    // Remove elements matching selectors
    selectors.forEach(selector => {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          // Only remove if it's actually blocking content (high z-index or fixed position)
          const style = window.getComputedStyle(el);
          const zIndex = parseInt(style.zIndex) || 0;
          const position = style.position;
          const role = el.getAttribute('role');
          
          if (zIndex > 100 || 
              position === 'fixed' || 
              position === 'absolute' ||
              role === 'dialog' ||
              el.hasAttribute('aria-modal')) {
            el.remove();
            removedCount++;
            console.log(`Removed element: ${selector}`);
          }
        });
      } catch (e) {
        // Ignore errors
      }
    });
    
    // Remove elements with very high z-index (likely overlays)
    try {
      const allElements = document.querySelectorAll('*');
      allElements.forEach(el => {
        const zIndex = parseInt(window.getComputedStyle(el).zIndex) || 0;
        if (zIndex > 9999) {
          el.remove();
          removedCount++;
          console.log(`Removed high z-index element: ${zIndex}`);
        }
      });
    } catch (e) {
      // Ignore
    }
    
    // Re-enable scrolling (many modals disable it)
    document.body.style.overflow = 'auto';
    document.body.style.position = 'static';
    document.documentElement.style.overflow = 'auto';
    
    // Remove modal-open class (Bootstrap adds this)
    document.body.classList.remove('modal-open');
    
    console.log(`✅ Removed ${removedCount} pop-up elements from DOM`);
    return removedCount;
  });
  
  if (removed > 0) {
    logger.info(`✅ Removed ${removed} pop-up element(s) from DOM`);
  } else {
    logger.info(`ℹ️ No pop-up elements found in DOM`);
  }
  
  return removed;
}

/**
 * Complete pop-up prevention workflow
 * Combines all three strategies in the optimal order
 * 
 * @param {Object} page - Puppeteer page object
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Stats about what was blocked/removed
 */
async function preventAllPopups(page, options = {}) {
  const {
    waitBetweenSteps = 1500,  // Time to wait between cleanup steps
    retries = 2                // How many times to check for pop-ups
  } = options;
  
  logger.info(`🛡️ Starting comprehensive pop-up prevention...`);
  
  const stats = {
    blocked: 0,
    closed: 0,
    removed: 0
  };
  
  try {
    // Step 1: Click to close visible pop-ups
    stats.closed += await closePopups(page);
    await new Promise(resolve => setTimeout(resolve, waitBetweenSteps));
    
    // Step 2: Force remove stubborn elements
    stats.removed += await removePopupElements(page);
    await new Promise(resolve => setTimeout(resolve, waitBetweenSteps));
    
    // Step 3: Check again (some pop-ups appear on delay)
    for (let i = 0; i < retries; i++) {
      logger.info(`🔄 Retry check ${i + 1}/${retries}...`);
      stats.closed += await closePopups(page);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    logger.info(`✅ Pop-up prevention complete: ${stats.closed} closed, ${stats.removed} removed`);
    
  } catch (err) {
    logger.error(`❌ Error during pop-up prevention: ${err.message}`);
  }
  
  return stats;
}

module.exports = {
  setupPopupBlocking,
  closePopups,
  removePopupElements,
  preventAllPopups
};
