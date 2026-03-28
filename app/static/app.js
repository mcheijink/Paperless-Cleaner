'use strict';

// ── XSS helper ───────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentEntries = [];       // all entries from last /api/entries fetch
let filteredEntries = [];      // after client-side filter+sort
let suggestions = new Map();   // docId → Suggestion object
let fieldStates = new Map();   // docId → {title,correspondent,document_type,tags} → "undecided"|"applied"|"rejected"
let approvedDocs = new Set();  // docIds with "approve" checked

let activeSortCol = 'quality';
let activeSortDir = 'asc';
let activeFilters = {};        // colName → filter value/state

let suggestionsVisible = false;
let currentJobId = null;
let pollTimer = null;
let openPaneDocId = null;

let refreshInFlight = false;
let applyInFlight = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const refreshBtn      = document.getElementById('refreshBtn');
const suggestBtn      = document.getElementById('suggestBtn');
const showSuggestBtn  = document.getElementById('showSuggestBtn');
const applyAllBtn     = document.getElementById('applyAllBtn');
const cancelQueueBtn  = document.getElementById('cancelQueueBtn');
const readyCountEl    = document.getElementById('readyCount');
const approvedCountEl = document.getElementById('approvedCount');
const progressSection = document.getElementById('progressSection');
const progressFill    = document.getElementById('progressFill');
const progressLabel   = document.getElementById('progressLabel');
const filterChipsEl   = document.getElementById('filterChips');
const chipsContainer  = document.getElementById('chipsContainer');
const clearAllFilters = document.getElementById('clearAllFilters');
const entryRows       = document.getElementById('entryRows');
const reviewPane      = document.getElementById('reviewPane');
const closePaneBtn    = document.getElementById('closePaneBtn');
const selectAll       = document.getElementById('selectAll');
const dropdown        = document.getElementById('columnFilterDropdown');
const sortAscBtn      = document.getElementById('sortAscBtn');
const sortDescBtn     = document.getElementById('sortDescBtn');
const dropdownFilter  = document.getElementById('dropdownFilterSection');
const clearColFilter  = document.getElementById('clearColFilterBtn');

let dropdownCol = null;  // which column the dropdown is open for

// ── Utility ───────────────────────────────────────────────────────────────────
function statusDot(entry) {
  if (entry.fallback_used) return '<span class="status-dot status-fallback" title="Ollama failed; heuristic used"></span>';
  const cls = { none: 'status-none', pending: 'status-pending', ready: 'status-ready', done: 'status-done' };
  const t   = { none: 'No suggestion', pending: 'Queued / processing', ready: 'Suggestion ready', done: 'Reviewed' };
  const s = entry.suggestion_status || 'none';
  return `<span class="status-dot ${cls[s] || 'status-none'}" title="${t[s] || s}"></span>`;
}

function qualityDisplay(entry) {
  return entry.llm_quality != null ? entry.llm_quality : (entry.heuristic_quality ?? '—');
}

function tagsHtml(tags) {
  if (!tags || !tags.length) return '<span style="color:var(--text-muted)">—</span>';
  return tags.map(t => `<span class="tag-badge">${esc(t)}</span>`).join('');
}

function getFieldState(docId, field) {
  return (fieldStates.get(docId) || {})[field] || 'undecided';
}

function setFieldState(docId, field, state) {
  if (!fieldStates.has(docId)) fieldStates.set(docId, {});
  fieldStates.get(docId)[field] = state;
  checkAllResolved(docId);
}

function checkAllResolved(docId) {
  const sug = suggestions.get(docId);
  if (!sug) return;
  const states = fieldStates.get(docId) || {};
  const fields = relevantFields(sug);
  if (fields.every(f => states[f] && states[f] !== 'undecided')) {
    // Update entry suggestion_status locally
    const entry = currentEntries.find(e => e.id === docId);
    if (entry) entry.suggestion_status = 'done';
    // Re-render row
    renderTable(filteredEntries);
    updateToolbarCounts();
    if (openPaneDocId === docId) refreshPane(docId);
  }
}

function relevantFields(sug) {
  const fields = ['title'];
  if (sug.suggested_correspondent) fields.push('correspondent');
  if (sug.suggested_document_type) fields.push('document_type');
  if (sug.suggested_tags && sug.suggested_tags.length) fields.push('tags');
  return fields;
}

// ── Load entries ──────────────────────────────────────────────────────────────
async function loadEntries() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.textContent = 'Refreshing…';
  refreshBtn.disabled = true;

  try {
    const response = await fetch('/api/entries?sort_by=quality');
    if (!response.ok) {
      entryRows.innerHTML = `<tr><td colspan="20" style="color:#f87171">Failed to load: ${esc(await response.text())}</td></tr>`;
      return;
    }
    currentEntries = await response.json();
    // Merge local suggestion_status from our in-flight state
    for (const entry of currentEntries) {
      const sug = suggestions.get(entry.id);
      if (sug) {
        if (entry.suggestion_status === 'none' || entry.suggestion_status === 'pending') {
          entry.suggestion_status = 'ready';
        }
      }
    }
    applyFilterSort();
    updateToolbarCounts();
  } finally {
    refreshBtn.textContent = 'Refresh';
    refreshBtn.disabled = false;
    refreshInFlight = false;
  }
}

// ── Filter + sort ─────────────────────────────────────────────────────────────
function applyFilterSort() {
  let data = [...currentEntries];

  for (const [col, filter] of Object.entries(activeFilters)) {
    if (!filter || (typeof filter === 'object' && !filter.value && !filter.from && !filter.to && !filter.neverReviewed)) continue;
    data = data.filter(e => matchFilter(e, col, filter));
  }

  data = sortData(data, activeSortCol, activeSortDir);
  filteredEntries = data;
  renderTable(data);
  renderFilterChips();
}

function matchFilter(entry, col, filter) {
  if (typeof filter === 'string') {
    // text search
    const val = String(entry[col] || '').toLowerCase();
    return val.includes(filter.toLowerCase());
  }
  if (filter.values) {
    // checkbox set
    if (col === 'tags') return (entry.tags || []).some(t => filter.values.has(t));
    return filter.values.has(String(entry[col] || '—'));
  }
  if (filter.min != null || filter.max != null) {
    const v = entry.llm_quality != null ? entry.llm_quality : (entry.heuristic_quality || 0);
    if (filter.min != null && v < filter.min) return false;
    if (filter.max != null && v > filter.max) return false;
    return true;
  }
  if (filter.from || filter.to) {
    const v = entry[col] || '';
    if (filter.from && v < filter.from) return false;
    if (filter.to && v > filter.to) return false;
    return true;
  }
  if (filter.neverReviewed) {
    return !entry.metadata_reviewed;
  }
  return true;
}

function sortData(data, col, dir) {
  return [...data].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (col === 'quality') {
      av = a.llm_quality != null ? a.llm_quality : (a.heuristic_quality || 0);
      bv = b.llm_quality != null ? b.llm_quality : (b.heuristic_quality || 0);
    }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderTable(data) {
  const fragment = document.createDocumentFragment();

  for (const entry of data) {
    const tr = document.createElement('tr');
    if (openPaneDocId === entry.id) tr.classList.add('row-selected');

    const sug = suggestions.get(entry.id);
    const states = fieldStates.get(entry.id) || {};

    let cells = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${entry.id}" ${approvedDocs.has(entry.id) ? 'checked' : ''} /></td>
      <td>${statusDot(entry)}</td>
      <td title="${esc(entry.title)}">${esc(entry.title)}</td>
      <td>${esc(entry.correspondent || '—')}</td>
      <td>${esc(entry.document_type || '—')}</td>
      <td>${esc(entry.date ? entry.date.slice(0, 10) : '—')}</td>
      <td>${tagsHtml(entry.tags)}</td>
      <td>${esc(qualityDisplay(entry))}</td>
      <td>${esc(entry.metadata_completeness)}</td>
      <td>${esc(entry.metadata_reviewed || '—')}</td>
    `;

    if (suggestionsVisible && sug) {
      cells += sugColumnCell(entry.id, 'title', sug.suggested_title, states);
      cells += sugColumnCell(entry.id, 'correspondent', sug.suggested_correspondent?.name, states);
      cells += sugColumnCell(entry.id, 'document_type', sug.suggested_document_type?.name, states);
      // Tags column
      const tagState = states['tags'] || 'undecided';
      if (tagState === 'applied') {
        cells += `<td><span class="sug-applied">${esc(sug.suggested_tags.map(t=>t.name).join(', '))}</span></td>`;
      } else if (tagState === 'rejected') {
        cells += `<td><span class="sug-rejected">${esc(sug.suggested_tags.map(t=>t.name).join(', '))}</span></td>`;
      } else {
        cells += `<td><div class="sug-cell">
          <span class="sug-value">${esc(sug.suggested_tags.map(t=>t.name).join(', '))}</span>
          <button class="apply-btn" data-action="apply" data-id="${entry.id}" data-field="tags">✓</button>
          <button class="reject-btn" data-action="reject" data-id="${entry.id}" data-field="tags">✕</button>
        </div></td>`;
      }
    } else if (suggestionsVisible) {
      cells += '<td></td><td></td><td></td><td></td>';
    }

    tr.innerHTML = cells;
    tr.querySelector('.row-check')?.addEventListener('change', onRowCheckChange);
    tr.addEventListener('click', e => {
      if (e.target.type === 'checkbox' || e.target.tagName === 'BUTTON') return;
      openReviewPane(entry.id);
    });
    fragment.appendChild(tr);
  }

  entryRows.innerHTML = '';
  entryRows.appendChild(fragment);

  // Wire inline apply/reject buttons
  entryRows.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', onInlineAction);
  });

  updateSuggestionColumns();
}

function sugColumnCell(docId, field, value, states) {
  const state = states[field] || 'undecided';
  if (!value) return '<td>—</td>';
  if (state === 'applied') return `<td><span class="sug-applied">${esc(value)}</span></td>`;
  if (state === 'rejected') return `<td><span class="sug-rejected">${esc(value)}</span></td>`;
  return `<td><div class="sug-cell">
    <span class="sug-value">${esc(value)}</span>
    <button class="apply-btn" data-action="apply" data-id="${docId}" data-field="${field}">✓</button>
    <button class="reject-btn" data-action="reject" data-id="${docId}" data-field="${field}">✕</button>
  </div></td>`;
}

function updateSuggestionColumns() {
  const headerRow = document.getElementById('tableHeaderRow');
  // Remove existing suggestion headers
  headerRow.querySelectorAll('.sug-header').forEach(th => th.remove());
  if (!suggestionsVisible) return;
  ['Suggested title', 'Sugg. correspondent', 'Sugg. doc. type', 'Suggested tags'].forEach(label => {
    const th = document.createElement('th');
    th.className = 'sug-header';
    th.textContent = label;
    headerRow.appendChild(th);
  });
}

// ── Row checkbox ──────────────────────────────────────────────────────────────
function onRowCheckChange(e) {
  const id = Number(e.target.dataset.id);
  if (e.target.checked) approvedDocs.add(id); else approvedDocs.delete(id);
  updateToolbarCounts();
}

selectAll.addEventListener('change', () => {
  const checked = selectAll.checked;
  entryRows.querySelectorAll('.row-check').forEach(cb => {
    const id = Number(cb.dataset.id);
    cb.checked = checked;
    if (checked) approvedDocs.add(id); else approvedDocs.delete(id);
  });
  updateToolbarCounts();
});

// ── Toolbar counts ────────────────────────────────────────────────────────────
function updateToolbarCounts() {
  const readyCount = currentEntries.filter(e => e.suggestion_status === 'ready').length;
  readyCountEl.textContent = readyCount;
  showSuggestBtn.style.display = readyCount > 0 || suggestionsVisible ? '' : 'none';

  const approvedWithSug = [...approvedDocs].filter(id => suggestions.has(id)).length;
  approvedCountEl.textContent = approvedWithSug;
  applyAllBtn.disabled = approvedWithSug === 0 || applyInFlight;
}

// ── Generate suggestions ──────────────────────────────────────────────────────
async function generateSuggestions() {
  const selected = [...approvedDocs];
  if (!selected.length) {
    // fall back to all visible
    const visible = filteredEntries.map(e => e.id);
    if (!visible.length) { alert('No documents selected.'); return; }
    visible.forEach(id => approvedDocs.add(id));
  }

  const ids = [...approvedDocs];
  suggestBtn.disabled = true;
  suggestBtn.textContent = 'Queuing…';

  try {
    const resp = await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!resp.ok) { alert(`Failed: ${await resp.text()}`); return; }
    const { job_id, total } = await resp.json();
    currentJobId = job_id;
    startPolling(job_id, total);
    cancelQueueBtn.style.display = '';
    // Mark entries as pending locally
    for (const id of ids) {
      const entry = currentEntries.find(e => e.id === id);
      if (entry) entry.suggestion_status = 'pending';
    }
    renderTable(filteredEntries);
  } finally {
    suggestBtn.textContent = 'Generate suggestions';
  }
}

function startPolling(jobId, total) {
  setProgress(0, total);
  progressSection.style.display = '';
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollStatus(jobId, total), 2000);
}

async function pollStatus(jobId, total) {
  try {
    const resp = await fetch(`/api/suggestions/status?job_id=${encodeURIComponent(jobId)}`);
    if (!resp.ok) return;
    const data = await resp.json();
    setProgress(data.completed, data.total);

    // Integrate new results
    for (const sug of data.results) {
      if (!suggestions.has(sug.id)) {
        suggestions.set(sug.id, sug);
        if (!fieldStates.has(sug.id)) fieldStates.set(sug.id, {});
        const entry = currentEntries.find(e => e.id === sug.id);
        if (entry) {
          entry.suggestion_status = sug.fallback_used ? 'ready' : 'ready';
          entry.fallback_used = sug.fallback_used;
          if (sug.title_quality != null) entry.llm_quality = sug.title_quality;
        }
      }
    }

    renderTable(filteredEntries);
    updateToolbarCounts();

    if (data.completed >= data.total) {
      stopPolling();
      suggestBtn.disabled = false;
    }
  } catch (_) {}
}

function setProgress(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressLabel.textContent = `Processing ${done} of ${total}…`;
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  progressSection.style.display = 'none';
  cancelQueueBtn.style.display = 'none';
  suggestBtn.disabled = false;
}

cancelQueueBtn.addEventListener('click', async () => {
  stopPolling();
  await fetch('/api/suggestions/queue', { method: 'DELETE' });
  suggestBtn.disabled = false;
});

// ── Show suggestions toggle ───────────────────────────────────────────────────
showSuggestBtn.addEventListener('click', () => {
  suggestionsVisible = !suggestionsVisible;
  showSuggestBtn.textContent = (suggestionsVisible ? 'Hide suggestions (' : 'Show suggestions (') + readyCountEl.textContent + ' ready)';
  renderTable(filteredEntries);
});

// ── Inline apply / reject ─────────────────────────────────────────────────────
async function onInlineAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const docId = Number(btn.dataset.id);
  const field = btn.dataset.field;

  if (action === 'reject') {
    setFieldState(docId, field, 'rejected');
    renderTable(filteredEntries);
    if (openPaneDocId === docId) refreshPane(docId);
    return;
  }

  // Apply
  const sug = suggestions.get(docId);
  if (!sug) return;
  await applyField(docId, field, sug);
}

async function applyField(docId, field, sug) {
  const item = { id: docId, tags_new: [] };

  if (field === 'title') item.title = sug.suggested_title;
  else if (field === 'correspondent') item.correspondent = sug.suggested_correspondent?.name || null;
  else if (field === 'document_type') item.document_type = sug.suggested_document_type?.name || null;
  else if (field === 'tags') {
    item.tags = sug.suggested_tags.filter(t => !t.is_new).map(t => t.name);
    item.tags_new = sug.suggested_tags.filter(t => t.is_new).map(t => t.name);
  }

  try {
    const resp = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [item] }),
    });
    if (!resp.ok) { alert(`Apply failed: ${await resp.text()}`); return; }
    setFieldState(docId, field, 'applied');
  } catch (err) {
    alert(`Apply error: ${err.message}`);
    return;
  }

  renderTable(filteredEntries);
  if (openPaneDocId === docId) refreshPane(docId);
}

// ── Apply all approved ────────────────────────────────────────────────────────
applyAllBtn.addEventListener('click', async () => {
  if (applyInFlight) return;
  applyInFlight = true;
  applyAllBtn.disabled = true;
  applyAllBtn.textContent = 'Applying…';

  const entries = [];
  for (const docId of approvedDocs) {
    const sug = suggestions.get(docId);
    if (!sug) continue;
    const states = fieldStates.get(docId) || {};
    const item = { id: docId, tags_new: [] };

    if ((states['title'] || 'undecided') === 'undecided') item.title = sug.suggested_title;
    if (sug.suggested_correspondent && (states['correspondent'] || 'undecided') === 'undecided')
      item.correspondent = sug.suggested_correspondent.name;
    if (sug.suggested_document_type && (states['document_type'] || 'undecided') === 'undecided')
      item.document_type = sug.suggested_document_type.name;
    if (sug.suggested_tags.length && (states['tags'] || 'undecided') === 'undecided') {
      item.tags = sug.suggested_tags.filter(t => !t.is_new).map(t => t.name);
      item.tags_new = sug.suggested_tags.filter(t => t.is_new).map(t => t.name);
    }
    entries.push(item);
  }

  if (!entries.length) { applyInFlight = false; applyAllBtn.disabled = false; applyAllBtn.textContent = `Apply all approved (${approvedCountEl.textContent})`; return; }

  try {
    const resp = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    if (!resp.ok) { alert(`Apply failed: ${await resp.text()}`); return; }

    // Mark all fields applied
    for (const item of entries) {
      const sug = suggestions.get(item.id);
      if (!sug) continue;
      for (const f of relevantFields(sug)) setFieldState(item.id, f, 'applied');
    }
    approvedDocs.clear();
    await loadEntries();
  } finally {
    applyInFlight = false;
    applyAllBtn.textContent = `Apply all approved (0)`;
    applyAllBtn.disabled = true;
  }
});

// ── Review pane ───────────────────────────────────────────────────────────────
function openReviewPane(docId) {
  openPaneDocId = docId;
  reviewPane.style.display = '';
  document.getElementById('tableAndPane').classList.add('pane-open');
  refreshPane(docId);

  // Highlight row
  entryRows.querySelectorAll('tr').forEach(tr => {
    const cb = tr.querySelector('.row-check');
    if (cb && Number(cb.dataset.id) === docId) tr.classList.add('row-selected');
    else tr.classList.remove('row-selected');
  });
}

function refreshPane(docId) {
  const entry = currentEntries.find(e => e.id === docId);
  if (!entry) return;

  document.getElementById('paneTitle').textContent = entry.title;
  const thumb = document.getElementById('paneThumb');
  thumb.src = `/api/documents/${docId}/thumb`;
  document.getElementById('panePreviewLink').href = `/api/documents/${docId}/preview`;

  const sug = suggestions.get(docId);
  const states = fieldStates.get(docId) || {};

  const paneFields = document.getElementById('paneFields');
  paneFields.innerHTML = '';

  // Language
  if (sug?.detected_language) {
    const langEl = document.createElement('div');
    langEl.className = 'lang-label';
    langEl.textContent = `🌐 ${sug.detected_language}`;
    paneFields.appendChild(langEl);
  }

  // Fields
  const fieldDefs = [
    { key: 'title', label: 'Title', current: entry.title, sugValue: sug?.suggested_title },
    { key: 'correspondent', label: 'Correspondent', current: entry.correspondent || '—', sugValue: sug?.suggested_correspondent?.name },
    { key: 'document_type', label: 'Document type', current: entry.document_type || '—', sugValue: sug?.suggested_document_type?.name },
  ];

  for (const def of fieldDefs) {
    const div = buildPaneField(docId, def.key, def.label, def.current, def.sugValue, states[def.key] || 'undecided', sug);
    paneFields.appendChild(div);
  }

  // Tags field
  const tagsDiv = buildPaneTagsField(docId, entry.tags, sug, states['tags'] || 'undecided');
  paneFields.appendChild(tagsDiv);

  // Reason
  if (sug?.reason) {
    const reasonEl = document.createElement('div');
    reasonEl.style.cssText = 'font-size:0.82rem;color:var(--text-muted);font-style:italic;';
    reasonEl.textContent = sug.reason;
    paneFields.appendChild(reasonEl);
  }

  // Apply all / Reject all
  const hasUndecided = sug && relevantFields(sug).some(f => (states[f] || 'undecided') === 'undecided');
  document.getElementById('paneApplyAllBtn').style.display = hasUndecided ? '' : 'none';
  document.getElementById('paneRejectAllBtn').style.display = hasUndecided ? '' : 'none';

  // Reasoning
  if (sug?.reasoning) {
    document.getElementById('paneReasoning').style.display = '';
    document.getElementById('paneReasoningText').textContent = sug.reasoning;
  } else {
    document.getElementById('paneReasoning').style.display = 'none';
  }
}

function buildPaneField(docId, field, label, current, sugValue, state, sug) {
  const div = document.createElement('div');
  div.className = 'pane-field';

  const lbl = document.createElement('div');
  lbl.className = 'pane-field-label';
  lbl.textContent = label;
  div.appendChild(lbl);

  const cur = document.createElement('div');
  cur.className = 'pane-field-current';
  cur.textContent = current;
  div.appendChild(cur);

  if (!sugValue || !sug) return div;

  if (state === 'applied') {
    const a = document.createElement('div');
    a.className = 'pane-field-applied';
    div.appendChild(a);
  } else if (state === 'rejected') {
    const r = document.createElement('div');
    r.className = 'pane-field-rejected';
    r.textContent = sugValue;
    div.appendChild(r);
  } else {
    const sugRow = document.createElement('div');
    sugRow.className = 'pane-field-suggestion';
    sugRow.innerHTML = `<span>${esc(sugValue)}</span>`;

    const conf = field === 'correspondent' ? sug.suggested_correspondent?.confidence
                 : field === 'document_type' ? sug.suggested_document_type?.confidence
                 : null;
    if (conf != null) {
      const pill = document.createElement('span');
      pill.className = 'confidence-pill';
      pill.textContent = Math.round(conf * 100) + '%';
      sugRow.appendChild(pill);
    }

    const applyBtn = document.createElement('button');
    applyBtn.className = 'apply-btn';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', () => applyField(docId, field, sug));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      setFieldState(docId, field, 'rejected');
      renderTable(filteredEntries);
      refreshPane(docId);
    });

    sugRow.appendChild(applyBtn);
    sugRow.appendChild(rejectBtn);
    div.appendChild(sugRow);
  }
  return div;
}

function buildPaneTagsField(docId, currentTags, sug, state) {
  const div = document.createElement('div');
  div.className = 'pane-field';

  const lbl = document.createElement('div');
  lbl.className = 'pane-field-label';
  lbl.textContent = 'Tags';
  div.appendChild(lbl);

  const cur = document.createElement('div');
  cur.className = 'pane-field-current';
  cur.innerHTML = tagsHtml(currentTags);
  div.appendChild(cur);

  if (!sug || !sug.suggested_tags.length) return div;

  if (state === 'applied') {
    const a = document.createElement('div');
    a.className = 'pane-field-applied';
    div.appendChild(a);
  } else if (state === 'rejected') {
    const r = document.createElement('div');
    r.className = 'pane-field-rejected';
    r.innerHTML = sug.suggested_tags.map(t => `<span class="tag-badge${t.is_new ? ' is-new' : ''}">${esc(t.name)}</span>`).join('');
    div.appendChild(r);
  } else {
    const sugRow = document.createElement('div');
    sugRow.className = 'pane-field-suggestion';
    sugRow.style.flexWrap = 'wrap';
    sugRow.innerHTML = sug.suggested_tags.map(t =>
      `<span class="tag-badge${t.is_new ? ' is-new' : ''}" title="${t.is_new ? 'New tag' : 'Existing tag'} — confidence ${Math.round(t.confidence*100)}%">${esc(t.name)}</span>`
    ).join('');

    const applyBtn = document.createElement('button');
    applyBtn.className = 'apply-btn';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', () => applyField(docId, 'tags', sug));

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'reject-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', () => {
      setFieldState(docId, 'tags', 'rejected');
      renderTable(filteredEntries);
      refreshPane(docId);
    });

    sugRow.appendChild(applyBtn);
    sugRow.appendChild(rejectBtn);
    div.appendChild(sugRow);
  }
  return div;
}

document.getElementById('paneApplyAllBtn').addEventListener('click', async () => {
  if (!openPaneDocId) return;
  const sug = suggestions.get(openPaneDocId);
  if (!sug) return;
  const states = fieldStates.get(openPaneDocId) || {};
  for (const f of relevantFields(sug)) {
    if ((states[f] || 'undecided') === 'undecided') {
      await applyField(openPaneDocId, f, sug);
    }
  }
});

document.getElementById('paneRejectAllBtn').addEventListener('click', () => {
  if (!openPaneDocId) return;
  const sug = suggestions.get(openPaneDocId);
  if (!sug) return;
  const states = fieldStates.get(openPaneDocId) || {};
  for (const f of relevantFields(sug)) {
    if ((states[f] || 'undecided') === 'undecided') setFieldState(openPaneDocId, f, 'rejected');
  }
  renderTable(filteredEntries);
  refreshPane(openPaneDocId);
});

closePaneBtn.addEventListener('click', () => {
  reviewPane.style.display = 'none';
  openPaneDocId = null;
  entryRows.querySelectorAll('tr').forEach(tr => tr.classList.remove('row-selected'));
});

// ── Column filter dropdown ────────────────────────────────────────────────────
document.getElementById('tableHeaderRow').addEventListener('click', e => {
  const th = e.target.closest('th[data-col]');
  if (!th) { closeDropdown(); return; }
  const col = th.dataset.col;
  if (dropdownCol === col) { closeDropdown(); return; }
  openDropdown(col, th);
});

function openDropdown(col, thEl) {
  dropdownCol = col;
  const rect = thEl.getBoundingClientRect();
  dropdown.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  dropdown.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 280) + 'px';
  dropdown.style.display = '';

  buildDropdownFilter(col);
}

function closeDropdown() {
  dropdown.style.display = 'none';
  dropdownCol = null;
}

sortAscBtn.addEventListener('click', () => {
  if (!dropdownCol) return;
  activeSortCol = dropdownCol === 'quality' ? 'quality' : dropdownCol;
  activeSortDir = 'asc';
  applyFilterSort();
  closeDropdown();
});

sortDescBtn.addEventListener('click', () => {
  if (!dropdownCol) return;
  activeSortCol = dropdownCol === 'quality' ? 'quality' : dropdownCol;
  activeSortDir = 'desc';
  applyFilterSort();
  closeDropdown();
});

clearColFilter.addEventListener('click', () => {
  if (!dropdownCol) return;
  delete activeFilters[dropdownCol];
  applyFilterSort();
  closeDropdown();
});

document.addEventListener('click', e => {
  if (!dropdown.contains(e.target) && !e.target.closest('th[data-col]')) closeDropdown();
});

function buildDropdownFilter(col) {
  dropdownFilter.innerHTML = '';

  if (col === 'title') {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search title…';
    input.value = typeof activeFilters[col] === 'string' ? activeFilters[col] : '';
    input.addEventListener('input', () => {
      activeFilters[col] = input.value;
      applyFilterSort();
    });
    dropdownFilter.appendChild(input);
    return;
  }

  if (col === 'quality') {
    const f = activeFilters[col] || {};
    const minInput = document.createElement('input');
    minInput.type = 'number'; minInput.placeholder = 'Min (0)'; minInput.value = f.min ?? '';
    minInput.addEventListener('input', () => {
      activeFilters[col] = { ...activeFilters[col], min: minInput.value ? Number(minInput.value) : null };
      applyFilterSort();
    });
    const maxInput = document.createElement('input');
    maxInput.type = 'number'; maxInput.placeholder = 'Max (100)'; maxInput.value = f.max ?? '';
    maxInput.addEventListener('input', () => {
      activeFilters[col] = { ...activeFilters[col], max: maxInput.value ? Number(maxInput.value) : null };
      applyFilterSort();
    });
    const minLbl = document.createElement('label');
    minLbl.textContent = 'Min quality'; minLbl.appendChild(minInput);
    const maxLbl = document.createElement('label');
    maxLbl.textContent = 'Max quality'; maxLbl.appendChild(maxInput);
    dropdownFilter.appendChild(minLbl);
    dropdownFilter.appendChild(maxLbl);
    return;
  }

  if (col === 'date' || col === 'metadata_reviewed') {
    const f = activeFilters[col] || {};
    const fromInput = document.createElement('input');
    fromInput.type = 'date'; fromInput.value = f.from || '';
    fromInput.addEventListener('change', () => {
      activeFilters[col] = { ...activeFilters[col], from: fromInput.value || null };
      applyFilterSort();
    });
    const toInput = document.createElement('input');
    toInput.type = 'date'; toInput.value = f.to || '';
    toInput.addEventListener('change', () => {
      activeFilters[col] = { ...activeFilters[col], to: toInput.value || null };
      applyFilterSort();
    });
    const fromLbl = document.createElement('label'); fromLbl.textContent = 'From'; fromLbl.appendChild(fromInput);
    const toLbl = document.createElement('label'); toLbl.textContent = 'To'; toLbl.appendChild(toInput);
    dropdownFilter.appendChild(fromLbl);
    dropdownFilter.appendChild(toLbl);

    if (col === 'metadata_reviewed') {
      const neverLbl = document.createElement('label');
      const neverCb = document.createElement('input');
      neverCb.type = 'checkbox';
      neverCb.checked = !!(activeFilters[col] || {}).neverReviewed;
      neverCb.addEventListener('change', () => {
        activeFilters[col] = { ...activeFilters[col], neverReviewed: neverCb.checked };
        applyFilterSort();
      });
      neverLbl.appendChild(neverCb);
      neverLbl.appendChild(document.createTextNode(' Never reviewed'));
      dropdownFilter.appendChild(neverLbl);
    }
    return;
  }

  // Checkbox list (correspondent, document_type, status, tags)
  const existing = (activeFilters[col] || {}).values || new Set();
  let values;
  if (col === 'tags') {
    values = [...new Set(currentEntries.flatMap(e => e.tags || []))].sort();
  } else if (col === 'status') {
    values = ['none', 'pending', 'ready', 'done'];
  } else {
    values = [...new Set(currentEntries.map(e => e[col] || '—'))].sort();
  }

  for (const val of values) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = existing.has(val);
    cb.addEventListener('change', () => {
      const cur = (activeFilters[col] || {}).values || new Set();
      const next = new Set(cur);
      if (cb.checked) next.add(val); else next.delete(val);
      if (next.size === 0) delete activeFilters[col];
      else activeFilters[col] = { values: next };
      applyFilterSort();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + val));
    dropdownFilter.appendChild(lbl);
  }
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function renderFilterChips() {
  const entries = Object.entries(activeFilters);
  if (!entries.length) {
    filterChipsEl.style.display = 'none';
    return;
  }
  filterChipsEl.style.display = '';
  chipsContainer.innerHTML = '';
  for (const [col, filter] of entries) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `<span>${esc(col)}: ${esc(filterDescription(filter))}</span>`;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.addEventListener('click', () => { delete activeFilters[col]; applyFilterSort(); });
    chip.appendChild(rm);
    chipsContainer.appendChild(chip);
  }
}

function filterDescription(filter) {
  if (typeof filter === 'string') return `"${filter}"`;
  if (filter.values) return [...filter.values].join(', ');
  if (filter.min != null || filter.max != null) return `${filter.min ?? ''}–${filter.max ?? ''}`;
  if (filter.from || filter.to) return `${filter.from || ''}→${filter.to || ''}`;
  if (filter.neverReviewed) return 'Never reviewed';
  return '';
}

clearAllFilters.addEventListener('click', () => {
  activeFilters = {};
  applyFilterSort();
});

// ── Event wiring ──────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', loadEntries);
suggestBtn.addEventListener('click', generateSuggestions);

// ── Init ──────────────────────────────────────────────────────────────────────
loadEntries();
