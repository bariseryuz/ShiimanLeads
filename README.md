# Shiiman Leads - Construction Permit Lead Generator

Automated lead generation system that scrapes construction permits from various sources.

## Features
- **AI-Powered Autonomous Navigation** - Just describe what you want, AI figures out how to extract it
- Automated scraping with node-cron
- SQLite database for lead storage
- API endpoints for lead retrieval
- Frontend client portal
- AI-powered lead extraction with Google Gemini

## Quick Start - AI Mode (Web Interface)

1. Log in to your dashboard
2. Go to "My Sources"
3. Click "+ Add Source"
4. Fill in:
   - **Source Name**: e.g., "Phoenix Building Permits"
   - **Website URL**: The page with the data
   - **AI Instructions**: "Find and open the building permits table, extract all data from all pages"
   - **Fields to extract**: permit number, address, contractor name, phone
5. Click "Save Source"
6. Click "Scrape Now" and watch AI work its magic! 🪄

### Example AI Instructions

- **Simple:** "Extract all building permits from the table"
- **With navigation:** "Click the 'Show Table' button, then extract all permits"
- **Multi-page:** "Extract all permits from every page of the table"
- **Complex:** "Click Building Permits tab, open the table, extract from all pages"

## How It Works

1. AI visits the URL you provide
2. Takes screenshots and analyzes the page
3. Finds buttons, tables, and data automatically
4. Handles pagination across multiple pages
5. Extracts and saves all data to your dashboard

No coding or selectors needed - just tell it what you want in plain English!

## Advanced Configuration

See [AI-NAVIGATION-EXAMPLE.md](backend/AI-NAVIGATION-EXAMPLE.md) for detailed examples and API configuration.

## Deployment

### Railway (Recommended)
1. Push code to GitHub
2. Connect Railway to your repo
3. Set environment variables in Railway dashboard
4. Deploy automatically

### Environment Variables
- `GEMINI_API_KEY` - Google Gemini API key for AI extraction
- `FRONTEND_PORT` - Port for the server (Railway sets this automatically)

## Local Development
```bash
cd backend
npm install
node index.js
```

Visit `http://localhost:3000`




add the stars to the backgroun or anythign thatbwill mak eit look futuristc so when it is sacrolled by the cliend or touched by client it can move itself
