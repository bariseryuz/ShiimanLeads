const puppeteer = require('puppeteer');

// Nashville URL with filters already applied
const URL = 'https://data.nashville.gov/datasets/2576bfb2d74f418b8ba8c4538e4f729f_0/explore?filters=eyJQZXJtaXRfVHlwZV9EZXNjcmlwdGlvbiI6WyJCdWlsZGluZyBSZXNpZGVudGlhbCAtIE5ldyJdLCJQZXJtaXRfU3VidHlwZV9EZXNjcmlwdGlvbiI6WyJNdWx0aWZhbWlseSwgVHJpLVBsZXgsIFF1YWQsIEFwYXJ0bWVudHMiLCJNdWx0aWZhbWlseSwgVG93bmhvbWUiXSwiRGF0ZV9FbnRlcmVkIjpbMTUwMTY1MDAwMDAwMCwxNzY0ODI4MDAwMDAwXSwiRGF0ZV9Jc3N1ZWQiOlsxNjcwMjIwMDAwMDAwLDE3NjUwODcyMDAwMDBdLCJDb25zdF9Db3N0IjpbMCwyMjYwNjg3NTldfQ%3D%3D&location=36.213201%2C-86.071734%2C8.14&showTable=true';

async function testNashville() {
  console.log('🚀 Starting Puppeteer test for Nashville...\n');
  
  let browser;
  let page;
  
  try {
    // STEP 1: Launch browser with anti-detection settings
    browser = await puppeteer.launch({
      headless: false, // Set to false to watch the browser
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    });
    
    console.log('✅ Browser launched');
    
    // STEP 2: Open new page
    page = await browser.newPage();
    
    // Make it look like a real browser
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log('✅ New page opened');
    
    // STEP 3: Navigate to URL
    console.log(`📍 Navigating to: ${URL.substring(0, 80)}...`);
    await page.goto(URL, { 
      waitUntil: 'domcontentloaded', // Less strict waiting
      timeout: 60000 
    });
    console.log('✅ Page loaded');
    
    // STEP 4: Wait for page to settle
    console.log('\n⏳ Waiting for page to render...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Try to find and click "View data table" button if it exists
    console.log('🔍 Looking for "View data table" button...');
    const viewTableButton = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const button = links.find(el => el.textContent.includes('View data table'));
      if (button) {
        button.click();
        return true;
      }
      return false;
    });
    
    if (viewTableButton) {
      console.log('✅ Found and clicked button, waiting for table...');
      await new Promise(resolve => setTimeout(resolve, 8000));
    } else {
      console.log('⚠️  Button not found, table might already be visible. Scrolling down...');
      await page.evaluate(() => window.scrollBy(0, 1000));
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // STEP 5: Take a screenshot to see what we got
    await page.screenshot({ path: 'nashville-page.png', fullPage: false });
    console.log('✅ Screenshot saved: nashville-page.png');
    
    // STEP 6: Get page HTML and check for table structure
    const html = await page.content();
    console.log(`\n📄 Page HTML length: ${html.length} characters`);
    
    // STEP 7: Try to find table elements
    console.log('\n🔍 Looking for table elements...');
    
    // Check if there's a table tag
    const hasTable = await page.$('table');
    console.log(`   <table> found: ${hasTable ? '✅ YES' : '❌ NO'}`);
    
    // Check for common data table classes/attributes
    const selectors = [
      'table tbody tr',
      'table',
      '[role="table"]',
      '[role="row"]',
      '[class*="table"]',
      '[class*="TableRow"]',
      '[class*="grid"]',
      '[class*="data"]',
      '[data-testid*="table"]',
      '[class*="calcite"]',
      '[class*="feature-table"]',
      '.feature-table tbody tr'
    ];
    
    for (const selector of selectors) {
      const count = await page.$$eval(selector, els => els.length).catch(() => 0);
      if (count > 0) {
        console.log(`   ✅ Found ${count} elements matching: ${selector}`);
      }
    }
    
    // Try to extract actual permit data if table exists
    if (hasTable) {
      console.log('\n📊 Attempting to extract first 3 rows of data...');
      const rows = await page.$$eval('table tbody tr', rows => {
        return rows.slice(0, 3).map(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          return cells.map(cell => cell.innerText.trim()).join(' | ');
        });
      }).catch(() => []);
      
      if (rows.length > 0) {
        console.log('✅ Sample data rows:');
        rows.forEach((row, i) => console.log(`   Row ${i+1}: ${row.substring(0, 150)}`));
      } else {
        console.log('⚠️  Table exists but no rows found');
      }
    }
    
    // STEP 8: Extract visible text to see what data is on page
    console.log('\n📝 Sample of visible text on page:');
    const bodyText = await page.evaluate(() => document.body.innerText);
    const textSample = bodyText.substring(0, 500);
    console.log(textSample);
    
    console.log('\n\n⏸️  Browser will stay open for 30 seconds so you can inspect the page...');
    console.log('   → Open DevTools (F12) in the browser');
    console.log('   → Inspect the table structure');
    console.log('   → Look for the CSS selector or XPath for rows\n');
    
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    await browser.close();
    console.log('\n✅ Test complete!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
}

// Run the test
testNashville().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
