# 🎯 Scraping Reliability Checklist - 99%+ Success Rate

## ✅ ALREADY IMPLEMENTED (Current System)

### 1. **Anti-Bot Detection** ✅
- ✅ Webdriver property masking
- ✅ Chrome runtime spoofing
- ✅ Plugin/language spoofing
- ✅ User-agent rotation
- ✅ Automation flags disabled
- ✅ Viewport set to 2560x1440 (real desktop)

### 2. **Network Reliability** ✅
- ✅ Proxy rotation with fallback
- ✅ Direct connection fallback (when allowed)
- ✅ Proxy authentication
- ✅ 90-120 second timeouts
- ✅ Network idle detection
- ✅ ERR_TUNNEL_CONNECTION_FAILED handling

### 3. **Dynamic Content Loading** ✅
- ✅ Auto-scrolling (vertical + horizontal)
- ✅ Lazy loading triggers
- ✅ Network idle waiting
- ✅ JavaScript render delays (3-8 seconds)
- ✅ Load More button detection
- ✅ Pagination handling

### 4. **Data Extraction** ✅
- ✅ AI vision-based extraction (Gemini)
- ✅ Table extraction with auto-scroll
- ✅ Field schema mapping
- ✅ Screenshot capture (full page)
- ✅ CSV download handling
- ✅ Multiple extraction retries

### 5. **Quality Validation** ✅
- ✅ Content quality scoring
- ✅ Field validation (20% threshold)
- ✅ Permit count checking
- ✅ Phone/dollar amount detection
- ✅ Hash-based deduplication
- ✅ Retry on validation failure

### 6. **Error Handling** ✅
- ✅ Browser crash recovery
- ✅ Proxy failure handling
- ✅ Timeout recovery
- ✅ Block detection (Cloudflare, CAPTCHA)
- ✅ Empty page detection
- ✅ Navigation error retries

### 7. **Logging & Monitoring** ✅
- ✅ Detailed step-by-step logs
- ✅ Screenshot debugging
- ✅ Progress tracking
- ✅ Error stack traces
- ✅ Source status updates

---

## 🔴 MISSING (CRITICAL for 99%+ Reliability)

### 1. **AI Prompt Quality Verification** ⚠️
**Current Issue:** AI prompts might be incomplete or outdated
**Solution Needed:**
```javascript
- [ ] Validate AI prompts against current page structure
- [ ] Auto-detect when page layout changes
- [ ] Prompt effectiveness scoring (% success rate per source)
- [ ] Automated prompt refinement based on failures
```

**Implementation:**
```javascript
// Track AI extraction success rate per source
async function trackSourceReliability(sourceId, success, extractedCount) {
  const stats = await dbGet(`
    SELECT success_count, failure_count, last_success 
    FROM source_reliability WHERE source_id = ?`, [sourceId]);
  
  if (success && extractedCount > 0) {
    // Increment success
    await dbRun(`UPDATE source_reliability SET 
      success_count = success_count + 1,
      last_success = ?,
      confidence_score = (success_count * 100.0) / (success_count + failure_count)
      WHERE source_id = ?`, [new Date(), sourceId]);
  } else {
    // Increment failure - ALERT if confidence drops below 80%
    await dbRun(`UPDATE source_reliability SET failure_count = failure_count + 1 WHERE source_id = ?`, [sourceId]);
    if (confidence < 80) {
      await sendAlert(`⚠️ Source ${sourceName} reliability dropped to ${confidence}%`);
    }
  }
}
```

### 2. **Real-Time Page Structure Detection** ⚠️
**Current Issue:** If website changes layout, scraper continues blindly
**Solution Needed:**
```javascript
- [ ] Detect when expected selectors are missing
- [ ] Compare current page structure to known working structure
- [ ] Auto-alert when page structure changes significantly
- [ ] Fallback to visual AI extraction when selectors fail
```

### 3. **Data Completeness Verification** ⚠️
**Current Issue:** 20% field fill threshold is too low
**Solution Needed:**
```javascript
- [ ] Increase validation threshold to 60% for high-confidence sources
- [ ] Require CRITICAL fields (permit_number, address, link) to be present
- [ ] Flag leads with missing contractor info for manual review
- [ ] Auto-retry if critical fields are missing
```

**Implementation:**
```javascript
function validateExtractedFields(data, sourceName, fieldSchema = null) {
  // CRITICAL FIELDS - must be present
  const criticalFields = ['link', 'permit_number', 'address'];
  const missingCritical = criticalFields.filter(f => !data[f] || data[f] === '');
  
  if (missingCritical.length > 0) {
    return {
      isValid: false,
      confidence: 0,
      issues: [`Missing critical fields: ${missingCritical.join(', ')}`]
    };
  }
  
  // For known-good sources, require 60% field completion
  const fillPercentage = (nonNullFields.length / dataKeys.length) * 100;
  const requiredThreshold = sourceReliability[sourceName] > 90 ? 60 : 40;
  
  return {
    isValid: fillPercentage >= requiredThreshold,
    confidence: fillPercentage,
    issues: fillPercentage < requiredThreshold ? 
      [`Only ${fillPercentage}% fields filled, need ${requiredThreshold}%`] : []
  };
}
```

### 4. **Intelligent Retry Strategy** ⚠️
**Current Issue:** Only 1-2 retries, no smart backoff
**Solution Needed:**
```javascript
- [ ] Exponential backoff (1s → 5s → 15s → 60s)
- [ ] Different proxy on each retry
- [ ] Try different extraction methods (AI → Table → HTML)
- [ ] Max 5 retry attempts before giving up
```

### 5. **Pagination Confidence** ⚠️
**Current Issue:** May miss pages or loop infinitely
**Solution Needed:**
```javascript
- [ ] Track unique page hashes to detect loops
- [ ] Count visible records vs. total count indicator
- [ ] Stop if same data extracted 3 times in a row
- [ ] Verify "Next" button actually navigates to new page
```

**Implementation:**
```javascript
let paginationState = {
  visitedHashes: new Set(),
  duplicateCount: 0,
  expectedTotal: null,
  extractedTotal: 0
};

// After each extraction
const pageHash = crypto.createHash('md5').update(JSON.stringify(extracted)).digest('hex');
if (paginationState.visitedHashes.has(pageHash)) {
  paginationState.duplicateCount++;
  if (paginationState.duplicateCount >= 3) {
    logger.warn('⚠️ Detected pagination loop - same page 3 times');
    return 'done'; // Stop pagination
  }
} else {
  paginationState.visitedHashes.add(pageHash);
  paginationState.duplicateCount = 0;
}

// Check if we've reached expected total
if (paginationState.expectedTotal && 
    paginationState.extractedTotal >= paginationState.expectedTotal * 0.95) {
  logger.info('✅ Extracted 95%+ of expected total, stopping');
  return 'done';
}
```

### 6. **CAPTCHA Detection & Handling** ⚠️
**Current Issue:** Detects CAPTCHA but doesn't solve or retry
**Solution Needed:**
```javascript
- [ ] Auto-detect CAPTCHA (reCAPTCHA, hCAPTCHA)
- [ ] Try different proxy if CAPTCHA appears
- [ ] Wait and retry (sometimes CAPTCHA clears after delay)
- [ ] Alert admin if CAPTCHA persists (manual intervention)
```

### 7. **Rate Limiting Detection** ⚠️
**Current Issue:** Continues scraping even when rate-limited
**Solution Needed:**
```javascript
- [ ] Detect "429 Too Many Requests"
- [ ] Detect "slow down" messages in page content
- [ ] Auto-pause scraping for 5-60 minutes
- [ ] Spread requests over time (random delays between 10-30s)
```

**Implementation:**
```javascript
// Add random delay between sources
const delayBetweenSources = Math.random() * 20000 + 10000; // 10-30 seconds
logger.info(`⏳ Waiting ${Math.round(delayBetweenSources/1000)}s before next source (rate limiting)`);
await new Promise(resolve => setTimeout(resolve, delayBetweenSources));

// Detect rate limiting
if (blockSignals.rateLimit) {
  const backoffMinutes = 15;
  logger.warn(`⚠️ Rate limit detected, pausing for ${backoffMinutes} minutes`);
  await dbRun(`UPDATE sources SET next_scrape = datetime('now', '+${backoffMinutes} minutes') WHERE id = ?`, [sourceId]);
  return; // Skip this source for now
}
```

### 8. **Field Mapping Validation** ⚠️
**Current Issue:** AI might map wrong columns to wrong fields
**Solution Needed:**
```javascript
- [ ] Verify field patterns (e.g., permit_number should match /\d+/)
- [ ] Check address format (should contain street number + name)
- [ ] Validate phone format (should be 10 digits)
- [ ] Detect when AI maps same column to multiple fields
```

**Implementation:**
```javascript
function validateFieldPatterns(data) {
  const patterns = {
    permit_number: /^[A-Z0-9-]{3,}$/i,
    phone: /\d{10}|\(\d{3}\)\s*\d{3}-\d{4}/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    address: /\d+\s+[A-Za-z]/,
    value: /\$[\d,]+|\d+\.\d{2}/,
    date: /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|20\d{2}-\d{2}-\d{2}/
  };
  
  const issues = [];
  for (const [field, pattern] of Object.entries(patterns)) {
    if (data[field] && !pattern.test(data[field])) {
      issues.push(`${field} format invalid: "${data[field]}"`);
    }
  }
  
  return issues;
}
```

### 9. **Screenshot Quality Verification** ⚠️
**Current Issue:** Screenshot might be blank, loading state, or error page
**Solution Needed:**
```javascript
- [ ] Detect blank/white screenshots
- [ ] Detect loading spinners in screenshot
- [ ] Detect error messages in screenshot
- [ ] Retry screenshot if quality is poor
```

### 10. **Duplicate Detection Enhancement** ⚠️
**Current Issue:** Only hash-based, might miss similar records
**Solution Needed:**
```javascript
- [ ] Check permit_number + address combination
- [ ] Fuzzy matching for similar addresses
- [ ] Detect if same permit appears across multiple sources
```

---

## 📊 RECOMMENDED PRIORITY ORDER

### **Priority 1 (Implement THIS WEEK)** 🔥
1. ✅ Field mapping validation (critical fields required)
2. ✅ Source reliability tracking
3. ✅ Pagination loop detection
4. ✅ Rate limiting detection & backoff

### **Priority 2 (Next 2 Weeks)** ⚙️
5. ✅ Intelligent retry with exponential backoff
6. ✅ Real-time page structure validation
7. ✅ Screenshot quality verification
8. ✅ CAPTCHA detection & proxy switching

### **Priority 3 (Future Enhancement)** 💡
9. ✅ Auto-prompt refinement based on failures
10. ✅ Fuzzy duplicate detection
11. ✅ Field pattern validation (regex checks)
12. ✅ Admin alerts for failures

---

## 🎯 EXPECTED IMPACT ON RELIABILITY

| Feature | Current | With P1 | With P2 | With P3 |
|---------|---------|---------|---------|---------|
| **Success Rate** | 85-90% | 93-95% | 97-98% | 99%+ |
| **Data Quality** | 70-80% | 85-90% | 90-95% | 95%+ |
| **False Positives** | 5-10% | 2-3% | 1-2% | <1% |
| **Pagination Accuracy** | 80-85% | 95%+ | 98%+ | 99%+ |
| **Downtime Handling** | Manual | Auto-retry | Self-healing | Predictive |

---

## 🚀 QUICK WINS (Implement Today)

### 1. Add Critical Field Validation
```javascript
// In validateExtractedFields function
const criticalFields = ['link', 'permit_number', 'address'];
const missingCritical = criticalFields.filter(f => !data[f]);
if (missingCritical.length > 0) return { isValid: false };
```

### 2. Add Rate Limit Delays
```javascript
// Between source scrapes
await new Promise(r => setTimeout(r, 10000 + Math.random() * 10000));
```

### 3. Track Source Reliability
```javascript
// Create table
CREATE TABLE source_reliability (
  source_id INTEGER PRIMARY KEY,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  last_success DATETIME,
  confidence_score REAL DEFAULT 100.0
);
```

### 4. Detect Pagination Loops
```javascript
// Track visited page hashes
const visitedHashes = new Set();
const currentHash = hashPageData(extracted);
if (visitedHashes.has(currentHash)) {
  logger.warn('Pagination loop detected');
  break;
}
visitedHashes.add(currentHash);
```

---

## 📈 MONITORING DASHBOARD (Add These Metrics)

```javascript
// Track per source:
- Success rate (last 30 days)
- Average extraction time
- Average leads per run
- Last successful scrape
- Failure reasons (blocked, timeout, empty, validation)
- Data quality score (% complete fields)

// Global metrics:
- Overall system reliability
- Most reliable sources
- Problematic sources needing attention
- Total leads scraped today/week/month
```
