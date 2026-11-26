if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

const STORAGE_KEY = 'espresso_shots_v1';
const HOST_KEY = 'espresso_esp_host';

const espHostInput = document.getElementById('espHost');
espHostInput.value = localStorage.getItem(HOST_KEY) || '';
espHostInput.addEventListener('change', () => {
  localStorage.setItem(HOST_KEY, espHostInput.value.trim().replace(/\/$/, ''));
});

function getShots() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveShots(shots) {
  shots.sort((a, b) => new Date(a.date) - new Date(b.date));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shots));
  render();
}

function parseJsonl(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toJsonl(shots) {
  return shots
    .map(({ synced, ...clean }) => JSON.stringify(clean))
    .join('\n') + '\n';
}

// Add new shot
document.getElementById('saveBtn').addEventListener('click', async () => {
  const shot = {
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    grind: parseFloat(document.getElementById('grind').value),
    weight: parseFloat(document.getElementById('weight').value),
    out: parseFloat(document.getElementById('out').value),
    time: parseInt(document.getElementById('time').value, 10),
    pressure: parseFloat(document.getElementById('pressure').value),
    bean_id: parseInt(document.getElementById('bean_id').value, 10),
    synced: false
  };

  const shots = getShots();
  shots.push(shot);
  saveShots(shots);
  await syncWithEsp32();
});

// Sync with ESP32 (Push unsynced shots, then pull latest shots.jsonl)
async function syncWithEsp32() {
  const host = espHostInput.value.trim().replace(/\/$/, '');
  const statusEl = document.getElementById('status');
  if (!host) {
    statusEl.textContent = 'Offline Mode';
    return;
  }

  statusEl.textContent = 'Syncing...';
  let shots = getShots();

  try {
    // 1. Push any local unsynced shots to ESP32
    for (const shot of shots) {
      if (shot.synced === false) {
        const { synced, ...payload } = shot;
        const res = await fetch(`${host}/api/shots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) shot.synced = true;
      }
    }

    // 2. Pull full shots.jsonl from ESP32 and merge by date
    const res = await fetch(`${host}/api/shots`);
    if (res.ok) {
      const text = await res.text();
      const remoteShots = parseJsonl(text).map((s) => ({ ...s, synced: true }));
      const map = new Map();
      [...shots, ...remoteShots].forEach((s) => map.set(s.date, s));
      shots = Array.from(map.values());
    }

    saveShots(shots);
    statusEl.textContent = 'Synced ✓';
  } catch (err) {
    saveShots(shots);
    statusEl.textContent = 'ESP32 Unreachable';
  }
}

document.getElementById('syncBtn').addEventListener('click', syncWithEsp32);

// Export to .jsonl file
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([toJsonl(getShots())], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shots.jsonl';
  a.click();
});

// Import from .jsonl file
const fileInput = document.getElementById('fileInput');
document.getElementById('importBtn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const imported = parseJsonl(reader.result).map((s) => ({ ...s, synced: false }));
    const map = new Map();
    [...getShots(), ...imported].forEach((s) => map.set(s.date, s));
    saveShots(Array.from(map.values()));
  };
  reader.readAsText(file);
});

// Draw lightweight chart on HTML5 Canvas
function drawChart(shots) {
  const canvas = document.getElementById('chart');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const recent = shots.slice(-15);
  if (recent.length < 2) {
    ctx.fillStyle = '#a8a29e';
    ctx.font = '13px sans-serif';
    ctx.fillText('Log or import at least 2 shots to see chart', 12, 90);
    return;
  }

  const pad = 20;
  const w = rect.width - pad * 2;
  const h = rect.height - pad * 2;

  const plotLine = (values, color) => {
    const min = Math.min(...values) * 0.9;
    const max = Math.max(...values) * 1.1 || 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad + (i / (values.length - 1)) * w;
      const y = pad + h - ((v - min) / (max - min)) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  // Orange = Yield Out (g), Blue = Time (s)
  plotLine(recent.map((s) => s.out), '#d97706');
  plotLine(recent.map((s) => s.time), '#38bdf8');
}

function render() {
  const shots = getShots();
  drawChart(shots);

  const tbody = document.getElementById('shotList');
  tbody.innerHTML = [...shots]
    .reverse()
    .map((s) => {
      const d = new Date(s.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const ratio = `1:${(s.out / s.weight).toFixed(1)}`;
      return `<tr>
        <td>${d} ${s.synced === false ? '<span class="unsynced">●</span>' : ''}</td>
        <td>${s.grind}</td>
        <td>${s.weight}g → ${s.out}g (${ratio})</td>
        <td>${s.time}s</td>
        <td>${s.pressure}</td>
        <td>${s.bean_id}</td>
      </tr>`;
    })
    .join('');
}

// Auto-load sample shots.jsonl on first visit if local storage is empty
(async function init() {
  if (getShots().length === 0) {
    try {
      const res = await fetch('./shots.jsonl');
      if (res.ok) {
        const sample = parseJsonl(await res.text()).map((s) => ({ ...s, synced: true }));
        saveShots(sample);
        return;
      }
    } catch {}
  }
  render();
})();
