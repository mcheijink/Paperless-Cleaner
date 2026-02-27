const form = document.getElementById('settingsForm');
const statusLine = document.getElementById('status');

async function loadSettings() {
  const response = await fetch('/api/settings');
  const settings = await response.json();
  Object.entries(settings).forEach(([key, value]) => {
    if (form.elements[key]) {
      form.elements[key].value = value;
    }
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  statusLine.textContent = response.ok ? 'Settings saved.' : 'Could not save settings.';
});

loadSettings();
