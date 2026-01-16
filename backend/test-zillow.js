const puppeteer = require('puppeteer');

async function testZillow() {
  console.log('🔍 Testing Zillow AGENTS scraping...\n');
  
  // Example Zillow Agents URLs
  const testUrls = [
    'https://www.zillow.com/professionals/real-estate-agent-reviews/phoenix-az/',
    'https://www.zillow.com/professionals/real-estate-agent-reviews/'
  ];
  
  for (const zillowUrl of testUrls) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${zillowUrl}`);
    console.log('='.repeat(60));
    
    let browser;
    try {
      console.log('🚀 Launching browser...');
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-web-security'
        ]
      });
      
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      console.log(`📡 Navigating...`);
      await page.goto(zillowUrl, { 
        waitUntil: 'networkidle2',
        timeout: 60000 
      });
      
      console.log('✅ Page loaded');
      
      const title = await page.title();
      console.log(`📄 Title: ${title}`);
      
      const html = await page.content();
      console.log(`📏 HTML: ${html.length} chars`);
      
      // Try to find agent cards/profiles
      const agentCount = await page.evaluate(() => {
        const selectors = [
          '[data-test*="agent-card"]',
          '[class*="AgentCard"]',
          '[class*="agent-card"]',
          'article[role="article"]',
          '.agent-list-card'
        ];
        
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          if (els.length > 0) return els.length;
        }
        return 0;
      });
      
      console.log(`👥 Found ${agentCount} agent profiles`);
      
      if (agentCount === 0) {
        console.log('\n⚠️ No agent cards found');
        
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 800));
        console.log('\n📝 Page preview:');
        console.log(bodyText.substring(0, 400));
        
        if (bodyText.toLowerCase().includes('captcha') || bodyText.toLowerCase().includes('verify')) {
          console.log('\n❌ CAPTCHA detected!');
        } else if (bodyText.toLowerCase().includes('404') || bodyText.toLowerCase().includes('not found')) {
          console.log('\n❌ 404 error - page not found');
        } else {
          console.log('\n💡 Page loaded but structure might be different');
        }
      } else {
        console.log('\n✅ SUCCESS! Agent profiles found');
        
        // Try to extract sample agent data
        const sampleAgents = await page.evaluate(() => {
          const agents = [];
          const cards = document.querySelectorAll('[data-test*="agent"], article, .agent-card, [class*="AgentCard"]');
          
          for (let i = 0; i < Math.min(3, cards.length); i++) {
            const card = cards[i];
            const text = card.innerText || '';
            agents.push(text.substring(0, 200));
          }
          return agents;
        });
        
        console.log('\n📋 Sample agent data:');
        sampleAgents.forEach((agent, i) => {
          console.log(`\nAgent ${i + 1}:`);
          console.log(agent);
        });
      }
    } catch (error) {
      console.error('\n❌ Error:');
      console.error(error.message);
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📝 SUMMARY:');
  console.log('='.repeat(60));
  console.log('\n✅ To scrape Zillow agents, use URLs like:');
  console.log('   • https://www.zillow.com/professionals/real-estate-agent-reviews/phoenix-az/');
  console.log('   • https://www.zillow.com/professionals/real-estate-agent-reviews/los-angeles-ca/');
  console.log('   • https://www.zillow.com/professionals/real-estate-agent-reviews/miami-fl/');
  console.log('\n💡 Make sure to:');
  console.log('   1. Use the FULL city URL (not just /professionals/)');
  console.log('   2. Enable "Use AI" checkbox');
  console.log('   3. Set keywords like: agent, phone, email, contact');
  console.log('\n');
}

testZillow();
