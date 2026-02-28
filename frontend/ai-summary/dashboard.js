// Global state
let allLeads = [];
let filteredLeads = [];
let selectedLeadIds = new Set();
let currentPage = 1;
const itemsPerPage = 20;

// maps for quick access
const leadsById = {};
const originalRowHtml = {};
const leadSummaries = {};  // store fetched summaries


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
 * Render leads table with checkboxes and inline Apply AI buttons
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
    <div class="table-container" style="overflow-x: auto; max-width: 100%; background: white; border: 1px solid var(--gray-200); border-top: none; border-radius: 0 0 12px 12px;">
      <table class="leads-table" style="margin: 0; border-radius: 0;">
        <thead>
          <tr>
            <th class="checkbox-col"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll()" /></th>
            <th>Name/Company</th>
            <th>Email</th>
            <th>Phone</th>
            <th>GIS</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
  `;

  pageLeads.forEach((lead, idx) => {
    const leadId = lead.id || `lead_${start + idx}`;
    leadsById[leadId] = lead;
    const isSelected = selectedLeadIds.has(leadId);
    const checked = isSelected ? 'checked' : '';
    const name = lead.name || lead.company || 'N/A';
    const email = lead.email || '—';
    const phone = lead.phone || '—';
    const source = lead.source || lead.source_name || 'Unknown';
    const date = extractLeadDate(lead)?.toLocaleDateString() || '—';

    html += `
      <tr id="lead-row-${leadId}">
        <td class="checkbox-col">
          <input type="checkbox" ${checked} onchange="toggleLeadSelection('${leadId}')" />
        </td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(email)}</td>
        <td>${escapeHtml(phone)}</td>
        <td class="source-col" id="source-cell-${leadId}">
          <div class="source-with-action">
            <span class="source-badge">${escapeHtml(source)}</span>
            <button class="btn-apply-ai" onclick="toggleRowSummary('${leadId}')">⚡ Apply AI</button>
          </div>
        </td>
        <td>${date}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
  renderPagination();
  updateBulkActionsBar();
}

/**
 * Analyze a single lead (inline button click)
 */
async function analyzeSingleLead(leadId) {
  console.log('analyzeSingleLead clicked', leadId);
  // Find the lead
  const lead = allLeads.find(l => (l.id || `lead_${allLeads.indexOf(l)}`).toString() === leadId);
  
  if (!lead) {
    alert('Lead not found');
    return;
  }

  const template = 'default';
  const maxTokens = 1024;

  try {
    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leads: [lead],
        template,
        maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start analysis');
    }

    const data = await response.json();
    window.location.href = `/ai-summary/summaries.html?jobId=${data.jobId}`;
  } catch (error) {
    console.error('Error:', error);
    alert(`❌ ${error.message}`);
  }
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
 * Proceed to analyze selected leads
 */
function proceedToAnalyze() {
  console.log('proceedToAnalyze invoked, selected', selectedLeadIds.size);
  if (selectedLeadIds.size === 0) {
    alert('⚠️ Please select at least one lead.');
    return;
  }
  document.getElementById('leadsCountInModal').textContent = selectedLeadIds.size;
  document.getElementById('analyzeModal').classList.add('active');
}

/**
 * Close the analyze modal
 */
function closeAnalyzeModal() {
  document.getElementById('analyzeModal').classList.remove('active');
}

/**
 * Submit analysis for all selected leads
 */
async function submitAnalysis(event) {
  if (selectedLeadIds.size === 0) {
    alert('⚠️ Please select at least one lead.');
    return;
  }

  const template = document.getElementById('templateSelect').value;
  const maxTokens = parseInt(document.getElementById('maxTokens').value);

  // Get selected lead objects
  const selectedLeads = filteredLeads.filter(lead => 
    selectedLeadIds.has(lead.id || `lead_${filteredLeads.indexOf(lead)}`)
  );

  try {
    const submitButton = event.target;
    submitButton.disabled = true;
    submitButton.textContent = '⏳ Analyzing...';

    const response = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leads: selectedLeads,
        template,
        maxTokens
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start analysis');
    }

    const data = await response.json();
    closeAnalyzeModal();
    window.location.href = `/ai-summary/summaries.html?jobId=${data.jobId}`;
  } catch (error) {
    console.error('Error starting analysis:', error);
    alert(`❌ ${error.message}`);
    
    const submitButton = event.target;
    submitButton.disabled = false;
    submitButton.textContent = '📊 Start Analysis';
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
  
  if (currentPage > 1) {
    html += `<button onclick="goToPage(${currentPage - 1})">← Previous</button>`;
  }

  for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
    if (i === currentPage) {
      html += `<button class="active">${i}</button>`;
    } else {
      html += `<button onclick="goToPage(${i})">${i}</button>`;
    }
  }

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
  document.getElementById('selectedLeads').textContent = selectedLeadIds.size;
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

/**
 * Format a structured summary object or plain string into a compact sentence.
 */
function formatLeadSummary(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;

  const s = data.summary || '';
  const businessType = data.business_type || data.type || '';
  const addr = data.address || data.location || data.address_text || '';
  const date = data.date || data.permit_date || data.issued || '';
  const contact = data.contact_info || {};
  const contractor = contact.contractor_name || contact.name || '';
  const phone = contact.phone || contact.phone_number || '';
  const email = contact.email || contact.email_address || '';
  const fee = data.fee || data.permit_fee || data.estimated_cost || '';
  const potential = data.potential || '';

  const parts = [];
  if (businessType) parts.push(`${businessType} project`);
  if (addr) parts.push(`at ${addr}`);
  if (date) parts.push(`permit issued ${date}`);
  if (contractor) parts.push(`contractor ${contractor}`);
  const contactParts = [];
  if (phone) contactParts.push(`phone ${phone}`);
  if (email) contactParts.push(`email ${email}`);
  if (contactParts.length) parts.push(`contact: ${contactParts.join(' / ')}`);
  if (fee) parts.push(`permit fee ${fee}`);
  if (potential) parts.push(potential);

  const human = parts.length ? parts.join('. ') + '.' : (s || JSON.stringify(data));
  return human;
}

/**
 * Toggle between original lead data and AI summary within the source column.
 * If a summary hasn't been fetched yet it will request it via the instant API.
 */
async function toggleRowSummary(leadId) {
  const row = document.getElementById(`lead-row-${leadId}`);
  if (!row) return;
  const cell = document.getElementById(`source-cell-${leadId}`);
  if (!cell) return;

  // If currently showing a summary, restore the original html and exit.
  if (cell.dataset.showingSummary === 'true') {
    cell.innerHTML = cell.dataset.originalHtml || cell.innerHTML;
    cell.dataset.showingSummary = 'false';
    return;
  }

  // store original html the first time we toggle for this row
  if (!cell.dataset.originalHtml) {
    cell.dataset.originalHtml = cell.innerHTML;
  }

  // If we already fetched a summary, just display it
  if (leadSummaries[leadId]) {
    cell.innerHTML = `<div class="summary-cell">
        ${escapeHtml(leadSummaries[leadId])}
        <button onclick="toggleRowSummary('${leadId}')">↩️ Details</button>
      </div>`;
    cell.dataset.showingSummary = 'true';
    return;
  }

  // otherwise request the summary from the server
  cell.innerHTML = '⚡ Generating summary...';
  try {
    const lead = leadsById[leadId];
    const response = await fetch('/api/summarize/instant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lead,
        template: 'default',
        maxTokens: 512
      })
    });
    if (!response.ok) {
      throw new Error('Failed to fetch summary');
    }
    const data = await response.json();
    const formatted = formatLeadSummary(data);
    leadSummaries[leadId] = formatted;

    cell.innerHTML = `<div class="summary-cell">
        ${escapeHtml(formatted)}
        <button onclick="toggleRowSummary('${leadId}')">↩️ Details</button>
      </div>`;
    cell.dataset.showingSummary = 'true';
  } catch (err) {
    console.error(err);
    alert('❌ Error fetching summary');
    // put back original content if something went wrong
    cell.innerHTML = cell.dataset.originalHtml || cell.innerHTML;
    cell.dataset.showingSummary = 'false';
  }
}
