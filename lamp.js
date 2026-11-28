/* Boekscanner — camera op de lamp.
   De iPhone hangt boven het boek en is alleen camera voor de computer.
   Alles wordt op de computer bediend; hier staat alleen het camerabeeld
   met één statuslampje. De camera loopt in 4K, het scherm blijft aan,
   en zodra het beeld na het omslaan stil is wordt er vanzelf opgenomen.
   Elke opname gaat rechtstreeks naar de computer en wordt hier gewist
   zodra de computer hem heeft ontvangen. */

import { shots as store, join, toBuffer } from './koppel.js';

const $ = (s) => document.querySelector(s);

/* ---------- Instellingen ---------- */

const SAMPLE_MS = 100;        // hoe vaak het voorbeeldbeeld wordt vergeleken
const THUMB_W = 192;          // breedte van het vergelijkingsbeeld in pixels
const STILL_MS = 800;         // zo lang moet het beeld stil zijn voor een opname
const MIN_MOVE = 4;           // gemiddeld grijsverschil (0–255) dat als beweging telt
const MIN_STILL = 2;          // ondergrens voor "stil": een hand die de bladzijde vasthoudt trilt een beetje
const MIN_CHANGE = 2.5;       // verschil met de vorige opname dat als nieuwe pagina telt
const TURN_MOVE = 10;         // zoveel beweging is omslaan: dan altijd een nieuwe opname, ook als de pagina erg lijkt op de vorige
const JPEG_QUALITY = 0.92;
const PREVIEW_MS = 300;       // live beeld naar de computer, ongeveer 3 per seconde
const PREVIEW_W = 960;        // breedte van dat live beeld
const DIM_MS = 8000;          // na zoveel tijd zonder aanraken wordt het scherm donker (scheelt warmte en accu)

/* ---------- Koppelcode ---------- */

// Uit de QR-code op de computer; onthouden, zodat de pagina na herladen weer verbindt.
const fromHash = new URLSearchParams(location.hash.slice(1)).get('koppel');
if (fromHash) localStorage.setItem('boekscanner-koppel', fromHash);
const code = fromHash || localStorage.getItem('boekscanner-koppel');

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
  let prev = null, noise = 1, stillSince = 0, armed = true, last = null, peak = Infinity;
  return {
    get noise() { return noise; },
    reset() { armed = true; stillSince = 0; },
    taken(thumb) { last = thumb; armed = false; peak = 0; },
    step(thumb, now) {
      const d = diff(thumb, prev);
      prev = thumb;
      const stillT = Math.max(MIN_STILL, noise * 1.8);
      const moveT = Math.max(MIN_MOVE, noise * 4);
      let state;
      if (d === Infinity || d > moveT) { state = 'move'; stillSince = 0; armed = true; peak = Math.max(peak, d); }
      else if (d < stillT) {
        state = 'still';
        noise = noise * 0.95 + d * 0.05;
        if (!stillSince) stillSince = now;
      } else { state = 'unsure'; stillSince = 0; }
      const change = diff(thumb, last);
      const ready = state === 'still' && armed && now - stillSince >= STILL_MS;
      // Nieuwe pagina: duidelijk omgeslagen (veel beweging), of duidelijk ander beeld dan de vorige opname.
      // Pagina's met lopende tekst lijken in het kleine vergelijkingsbeeld erg op elkaar, dus alleen
      // het beeldverschil is niet genoeg.
      const fresh = change >= MIN_CHANGE || peak >= TURN_MOVE;
      const same = ready && !fresh;
      if (same) armed = false;   // stilgehouden zonder om te slaan
      return { state, d, change, same, fire: ready && fresh };
    },
  };
}

/* ---------- Camera ---------- */

const video = $('#video');
const thumbCanvas = document.createElement('canvas');
const trigger = createTrigger();
let stream = null, timer = null, previewTimer = null, wakeLock = null, audio = null;
let auto = false, busy = false, motion = 'still', camOk = false, resLabel = '';

async function startCamera() {
  stopCamera();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => setCam(false));
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise(r => video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true }));
  resLabel = `${video.videoWidth}×${video.videoHeight}`;
  trigger.reset();
  timer = setInterval(tick, SAMPLE_MS);
  startLink();
  setCam(true);
  await keepAwake();
}

function stopCamera() {
  clearInterval(timer); timer = null;
  clearInterval(previewTimer); previewTimer = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !camOk) return;
  await keepAwake();
  const live = stream && stream.getVideoTracks().some(t => t.readyState === 'live');
  if (!live) setCam(false);
});

function tick() {
  if (!video.videoWidth || busy) return;
  const thumb = grab(video, thumbCanvas);
  const r = trigger.step(thumb, performance.now());
  motion = r.same ? 'same' : r.state;
  status();
  if (auto && r.fire) capture(thumb);
}

/**
 * Scherpte van het beeld: gemiddelde sterkte van de fijne contrasten (Laplace) in twee stroken
 * op ware grootte, links en rechts van het midden (daar staat bij een open boek de tekst).
 * Alleen om beelden van hetzelfde boek met elkaar te vergelijken.
 */
const sharpCanvas = document.createElement('canvas');
function sharpness(src, w, h) {
  const cw = Math.min(480, Math.round(w / 5)), ch = Math.min(360, Math.round(h / 4));
  sharpCanvas.width = cw * 2; sharpCanvas.height = ch;
  const ctx = sharpCanvas.getContext('2d', { willReadFrequently: true });
  const y = Math.round(h * 0.55 - ch / 2);
  ctx.drawImage(src, Math.round(w * 0.3 - cw / 2), y, cw, ch, 0, 0, cw, ch);
  ctx.drawImage(src, Math.round(w * 0.7 - cw / 2), y, cw, ch, cw, 0, cw, ch);
  const px = ctx.getImageData(0, 0, cw * 2, ch).data, W = cw * 2;
  const g = new Float32Array(W * ch);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11;
  let s = 0, n = 0;
  for (let yy = 1; yy < ch - 1; yy++) for (let x = 1; x < W - 1; x++) {
    if (x === cw - 1 || x === cw) continue;
    const k = yy * W + x;
    s += Math.abs(4 * g[k] - g[k - 1] - g[k + 1] - g[k - W] - g[k + W]); n++;
  }
  return n ? s / n : 0;
}
const SHARP_TRIES = 4;        // zoveel beelden vlak na elkaar; de scherpste wordt de opname
const SHARP_GAP_MS = 120;     // tijd tussen die beelden (een trillende lamp komt in een paar tienden tot rust)

async function capture(thumb = null) {
  if (busy || !video.videoWidth) return;
  busy = true;
  try {
    const w = video.videoWidth, h = video.videoHeight;
    // Een paar beelden vlak na elkaar, en de scherpste houden: na omslaan of aantikken kan de lamp
    // nog nawiebelen, en een bewogen opname wordt slecht gelezen.
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    let best = -1, scores = [];
    for (let i = 0; i < SHARP_TRIES; i++) {
      if (i) await new Promise(r => setTimeout(r, SHARP_GAP_MS));
      const sc = sharpness(video, w, h);
      scores.push(Math.round(sc * 10) / 10);
      if (sc > best) { best = sc; c.getContext('2d').drawImage(video, 0, 0, w, h); }
    }
    console.debug('[lamp] scherpte', scores.join(' '), '→', Math.round(best * 10) / 10);
    const image = await new Promise(r => c.toBlob(r, 'image/jpeg', JPEG_QUALITY));
    await store.put({ id: Date.now(), width: w, height: h, image, createdAt: new Date().toISOString(), pending: true });
    trigger.taken(thumb || grab(video, thumbCanvas));
    feedback();
    flush();
  } catch (err) {
    console.error(err);
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

/* ---------- Status: één lampje ---------- */

function status() {
  const linked = !!(link && link.connected);
  const [cls, text] = !camOk ? ['bad', 'camera gestopt']
    : !linked ? ['wait', 'zoekt computer']
    : motion === 'move' || motion === 'unsure' ? ['wait', 'beweging']
    : ['ok', 'klaar'];
  const el = $('#status');
  if (el.dataset.cls !== cls || el.dataset.text !== text) {
    el.dataset.cls = cls; el.dataset.text = text;
    el.className = 'status ' + cls;
    $('#status-text').textContent = text;
  }
}

function setCam(on) {
  camOk = on;
  $('#tap').hidden = on;
  if (!on) $('#tap-text').textContent = 'De camera is gestopt. Tik om verder te gaan.';
  status();
}

/* Scherm donker als niemand kijkt; aantikken laat het beeld weer even zien. */
let dimTimer = null;
function wake() {
  $('#dim').classList.remove('on');
  clearTimeout(dimTimer);
  dimTimer = setTimeout(() => { if (link && link.connected) $('#dim').classList.add('on'); else wake(); }, DIM_MS);
}

/* ---------- Koppeling met de computer ---------- */

let link = null, sending = false;
const sent = new Set();

function startLink() {
  if (!link) {
    link = join(code, {
      open() {
        sent.clear();
        link.send({ t: 'hello', w: video.videoWidth, h: video.videoHeight, auto });
        flush();
        status();
      },
      close() { status(); wake(); },
      message(m) {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'capture') capture();
        else if (m.t === 'auto') { auto = !!m.on; trigger.reset(); }
        else if (m.t === 'ack') store.del(m.id);
      },
    });
  }
  clearInterval(previewTimer);
  previewTimer = setInterval(sendPreview, PREVIEW_MS);
}

/** Klein beeld voor het live beeld op de computer. */
const previewCanvas = document.createElement('canvas');
let previewBusy = false;
const STATE_TEXT = { move: 'beweging', unsure: 'bijna stil', still: 'stil', same: 'stil · zelfde pagina' };
async function sendPreview() {
  if (!link || !link.connected || previewBusy || !video.videoWidth || link.buffered > 512 * 1024) return;
  previewBusy = true;
  try {
    const w = PREVIEW_W, h = Math.round(w * video.videoHeight / video.videoWidth);
    if (previewCanvas.width !== w || previewCanvas.height !== h) { previewCanvas.width = w; previewCanvas.height = h; }
    previewCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const b = await new Promise(r => previewCanvas.toBlob(r, 'image/jpeg', 0.6));
    link.send({ t: 'preview', img: await toBuffer(b), state: STATE_TEXT[motion] || '', auto, w: video.videoWidth, h: video.videoHeight });
  } finally { previewBusy = false; }
}

/** Alle opnames die de computer nog niet heeft bevestigd, (opnieuw) versturen. */
async function flush() {
  if (!link || !link.connected || sending) return;
  sending = true;
  try {
    for (;;) {
      const todo = (await store.all()).filter(s => s.pending && !sent.has(s.id)).sort((a, b) => a.id - b.id);
      if (!todo.length || !link.connected) break;
      for (const s of todo) {
        if (!link.connected) break;
        link.send({ t: 'shot', id: s.id, w: s.width, h: s.height, img: await toBuffer(s.image), createdAt: s.createdAt });
        sent.add(s.id);
      }
    }
  } finally { sending = false; }
}

/* ---------- Start ---------- */

async function go() {
  // Eén tik is nodig: iOS geeft het geluid (piep) en soms de camera pas vrij na aanraken.
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
  try {
    await startCamera();
    wake();
  } catch (err) {
    $('#tap').hidden = false;
    $('#tap-text').textContent = err && err.name === 'NotAllowedError'
      ? 'Geen toegang tot de camera. Sta het toe via aA › Website-instellingen in Safari, en tik dan opnieuw.'
      : `De camera kon niet starten (${err && err.message || err}). Tik om het opnieuw te proberen.`;
  }
}

if (!code) {
  $('#tap').hidden = true;
  $('#nocode').hidden = false;
} else {
  $('#tap').addEventListener('click', go);
  document.addEventListener('pointerdown', () => { if (camOk) wake(); });
}

// Voor tests.
window.__lamp = { createTrigger, diff, store, sharpness };
