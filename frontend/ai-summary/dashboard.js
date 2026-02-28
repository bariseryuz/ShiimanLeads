// Global state
let allLeads = [];
let filteredLeads = [];
let currentPage = 1;
let currentAnalyzingLead = null; // Track which lead is being analyzed
const itemsPerPage = 20;

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  await loadLeads();
  renderTable();
  updateStats();
});

/**
 * Load leads from the server
 */
async function loadLeads() {
  try {
    const response = await fetch('/api/leads');
    if (!response.ok) throw new Error('Failed to load leads');
    
    const data = await response.json();
    
    // Handle both array and wrapped object responses
    allLeads = Array.isArray(data) ? data : (data.leads || data.data || []);
    
    if (!Array.isArray(allLeads)) {
      throw new Error('API returned invalid leads format');
    }
    
    filteredLeads = [...allLeads];
    updateStats();
  } catch (error) {
    console.error('Error loading leads:', error);
    document.getElementById('leadsContainer').innerHTML = 
      '<div class="no-data">❌ Error loading leads. Please refresh.</div>';
  }
}

/**
 * Apply date range and search filters
 */
function applyFilters() {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  const search = document.getElementById('searchBox').value.toLowerCase();

  filteredLeads = allLeads.filter(lead => {
    // Date range filter
    if (dateFrom || dateTo) {
      const leadDate = extractLeadDate(lead);
      if (leadDate) {
        if (dateFrom && new Date(leadDate) < new Date(dateFrom)) return false;
        if (dateTo && new Date(leadDate) > new Date(dateTo)) return false;
      }
    }

    // Search filter
    if (search) {
      const searchableFields = ['name', 'company', 'email', 'phone', 'source', 'source_name'];
      const matches = searchableFields.some(field => 
        String(lead[field] || '').toLowerCase().includes(search)
      );
      if (!matches) return false;
    }

    return true;
  });

  currentPage = 1;
  renderTable();
  updateStats();
}

/**
 * Reset all filters
 */
function resetFilters() {
  document.getElementById('dateFrom').value = '';
  document.getElementById('dateTo').value = '';
  document.getElementById('quickDateRange').value = '';
  document.getElementById('searchBox').value = '';
  
  filteredLeads = [...allLeads];
  currentPage = 1;
  renderTable();
  updateStats();
}

/**
 * Apply quick date range presets
 */
function applyQuickDateRange() {
  const preset = document.getElementById('quickDateRange').value;
  const today = new Date();
  let startDate = new Date();

  switch (preset) {
    case 'last7':
      startDate.setDate(today.getDate() - 7);
      break;
    case 'last30':
      startDate.setDate(today.getDate() - 30);
      break;
    case 'last90':
      startDate.setDate(today.getDate() - 90);
      break;
    case 'ytd':
      startDate = new Date(today.getFullYear(), 0, 1);
      break;
    default:
      return;
  }

  document.getElementById('dateFrom').value = startDate.toISOString().split('T')[0];
  document.getElementById('dateTo').value = today.toISOString().split('T')[0];
  applyFilters();
}

/**
 * Extract date from lead object
 */
function extractLeadDate(lead) {
  const dateFields = ['date', 'created_at', 'createdAt', 'date_issued', 'capturedAt', 'timestamp'];
  for (const field of dateFields) {
    if (lead[field]) {
      const date = new Date(lead[field]);
      if (!isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/**
 * Render leads table with per-lead action buttons
 */
function renderTable() {
  const container = document.getElementById('leadsContainer');
  
  if (filteredLeads.length === 0) {
    container.innerHTML = '<div class="no-data">📭 No leads match your filters.</div>';
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageLeads = filteredLeads.slice(start, end);

  let html = `
    <table class="leads-table">
      <thead>
        <tr>
          <th>Name/Company</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Source</th>
          <th>Date</th>
          <th class="action-col">Action</th>
        </tr>
      </thead>
      <tbody>
  `;

  pageLeads.forEach((lead, idx) => {
    const leadId = lead.id || `lead_${start + idx}`;
    const name = lead.name || lead.company || 'N/A';
    const email = lead.email || '—';
    const phone = lead.phone || '—';
    const source = lead.source || lead.source_name || 'Unknown';
    const date = extractLeadDate(lead)?.toLocaleDateString() || '—';

    html += `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(email)}</td>
        <td>${escapeHtml(phone)}</td>
        <td><span class="source-badge">${escapeHtml(source)}</span></td>
        <td>${date}</td>
        <td class="action-col">
          <button class="btn-apply-ai" onclick="analyzeLead('${escapeHtml(leadId)}')">⚡ Apply AI</button>
        </td>
      </tr>
    `;
  });

  html += `
    </tbody>
    </table>
  `;

  container.innerHTML = html;
  renderPagination();
}

/**
 * Open the analyze modal for a specific lead
 */
function analyzeLead(leadId) {
  // Find the lead in filteredLeads first, then in allLeads
  let lead = filteredLeads.find(l => (l.id || `lead_${filteredLeads.indexOf(l)}`).toString() === leadId);
  if (!lead) {
    lead = allLeads.find(l => (l.id || `lead_${allLeads.indexOf(l)}`).toString() === leadId);
  }
  
  if (!lead) {
    alert('Lead not found');
    return;
  }

  // Store the current lead
  currentAnalyzingLead = lead;

  // Populate the modal with lead info
  document.getElementById('leadNameInModal').textContent = lead.name || lead.company || 'N/A';
  document.getElementById('leadCompanyInModal').textContent = lead.company || '—';
  document.getElementById('leadEmailInModal').textContent = lead.email || '—';

  // Reset form fields
  document.getElementById('templateSelect').value = 'default';
  document.getElementById('maxTokens').value = '1024';

  // Open modal
  document.getElementById('analyzeModal').classList.add('active');
}

/**
 * Close the analyze modal
 */
function closeAnalyzeModal() {
  document.getElementById('analyzeModal').classList.remove('active');
  currentAnalyzingLead = null;
}

/**
 * Submit the single lead for analysis
 */
async function submitAnalyze() {
  if (!currentAnalyzingLead) {
    alert('No lead selected');
    return;
  }

  const template = document.getElementById('templateSelect').value;
  const maxTokens = parseInt(document.getElementById('maxTokens').value);

  try {
    // Show loading state
    const submitButton = event.target;
    submitButton.disabled = true;
    const originalText = submitButton.textContent;
    submitButton.textContent = '⏳ Analyzing...';

    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        leads: [currentAnalyzingLead],
        template,
        maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start analysis');
    }

    const data = await response.json();
    const jobId = data.jobId;

    // Close modal
    closeAnalyzeModal();

    // Redirect to results page
    window.location.href = `/ai-summary/summaries.html?jobId=${jobId}`;

  } catch (error) {
    console.error('Error starting analysis:', error);
    alert(`❌ ${error.message}`);
    
    // Re-enable button
    const submitButton = event.target;
    submitButton.disabled = false;
    submitButton.textContent = originalText;
  }
}

/**
 * Render pagination
 */
function renderPagination() {
  const totalPages = Math.ceil(filteredLeads.length / itemsPerPage);
  const paginationDiv = document.getElementById('pagination');

  if (totalPages <= 1) {
    paginationDiv.innerHTML = '';
    return;
  }

  let html = '';
  
  // Previous button
  if (currentPage > 1) {
    html += `<button onclick="goToPage(${currentPage - 1})">← Previous</button>`;
  }

  // Page numbers
  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    if (i === currentPage) {
      html += `<button class="active">${i}</button>`;
    } else {
      html += `<button onclick="goToPage(${i})">${i}</button>`;
    }
  }

  // Next button
  if (currentPage < totalPages) {
    html += `<button onclick="goToPage(${currentPage + 1})">Next →</button>`;
  }

  paginationDiv.innerHTML = html;
}

/**
 * Go to page
 */
function goToPage(page) {
  currentPage = page;
  renderTable();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Update stats
 */
function updateStats() {
  document.getElementById('totalLeads').textContent = allLeads.length;
  document.getElementById('filteredLeads').textContent = filteredLeads.length;
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  if (!text) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}
