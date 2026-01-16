const puppeteer = require('puppeteer');
require('dotenv').config();

async function testRedfinWithAI() {
  console.log('🔍 Testing Redfin with AI Extraction (Full Simulation)...\n');
  
  const url = 'https://www.redfin.com/real-estate-agents/phoenix-az';
  
  // Check if Gemini API key exists
  if (!process.env.GEMINI_API_KEY) {
    console.log('❌ GEMINI_API_KEY not found in .env file!');
    console.log('💡 The scraper needs this to extract data with AI');
    console.log('💡 Add GEMINI_API_KEY=your-key-here to .env file\n');
  } else {
    console.log('✅ Gemini API key found\n');
  }
  
  let browser;
  try {
    console.log('🚀 Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    console.log('📡 Loading Redfin...');
    await page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    console.log('✅ Page loaded');
    
    // Get page content (what AI will process)
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log(`📏 Page text length: ${pageText.length} characters`);
    
    // Show sample of what AI sees
    console.log('\n📝 Sample content AI will process:');
    console.log('-'.repeat(60));
    console.log(pageText.substring(0, 500));
    console.log('-'.repeat(60));
    
    // Check for agent data patterns
    const hasEmails = pageText.toLowerCase().includes('@') || pageText.toLowerCase().includes('email');
    const hasPhones = /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(pageText);
    const hasAgents = pageText.toLowerCase().includes('agent');
    const hasNames = /[A-Z][a-z]+ [A-Z][a-z]+/.test(pageText);
    
    console.log('\n🔍 Data pattern detection:');
    console.log(`  Emails found: ${hasEmails ? '✅' : '❌'}`);
    console.log(`  Phone numbers found: ${hasPhones ? '✅' : '❌'}`);
    console.log(`  Agent mentions: ${hasAgents ? '✅' : '❌'}`);
    console.log(`  Names found: ${hasNames ? '✅' : '❌'}`);
    
    // Test AI extraction (if API key exists)
    if (process.env.GEMINI_API_KEY) {
      console.log('\n🤖 Testing AI extraction...');
      
      try {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        
        const prompt = `Extract real estate agent contact information from this webpage.
Focus on: agent names, phone numbers, email addresses, companies.
Return ONLY valid structured data in JSON array format like:
[{"name":"John Doe","phone":"602-555-1234","email":"john@realty.com","company":"ABC Realty"}]

If no data found, return empty array: []

Webpage content:
${pageText.substring(0, 8000)}`;
        
        console.log('  Sending to Gemini AI...');
        const result = await model.generateContent(prompt);
        const aiResponse = result.response.text();
        
        console.log('\n🤖 AI Response:');
        console.log('-'.repeat(60));
        console.log(aiResponse);
        console.log('-'.repeat(60));
        
        // Try to parse JSON
        try {
          const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const leads = JSON.parse(jsonMatch[0]);
            console.log(`\n✅ Successfully extracted ${leads.length} leads!`);
            
            if (leads.length > 0) {
              console.log('\n📋 Sample leads:');
              leads.slice(0, 3).forEach((lead, i) => {
                console.log(`\n  Lead ${i + 1}:`);
                console.log(`    Name: ${lead.name || 'N/A'}`);
                console.log(`    Phone: ${lead.phone || 'N/A'}`);
                console.log(`    Email: ${lead.email || 'N/A'}`);
                console.log(`    Company: ${lead.company || 'N/A'}`);
              });
            }
          } else {
            console.log('⚠️ AI response is not in JSON format');
          }
        } catch (parseErr) {
          console.log('⚠️ Could not parse AI response as JSON');
        }
        
      } catch (aiErr) {
        console.error('❌ AI extraction error:', aiErr.message);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📝 DIAGNOSIS:');
    console.log('='.repeat(60));
    
    if (!process.env.GEMINI_API_KEY) {
      console.log('❌ PROBLEM: No Gemini API key configured');
      console.log('💡 SOLUTION: Add GEMINI_API_KEY to Railway environment variables');
    } else if (!hasAgents && !hasNames) {
      console.log('❌ PROBLEM: No agent data found on page');
      console.log('💡 SOLUTION: Try different URL or website');
    } else {
      console.log('✅ Setup looks correct!');
      console.log('💡 Check Railway logs for scraping errors');
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    if (browser) await browser.close();
  }
}

testRedfinWithAI();
