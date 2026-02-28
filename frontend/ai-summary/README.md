# 🤖 AI Lead Analyzer Feature

## Overview
The AI Lead Analyzer allows users to analyze and summarize their leads using AI (Gemini API). Users can filter leads by date range, search criteria, select them individually or in bulk, and generate AI-powered summaries with customizable templates.

## 📁 Project Structure

### Backend
- **`backend/services/ai/Alsummarize.js`** - Core AI summarization service
  - Job creation and management
  - Lead filtering by date range
  - Cost estimation
  - Prompt templating
  - Summary cache

- **`backend/routes/summarize.js`** - API endpoints
  - `POST /api/summarize` - Create summarization job
  - `GET /api/summarize/:jobId` - Get job status and results
  - `GET /api/summarize` - List user's jobs

### Frontend
- **`frontend/ai-summary/dashboard.html`** - Main lead selection interface
  - Date range filters with quick presets (Last 7/30/90 days, YTD)
  - Search and filter functionality
  - Single and bulk lead selection
  - Real-time statistics (total, selected, filtered, estimated cost)
  - Pagination support (20 items per page)
  - "AI Analyze" button to initiate summarization

- **`frontend/ai-summary/dashboard.js`** - Dashboard logic
  - Lead loading and filtering
  - Selection management
  - Pagination
  - Modal for AI settings (template, max tokens)
  - Job submission

- **`frontend/ai-summary/summaries.html`** - Results viewer
  - Job status tracking (queued, processing, completed, failed)
  - Summary card grid display
  - Export options (CSV, JSON)
  - Copy-to-clipboard functionality
  - Real-time polling for job updates

- **`frontend/ai-summary/summaries.js`** - Results logic
  - Job polling (2-second intervals)
  - Export handlers
  - Download functionality
  - Summary copying

## 🚀 Features

### 1. Lead Filtering & Selection
- **Date Range Filter**: Custom date picker or quick presets
- **Search**: Full-text search across multiple fields (name, company, email, phone)
- **Pagination**: 20 leads per page for better performance
- **Bulk Selection**: Select all visible, select all filtered, or individual selection
- **Real-time Stats**: Shows total, selected, filtered counts and estimated cost

### 2. Summarization Options
- **Templates**: Pre-configured prompts for different use cases
  - `default` - General 2-3 sentence summary
  - `business` - Business analysis and industry focus
  - `contact` - Contact profile summary
  - `opportunity` - Sales opportunity assessment

- **Output Length Control**:
  - Short: 512 tokens (~2-3 sentences)
  - Medium: 1024 tokens (~4-6 sentences) - Default
  - Long: 2048 tokens (~10-15 sentences)
  - Very Long: 4096 tokens (~20+ sentences)

- **Cost Estimation**: Real-time cost calculation based on lead count and token usage

### 3. Async Job Processing
- **Background Processing**: Jobs run asynchronously to avoid timeout
- **Job Status Tracking**: Queued → Processing → Completed/Failed
- **Automatic Retry**: Failed items can be reprocessed
- **Job History**: Users can view their last 20 jobs

### 4. Results & Export
- **Summary Cards**: Each lead displays with full details and summary
- **Error Handling**: Failed summaries show error messages with retry option
- **Export Formats**:
  - CSV (opens in Excel)
  - JSON (raw data with metadata)
  - Copy to clipboard (all summaries)

- **Download Individual**: Save each summary as text file

## 🔗 API Endpoints

### Create Summarization Job
```
POST /api/summarize
Content-Type: application/json

{
  "leads": [
    { "id": "1", "name": "John Doe", "company": "Acme Inc", "email": "john@acme.com", "phone": "555-1234", "source": "ArcGIS" },
    ...
  ],
  "template": "default",
  "maxTokens": 1024,
  "dateRange": {
    "startDate": "2026-02-01",
    "endDate": "2026-02-28"
  }
}

Response:
{
  "jobId": "job_1234567890_abc123def",
  "status": "queued"
}
```

### Get Job Status
```
GET /api/summarize/:jobId

Response:
{
  "id": "job_1234567890_abc123def",
  "userId": "user_123",
  "status": "completed",
  "createdAt": "2026-02-28T10:00:00Z",
  "startedAt": "2026-02-28T10:00:05Z",
  "completedAt": "2026-02-28T10:02:30Z",
  "result": {
    "summaries": [
      {
        "lead": { ... },
        "summary": "This lead represents a mid-sized business in the real estate sector..."
      }
    ],
    "totalLeads": 5,
    "successCount": 5,
    "failureCount": 0
  },
  "estimatedCost": {
    "estimatedInputTokens": 2500,
    "estimatedOutputTokens": 1500,
    "inputCost": "0.0002",
    "outputCost": "0.0005",
    "totalCost": "0.0007",
    "currency": "USD"
  }
}
```

### List User Jobs
```
GET /api/summarize

Response:
{
  "jobs": [
    { ...job object... },
    ...
  ],
  "count": 5
}
```

## 🔧 Installation & Setup

### 1. Backend
The backend files are already integrated:
- `Alsummarize.js` handles all summarization logic
- `summarize.js` routes are registered in `index.js`
- Requires Gemini API credentials in `.env`:

```env
GEMINI_API_KEY=your_key_here
```

### 2. Frontend
Access the AI Summary feature:
```
Frontend: localhost:3000/ai-summary/dashboard.html
```

## 📊 Usage Workflow

1. **Navigate to Dashboard**
   - Load leads by applying filters or using search
   - Stats panel shows real-time counts

2. **Select Leads**
   - Choose individual leads with checkboxes
   - Use "Select All Filtered" for bulk selection
   - Bulk actions bar shows selected count

3. **Adjust Settings** (optional)
   - Click "AI Analyze" button
   - Choose template and output length
   - See cost estimate

4. **Generate Summaries**
   - Click "Start Analyzing"
   - Redirected to summaries page
   - Job status updates in real-time

5. **Review & Export**
   - View all summaries in card grid
   - Copy individual summaries
   - Export all as CSV/JSON
   - Download individual summaries as .txt

## 💰 Cost Estimation

Costs are based on Gemini API pricing (as of Feb 2026):
- Input: $0.075 per 1M tokens
- Output: $0.3 per 1M tokens

**Average cost per lead**: ~$0.12 (varies by lead complexity)

## 🛡️ Security & Privacy

- User authentication required for all endpoints
- Sessions managed with SQLite store
- CORS headers configured for API security
- PII fields can be masked (future enhancement)

## ⚙️ Configuration

### Environment Variables
```env
# Gemini API
GEMINI_API_KEY=sk-...

# Pricing estimation
GEMINI_INPUT_COST_PER_1M=0.075
GEMINI_OUTPUT_COST_PER_1M=0.3

# Rate limiting (future)
SUMMARIZE_MAX_LEADS_PER_JOB=1000
SUMMARIZE_MAX_JOBS_PER_USER=10
```

## 🚦 Status Codes

- `queued` - Job waiting in queue
- `processing` - Actively summarizing leads
- `completed` - All summaries generated successfully
- `failed` - Job encountered fatal error

## 📝 Example Use Cases

### Real Estate Prospecting
Template: `business`
Max Tokens: `1024`
- Analyzes property types, market segments, and investment potential

### Sales Lead Qualification
Template: `opportunity`
Max Tokens: `1024`
- Assesses sales potential, budget indicators, and urgency

### Contact Database Enrichment
Template: `contact`
Max Tokens: `512`
- Creates lean contact profiles with key identifiers

### Research & News
Template: `default`
Max Tokens: `2048`
- Detailed summaries of company news, expansion plans, partnerships

## 🐛 Troubleshooting

### Job Shows "Processing" Forever
- Check backend logs: `backend/logs/combined.log`
- Verify Gemini API credentials in `.env`
- Check rate limiting (free tier: 60 requests/min)

### Summaries Page Not Loading
- Check browser console for errors
- Verify job ID in URL query parameter
- Clear browser cache and reload

### Cost Higher Than Expected
- Review selected lead count (shown in stats)
- Check token settings (higher = more costly)
- Use "Short" template for preliminary analysis

## 📈 Future Enhancements

- [ ] Webhook notifications on job completion
- [ ] Scheduled batch summarization
- [ ] Custom prompt templates per user
- [ ] Summary quality scoring
- [ ] PII masking and redaction
- [ ] Queue priority levels
- [ ] Rate limiting per user/team
- [ ] History and caching for duplicate summaries
- [ ] Integration with CRM systems
- [ ] Multi-language summarization

## 📞 Support

For issues or feature requests, contact the development team or file an issue in the project repository.

---

**Last Updated**: February 28, 2026
**Version**: 1.0.0
