'use strict';

// ── XSS helper ────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── State ─────────────────────────────────────────────────────────────────────
let paperlessBaseUrl = '';
let groups = [];          // accumulated result groups from scan
let openGroupIdx = null;  // which group's preview is open
let activeEventSource = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const scanBtn         = document.getElementById('scanBtn');
const scanSummary     = document.getElementById('scanSummary');
const progressSection = document.getElementById('progressSection');
const progressFill    = document.getElementById('progressFill');
const progressLabel   = document.getElementById('progressLabel');
const progressPhase   = document.getElementById('progressPhase');
const resultsSection  = document.getElementById('resultsSection');
const groupsContainer = document.getElementById('groupsContainer');
const emptyState      = document.getElementById('emptyState');
const previewBackdrop = document.getElementById('previewBackdrop');
const previewModal    = document.getElementById('previewModal');
const previewPanes    = document.getElementById('previewPanes');
const previewTitle    = document.getElementById('previewTitle');
const closePreviewBtn = document.getElementById('closePreviewBtn');
const cancelScanBtn   = document.getElementById('cancelScanBtn');
const progressTrack   = document.getElementById('progressTrack');
const dismissedNote   = document.getElementById('dismissedNote');

// ── Dismissed groups ("not duplicates") — remembered in this browser ──────────
const DISMISSED_KEY = 'paperlessCleaner.dismissedDuplicateGroups';
function groupKey(group) {
  return group.documents.map(d => d.id).sort((a, b) => a - b).join('-');
}
function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); } catch (_) { return new Set(); }
}
function saveDismissed(set) {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set])); } catch (_) {}
}
let dismissed = loadDismissed();

function visibleGroups() {
  return groups.filter(g => !dismissed.has(groupKey(g)));
}

function renderDismissedNote() {
  const hiddenCount = groups.length - visibleGroups().length;
  dismissedNote.hidden = hiddenCount === 0;
  dismissedNote.textContent = '';
  if (!hiddenCount) return;
  dismissedNote.textContent = `${hiddenCount} group(s) hidden because you marked them "not duplicates". `;
  const btn = document.createElement('button');
  btn.className = 'chip-clear-all';
  btn.textContent = 'Show them again';
  btn.addEventListener('click', () => {
    for (const g of groups) dismissed.delete(groupKey(g));
    saveDismissed(dismissed);
    rerenderAll();
  });
  dismissedNote.appendChild(btn);
}

function rerenderAll() {
  groupsContainer.innerHTML = '';
  groups.forEach((g, i) => renderGroup(g, i));
  resultsSection.style.display = visibleGroups().length ? '' : 'none';
  renderDismissedNote();
}

function summaryText(prefix) {
  const shown = visibleGroups();
  if (!shown.length) return `${prefix}no potential duplicates found.`;
  const high     = shown.filter(g => g.confidence === 'high').length;
  const medium   = shown.filter(g => g.confidence === 'medium').length;
  const possible = shown.filter(g => g.confidence === 'possible').length;
  return `${prefix}${shown.length} group${shown.length !== 1 ? 's' : ''}: ` +
    [high && `${high} high confidence`, medium && `${medium} medium`, possible && `${possible} possible`]
      .filter(Boolean).join(', ') + '.';
}

// ── Init ──────────────────────────────────────────────────────────────────────
fetch('/api/settings')
  .then(r => r.json())
  .then(s => { paperlessBaseUrl = (s.paperless_base_url || '').replace(/\/$/, ''); })
  .catch(() => {});

// Show the previous scan right away so a visit does not force a rescan
fetch('/api/duplicates/last')
  .then(r => (r.ok ? r.json() : null))
  .then(last => {
    if (!last || activeEventSource) return;
    groups = last.results || [];
    rerenderAll();
    const when = new Date(last.finished_at * 1000).toLocaleString();
    scanSummary.style.display = '';
    scanSummary.textContent = summaryText(`Last scan (${when}): `);
    scanBtn.textContent = 'Scan again';
  })
  .catch(() => {});

// ── Scan ──────────────────────────────────────────────────────────────────────
scanBtn.addEventListener('click', runScan);
cancelScanBtn.addEventListener('click', () => {
  // Closing the stream makes the server stop the scan
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
  finishScanUi();
  progressSection.style.display = 'none';
  scanSummary.style.display = '';
  scanSummary.textContent = summaryText('Scan cancelled — partial results: ');
});

function finishScanUi() {
  scanBtn.disabled = false;
  scanBtn.textContent = 'Scan again';
  cancelScanBtn.hidden = true;
}

function runScan() {
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }

  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning…';
  scanSummary.style.display = 'none';
  resultsSection.style.display = 'none';
  emptyState.style.display = 'none';
  groupsContainer.innerHTML = '';
  groups = [];
  renderDismissedNote();
  cancelScanBtn.hidden = false;

  progressSection.style.display = '';
  setProgress(0, 'Connecting…', '');

  const es = new EventSource('/api/duplicates/scan');
  activeEventSource = es;

  es.addEventListener('progress', e => {
    const d = JSON.parse(e.data);
    // Phases 1–2 are quick (0–20%); phase 3 tracks the LLM group count (20–100%)
    let pct = d.phase === 1 ? 5 : d.phase === 2 ? 15 : 20;
    if (d.phase === 3 && d.total) pct = 20 + Math.round(80 * d.current / d.total);
    const label = { 1: 'Step 1 of 3 — reading documents', 2: 'Step 2 of 3 — comparing text', 3: 'Step 3 of 3 — LLM check' }[d.phase] || d.phase_label;
    setProgress(pct, label, d.detail);
  });

  es.addEventListener('result', e => {
    const group = JSON.parse(e.data);
    groups.push(group);
    renderGroup(group, groups.length - 1);
    if (visibleGroups().length) resultsSection.style.display = '';
    renderDismissedNote();
    scanSummary.style.display = '';
    scanSummary.textContent = summaryText('So far: ');
  });

  es.addEventListener('done', e => {
    const d = JSON.parse(e.data);
    setProgress(100, 'Complete', '');
    setTimeout(() => { progressSection.style.display = 'none'; }, 800);

    finishScanUi();
    activeEventSource = null;
    es.close();

    if (!visibleGroups().length) emptyState.style.display = '';
    scanSummary.style.display = '';
    scanSummary.textContent = summaryText('Scan complete: ');
  });

  es.addEventListener('error', e => {
    let msg = 'Scan failed.';
    try { msg = JSON.parse(e.data).message; } catch (_) {}
    setProgress(0, 'Scan failed', msg);
    finishScanUi();
    activeEventSource = null;
    es.close();
  });

  // SSE network error (no data event)
  es.onerror = () => {
    // Never let EventSource auto-reconnect: that would silently start a second full scan
    if (activeEventSource !== es) return;
    es.close();
    activeEventSource = null;
    finishScanUi();
    setProgress(0, 'Scan interrupted', 'The connection to the server was lost. Results so far are kept.');
  };
}

function setProgress(pct, phase, detail) {
  progressFill.style.width = pct + '%';
  progressTrack.setAttribute('aria-valuenow', String(pct));
  progressPhase.textContent = phase;
  progressLabel.textContent = detail;
}

// ── Render a single group card (streamed in as results arrive) ────────────────
const CONF_LABEL = { high: 'High confidence', medium: 'Medium confidence', possible: 'Possible' };
const CONF_CLASS = { high: 'conf-high', medium: 'conf-medium', possible: 'conf-possible' };

const VERDICT_LABEL = {
  duplicate:     { text: 'LLM: likely duplicate',           cls: 'verdict-identical' },
  same_template: { text: 'LLM: same template, diff. recipient', cls: 'verdict-template' },
  different:     { text: 'LLM: different documents',        cls: 'verdict-different' },
  unknown:       { text: 'LLM: inconclusive',               cls: 'verdict-unknown' },
};

function renderGroup(group, idx) {
  const card = document.createElement('div');
  card.className = 'dup-card';
  card.dataset.idx = idx;
  if (dismissed.has(groupKey(group))) card.classList.add('is-dismissed');

  // ── Header ─────────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'dup-card-header';

  const confBadge = `<span class="dup-conf-badge ${CONF_CLASS[group.confidence] || 'conf-possible'}">${esc(CONF_LABEL[group.confidence] || group.confidence)}</span>`;
  const reasonSpan = `<span class="dup-reason">${esc(group.reason)}</span>`;

  // LLM verdict badge (only if LLM ran)
  let llmBadge = '';
  if (group.llm_verdict && group.llm_verdict !== '') {
    const v = VERDICT_LABEL[group.llm_verdict] || { text: group.llm_verdict, cls: 'verdict-unknown' };
    llmBadge = `<span class="dup-verdict-badge ${v.cls}" title="${esc(group.llm_reasoning || '')}">${esc(v.text)}</span>`;
  }

  // Pairwise similarity badges
  let simBadges = '';
  for (const pair of (group.pairs || [])) {
    const pct = Math.round(pair.similarity * 100);
    const cls = pair.similarity >= 0.85 ? 'sim-high' : pair.similarity >= 0.35 ? 'sim-medium' : 'sim-low';
    simBadges += `<span class="dup-sim-badge ${cls}" title="Content similarity">${pct}% similar</span>`;
  }

  header.innerHTML = `
    ${confBadge}
    ${reasonSpan}
    <div class="dup-header-badges">${llmBadge}${simBadges}</div>
    <div class="dup-card-actions">
      <button class="btn-compare" data-idx="${idx}">Compare side by side</button>
      <button class="btn-secondary btn-dismiss" title="Hide this group now and in future scans (remembered in this browser)">Not duplicates</button>
    </div>
  `;
  card.appendChild(header);

  // ── Document table ─────────────────────────────────────────────────────────
  const table = document.createElement('table');
  table.className = 'dup-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th></th>
        <th>Title</th>
        <th>Date</th>
        <th>Correspondent</th>
        <th>Type</th>
        <th>Tags</th>
        <th title="Heuristic title quality (0–100)">Quality</th>
        <th title="Metadata completeness (0–100)">Complete</th>
        <th title="OCR content length — proxy for scan quality">Content</th>
        <th></th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');
  for (const doc of group.documents) {
    const tr = document.createElement('tr');
    if (doc.is_best) tr.classList.add('dup-best-row');
    const tagsHtml = (doc.tags || []).map(t => `<span class="tag-badge">${esc(t)}</span>`).join('');
    const bestBadge = doc.is_best
      ? '<span class="dup-best-badge" title="Most text and most complete metadata — the copy to keep">★ Keep this one</span>'
      : '';
    const plLink = paperlessBaseUrl
      ? `<a href="${esc(paperlessBaseUrl)}/documents/${doc.id}/details" target="_blank" rel="noopener" class="dup-open-link">Open in Paperless ↗</a>`
      : '';
    const contentLen = doc.content_len > 0
      ? (doc.content_len >= 1000 ? Math.round(doc.content_len / 1000) + 'k' : doc.content_len)
      : '—';
    tr.innerHTML = `
      <td>${bestBadge}</td>
      <td title="${esc(doc.title)}">${esc(doc.title)}</td>
      <td>${esc(doc.date || '—')}</td>
      <td>${esc(doc.correspondent || '—')}</td>
      <td>${esc(doc.document_type || '—')}</td>
      <td class="dup-tags-cell">${tagsHtml || '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${esc(doc.heuristic_quality)}</td>
      <td>${esc(doc.completeness)}</td>
      <td>${esc(contentLen)}</td>
      <td>${plLink}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);

  // ── Content snippets (collapsed) ───────────────────────────────────────────
  if (group.snippets && Object.keys(group.snippets).length) {
    const details = document.createElement('details');
    details.className = 'dup-content-area';
    const summary = document.createElement('summary');
    summary.textContent = 'Content snippets';
    details.appendChild(summary);

    const snippetGrid = document.createElement('div');
    snippetGrid.className = 'dup-snippet-grid';
    for (const doc of group.documents) {
      const snippet = group.snippets[doc.id] || '';
      const col = document.createElement('div');
      col.className = 'dup-snippet-col';
      col.innerHTML = `
        <div class="dup-snippet-title">${esc(doc.title)}</div>
        <pre class="dup-snippet-text">${esc(snippet || '(no content)')}</pre>
      `;
      snippetGrid.appendChild(col);
    }
    details.appendChild(snippetGrid);
    card.appendChild(details);
  }

  const hint = document.createElement('div');
  hint.className = 'dup-keep-hint';
  hint.textContent = 'If these are duplicates: open the copy you do not want in Paperless and delete it there. This tool never deletes anything.';
  card.appendChild(hint);

  groupsContainer.appendChild(card);

  // Wire preview + dismiss buttons
  header.querySelector('.btn-compare').addEventListener('click', () => openPreview(idx));
  header.querySelector('.btn-dismiss').addEventListener('click', () => {
    dismissed.add(groupKey(group));
    saveDismissed(dismissed);
    card.classList.add('is-dismissed');
    if (!visibleGroups().length) resultsSection.style.display = 'none';
    renderDismissedNote();
  });
}

// ── Side-by-side preview ──────────────────────────────────────────────────────
function openPreview(idx) {
  openGroupIdx = idx;
  const group = groups[idx];
  previewTitle.textContent = `Compare — ${group.reason}`;
  previewPanes.innerHTML = '';

  for (const doc of group.documents) {
    const pane = document.createElement('div');
    pane.className = 'dup-preview-pane';

    const meta = document.createElement('div');
    meta.className = 'dup-preview-meta';
    const bestBadge = doc.is_best ? '<span class="dup-best-badge">★ Keep this one</span> ' : '';
    const plHref = paperlessBaseUrl ? `${paperlessBaseUrl}/documents/${doc.id}/details` : '#';
    meta.innerHTML = `
      <div class="dup-preview-meta-title">${bestBadge}${esc(doc.title)}</div>
      <div class="dup-preview-meta-sub">${esc(doc.date || '—')} · ${esc(doc.correspondent || '—')} · ${esc(doc.document_type || '—')}</div>
      <div><a href="${esc(plHref)}" target="_blank" rel="noopener" class="dup-open-link">Open in Paperless ↗</a></div>
    `;
    pane.appendChild(meta);

    const embed = document.createElement('embed');
    embed.className = 'dup-preview-embed';
    embed.type = 'application/pdf';
    pane.appendChild(embed);

    previewPanes.appendChild(pane);

    fetch(`/api/documents/${doc.id}/preview`)
      .then(r => r.blob())
      .then(blob => {
        const url = URL.createObjectURL(blob);
        embed.dataset.blobUrl = url;
        embed.src = url;
      })
      .catch(() => {});
  }

  previewBackdrop.style.display = '';
  previewModal.style.display = '';
  previewModal.focus();
  document.body.classList.add('pane-open');
}

function closePreview() {
  previewModal.style.display = 'none';
  previewBackdrop.style.display = 'none';
  document.body.classList.remove('pane-open');
  openGroupIdx = null;
  previewPanes.querySelectorAll('embed').forEach(e => {
    if (e.dataset.blobUrl) URL.revokeObjectURL(e.dataset.blobUrl);
  });
  previewPanes.innerHTML = '';
}

closePreviewBtn.addEventListener('click', closePreview);
previewBackdrop.addEventListener('click', closePreview);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && previewModal.style.display !== 'none') closePreview();
});
