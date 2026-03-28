const rows = document.getElementById('entryRows');
const suggestionsContainer = document.getElementById('suggestions');
const sortBy = document.getElementById('sortBy');
const refreshBtn = document.getElementById('refreshBtn');
const suggestBtn = document.getElementById('suggestBtn');
const applyBtn = document.getElementById('applyBtn');

let currentEntries = [];
let currentSuggestions = [];

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderEntries(entries) {
  rows.innerHTML = '';
  entries.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${esc(entry.id)}" /></td>
      <td>${esc(entry.title)}</td>
      <td>${esc(entry.tags.join(', '))}</td>
      <td>${esc(entry.quality)}</td>
    `;
    rows.appendChild(tr);
  });
}

function renderSuggestions(items) {
  suggestionsContainer.innerHTML = '';
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <label><input type="checkbox" data-approve="${esc(item.id)}" checked /> Approve</label>
      <p><strong>Entry ID:</strong> ${esc(item.id)}</p>
      <label>Title <input data-title="${esc(item.id)}" value="${esc(item.suggested_title)}" /></label>
      <label>Tags (comma separated)
        <input data-tags="${esc(item.id)}" value="${esc(item.suggested_tags.join(', '))}" />
      </label>
      <p><em>${esc(item.reason)}</em></p>
    `;
    suggestionsContainer.appendChild(card);
  });
}

async function loadEntries() {
  const response = await fetch(`/api/entries?sort_by=${sortBy.value}`);
  if (!response.ok) {
    rows.innerHTML = `<tr><td colspan="4">Failed to load entries: ${esc(await response.text())}</td></tr>`;
    return;
  }
  currentEntries = await response.json();
  renderEntries(currentEntries);
}

async function generateSuggestions() {
  const selected = [...document.querySelectorAll('input[data-id]:checked')].map((box) => Number(box.dataset.id));
  if (!selected.length) {
    alert('Select at least one entry first.');
    return;
  }
  const response = await fetch('/api/suggestions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: selected }),
  });
  if (!response.ok) {
    alert(`Failed to generate suggestions: ${await response.text()}`);
    return;
  }
  currentSuggestions = await response.json();
  renderSuggestions(currentSuggestions);
}

async function applySuggestions() {
  const approved = currentSuggestions
    .filter((item) => document.querySelector(`input[data-approve="${item.id}"]`)?.checked)
    .map((item) => {
      const title = document.querySelector(`input[data-title="${item.id}"]`).value;
      const tags = document.querySelector(`input[data-tags="${item.id}"]`).value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      return { id: item.id, title, tags };
    });

  if (!approved.length) {
    alert('Nothing approved.');
    return;
  }

  const response = await fetch('/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries: approved }),
  });

  if (!response.ok) {
    const problem = await response.text();
    alert(`Apply failed: ${problem}`);
    return;
  }

  alert('Changes applied to Paperless.');
  await loadEntries();
}

refreshBtn.addEventListener('click', loadEntries);
sortBy.addEventListener('change', loadEntries);
suggestBtn.addEventListener('click', generateSuggestions);
applyBtn.addEventListener('click', applySuggestions);

loadEntries();
