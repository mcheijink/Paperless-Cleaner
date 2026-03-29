const form = document.getElementById('settingsForm');
const statusLine = document.getElementById('status');

const NUMERIC_FIELDS = ['ollama_temperature', 'confidence_discount', 'few_shot_min_documents'];

async function loadSettings() {
  const response = await fetch('/api/settings');
  if (!response.ok) {
    statusLine.textContent = 'Could not load settings.';
    return;
  }
  const settings = await response.json();
  Object.entries(settings).forEach(([key, value]) => {
    const el = form.elements[key];
    if (!el) return;
    if (el.tagName === 'SELECT') {
      el.value = value;
    } else {
      el.value = value ?? '';
    }
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(form).entries());

  // Cast numeric fields
  const payload = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NUMERIC_FIELDS.includes(key)) {
      payload[key] = Number(value);
    } else {
      payload[key] = value;
    }
  }

  // Token masking: if unchanged sentinel, send empty string so backend keeps existing
  // (backend treats "***" as "no change")

  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  statusLine.textContent = response.ok ? 'Settings saved.' : 'Could not save settings.';
});

loadSettings();
