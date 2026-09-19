const form = document.getElementById('settingsForm');
const statusLine = document.getElementById('status');
const ollamaFields = document.getElementById('ollamaFields');

const NUMERIC_FIELDS = ['ollama_temperature', 'confidence_discount', 'few_shot_min_documents'];

function setStatus(el, ok, message) {
  el.textContent = message;
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('fail', ok === false);
}

// Ollama fields only matter for the Ollama provider
function syncProviderFields() {
  const off = form.elements.suggestion_provider.value !== 'ollama';
  ollamaFields.classList.toggle('is-disabled', off);
  ollamaFields.querySelectorAll('input, button').forEach(el => {
    // readOnly (not disabled) so the values are still submitted and kept
    if (el.tagName === 'INPUT') el.readOnly = off; else el.disabled = off;
  });
}
form.elements.suggestion_provider.addEventListener('change', syncProviderFields);

async function loadSettings() {
  let response;
  try { response = await fetch('/api/settings'); } catch (_) { response = null; }
  if (!response || !response.ok) {
    setStatus(statusLine, false, 'Could not load settings.');
    return;
  }
  const settings = await response.json();
  Object.entries(settings).forEach(([key, value]) => {
    const el = form.elements[key];
    if (!el) return;
    el.value = value ?? '';
  });
  syncProviderFields();
}

function readPayload() {
  const raw = Object.fromEntries(new FormData(form).entries());
  const payload = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NUMERIC_FIELDS.includes(key)) {
      // An emptied number field must not silently become 0
      if (String(value).trim() === '' || Number.isNaN(Number(value))) {
        return { error: `Enter a number for "${form.elements[key].closest('label').firstChild.textContent.trim()}".`, field: form.elements[key] };
      }
      payload[key] = Number(value);
    } else {
      payload[key] = value;
    }
  }
  return { payload };
}

async function runTest(which, resultEl, button) {
  const { payload } = readPayload();
  const body = payload || Object.fromEntries(new FormData(form).entries());
  button.disabled = true;
  setStatus(resultEl, null, 'Testing…');
  try {
    const resp = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paperless_base_url: body.paperless_base_url,
        paperless_token: body.paperless_token,
        ollama_base_url: body.ollama_base_url,
        ollama_model: body.ollama_model,
      }),
    });
    const result = (await resp.json())[which];
    setStatus(resultEl, result.ok, (result.ok ? '✓ ' : '✕ ') + result.message);
  } catch (_) {
    setStatus(resultEl, false, '✕ Test could not be run.');
  } finally {
    button.disabled = false;
  }
}

const testPaperlessBtn = document.getElementById('testPaperlessBtn');
const testOllamaBtn = document.getElementById('testOllamaBtn');
testPaperlessBtn.addEventListener('click', () => runTest('paperless', document.getElementById('testPaperlessResult'), testPaperlessBtn));
testOllamaBtn.addEventListener('click', () => runTest('ollama', document.getElementById('testOllamaResult'), testOllamaBtn));

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { payload, error, field } = readPayload();
  if (error) {
    setStatus(statusLine, false, error);
    field.focus();
    return;
  }

  // Token masking: the backend treats "***" as "no change"
  setStatus(statusLine, null, 'Saving…');
  let response;
  try {
    response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) { response = null; }
  if (!response || !response.ok) {
    setStatus(statusLine, false, 'Could not save settings.');
    return;
  }
  const result = await response.json();
  if (result.paperless_ok) {
    setStatus(statusLine, true, '✓ Settings saved — Paperless connection works.');
  } else {
    setStatus(statusLine, false, `Settings saved, but Paperless could not be reached: ${result.paperless_error || 'unknown error'}`);
  }
});

loadSettings();
