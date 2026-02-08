# Roadmap: Intelligent Strategy Selection

## Phase 1: URL Analysis (2-3 days)
```javascript
async function analyzeURL(url) {
  // 1. Check robots.txt for API hints
  // 2. Detect framework (React, Angular, Vue)
  // 3. Find network requests
  // 4. Score each strategy
  
  return {
    recommended: 'api',
    confidence: 0.85,
    fallbacks: ['puppeteer', 'vision'],
    reason: 'Found GraphQL endpoint at /graphql'
  }
}
```

**Implementation:**
- Network request interception
- Framework detection patterns
- API endpoint discovery
- Performance estimation

---

## Phase 2: API Auto-Discovery (3-4 days)
```javascript
async function discoverAPI(page) {
  // Listen to XHR/Fetch requests
  const requests = await interceptNetworkRequests(page);
  
  // Find data endpoints
  const dataAPIs = requests.filter(r => 
    r.type === 'XHR' && 
    r.response.includes('json')
  );
  
  // Reverse engineer API calls
  return {
    endpoint: 'https://permits.example.com/api/v1/permits',
    method: 'POST',
    params: { startDate, endDate, limit: 100 },
    pagination: 'offset-based'
  }
}
```

**Implementation:**
- Puppeteer request interception
- GraphQL introspection
- REST pattern detection
- Authentication handling

---

## Phase 3: Self-Learning Schema (4-5 days)
```javascript
async function learnSchema(samples) {
  // Analyze 10-20 sample records
  const fields = extractCommonFields(samples);
  
  // Detect field types
  const schema = {};
  for (const field of fields) {
    schema[field] = {
      type: detectType(samples.map(s => s[field])),
      required: calculatePresence(samples, field) > 0.8,
      example: samples[0][field]
    }
  }
  
  return schema;
}
```

**Implementation:**
- Field frequency analysis
- Type detection (string, number, date, phone, email)
- Required vs optional classification
- Synonym detection (permit_number = permitNumber = number)

---

## Phase 4: Intelligent Fallback Chain (2-3 days)
```javascript
async function scrapeWithFallback(source) {
  const strategies = [
    { name: 'api', speed: 0.1, cost: 0, reliability: 0.95 },
    { name: 'static', speed: 0.5, cost: 0, reliability: 0.7 },
    { name: 'puppeteer', speed: 5, cost: 0.01, reliability: 0.9 },
    { name: 'vision', speed: 10, cost: 0.05, reliability: 0.85 }
  ];
  
  for (const strategy of strategies) {
    try {
      const result = await executeStrategy(strategy, source);
      if (result.success) return result;
    } catch (err) {
      logger.warn(`${strategy.name} failed, trying next...`);
    }
  }
}
```

**Implementation:**
- Strategy scoring system
- Automatic fallback triggering
- Performance tracking
- Cost-aware selection

---

## Phase 5: URL → Auto-Config (3-4 days)
```javascript
// User provides ONLY URL
app.post('/api/sources/auto-create', async (req, res) => {
  const { url } = req.body;
  
  // 1. Analyze URL
  const analysis = await analyzeURL(url);
  
  // 2. Discover API if available
  const api = await discoverAPI(url);
  
  // 3. Extract sample data
  const samples = await extractSamples(url, analysis.strategy);
  
  // 4. Learn schema
  const schema = await learnSchema(samples);
  
  // 5. Create source automatically
  const source = {
    name: extractDomain(url),
    url: url,
    strategy: analysis.recommended,
    fieldSchema: schema,
    apiConfig: api || null
  };
  
  return source;
});
```

**Result:**
```
User: "https://permits.phoenix.gov"
System: "✅ Created Phoenix Permits source
         Strategy: API (fastest)
         Fields detected: permit_number, address, value, contractor
         Ready to scrape!"
```

---

## Timeline Summary

| Phase | Feature | Time | Status |
|-------|---------|------|--------|
| 1 | URL Analysis | 2-3 days | ❌ Not Started |
| 2 | API Discovery | 3-4 days | ❌ Not Started |
| 3 | Schema Learning | 4-5 days | ❌ Not Started |
| 4 | Smart Fallback | 2-3 days | ❌ Not Started |
| 5 | Auto-Config | 3-4 days | ❌ Not Started |

**Total: 14-19 days** (~3 weeks of focused development)

---

## Current Capability Score

```
User provides URL: ❌ (manual source config required)
    ↓
Strategy Selection: ⚠️ (manual, but all strategies available)
    ↓
├→ Static HTML: ✅ (axios + cheerio)
├→ Dynamic JS: ✅ (Puppeteer)
├→ API Detection: ❌ (not implemented)
├→ Vision AI: ✅ (Gemini)
└→ Hybrid: ⚠️ (manual fallback only)
    ↓
Data Extraction: ✅ (working)
    ↓
Schema Detection: ⚠️ (manual fieldSchema required)
    ↓
Structured Output: ✅ (universal deduplication)

Overall: 60% Complete
```

---

## Quick Wins (Can Implement Today)

### 1. Basic Strategy Auto-Selection (2 hours)
```javascript
function guessStrategy(url) {
  if (url.includes('/api/')) return 'api';
  if (url.includes('arcgis')) return 'puppeteer';
  if (url.includes('zillow')) return 'puppeteer';
  return 'static';
}
```

### 2. Simple Schema Detection (3 hours)
```javascript
function detectSchemaFromSample(sample) {
  const schema = {};
  for (const [key, value] of Object.entries(sample)) {
    schema[key] = { 
      type: typeof value,
      required: value !== null && value !== ''
    };
  }
  return schema;
}
```

Want me to implement these quick wins now? 🚀
