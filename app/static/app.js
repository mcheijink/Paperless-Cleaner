const rows = document.getElementById('entryRows');
const suggestionsContainer = document.getElementById('suggestions');
const sortBy = document.getElementById('sortBy');
const refreshBtn = document.getElementById('refreshBtn');
const suggestBtn = document.getElementById('suggestBtn');
const applyBtn = document.getElementById('applyBtn');

let currentEntries = [];
let currentSuggestions = [];

function renderEntries(entries) {
  rows.innerHTML = '';
  entries.forEach((entry) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${entry.id}" /></td>
      <td>${entry.title}</td>
      <td>${entry.tags.join(', ')}</td>
      <td>${entry.quality}</td>
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
      <label><input type="checkbox" data-approve="${item.id}" checked /> Approve</label>
      <p><strong>Entry ID:</strong> ${item.id}</p>
      <label>Title <input data-title="${item.id}" value="${item.suggested_title}" /></label>
      <label>Tags (comma separated)
        <input data-tags="${item.id}" value="${item.suggested_tags.join(', ')}" />
      </label>
      <p><em>${item.reason}</em></p>
    `;
    suggestionsContainer.appendChild(card);
  });
}

async function loadEntries() {
  const response = await fetch(`/api/entries?sort_by=${sortBy.value}`);
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
