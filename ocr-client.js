/* Wachtrij voor de tekstherkenning. Het echte werk gebeurt in ocr-worker.js, zodat de pagina
   niet vastloopt. Eén opdracht tegelijk (Tesseract kan er maar één aan); opdrachten met
   voorrang (de pagina die je nu nakijkt) gaan vóór het werk op de achtergrond.
   Lukt de worker niet (oude browser), dan draait alles gewoon op de pagina zelf. */

let worker = null, ready = null, seq = 0;
const pending = new Map();
let direct = null;   // terugval: ocr.js op de pagina zelf

function start() {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    try {
      worker = new Worker(new URL('ocr-worker.js', import.meta.url), { type: 'module' });
    } catch { return resolve(false); }
    const t = setTimeout(() => resolve(false), 20000);
    worker.onmessage = (e) => {
      const { id, ok, result, error, progress } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      if (progress) { p.onProgress?.(progress); return; }
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = (e) => { console.warn('[ocr] worker', e.message); clearTimeout(t); resolve(false); };
    call('ping').then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(false); });
  }).then((ok) => {
    if (!ok) { console.warn('[ocr] geen worker, herkenning op de pagina zelf'); worker?.terminate(); worker = null; }
    return ok;
  });
  return ready;
}

function call(op, args = [], onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, args });
  });
}

let configured = null;
async function run(op, args, onProgress) {
  if (op !== 'config') await (configured ||= run('config', [{ maxSide }]));
  if (await start()) return call(op, args, onProgress);
  direct ||= import('./ocr.js');
  const m = await direct;
  if (op === 'config') return Object.assign(m.ocrConfig, args[0]);
  if (op === 'resize') return m.resizeToBlob(...args);
  return m.ocr.recognize(args[0], args[1], onProgress, args[2] || {});
}

/* ---------- Wachtrij ---------- */

const queue = [];
let busy = false;

function pump() {
  if (busy || !queue.length) return;
  queue.sort((a, b) => b.prio - a.prio || a.n - b.n);
  const job = queue.shift();
  if (job.cancelled) return pump();
  busy = true;
  run(job.op, job.args, job.onProgress).then(job.resolve, job.reject).finally(() => { busy = false; pump(); });
}

let n = 0;
function enqueue(op, args, { priority = 0, onProgress } = {}) {
  let job;
  const p = new Promise((resolve, reject) => { job = { op, args, prio: priority, n: n++, onProgress, resolve, reject }; });
  queue.push(job);
  pump();
  p.cancel = () => { if (queue.includes(job)) { job.cancelled = true; job.reject(Object.assign(new Error('geannuleerd'), { cancelled: true })); } };
  return p;
}

let maxSide = 2200;

export const ocrQueue = {
  /** Grootste zijde waarmee een foto wordt herkend (op de computer hoger dan op de telefoon). */
  get maxSide() { return maxSide; },
  setMaxSide(n) { maxSide = n; configured = null; },
  /** Herkent een foto. priority > 0: vóór het achtergrondwerk. */
  recognize: (blob, lang, opts = {}) => enqueue('recognize', [blob, lang, opts.figures ? { figures: opts.figures } : {}], opts),
  /** Verkleinen/draaien zonder de pagina te belasten; gaat niet in de wachtrij. */
  resize: (blob, maxSide, quality, rotate) => run('resize', [blob, maxSide, quality, rotate]),
  warm: () => start(),
};
