/* Tekstherkenning in een eigen worker, zodat de app klikbaar blijft terwijl een foto wordt
   voorbewerkt en herkend. Tesseract draait hier weer in zijn eigen (geneste) worker. */

// tesseract.min.js verwacht `window` voor het oplossen van paden; in een worker is dat `self`.
self.window = self;

let lib = null;
const load = () => (lib ||= (async () => {
  await import('./vendor/tesseract/tesseract.min.js');
  const m = await import('./ocr.js');
  if (!self.Tesseract) throw new Error('Tesseract niet geladen');
  return m;
})());

self.onmessage = async (e) => {
  const { id, op, args } = e.data || {};
  const reply = (msg) => self.postMessage({ id, ...msg });
  try {
    const m = await load();
    if (op === 'ping') return reply({ ok: true, result: true });
    if (op === 'config') { Object.assign(m.ocrConfig, args[0]); return reply({ ok: true, result: true }); }
    if (op === 'resize') return reply({ ok: true, result: await m.resizeToBlob(...args) });
    if (op === 'prepare') return reply({ ok: true, result: await m.ocr.preparePages(...args) });
    if (op === 'recognize') {
      const [blob, lang, opts] = args;
      let last = 0;
      const res = await m.ocr.recognize(blob, lang, (p) => {
        // Niet elk procentje doorsturen.
        const pct = p.status === 'recognizing text' ? Math.round(p.progress * 100) : null;
        if (pct != null && pct === last) return;
        if (pct != null) last = pct;
        reply({ progress: { status: p.status, progress: p.progress } });
      }, opts || {});
      // Alleen wat de app gebruikt (geen canvassen of Tesseract-blokken terugsturen).
      return reply({ ok: true, result: {
        text: res.text, confidence: res.confidence, steps: res.steps, image: res.image, rotated: res.rotated,
        pages: (res.pages || []).map(p => ({ text: p.text, confidence: p.confidence, figures: p.figures || [], scan: p.scan || null })),
      } });
    }
    throw new Error('onbekende opdracht ' + op);
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) });
  }
};
