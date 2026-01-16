const puppeteer = require('puppeteer');

async function testRedfin() {
  console.log('🔍 Testing Redfin agents page...\n');
  
  const url = 'https://www.redfin.com/real-estate-agents/phoenix-az';
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    console.log('📡 Loading page...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    console.log('✅ Page loaded\n');
    
    // Test 1: Check if content exists WITHOUT JavaScript
    console.log('TEST 1: Static HTML (no JS execution)');
    const staticHtml = await page.content();
    const hasStaticAgents = staticHtml.includes('agent') && (staticHtml.includes('phone') || staticHtml.includes('email'));
    console.log(`  Has agent data in static HTML: ${hasStaticAgents ? '✅ YES' : '❌ NO'}`);
    
    // Test 2: Check rendered content WITH JavaScript
    console.log('\nTEST 2: Dynamic content (JS executed)');
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for JS
    
    const agentElements = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="agent"], [class*="Agent"], .result');
      return {
        count: cards.length,
        hasContent: cards.length > 0,
        sampleText: cards[0]?.innerText?.substring(0, 200) || 'No content'
      };
    });
    
    console.log(`  Agent cards found: ${agentElements.count}`);
    console.log(`  Has dynamic content: ${agentElements.hasContent ? '✅ YES' : '❌ NO'}`);
    
    if (agentElements.hasContent) {
      console.log(`\n📋 Sample agent data:`);
      console.log(agentElements.sampleText);
    }
    
    // Test 3: Check for CAPTCHA/blocking
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
    const isBlocked = bodyText.includes('captcha') || bodyText.includes('access denied') || bodyText.includes('bot');
    
    console.log(`\n🔒 Blocked/CAPTCHA: ${isBlocked ? '❌ YES' : '✅ NO'}`);
    
    // Final verdict
    console.log('\n' + '='.repeat(60));
    console.log('📝 VERDICT:');
    console.log('='.repeat(60));
    
    if (isBlocked) {
      console.log('❌ Redfin is blocking automated access');
    } else if (agentElements.hasContent) {
      if (hasStaticAgents) {
        console.log('✅ Redfin works with STATIC HTML');
        console.log('📝 Settings:');
        console.log('   • Use AI Extraction: ✅ YES');
        console.log('   • Use Dynamic Rendering: ❌ NO (not needed)');
      } else {
        console.log('✅ Redfin works with DYNAMIC RENDERING');
        console.log('📝 Settings:');
        console.log('   • Use AI Extraction: ✅ YES');
        console.log('   • Use Dynamic Rendering: ✅ YES (required)');
      }
      console.log('   • Keywords: agent, email, phone, contact, name');
    } else {
      console.log('❌ Could not find agent data on page');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    if (browser) await browser.close();
  }
}

testRedfin();
