/* Beelden in de app: een rij miniaturen onder de tekst, en een scherm om de kaders zelf aan te
   passen (verschuiven, groter of kleiner maken, toevoegen of weghalen). */

import { figureRefs, removeFigureRef, insertFigureRef } from './figures.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Miniaturen van de beelden die in de tekst staan, in de volgorde van de tekst. */
export function figureStrip(text, figures, urlOf, { page = 0, editable = true } = {}) {
  const refs = figureRefs(text);
  const shown = refs.map(r => (figures || []).find(f => f.n === r.n)).filter(f => f && f.blob);
  if (!shown.length && !editable) return '';
  return `
    <div class="fig-strip" data-page="${page}">
      ${shown.map(f => `
        <figure class="fig-thumb">
          <img src="${urlOf(f.blob)}" alt="${esc(f.caption || 'Afbeelding')}">
          <figcaption>${esc(f.caption || 'Afbeelding ' + f.n)}</figcaption>
          <button class="fig-del" data-act="fig-del" data-page="${page}" data-n="${f.n}" aria-label="Beeld weghalen">×</button>
        </figure>`).join('')}
      ${editable ? `<button class="chip fig-edit" data-act="fig-edit" data-page="${page}">${shown.length ? 'Kaders aanpassen' : 'Beeld toevoegen'}</button>` : ''}
    </div>`;
}

/** Knipt een stuk (kader 0–1) uit de rechtgezette pagina. */
export async function cropFromScan(scan, box) {
  const bmp = await createImageBitmap(scan);
  const [x0, y0, x1, y1] = box;
  const sx = Math.round(x0 * bmp.width), sy = Math.round(y0 * bmp.height);
  const w = Math.max(1, Math.round((x1 - x0) * bmp.width)), h = Math.max(1, Math.round((y1 - y0) * bmp.height));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
  bmp.close?.();
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
}

/**
 * Scherm om kaders aan te passen op de rechtgezette pagina.
 * boxes: [{ n, box: [x0, y0, x1, y1] }] (0–1). Geeft de nieuwe lijst terug (nieuwe kaders zonder n),
 * of null bij Annuleren.
 */
export function editFigures(scan, boxes) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(scan);
    let list = boxes.map(b => ({ n: b.n, box: [...b.box] }));
    let sel = -1;
    const wrap = document.createElement('div');
    wrap.className = 'fig-editor';
    wrap.innerHTML = `
      <header class="fig-editor-top">
        <button class="btn btn-quiet" data-a="cancel">Annuleren</button>
        <strong>Beelden</strong>
        <button class="btn btn-primary" data-a="ok">Klaar</button>
      </header>
      <p class="fig-editor-hint">Sleep over de pagina om een kader te tekenen. Versleep een kader of zijn hoekjes om het aan te passen. Tik op × om het weg te halen.</p>
      <div class="fig-editor-scroll"><div class="fig-editor-page"><img src="${url}" alt="Pagina" draggable="false"><div class="fig-layer"></div></div></div>`;
    document.body.appendChild(wrap);
    const layer = wrap.querySelector('.fig-layer');
    const pageEl = wrap.querySelector('.fig-editor-page');

    const draw = () => {
      layer.innerHTML = list.map((b, i) => {
        const [x0, y0, x1, y1] = b.box;
        return `<div class="fig-box${i === sel ? ' sel' : ''}" data-i="${i}" style="left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%">
          <span class="fig-h" data-h="nw"></span><span class="fig-h" data-h="ne"></span><span class="fig-h" data-h="sw"></span><span class="fig-h" data-h="se"></span>
          <button class="fig-x" data-x="${i}" aria-label="Kader weghalen">×</button>
        </div>`;
      }).join('');
    };
    draw();

    const pos = (e) => {
      const r = pageEl.getBoundingClientRect();
      return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
    };
    let drag = null;
    pageEl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fig-x')) return;
      const p = pos(e);
      const boxEl = e.target.closest('.fig-box');
      const h = e.target.dataset.h;
      if (boxEl) {
        sel = +boxEl.dataset.i;
        drag = { mode: h || 'move', i: sel, start: p, orig: [...list[sel].box] };
      } else {
        list.push({ n: null, box: [p[0], p[1], p[0], p[1]] });
        sel = list.length - 1;
        drag = { mode: 'new', i: sel, start: p };
      }
      pageEl.setPointerCapture(e.pointerId);
      e.preventDefault();
      draw();
    });
    pageEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = pos(e), b = list[drag.i].box;
      const [sx, sy] = drag.start, o = drag.orig;
      if (drag.mode === 'new') list[drag.i].box = [Math.min(sx, x), Math.min(sy, y), Math.max(sx, x), Math.max(sy, y)];
      else if (drag.mode === 'move') {
        const dx = Math.min(1 - o[2], Math.max(-o[0], x - sx)), dy = Math.min(1 - o[3], Math.max(-o[1], y - sy));
        list[drag.i].box = [o[0] + dx, o[1] + dy, o[2] + dx, o[3] + dy];
      } else {
        if (drag.mode.includes('w')) b[0] = Math.min(x, b[2] - 0.02);
        if (drag.mode.includes('e')) b[2] = Math.max(x, b[0] + 0.02);
        if (drag.mode.includes('n')) b[1] = Math.min(y, b[3] - 0.02);
        if (drag.mode.includes('s')) b[3] = Math.max(y, b[1] + 0.02);
      }
      draw();
    });
    const up = () => {
      if (!drag) return;
      const b = list[drag.i].box;
      // Een tik zonder slepen maakt geen piepklein kader.
      if (drag.mode === 'new' && (b[2] - b[0] < 0.03 || b[3] - b[1] < 0.02)) { list.splice(drag.i, 1); sel = -1; }
      drag = null;
      draw();
    };
    pageEl.addEventListener('pointerup', up);
    pageEl.addEventListener('pointercancel', up);

    const close = (val) => { wrap.remove(); URL.revokeObjectURL(url); resolve(val); };
    wrap.addEventListener('click', (e) => {
      const x = e.target.closest('[data-x]');
      if (x) { list.splice(+x.dataset.x, 1); sel = -1; draw(); return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'cancel') close(null);
      if (a === 'ok') close(list);
    });
  });
}

/** Past de tekst en de beelden van een pagina aan na het aanpassen van de kaders, zonder opnieuw
    te herkennen: weggehaalde beelden uit de tekst, verschoven kaders opnieuw uitknippen, nieuwe
    kaders als beeld in de tekst zetten (ongeveer op de hoogte waar ze op de pagina staan). */
export async function applyBoxes(text, figures, scan, list) {
  let figs = [...(figures || [])];
  for (const r of figureRefs(text)) if (!list.some(b => b.n === r.n)) text = removeFigureRef(text, r.n);
  let next = Math.max(0, ...figs.map(f => f.n));
  for (const b of list) {
    if (b.n != null) {
      const f = figs.find(x => x.n === b.n);
      if (f && f.box.join() !== b.box.join()) {
        const blob = await cropFromScan(scan, b.box);
        figs = figs.map(x => (x.n === b.n ? { ...x, box: b.box, blob } : x));
      }
      continue;
    }
    const n = ++next;
    figs.push({ n, caption: '', box: b.box, blob: await cropFromScan(scan, b.box) });
    text = insertFigureRef(text, n, (b.box[1] + b.box[3]) / 2);
  }
  return { text, figures: figs };
}

/** De beelden die nu in de tekst staan, als kaders voor het aanpasscherm. */
export const boxesInText = (text, figures) => figureRefs(text)
  .map(r => (figures || []).find(f => f.n === r.n)).filter(f => f && f.box).map(f => ({ n: f.n, box: f.box }));
