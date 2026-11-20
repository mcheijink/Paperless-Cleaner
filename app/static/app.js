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
let selectedDocs = new Set();  // docIds ticked in the table — selection only, never implies approval

let activeSortCol = 'quality';
let activeSortDir = 'asc';
let activeFilters = {};        // colName → filter value/state

let suggestionsVisible = false;
let pollTimer = null;
let openPaneDocId = null;

let refreshInFlight = false;
let applyInFlight = false;
let paperlessBaseUrl = '';
let lastQueueData = null;
let entriesLoaded = false;
let loadFailed = false;      // true while the table shows a load error

// ── DOM refs ──────────────────────────────────────────────────────────────────
const refreshBtn      = document.getElementById('refreshBtn');
const suggestBtn      = document.getElementById('suggestBtn');
const showSuggestBtn  = document.getElementById('showSuggestBtn');
const applyAllBtn     = document.getElementById('applyAllBtn');
const cancelQueueBtn  = document.getElementById('cancelQueueBtn');
const reviewBtn       = document.getElementById('reviewBtn');
const selectWorstBtn  = document.getElementById('selectWorstBtn');
const clearSelBtn     = document.getElementById('clearSelectionBtn');
const selectedCountEl = document.getElementById('selectedCount');
const statusStrip     = document.getElementById('statusStrip');
const warningBanner   = document.getElementById('warningBanner');
const toastHost       = document.getElementById('toastHost');
const readyCountEl    = document.getElementById('readyCount');
const approvedCountEl = document.getElementById('approvedCount');
const progressSection = document.getElementById('progressSection');
const progressTrack   = document.getElementById('progressTrack');
const progressFill    = document.getElementById('progressFill');
const progressEta     = document.getElementById('progressEta');
const queuePanel      = document.getElementById('queuePanel');
const queuePanelBody  = document.getElementById('queuePanelBody');
const progressLabel   = document.getElementById('progressLabel');
const filterChipsEl   = document.getElementById('filterChips');
const chipsContainer  = document.getElementById('chipsContainer');
const clearAllFilters = document.getElementById('clearAllFilters');
const entryRows       = document.getElementById('entryRows');
const reviewPane      = document.getElementById('reviewPane');
const paneBackdrop    = document.getElementById('paneBackdrop');
const closePaneBtn    = document.getElementById('closePaneBtn');
const selectAll       = document.getElementById('selectAll');
const dropdown        = document.getElementById('columnFilterDropdown');
const sortAscBtn      = document.getElementById('sortAscBtn');
const sortDescBtn     = document.getElementById('sortDescBtn');
const dropdownFilter  = document.getElementById('dropdownFilterSection');
const clearColFilter  = document.getElementById('clearColFilterBtn');

let dropdownCol = null;  // which column the dropdown is open for

// ── Help modal ────────────────────────────────────────────────────────────────
const helpBackdrop = document.getElementById('helpBackdrop');
const helpModal    = document.getElementById('helpModal');
document.getElementById('helpBtn').addEventListener('click', () => {
  helpBackdrop.style.display = '';
  helpModal.style.display = '';
  helpModal.focus();
});
document.getElementById('closeHelpBtn').addEventListener('click', closeHelp);
helpBackdrop.addEventListener('click', closeHelp);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && helpModal.style.display !== 'none') closeHelp();
});
function closeHelp() {
  helpBackdrop.style.display = 'none';
  helpModal.style.display = 'none';
}

// ── Utility ───────────────────────────────────────────────────────────────────
const STATUS_LABEL = { none: 'No suggestion', pending: 'Queued', ready: 'Suggestion ready', done: 'Reviewed' };
const COLUMN_LABEL = {
  status: 'Status', title: 'Title', correspondent: 'Correspondent', document_type: 'Document type',
  date: 'Date', tags: 'Tags', quality: 'Quality', metadata_completeness: 'Completeness',
  metadata_reviewed: 'Reviewed',
};

function statusBadge(entry) {
  const s = entry.suggestion_status || 'none';
  if (entry.fallback_used && s === 'ready') {
    return '<span class="status-badge status-fallback" title="The LLM failed; a simple heuristic suggestion was used">Ready (fallback)</span>';
  }
  return `<span class="status-badge status-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

function qualityDisplay(entry) {
  if (entry.llm_quality != null) return `<span title="LLM title-quality score">${esc(entry.llm_quality)}</span>`;
  if (entry.heuristic_quality == null) return '—';
  return `<span class="quality-heuristic" title="Heuristic estimate — no LLM score yet">~${esc(entry.heuristic_quality)}</span>`;
}

async function errorMessage(resp) {
  const text = await resp.text();
  try {
    const detail = JSON.parse(text).detail;
    if (typeof detail === 'string') return detail;
  } catch (_) {}
  return text || `HTTP ${resp.status}`;
}

// ── Toasts ────────────────────────────────────────────────────────────────────
function showToast(message, { undo = null, kind = 'info', timeout = 8000 } = {}) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);
  if (undo) {
    const btn = document.createElement('button');
    btn.className = 'toast-undo';
    btn.textContent = 'Undo';
    btn.addEventListener('click', async () => { toast.remove(); await undo(); });
    toast.appendChild(btn);
  }
  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => toast.remove());
  toast.appendChild(close);
  toastHost.appendChild(toast);
  if (timeout) setTimeout(() => toast.remove(), timeout);
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
  const entry = currentEntries.find(e => e.id === docId);
  const states = fieldStates.get(docId) || {};
  // Use actionable fields only: tags only count if there's an actual diff
  const fields = actionableFields(docId, sug, entry);
  if (fields.every(f => states[f] && states[f] !== 'undecided')) {
    // Update entry suggestion_status locally
    if (entry) entry.suggestion_status = 'done';
    // Re-render row
    renderTable(filteredEntries);
    updateToolbarCounts();
    if (openPaneDocId === docId) refreshPane(docId);
  }
}

function actionableFields(docId, sug, entry) {
  const fields = ['title'];
  if (sug.suggested_correspondent) fields.push('correspondent');
  if (sug.suggested_document_type) fields.push('document_type');
  if (sug.suggested_tags && sug.suggested_tags.length) {
    // Only include tags if there is an actual diff (add or remove)
    const sugNames = new Set(sug.suggested_tags.map(t => t.name.toLowerCase()));
    const protected_ = new Set((sug.protected_tags || []).map(t => t.toLowerCase()));
    const currentLower = (entry?.tags || []).map(x => x.toLowerCase());
    const hasDiff = sug.suggested_tags.some(t => !currentLower.includes(t.name.toLowerCase()))
        || (entry?.tags || []).some(t => !sugNames.has(t.toLowerCase()) && !protected_.has(t.toLowerCase()));
    if (hasDiff) fields.push('tags');
  }
  return fields;
}

function relevantFields(sug) {
  const fields = ['title'];
  if (sug.suggested_correspondent) fields.push('correspondent');
  if (sug.suggested_document_type) fields.push('document_type');
  if (sug.suggested_tags && sug.suggested_tags.length) fields.push('tags');
  return fields;
}

function hasActionableUndecided(docId) {
  const entry = currentEntries.find(e => e.id === docId);
  const sug = suggestions.get(docId);
  if (!entry || !sug) return false;
  const states = fieldStates.get(docId) || {};
  return relevantFields(sug).some(f => {
    if ((states[f] || 'undecided') !== 'undecided') return false;
    if (f === 'tags') {
      const sugNames = new Set(sug.suggested_tags.map(t => t.name.toLowerCase()));
      const protected_ = new Set((sug.protected_tags || []).map(t => t.toLowerCase()));
      const currentLower = (entry.tags || []).map(x => x.toLowerCase());
      return sug.suggested_tags.some(t => !currentLower.includes(t.name.toLowerCase()))
          || (entry.tags || []).some(t => !sugNames.has(t.toLowerCase()) && !protected_.has(t.toLowerCase()));
    }
    return true;
  });
}

function docsToReview() {
  return filteredEntries.filter(e => hasActionableUndecided(e.id));
}

// Returns true when it moved to another document
function openNextDocToReview(direction = 1) {
  if (!openPaneDocId) return false;
  const currentIdx = filteredEntries.findIndex(e => e.id === openPaneDocId);
  if (currentIdx === -1) return false;
  const n = filteredEntries.length;
  // Search forward (or backward) for a doc with actionable undecided suggestions
  for (let i = 1; i < n; i++) {
    const idx = (currentIdx + direction * i + n) % n;
    const candidate = filteredEntries[idx];
    if (hasActionableUndecided(candidate.id)) {
      openReviewPane(candidate.id);
      return true;
    }
  }
  return false;
}

// After acting on a whole document: move on, or say clearly that the queue is empty
function advanceAfterDecision() {
  if (openNextDocToReview(1)) return;
  if (openPaneDocId) refreshPane(openPaneDocId);
  if (!docsToReview().length && suggestions.size) showToast('All suggestions reviewed.', { kind: 'success' });
}

// ── Load entries ──────────────────────────────────────────────────────────────
async function loadEntries() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.textContent = 'Refreshing…';
  refreshBtn.disabled = true;
  if (!entriesLoaded) showTableMessage('Loading documents from Paperless…');
  statusStrip.textContent = 'Loading documents…';

  try {
    let response;
    try {
      response = await fetch('/api/entries?sort_by=quality');
    } catch (err) {
      showLoadError('Could not reach the Paperless Cleaner server. Check your network connection.');
      return;
    }
    if (!response.ok) {
      showLoadError(await errorMessage(response));
      return;
    }
    const payload = await response.json();
    currentEntries = payload.entries;
    entriesLoaded = true;
    loadFailed = false;
    const warnings = payload.warnings || [];
    warningBanner.hidden = warnings.length === 0;
    warningBanner.textContent = warnings.join(' ');
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

function showTableMessage(html) {
  entryRows.innerHTML = `<tr class="table-message"><td colspan="20">${html}</td></tr>`;
}

function showLoadError(message) {
  loadFailed = true;
  currentEntries = [];
  filteredEntries = [];
  statusStrip.textContent = 'Documents could not be loaded.';
  showTableMessage(`<span class="error-text">${esc(message)}</span>
    <button id="retryLoadBtn" class="btn-secondary">Retry</button>
    <a href="/settings">Check connection settings</a>`);
  document.getElementById('retryLoadBtn').addEventListener('click', loadEntries);
}

// ── Filter + sort ─────────────────────────────────────────────────────────────
function applyFilterSort() {
  let data = [...currentEntries];

  for (const [col, filter] of Object.entries(activeFilters)) {
    if (!filter || (typeof filter === 'object' && !filter.values && !filter.value && filter.min == null && filter.max == null && !filter.from && !filter.to && !filter.neverReviewed)) continue;
    data = data.filter(e => matchFilter(e, col, filter));
  }

  data = sortData(data, activeSortCol, activeSortDir);
  filteredEntries = data;
  const visibleIds = new Set(data.map(e => e.id));
  for (const id of [...selectedDocs]) if (!visibleIds.has(id)) selectedDocs.delete(id);
  renderTable(data);
  renderFilterChips();
  renderSortArrows();
  updateToolbarCounts();
}

function renderSortArrows() {
  document.querySelectorAll('#tableHeaderRow th[data-col]').forEach(th => {
    const active = th.dataset.col === activeSortCol;
    th.classList.toggle('col-active', active);
    th.setAttribute('aria-sort', active ? (activeSortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (activeSortDir === 'asc' ? '↑' : '↓') : '▾';
  });
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
    const dataKey = col === 'status' ? 'suggestion_status' : col;
    return filter.values.has(String(entry[dataKey] || '—'));
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
  if (!data.length) {
    updateSuggestionColumns();
    if (!entriesLoaded || loadFailed) return;  // keep the loading / error message
    if (currentEntries.length) {
      showTableMessage('No documents match these filters. <button id="emptyClearFilters" class="btn-secondary">Clear filters</button>');
      document.getElementById('emptyClearFilters').addEventListener('click', () => { activeFilters = {}; applyFilterSort(); });
    } else {
      showTableMessage('No documents found in Paperless. <a href="/settings">Check the connection in Settings</a>.');
    }
    selectAll.checked = false;
    return;
  }
  const fragment = document.createDocumentFragment();

  for (const entry of data) {
    const tr = document.createElement('tr');
    if (openPaneDocId === entry.id) tr.classList.add('row-selected');

    const sug = suggestions.get(entry.id);
    const states = fieldStates.get(entry.id) || {};

    let cells = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${entry.id}" aria-label="Select document" ${selectedDocs.has(entry.id) ? 'checked' : ''} /></td>
      <td>${statusBadge(entry)}</td>
      <td title="${esc(entry.title)}">${esc(entry.title)}</td>
      <td>${esc(entry.correspondent || '—')}</td>
      <td>${esc(entry.document_type || '—')}</td>
      <td>${esc(entry.date ? entry.date.slice(0, 10) : '—')}</td>
      <td>${tagsHtml(entry.tags)}</td>
      <td>${qualityDisplay(entry)}</td>
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
          <button class="apply-btn" data-action="apply" data-id="${entry.id}" data-field="tags" title="Apply to Paperless" aria-label="Apply suggested tags">✓</button>
          <button class="reject-btn" data-action="reject" data-id="${entry.id}" data-field="tags" title="Reject" aria-label="Reject suggested tags">✕</button>
        </div></td>`;
      }
    } else if (suggestionsVisible) {
      cells += '<td></td><td></td><td></td><td></td>';
    }

    tr.innerHTML = cells;
    tr.tabIndex = 0;
    tr.querySelector('.row-check')?.addEventListener('change', onRowCheckChange);
    tr.addEventListener('click', e => {
      if (e.target.type === 'checkbox' || e.target.tagName === 'BUTTON') return;
      openReviewPane(entry.id);
    });
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target === tr) { e.preventDefault(); openReviewPane(entry.id); }
    });
    fragment.appendChild(tr);
  }

  entryRows.innerHTML = '';
  entryRows.appendChild(fragment);
  selectAll.checked = data.every(e => selectedDocs.has(e.id));

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
    <button class="apply-btn" data-action="apply" data-id="${docId}" data-field="${field}" title="Apply to Paperless" aria-label="Apply suggestion">✓</button>
    <button class="reject-btn" data-action="reject" data-id="${docId}" data-field="${field}" title="Reject" aria-label="Reject suggestion">✕</button>
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
  if (e.target.checked) selectedDocs.add(id); else selectedDocs.delete(id);
  updateToolbarCounts();
}

selectAll.addEventListener('change', () => {
  const checked = selectAll.checked;
  entryRows.querySelectorAll('.row-check').forEach(cb => {
    const id = Number(cb.dataset.id);
    cb.checked = checked;
    if (checked) selectedDocs.add(id); else selectedDocs.delete(id);
  });
  updateToolbarCounts();
});

// ── Toolbar counts ────────────────────────────────────────────────────────────
function updateToolbarCounts() {
  // "To review" counts what the Review button will actually open
  const toReview = currentEntries.filter(e => hasActionableUndecided(e.id)).length;
  const queued = currentEntries.filter(e => e.suggestion_status === 'pending').length;
  readyCountEl.textContent = toReview;
  reviewBtn.hidden = toReview === 0;
  showSuggestBtn.hidden = !(toReview > 0 || suggestionsVisible);
  showSuggestBtn.textContent = suggestionsVisible ? 'Hide suggestions in table' : 'Show suggestions in table';

  selectedCountEl.textContent = selectedDocs.size;
  suggestBtn.disabled = selectedDocs.size === 0;
  clearSelBtn.hidden = selectedDocs.size === 0;

  const selectedWithSug = [...selectedDocs].filter(id => hasActionableUndecided(id)).length;
  approvedCountEl.textContent = selectedWithSug;
  applyAllBtn.hidden = selectedWithSug === 0;
  applyAllBtn.disabled = applyInFlight;

  if (entriesLoaded && !loadFailed) {
    const sortLabel = `${COLUMN_LABEL[activeSortCol] || activeSortCol} ${activeSortDir === 'asc' ? 'lowest first' : 'highest first'}`;
    const shown = filteredEntries.length !== currentEntries.length ? ` (${filteredEntries.length} shown)` : '';
    statusStrip.textContent =
      `${currentEntries.length} documents${shown} · ${toReview} to review · ${queued} queued · sorted by ${sortLabel}`;
  }
}

selectWorstBtn.addEventListener('click', () => {
  const candidates = sortData(
    filteredEntries.filter(e => !e.metadata_reviewed && (e.suggestion_status || 'none') === 'none'),
    'quality', 'asc',
  ).slice(0, 25);
  if (!candidates.length) { showToast('No unreviewed documents without a suggestion in the current view.'); return; }
  candidates.forEach(e => selectedDocs.add(e.id));
  renderTable(filteredEntries);
  updateToolbarCounts();
});

clearSelBtn.addEventListener('click', () => {
  selectedDocs.clear();
  renderTable(filteredEntries);
  updateToolbarCounts();
});

reviewBtn.addEventListener('click', () => {
  const first = docsToReview()[0] || currentEntries.find(e => hasActionableUndecided(e.id));
  if (!first) return;
  if (!filteredEntries.some(e => e.id === first.id)) { activeFilters = {}; applyFilterSort(); }
  openReviewPane(first.id);
});

// ── Generate suggestions ──────────────────────────────────────────────────────
async function generateSuggestions() {
  const ids = [...selectedDocs];
  if (!ids.length) return;
  if (ids.length > 25 && !confirm(`Queue ${ids.length} documents for LLM suggestions? This can take a long time. Nothing is written to Paperless until you apply a suggestion.`)) return;
  suggestBtn.disabled = true;

  try {
    const resp = await fetch('/api/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!resp.ok) { showToast(`Could not queue documents: ${await errorMessage(resp)}`, { kind: 'error' }); return; }
    const { total, newly_added } = await resp.json();
    showToast(`${newly_added} document(s) queued for suggestions.`);
    startPolling(total);
    cancelQueueBtn.style.display = '';
    // Mark entries as pending locally
    for (const id of ids) {
      const entry = currentEntries.find(e => e.id === id);
      if (entry && !suggestions.has(id)) entry.suggestion_status = 'pending';
    }
    // Selection has done its job — clear it so it cannot leak into a later bulk accept
    selectedDocs.clear();
    renderTable(filteredEntries);
  } finally {
    updateToolbarCounts();
  }
}

function startPolling(total) {
  setProgress(0, total);
  progressSection.style.display = '';
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollStatus(), 2000);
}

async function pollStatus() {
  try {
    const resp = await fetch('/api/suggestions/status');
    if (!resp.ok) { stopPolling(); return; }
    const data = await resp.json();
    lastQueueData = data;
    setProgress(data.completed, data.total, data.eta_seconds, data.avg_seconds_per_doc);
    if (queuePanel.style.display !== 'none') renderQueuePanel();

    const hadBefore = suggestions.size;
    mergeResults(data.results);
    // New results change suggestion_status; re-run the active filters so that
    // e.g. a "Suggestion ready" filter picks up documents as they finish.
    if (suggestions.size !== hadBefore) applyFilterSort();
    else renderTable(filteredEntries);
    updateToolbarCounts();
    if (openPaneDocId && suggestions.size !== hadBefore) refreshPane(openPaneDocId);

    if (data.completed >= data.total) {
      stopPolling();
      showToast(`Suggestions finished: ${docsToReview().length} document(s) to review.`, { kind: 'success' });
    }
  } catch (_) {}
}

// Integrate suggestion results from the server job into local state
function mergeResults(results) {
  for (const sug of results || []) {
    if (suggestions.has(sug.id)) continue;
    const entry = currentEntries.find(e => e.id === sug.id);
    // Already applied in an earlier page session — nothing left to review
    if (entry && entry.suggestion_status === 'done') continue;
    suggestions.set(sug.id, sug);
    if (!fieldStates.has(sug.id)) fieldStates.set(sug.id, {});
    if (entry) {
      entry.suggestion_status = 'ready';
      entry.fallback_used = sug.fallback_used;
      if (sug.title_quality != null) entry.llm_quality = sug.title_quality;
    }
  }
}

function setProgress(done, total, etaSeconds, avgSeconds) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  progressLabel.textContent = `Processing ${done} of ${total}…`;
  if (etaSeconds != null) {
    const mins = Math.floor(etaSeconds / 60);
    const secs = Math.round(etaSeconds % 60);
    const etaStr = mins > 0 ? `${mins}m ${secs}s remaining` : `${secs}s remaining`;
    const speedStr = avgSeconds != null ? ` · ${avgSeconds}s/doc` : '';
    progressEta.textContent = etaStr + speedStr;
  } else {
    progressEta.textContent = '';
  }
}

function renderQueuePanel() {
  if (!lastQueueData) return;
  const { items, elapsed_seconds, avg_seconds_per_doc, eta_seconds, completed, total } = lastQueueData;
  queuePanelBody.innerHTML = '';

  // Stats row
  const stats = document.createElement('div');
  stats.className = 'queue-stats';
  const elapsedStr = elapsed_seconds != null ? `Elapsed: ${elapsed_seconds}s` : '';
  const speedStr = avg_seconds_per_doc != null ? `Speed: ${avg_seconds_per_doc}s/doc` : '';
  const etaStr = eta_seconds != null ? `ETA: ${eta_seconds >= 60 ? Math.floor(eta_seconds/60)+'m ' : ''}${Math.round(eta_seconds%60)}s` : '';
  [elapsedStr, speedStr, etaStr].filter(Boolean).forEach(s => {
    const span = document.createElement('span'); span.textContent = s; stats.appendChild(span);
  });
  queuePanelBody.appendChild(stats);

  // Item list
  const statusIcon = { pending: '⏳', processing: '⚙️', done: '✓', failed: '⚠️' };
  for (const item of (items || [])) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const icon = document.createElement('span');
    icon.className = 'queue-item-icon';
    icon.textContent = statusIcon[item.status] || '·';
    const title = document.createElement('span');
    title.className = 'queue-item-title';
    title.textContent = item.title;
    const dur = document.createElement('span');
    dur.className = 'queue-item-duration';
    if (item.started_at && item.finished_at) {
      dur.textContent = `${Math.round(item.finished_at - item.started_at)}s`;
    } else if (item.status === 'processing' && item.started_at) {
      dur.textContent = 'running…';
    }
    row.appendChild(icon); row.appendChild(title); row.appendChild(dur);
    queuePanelBody.appendChild(row);
  }
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  progressSection.style.display = 'none';
  cancelQueueBtn.style.display = 'none';
  // Keep queue panel open so user can review results; they can close it manually
}

progressTrack.addEventListener('click', () => {
  if (queuePanel.style.display === 'none') {
    renderQueuePanel();
    queuePanel.style.display = '';
  } else {
    queuePanel.style.display = 'none';
  }
});

document.getElementById('closeQueuePanel').addEventListener('click', () => {
  queuePanel.style.display = 'none';
});

cancelQueueBtn.addEventListener('click', async () => {
  stopPolling();
  await fetch('/api/suggestions/queue', { method: 'DELETE' });
  for (const entry of currentEntries) {
    if (entry.suggestion_status === 'pending') entry.suggestion_status = 'none';
  }
  renderTable(filteredEntries);
  updateToolbarCounts();
  showToast('Queue cancelled. Finished suggestions are kept.');
});

// ── Show suggestions toggle ───────────────────────────────────────────────────
showSuggestBtn.addEventListener('click', () => {
  suggestionsVisible = !suggestionsVisible;
  renderTable(filteredEntries);
  updateToolbarCounts();
  if (suggestionsVisible) {
    // The new columns are appended on the right — bring them into view
    const section = document.getElementById('tableSection');
    section.scrollTo({ left: section.scrollWidth, behavior: 'smooth' });
  }
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

  const entry = currentEntries.find(e => e.id === docId);
  const previous = entry ? { title: entry.title, correspondent: entry.correspondent, document_type: entry.document_type, tags: [...(entry.tags || [])] } : null;

  if (!(await postApply([item]))) return false;
  if (entry) applyLocally(entry, item, sug);
  setFieldState(docId, field, 'applied');

  renderTable(filteredEntries);
  updateToolbarCounts();
  if (openPaneDocId === docId) refreshPane(docId);

  const label = COLUMN_LABEL[field] || field;
  // Paperless cannot be told to clear a value through this API, so undo needs a previous value
  const canUndo = previous && (field === 'tags' || previous[field]);
  showToast(`${label} applied to Paperless.`, {
    kind: 'success',
    undo: canUndo ? async () => {
      const revert = { id: docId, tags_new: [] };
      revert[field] = previous[field];
      if (!(await postApply([revert]))) return;
      if (entry) entry[field] = previous[field];
      setFieldState(docId, field, 'undecided');
      if (entry) entry.suggestion_status = 'ready';
      renderTable(filteredEntries);
      updateToolbarCounts();
      if (openPaneDocId === docId) refreshPane(docId);
      showToast(`${label} restored.`);
    } : null,
  });
  return true;
}

async function postApply(entries) {
  try {
    const resp = await fetch('/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    if (!resp.ok) { showToast(`Apply failed: ${await errorMessage(resp)}`, { kind: 'error', timeout: 0 }); return false; }
    return true;
  } catch (err) {
    showToast(`Apply failed: ${err.message}`, { kind: 'error', timeout: 0 });
    return false;
  }
}

// Mirror what /api/apply wrote, so the row and pane show the new values
function applyLocally(entry, item, sug) {
  if (item.title != null) entry.title = item.title;
  if (item.correspondent != null) entry.correspondent = item.correspondent;
  if (item.document_type != null) entry.document_type = item.document_type;
  if (item.tags != null) {
    const protectedLower = new Set((sug?.protected_tags || []).map(t => t.toLowerCase()));
    const kept = (entry.tags || []).filter(t => protectedLower.has(t.toLowerCase()));
    entry.tags = [...new Set([...kept, ...item.tags, ...(item.tags_new || [])])];
  }
  entry.metadata_reviewed = new Date().toISOString().slice(0, 10);
}

// ── Apply all approved ────────────────────────────────────────────────────────
applyAllBtn.addEventListener('click', async () => {
  if (applyInFlight) return;

  const entries = [];
  for (const docId of selectedDocs) {
    const sug = suggestions.get(docId);
    if (!sug || !hasActionableUndecided(docId)) continue;
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

  if (!entries.length) return;
  const fieldCount = entries.reduce((n, item) =>
    n + ['title', 'correspondent', 'document_type', 'tags'].filter(f => item[f] != null).length, 0);
  if (!confirm(`Write ${fieldCount} suggested change(s) to ${entries.length} document(s) in Paperless without reviewing them one by one? This cannot be undone from here.`)) return;

  applyInFlight = true;
  applyAllBtn.disabled = true;

  try {
    if (!(await postApply(entries))) return;
    showToast(`${fieldCount} change(s) written to ${entries.length} document(s).`, { kind: 'success' });

    // Mark all fields applied
    for (const item of entries) {
      const sug = suggestions.get(item.id);
      if (!sug) continue;
      for (const f of relevantFields(sug)) setFieldState(item.id, f, 'applied');
    }
    selectedDocs.clear();
    await loadEntries();
  } finally {
    applyInFlight = false;
    updateToolbarCounts();
  }
});

// ── Review pane ───────────────────────────────────────────────────────────────
function openReviewPane(docId) {
  openPaneDocId = docId;
  reviewPane.style.display = '';
  paneBackdrop.style.display = '';
  document.body.classList.add('pane-open');
  refreshPane(docId);
  if (!reviewPane.contains(document.activeElement)) reviewPane.focus();

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
  const previewFrame = document.getElementById('panePreviewFrame');
  const previewUrl = `/api/documents/${docId}/preview`;
  if (previewFrame.dataset.docId !== String(docId)) {
    previewFrame.dataset.docId = String(docId);
    // Fetch as blob so the browser renders it inline rather than downloading
    fetch(previewUrl)
      .then(r => { if (!r.ok) throw new Error('preview unavailable'); return r.blob(); })
      .then(blob => {
        if (previewFrame.dataset.docId !== String(docId)) return;  // user moved on
        const blobUrl = URL.createObjectURL(blob);
        // Revoke previous blob URL to free memory
        if (previewFrame.dataset.blobUrl) URL.revokeObjectURL(previewFrame.dataset.blobUrl);
        previewFrame.dataset.blobUrl = blobUrl;
        previewFrame.src = blobUrl;
      })
      .catch(() => { previewFrame.src = ''; });
  }

  document.getElementById('panePreviewLink').href = previewUrl;
  const paperlessLink = document.getElementById('panePaperlessLink');
  if (paperlessBaseUrl) {
    paperlessLink.href = `${paperlessBaseUrl}/documents/${docId}/details`;
    paperlessLink.style.display = '';
  } else {
    paperlessLink.style.display = 'none';
  }

  const sug = suggestions.get(docId);
  const states = fieldStates.get(docId) || {};

  const paneFields = document.getElementById('paneFields');
  paneFields.innerHTML = '';

  // Explain the state of this document before listing fields
  const note = document.createElement('div');
  note.className = 'pane-note';
  const status = entry.suggestion_status || 'none';
  if (!sug && status === 'ready') {
    note.textContent = 'The suggestion for this document is no longer available (the server restarted or the queue was cancelled). ';
    note.appendChild(paneGenerateButton(docId, 'Regenerate suggestion'));
  } else if (!sug && status === 'pending') {
    note.textContent = 'Queued — the suggestion will appear here when the LLM has processed this document.';
  } else if (!sug) {
    note.textContent = status === 'done' ? 'Already reviewed. ' : 'No suggestion yet. ';
    note.appendChild(paneGenerateButton(docId, 'Generate suggestion'));
  } else if (!hasActionableUndecided(docId)) {
    note.classList.add('pane-note-done');
    const left = docsToReview().length;
    note.textContent = left
      ? `Done with this document — ${left} more to review.`
      : 'All done — no suggestions left to review.';
  }
  if (note.textContent) paneFields.appendChild(note);

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
  const hasUndecided = hasActionableUndecided(docId);
  document.getElementById('paneApplyAllBtn').style.display = hasUndecided ? '' : 'none';
  document.getElementById('paneRejectAllBtn').style.display = hasUndecided ? '' : 'none';

  // Prev / Next nav buttons — show whether adjacent actionable docs exist
  const queue = docsToReview();
  const others = queue.some(e => e.id !== docId);
  document.getElementById('panePrevBtn').disabled = !others;
  document.getElementById('paneNextBtn').disabled = !others;
  const pos = queue.findIndex(e => e.id === docId);
  document.getElementById('panePosition').textContent =
    pos !== -1 ? `${pos + 1} of ${queue.length} to review` : (queue.length ? `${queue.length} to review` : '');

  // Reasoning
  if (sug?.reasoning) {
    document.getElementById('paneReasoning').style.display = '';
    document.getElementById('paneReasoningText').textContent = sug.reasoning;
  } else {
    document.getElementById('paneReasoning').style.display = 'none';
  }
}

function paneGenerateButton(docId, label) {
  const btn = document.createElement('button');
  btn.className = 'btn-secondary';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    suggestions.delete(docId);
    fieldStates.delete(docId);
    selectedDocs.clear();
    selectedDocs.add(docId);
    await generateSuggestions();
    refreshPane(docId);
  });
  return btn;
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
    r.textContent = `Rejected: ${sugValue}`;
    div.appendChild(r);
  } else {
    const sugRow = document.createElement('div');
    sugRow.className = 'pane-field-suggestion';
    sugRow.innerHTML = `<span class="sug-arrow" aria-hidden="true">→</span><span>${esc(sugValue)}</span>`;

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

  // Compute diff: what changes relative to current tags
  const suggestedNames = new Set(sug.suggested_tags.map(t => t.name.toLowerCase()));
  const protectedNames = new Set((sug.protected_tags || []).map(t => t.toLowerCase()));
  const currentLower = currentTags.map(x => x.toLowerCase());
  // Tags present in suggestion but not current = additions
  const additions = sug.suggested_tags.filter(t => !currentLower.includes(t.name.toLowerCase()));
  // Current non-protected tags not in suggestion = removals
  const removals = currentTags.filter(t => !suggestedNames.has(t.toLowerCase()) && !protectedNames.has(t.toLowerCase()));

  const hasDiff = additions.length > 0 || removals.length > 0;
  if (!hasDiff) return div;

  if (state === 'applied') {
    const a = document.createElement('div');
    a.className = 'pane-field-applied';
    div.appendChild(a);
  } else if (state === 'rejected') {
    const r = document.createElement('div');
    r.className = 'pane-field-rejected';
    r.textContent = 'Changes rejected';
    div.appendChild(r);
  } else {
    const diffRow = document.createElement('div');
    diffRow.className = 'pane-field-suggestion tag-diff';

    additions.forEach(t => {
      const badge = document.createElement('span');
      badge.className = `tag-badge tag-add${t.is_new ? ' is-new' : ''}`;
      badge.title = `Add — confidence ${Math.round(t.confidence * 100)}%`;
      badge.textContent = '+ ' + t.name;
      diffRow.appendChild(badge);
    });
    removals.forEach(name => {
      const badge = document.createElement('span');
      badge.className = 'tag-badge tag-remove';
      badge.title = 'Remove';
      badge.textContent = '− ' + name;
      diffRow.appendChild(badge);
    });

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

    diffRow.appendChild(applyBtn);
    diffRow.appendChild(rejectBtn);
    div.appendChild(diffRow);
  }
  return div;
}

document.getElementById('paneApplyAllBtn').addEventListener('click', async () => {
  if (!openPaneDocId) return;
  const sug = suggestions.get(openPaneDocId);
  if (!sug) return;
  const states = fieldStates.get(openPaneDocId) || {};
  const docId = openPaneDocId;
  for (const f of actionableFields(docId, sug, currentEntries.find(e => e.id === docId))) {
    if ((states[f] || 'undecided') === 'undecided') {
      if (!(await applyField(docId, f, sug))) return;  // stay on this document when a write fails
    }
  }
  if (openPaneDocId === docId) advanceAfterDecision();
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
  updateToolbarCounts();
  advanceAfterDecision();
});

document.getElementById('panePrevBtn').addEventListener('click', () => openNextDocToReview(-1));
document.getElementById('paneNextBtn').addEventListener('click', () => openNextDocToReview(1));

function closeReviewPane() {
  reviewPane.style.display = 'none';
  paneBackdrop.style.display = 'none';
  document.body.classList.remove('pane-open');
  openPaneDocId = null;
  entryRows.querySelectorAll('tr').forEach(tr => tr.classList.remove('row-selected'));
}
closePaneBtn.addEventListener('click', closeReviewPane);
paneBackdrop.addEventListener('click', closeReviewPane);

// ── Pane keyboard shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (!openPaneDocId) return;
  // Don't fire when user is typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.key === 'ArrowRight' || e.key === 'l') { e.preventDefault(); openNextDocToReview(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'h') { e.preventDefault(); openNextDocToReview(-1); }
  else if (e.key === 'a') { e.preventDefault(); document.getElementById('paneApplyAllBtn').click(); }
  else if (e.key === 'r') { e.preventDefault(); document.getElementById('paneRejectAllBtn').click(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeReviewPane(); }
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
  dropdown.style.top = (rect.bottom + 4) + 'px';  // position: fixed → viewport coordinates
  dropdown.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 270)) + 'px';
  dropdown.style.display = '';

  buildDropdownFilter(col);
}

function closeDropdown() {
  dropdown.style.display = 'none';
  dropdownCol = null;
}

document.querySelectorAll('#tableHeaderRow th[data-col]').forEach(th => {
  th.tabIndex = 0;
  th.setAttribute('aria-haspopup', 'true');
  th.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); th.click(); }
  });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && dropdownCol) { e.stopPropagation(); closeDropdown(); }
}, true);

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
    lbl.appendChild(document.createTextNode(' ' + (col === 'status' ? (STATUS_LABEL[val] || val) : val)));
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
    chip.innerHTML = `<span>${esc(COLUMN_LABEL[col] || col)}: ${esc(filterDescription(filter, col))}</span>`;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove filter');
    rm.addEventListener('click', () => { delete activeFilters[col]; applyFilterSort(); });
    chip.appendChild(rm);
    chipsContainer.appendChild(chip);
  }
}

function filterDescription(filter, col) {
  if (typeof filter === 'string') return `"${filter}"`;
  if (filter.values) return [...filter.values].map(v => col === 'status' ? (STATUS_LABEL[v] || v) : v).join(', ');
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
refreshBtn.addEventListener('click', () => loadEntries().then(syncQueue));
suggestBtn.addEventListener('click', generateSuggestions);

// ── Init ──────────────────────────────────────────────────────────────────────
fetch('/api/settings').then(r => r.json()).then(s => { paperlessBaseUrl = (s.paperless_base_url || '').replace(/\/$/, ''); }).catch(() => {});
// Restore the server-side queue after a page load: finished results are merged
// even when the queue is complete — otherwise rows say "ready" with nothing to show.
async function syncQueue() {
  try {
    const r = await fetch('/api/suggestions/status');
    if (!r.ok) return;
    const data = await r.json();
    lastQueueData = data;
    mergeResults(data.results);
    renderTable(filteredEntries);
    updateToolbarCounts();
    if (data.completed < data.total) {
      startPolling(data.total);
      setProgress(data.completed, data.total, data.eta_seconds, data.avg_seconds_per_doc);
      cancelQueueBtn.style.display = '';
    }
  } catch (_) {}
}

loadEntries().then(syncQueue);
