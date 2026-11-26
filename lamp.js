/* Boekscanner — lampmodus.
   De telefoon hangt boven het boek en is alleen camera. Hij opent de camera
   in de hoogste resolutie die Safari toestaat (4K), houdt het scherm wakker
   en neemt vanzelf een foto zodra het beeld na het omslaan stil is.
   Opnames blijven lokaal (IndexedDB) en kunnen gedeeld worden (AirDrop).
   Los van app.js gehouden, zodat de koppeling met de computer (fase 2)
   hier later op kan aansluiten. */

const $ = (s) => document.querySelector(s);

/* ---------- Instellingen ---------- */

const SAMPLE_MS = 100;        // hoe vaak het voorbeeldbeeld wordt vergeleken
const THUMB_W = 192;          // breedte van het vergelijkingsbeeld in pixels
const STILL_MS = 800;         // zo lang moet het beeld stil zijn voor een opname
const MIN_MOVE = 4;           // gemiddeld grijsverschil (0–255) dat als beweging telt
const MIN_STILL = 1.2;        // ondergrens voor "stil", ook bij een heel rustig beeld
const MIN_CHANGE = 2.5;       // verschil met de vorige opname dat als nieuwe pagina telt
const JPEG_QUALITY = 0.92;

/* ---------- Opslag ---------- */

const store = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('boekscanner-lamp', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('shots', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('shots', mode);
      const r = fn(t.objectStore('shots'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.run('readonly', s => s.getAll()); },
  count() { return this.run('readonly', s => s.count()); },
  put(v) { return this.run('readwrite', s => s.put(v)); },
  del(id) { return this.run('readwrite', s => s.delete(id)); },
  clear() { return this.run('readwrite', s => s.clear()); },
};

/* ---------- Beeldvergelijking ---------- */

/** Grijswaarden van een verkleind beeld. */
function grab(video, canvas) {
  const w = THUMB_W;
  const h = Math.max(1, Math.round(w * video.videoHeight / video.videoWidth));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
  return g;
}

/** Gemiddeld absoluut verschil tussen twee grijsbeelden (0–255). */
function diff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Beslist wanneer er automatisch wordt opgenomen.
 * Eerst moet er beweging zijn geweest (omslaan), dan moet het beeld
 * STILL_MS stil zijn, en het moet duidelijk anders zijn dan de vorige opname.
 * Een stilliggende hand op de rand van het boek mag; die beweegt niet.
 */
function createTrigger() {
  let prev = null, noise = 1, stillSince = 0, armed = true, last = null;
  return {
    get noise() { return noise; },
    reset() { armed = true; stillSince = 0; },
    taken(thumb) { last = thumb; armed = false; },
    step(thumb, now) {
      const d = diff(thumb, prev);
      prev = thumb;
      const stillT = Math.max(MIN_STILL, noise * 1.8);
      const moveT = Math.max(MIN_MOVE, noise * 4);
      let state;
      if (d === Infinity || d > moveT) { state = 'move'; stillSince = 0; armed = true; }
      else if (d < stillT) {
        state = 'still';
        noise = noise * 0.95 + d * 0.05;
        if (!stillSince) stillSince = now;
      } else { state = 'unsure'; stillSince = 0; }
      const change = diff(thumb, last);
      const ready = state === 'still' && armed && now - stillSince >= STILL_MS;
      if (ready && change < MIN_CHANGE) armed = false;   // stilgehouden zonder om te slaan
      return { state, d, change, fire: ready && change >= MIN_CHANGE };
    },
  };
}

/* ---------- Camera ---------- */

const video = $('#video');
const thumbCanvas = document.createElement('canvas');
const trigger = createTrigger();
let stream = null, timer = null, wakeLock = null, audio = null, auto = true, busy = false;

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => showStopped(true));
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise(r => video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true }));
  const w = video.videoWidth, h = video.videoHeight;
  const big = Math.max(w, h);
  $('#res').textContent = `${w}×${h}`;
  $('#res').className = 'pill ' + (big >= 3840 ? 'still' : big >= 1920 ? 'move' : 'warn');
  $('#res').title = big >= 3840 ? '4K' : 'Lager dan 4K: de tekst wordt minder scherp';
  trigger.reset();
  timer = setInterval(tick, SAMPLE_MS);
  showStopped(false);
  await keepAwake();
}

function stopCamera() {
  clearInterval(timer); timer = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

function showStopped(on) { $('#stopped').hidden = !on; }

async function keepAwake() {
  const pill = $('#wake');
  if (!('wakeLock' in navigator)) { pill.textContent = 'zet automatisch slot uit'; pill.className = 'pill warn'; return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    pill.textContent = 'scherm blijft aan'; pill.className = 'pill still';
    wakeLock.addEventListener('release', () => { pill.textContent = 'scherm kan uitgaan'; pill.className = 'pill warn'; });
  } catch {
    pill.textContent = 'zet automatisch slot uit'; pill.className = 'pill warn';
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || $('#cam').hidden) return;
  await keepAwake();
  const live = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
  if (!live) showStopped(true);
});

const LABEL = { move: 'beweging', still: 'stil', unsure: 'bijna stil' };

function tick() {
  if (!video.videoWidth || busy) return;
  const thumb = grab(video, thumbCanvas);
  const r = trigger.step(thumb, performance.now());
  const el = $('#state');
  el.textContent = auto ? LABEL[r.state] : `${LABEL[r.state]} · auto uit`;
  el.className = 'pill ' + (r.state === 'still' ? 'still' : 'move');
  if (auto && r.fire) capture(thumb);
}

async function capture(thumb = null) {
  if (busy || !video.videoWidth) return;
  busy = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    const image = await new Promise(r => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
    const tw = 320, th = Math.round(tw * h / w);
    const t = document.createElement('canvas');
    t.width = tw; t.height = th;
    t.getContext('2d').drawImage(c, 0, 0, tw, th);
    const preview = await new Promise(r => t.toBlob(r, 'image/jpeg', 0.7));
    const n = (await store.count()) + 1;
    await store.put({ id: Date.now(), n, width: w, height: h, image, preview, createdAt: new Date().toISOString() });
    trigger.taken(thumb || grab(video, thumbCanvas));
    feedback();
    await updateCount();
  } catch (err) {
    console.error(err);
    $('#state').textContent = 'opname mislukt'; $('#state').className = 'pill warn';
  } finally {
    busy = false;
  }
}

function feedback() {
  const f = $('#flash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 1320;
  g.gain.setValueAtTime(0.25, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15);
  o.connect(g).connect(audio.destination);
  o.start(); o.stop(audio.currentTime + 0.16);
}

async function updateCount() {
  const n = await store.count();
  $('#count').textContent = `${n} ${n === 1 ? 'opname' : 'opnames'}`;
  $('#count0').textContent = n;
  return n;
}

/* ---------- Opnames ---------- */

let prepared = [];
const urls = [];

async function showShots() {
  stopCamera();
  show('shots');
  urls.splice(0).forEach(u => URL.revokeObjectURL(u));
  const shots = (await store.all()).sort((a, b) => a.id - b.id);
  prepared = shots.map((s, i) => new File([s.image], `opname-${String(i + 1).padStart(3, '0')}.jpg`, { type: 'image/jpeg' }));
  const grid = $('#grid');
  grid.innerHTML = shots.length ? '' : '<p class="muted">Nog geen opnames.</p>';
  shots.forEach((s, i) => {
    const u = URL.createObjectURL(s.preview || s.image); urls.push(u);
    const d = document.createElement('div');
    d.className = 'shot';
    d.innerHTML = `<img alt="Opname ${i + 1}" src="${u}"><span>${i + 1} · ${s.width}×${s.height}</span><button>Wis</button>`;
    d.querySelector('button').addEventListener('click', async () => { await store.del(s.id); showShots(); });
    grid.appendChild(d);
  });
  $('#share').disabled = !shots.length;
  $('#clear').disabled = !shots.length;
  await updateCount();
}

$('#share').addEventListener('click', async () => {
  const files = prepared;
  if (!files.length) return;
  // Direct vanuit de tik delen: iOS staat delen alleen toe binnen een gebruikersgebaar.
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: 'Boekscanner opnames' }); } catch {}
    return;
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
});

$('#clear').addEventListener('click', async () => {
  if (!confirm('Alle opnames wissen?')) return;
  await store.clear();
  showShots();
});

/* ---------- Schermen ---------- */

function show(name) {
  for (const id of ['start', 'cam', 'shots']) $('#' + id).hidden = id !== name;
}

async function goCamera() {
  show('cam');
  try {
    await startCamera();
  } catch (err) {
    show('start');
    const e = $('#start-err');
    e.hidden = false;
    e.textContent = err && err.name === 'NotAllowedError'
      ? 'Geen toegang tot de camera. Sta cameratoegang toe voor deze website in Safari (aA › Website-instellingen).'
      : `De camera kon niet starten: ${err && err.message || err}`;
  }
}

$('#go').addEventListener('click', () => {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
  goCamera();
});
$('#open-shots').addEventListener('click', showShots);
$('#to-shots').addEventListener('click', showShots);
$('#back-cam').addEventListener('click', goCamera);
$('#restart').addEventListener('click', goCamera);
$('#shoot').addEventListener('click', () => capture());
$('#auto').addEventListener('click', () => {
  auto = !auto;
  trigger.reset();
  const b = $('#auto');
  b.classList.toggle('on', auto);
  b.setAttribute('aria-pressed', String(auto));
  b.textContent = auto ? 'Auto aan' : 'Auto uit';
});
document.addEventListener('keydown', (e) => {
  if ($('#cam').hidden) return;
  if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); capture(); }
});

updateCount();

// Voor tests.
window.__lamp = { createTrigger, diff, store };
