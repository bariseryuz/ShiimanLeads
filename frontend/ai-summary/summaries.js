// Global state
let jobData = null;
let allSummaries = [];

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get('jobId');

  if (!jobId) {
    document.getElementById('summariesGrid').innerHTML = 
      '<div class="no-summaries">❌ No job ID provided. <a href="dashboard.html">Return to Dashboard</a></div>';
    return;
  }

  loadJobData(jobId);
  // Poll for updates every 2 seconds
  setInterval(() => loadJobData(jobId), 2000);
});

/**
 * Load job data from server
 */
async function loadJobData(jobId) {
  try {
    const response = await fetch(`/api/summarize/${jobId}`);
    if (!response.ok) throw new Error('Failed to load job');
    
    jobData = await response.json();
    allSummaries = jobData.result?.summaries || [];
    
    renderJobInfo();
    renderSummaries();
  } catch (error) {
    console.error('Error loading job data:', error);
    if (!jobData) {
      document.getElementById('summariesGrid').innerHTML = 
        '<div class="no-summaries">❌ Failed to load summaries. Please try again.</div>';
    }
  }
}

/**
 * Render job information
 */
function renderJobInfo() {
  if (!jobData) return;

  document.getElementById('jobId').textContent = jobData.id;
  
  const statusEl = document.getElementById('jobStatus');
  statusEl.textContent = jobData.status.toUpperCase();
  statusEl.className = `status-badge status-${jobData.status}`;
  
  document.getElementById('subtitle').textContent = 
    `${jobData.status === 'completed' ? '✅ Completed' : '⏳ Processing'} - ${allSummaries.length} summaries`;
  
  document.getElementById('jobProgress').textContent = 
    `${jobData.result?.successCount || 0}/${jobData.result?.totalLeads || 0}`;
  
  document.getElementById('jobCost').textContent = 
    jobData.estimatedCost ? `$${parseFloat(jobData.estimatedCost.totalCost).toFixed(2)}` : '$0.00';

  // Show export section when completed
  if (jobData.status === 'completed') {
    document.getElementById('exportSection').style.display = 'block';
    document.getElementById('totalSummaries').textContent = jobData.result?.totalLeads || 0;
    document.getElementById('successCount').textContent = jobData.result?.successCount || 0;
    document.getElementById('failureCount').textContent = jobData.result?.failureCount || 0;
  }
}

/**
 * Render summaries grid
 */
function renderSummaries() {
  const container = document.getElementById('summariesGrid');

  if (allSummaries.length === 0) {
    if (jobData?.status === 'processing') {
      container.innerHTML = '<div class="loading">Processing your leads</div>';
    } else {
      container.innerHTML = '<div class="no-summaries">📭 No summaries to display.</div>';
    }
    return;
  }

  let html = '';
  allSummaries.forEach((item, idx) => {
    const lead = item.lead;
    const summary = item.summary;
    const error = item.error;
    const leadName = lead.name || lead.company || `Lead #${idx + 1}`;
    const leadEmail = lead.email || '—';
    const leadPhone = lead.phone || '—';

    html += `
      <div class="summary-card">
        <div class="card-header">
          <h3>${escapeHtml(leadName)}</h3>
          <p>${escapeHtml(leadEmail)}</p>
        </div>
        <div class="card-body">
          <div class="lead-details">
            <p><strong>Email:</strong> ${escapeHtml(leadEmail)}</p>
            <p><strong>Phone:</strong> ${escapeHtml(leadPhone)}</p>
            <p><strong>Source:</strong> ${escapeHtml(lead.source || lead.source_name || '—')}</p>
          </div>
    `;

    if (summary) {
      html += `<div class="summary-text">${escapeHtml(summary)}</div>`;
    } else if (error) {
      html += `<div class="error-text">❌ ${escapeHtml(error)}</div>`;
    }

    html += `
          <div class="card-actions">
            <button class="btn btn-copy" onclick="copySummary(${idx})">📋 Copy</button>
            <button class="btn btn-download" onclick="downloadSummary(${idx})">📥 Save</button>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * Copy summary to clipboard
 */
function copySummary(idx) {
  const item = allSummaries[idx];
  if (!item.summary) {
    alert('❌ No summary to copy.');
    return;
  }

  const text = `
Lead: ${item.lead.name || item.lead.company}
Email: ${item.lead.email}
Summary: ${item.summary}
  `.trim();

  navigator.clipboard.writeText(text).then(() => {
    alert('✅ Summary copied to clipboard!');
  }).catch(() => {
    alert('❌ Failed to copy.');
  });
}

/**
 * Download summary as text file
 */
function downloadSummary(idx) {
  const item = allSummaries[idx];
  if (!item.summary) {
    alert('❌ No summary to download.');
    return;
  }

  const filename = `summary_${Date.now()}.txt`;
  const text = `
Lead: ${item.lead.name || item.lead.company}
Email: ${item.lead.email}
Phone: ${item.lead.phone}
Source: ${item.lead.source || item.lead.source_name}
Date: ${new Date().toISOString()}

Summary:
${item.summary}
  `.trim();

  downloadFile(text, filename, 'text/plain');
}

/**
 * Export all summaries to CSV
 */
function exportToCSV() {
  if (allSummaries.length === 0) {
    alert('❌ No summaries to export.');
    return;
  }

  let csv = 'Name,Email,Phone,Source,Summary\n';
  allSummaries.forEach(item => {
    const name = escape(item.lead.name || item.lead.company || '');
    const email = escape(item.lead.email || '');
    const phone = escape(item.lead.phone || '');
    const source = escape(item.lead.source || item.lead.source_name || '');
    const summary = escape(item.summary || item.error || '');

    csv += `"${name}","${email}","${phone}","${source}","${summary}"\n`;
  });

  downloadFile(csv, `summaries_${Date.now()}.csv`, 'text/csv');
}

/**
 * Export all summaries to JSON
 */
function exportToJSON() {
  if (allSummaries.length === 0) {
    alert('❌ No summaries to export.');
    return;
  }

  const json = JSON.stringify({
    jobId: jobData.id,
    status: jobData.status,
    createdAt: jobData.createdAt,
    completedAt: jobData.completedAt,
    summaries: allSummaries
  }, null, 2);

  downloadFile(json, `summaries_${Date.now()}.json`, 'application/json');
}

/**
 * Copy all summaries to clipboard
 */
function copyAllSummaries() {
  const text = allSummaries
    .map((item, idx) => `
Summarized Lead #${idx + 1}
Name: ${item.lead.name || item.lead.company}
Email: ${item.lead.email}
Phone: ${item.lead.phone}

Summary:
${item.summary || `Error: ${item.error}`}
---
    `.trim())
    .join('\n\n');

  navigator.clipboard.writeText(text).then(() => {
    alert('✅ All summaries copied to clipboard!');
  }).catch(() => {
    alert('❌ Failed to copy.');
  });
}

/**
 * Refresh job data
 */
function refreshJob() {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get('jobId');
  loadJobData(jobId);
}

/**
 * Download file helper
 */
function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Escape HTML
 */
function escapeHtml(text) {
  if (!text) return '—';
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
 * Escape CSV
 */
function escape(text) {
  if (!text) return '';
  return String(text).replace(/"/g, '""');
}
