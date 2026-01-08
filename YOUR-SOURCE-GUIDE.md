# Your Custom Source Management System - Quick Guide

## ✅ What's Been Set Up

### 1. **Profile Management**
- Access at: `http://localhost:3000/profile.html`
- Add your company name, email, phone, and website
- Completely separate from other users

### 2. **Source Management** 
- Access at: `http://localhost:3000/manage-sources.html`
- Add YOUR OWN sources (not shared with anyone)
- Delete your sources anytime

### 3. **Pre-Built Templates**
I've included 3 quick templates you can use:

#### **Zillow Real Estate Agents** ⭐ (Recommended for you)
- Scrapes agent names, emails, phones, brokerages
- Uses AI to extract contact info
- Perfect for finding agents to send deals to

#### **Realtor.com Agents**
- Another source for real estate agents
- Similar to Zillow

#### **LinkedIn Search**
- For finding professionals on LinkedIn
- Note: May require login

## 🚀 How to Use

### Step 1: Login
Go to `http://localhost:3000/login.html`

### Step 2: Go to "My Sources"
Click "My Sources" in the navigation OR go to `/manage-sources.html`

### Step 3: Add a Source
1. Click "+ Add New Source"
2. You can either:
   - Click "Zillow Agents" template button (easiest!)
   - Or manually fill in:
     - Name: e.g., "Zillow Phoenix Agents"
     - URL: https://www.zillow.com/professionals/real-estate-agent-reviews/
     - Method: Puppeteer
     - Check "Use AI to extract contact info" ✓

### Step 4: Customize Zillow URL (Optional)
You can target specific locations by changing the URL:
- Phoenix: `https://www.zillow.com/professionals/real-estate-agent-reviews/phoenix-az/`
- Miami: `https://www.zillow.com/professionals/real-estate-agent-reviews/miami-fl/`
- Any city: Just add the city name

### Step 5: Let it Run!
- The scraper runs automatically every 5 minutes
- Your leads will appear in your dashboard at `/client-portal.html`
- Only YOU can see your sources and leads

## 📋 Your Sources Are Private
- Sources you add are ONLY for you
- They're stored in the `user_sources` table with your user_id
- Other users can't see or access your sources
- The default sources in `client-sources-config.json` are separate

## 🎯 What Gets Scraped from Zillow
The AI will extract:
- Agent names
- Email addresses
- Phone numbers
- Brokerage/company names
- Locations
- Any other contact information it finds

## ⚙️ Advanced: Add Custom Sources
You can scrape ANY website:

1. **Simple websites**: Use "HTML" method
2. **Complex websites**: Use "Puppeteer" method
3. **APIs**: Use "JSON" method

The system will:
- Automatically deduplicate leads
- Run every 5 minutes
- Use AI to extract contact info if enabled

## 📱 Profile Page
At `/profile.html` you can add:
- Company name
- Email
- Phone
- Website

This is for your reference and future features.

## 🔧 Technical Details
- Server runs on port 3000 (or auto-finds free port)
- Database: SQLite (`leads.db`)
- AI: Google Gemini for extraction
- Browser automation: Puppeteer for complex sites

## 🆘 Troubleshooting

**Can't see my sources?**
- Make sure you're logged in
- Check the browser console for errors

**Sources not scraping?**
- Check if AI is enabled (recommended for most sites)
- Some sites may block automated scraping
- Try adding wait times in Puppeteer config

**Want to scrape a specific Zillow page?**
- Just update the URL to be more specific
- Examples:
  - By location: `/professionals/real-estate-agent-reviews/[city-name]/`
  - By state: `/professionals/real-estate-agent-reviews/[state-code]/`

## 🎉 You're All Set!
Your system is ready to scrape Zillow agents and any other sources you want to add!
