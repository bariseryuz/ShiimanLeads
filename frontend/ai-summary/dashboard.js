// Global state
let allLeads = [];
let filteredLeads = [];
let selectedLeadIds = new Set();
let currentPage = 1;
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
    allLeads = await response.json();
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
  selectedLeadIds.clear();
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
  selectedLeadIds.clear();
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
      startDate.setMonth(0);
      startDate.setDate(1);
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
 * Render leads table
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
          <th class="checkbox-col"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll()" /></th>
          <th>Name/Company</th>
          <th>Email</th>
          <th>Phone</th>
          <th>Source</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
  `;

  pageLeads.forEach((lead, idx) => {
    const leadId = lead.id || `lead_${start + idx}`;
    const isSelected = selectedLeadIds.has(leadId);
    const checked = isSelected ? 'checked' : '';
    const name = lead.name || lead.company || 'N/A';
    const email = lead.email || '—';
    const phone = lead.phone || '—';
    const source = lead.source || lead.source_name || 'Unknown';
    const date = extractLeadDate(lead)?.toLocaleDateString() || '—';

    html += `
      <tr>
        <td class="checkbox-col">
          <input type="checkbox" ${checked} onchange="toggleLeadSelection('${leadId}')" />
        </td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(email)}</td>
        <td>${escapeHtml(phone)}</td>
        <td><span class="source-badge">${escapeHtml(source)}</span></td>
        <td>${date}</td>
      </tr>
    `;
  });

  html += `
    </tbody>
    </table>
  `;

  container.innerHTML = html;
  renderPagination();
  updateBulkActionsBar();
}

/**
 * Toggle individual lead selection
 */
function toggleLeadSelection(leadId) {
  if (selectedLeadIds.has(leadId)) {
    selectedLeadIds.delete(leadId);
  } else {
    selectedLeadIds.add(leadId);
  }
  updateBulkActionsBar();
  updateStats();
  document.getElementById('selectAllCheckbox').checked = false;
}

/**
 * Toggle select all on page
 */
function toggleSelectAll() {
  const isChecked = document.getElementById('selectAllCheckbox').checked;
  const start = (currentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageLeads = filteredLeads.slice(start, end);

  pageLeads.forEach((lead, idx) => {
    const leadId = lead.id || `lead_${start + idx}`;
    if (isChecked) {
      selectedLeadIds.add(leadId);
    } else {
      selectedLeadIds.delete(leadId);
    }
  });

  renderTable();
  updateStats();
}

/**
 * Select all filtered leads
 */
function selectAllFiltered() {
  filteredLeads.forEach((lead, idx) => {
    selectedLeadIds.add(lead.id || `lead_${idx}`);
  });
  renderTable();
  updateStats();
}

/**
 * Clear selection
 */
function clearSelection() {
  selectedLeadIds.clear();
  renderTable();
  updateStats();
}

/**
 * Update bulk actions bar visibility
 */
function updateBulkActionsBar() {
  const bar = document.getElementById('bulkActionsBar');
  const text = document.getElementById('bulkActionText');
  
  if (selectedLeadIds.size > 0) {
    bar.classList.remove('hidden');
    text.textContent = `${selectedLeadIds.size} lead${selectedLeadIds.size !== 1 ? 's' : ''} selected`;
  } else {
    bar.classList.add('hidden');
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
  for (let i = 1; i <= totalPages; i++) {
    const activeClass = i === currentPage ? 'active' : '';
    html += `<button class="${activeClass}" onclick="goToPage(${i})">${i}</button>`;
  }

  paginationDiv.innerHTML = html;
}

/**
 * Go to page
 */
function goToPage(page) {
  currentPage = page;
  renderTable();
  window.scrollTo(0, 0);
}

/**
 * Update stats
 */
function updateStats() {
  document.getElementById('totalLeads').textContent = allLeads.length;
  document.getElementById('selectedLeads').textContent = selectedLeadIds.size;
  document.getElementById('filteredLeads').textContent = filteredLeads.length;
  
  const cost = estimateCost(selectedLeadIds.size);
  document.getElementById('estimatedCost').textContent = `$${cost.toFixed(2)}`;
  document.getElementById('costEstimate').textContent = `$${cost.toFixed(2)}`;
}

/**
 * Estimate cost
 */
function estimateCost(leadCount) {
  // Simple estimation: $0.12 per lead average
  return leadCount * 0.12;
}

/**
 * Open analyze modal
 */
function openAnalyzeModal() {
  document.getElementById('analyzeModal').classList.add('active');
}

/**
 * Close analyze modal
 */
function closeAnalyzeModal() {
  document.getElementById('analyzeModal').classList.remove('active');
}

/**
 * Proceed to summarize (requires selection)
 */
function proceedToSummarize() {
  if (selectedLeadIds.size === 0) {
    alert('⚠️ Please select at least one lead to summarize.');
    return;
  }
  openAnalyzeModal();
}

/**
 * Start summarization
 */
async function startSummarization() {
  if (selectedLeadIds.size === 0) {
    alert('⚠️ Please select at least one lead to summarize.');
    return;
  }

  const template = document.getElementById('templateSelect').value;
  const maxTokens = parseInt(document.getElementById('maxTokens').value);

  // Get selected lead objects
  const selectedLeads = filteredLeads.filter(lead => 
    selectedLeadIds.has(lead.id || `lead_${filteredLeads.indexOf(lead)}`)
  );

  try {
    closeAnalyzeModal();
    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leads: selectedLeads,
        template,
        maxTokens,
        dateRange: {
          startDate: document.getElementById('dateFrom').value,
          endDate: document.getElementById('dateTo').value
        }
      })
    });

    if (!response.ok) throw new Error('Summarization failed');
    const result = await response.json();

    // Redirect to summaries page
    window.location.href = `/ai-summary/summaries.html?jobId=${result.jobId}`;
  } catch (error) {
    console.error('Error starting summarization:', error);
    alert('❌ Failed to start summarization. Please try again.');
  }
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
