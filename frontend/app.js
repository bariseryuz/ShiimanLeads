async function fetchSources() {
  const res = await fetch('/api/sources');
  const json = await res.json();
  const select = document.getElementById('sourceFilter');
  (json.data || []).forEach(src => {
    const opt = document.createElement('option');
    opt.value = src.name;
    opt.textContent = src.name;
    select.appendChild(opt);
  });
}

function formatDate(iso){
  if(!iso) return '';
  const d = new Date(iso); return d.toLocaleString();
}

async function fetchLeads() {
  const source = document.getElementById('sourceFilter').value;
  const search = document.getElementById('search').value.trim();
  const days = document.getElementById('daysFilter').value;
  const params = new URLSearchParams();
  params.set('limit','500');
  if (source) params.set('source', source);
  if (search) params.set('q', search);
  if (days) params.set('days', days);
  const url = '/api/leads?' + params.toString();
  const tBody = document.querySelector('#leadsTable tbody');
  tBody.innerHTML = '<tr><td colspan="8">Loading...</td></tr>';
  try {
    const res = await fetch(url);
    const json = await res.json();
    const rows = Array.isArray(json) ? json : (json.data || []);
    tBody.innerHTML = '';
    rows.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.permit_number || ''}</td>
        <td>${r.address || ''}</td>
        <td>${r.value || ''}</td>
        <td>${r.phone || 'N/A'}</td>
        <td>${(r.description || '').substring(0,160)}</td>
        <td>${r.source || ''}</td>
        <td>${r.page_url ? `<a href="${r.page_url}" target="_blank" style="color: #6366f1; text-decoration: underline;">View</a>` : 'N/A'}</td>
        <td>${formatDate(r.date_added)}</td>
      `;
      tBody.appendChild(tr);
    });
    document.getElementById('status').textContent = `Showing ${rows.length} lead(s).`;
  } catch (e) {
    tBody.innerHTML = '<tr><td colspan="8">Error loading data</td></tr>';
    document.getElementById('status').textContent = e.message;
  }
}

// Events
['search','sourceFilter','daysFilter'].forEach(id => {
  document.getElementById(id).addEventListener('change', fetchLeads);
});

document.getElementById('refreshBtn').addEventListener('click', fetchLeads);

// Init
fetchSources().then(fetchLeads);
