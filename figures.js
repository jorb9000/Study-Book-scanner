/* Beelden op een pagina: foto's, grafieken en schema's vinden, in kleur uitknippen en met hun
   bijschrift op de juiste plek in de tekst zetten.

   Werkwijze: de pagina wordt in vakjes verdeeld. Een vakje telt als "beeld" als er inkt in staat
   (lijnen, staven, letters) of als het duidelijk donkerder is dan het papier (foto), en het niet
   bij een gewone tekstregel hoort. Aaneengesloten groepen van zulke vakjes die groot genoeg zijn,
   worden een beeld. Losse woordjes erin (aslabels, legenda) horen bij het beeld, niet bij de tekst. */

import { newCanvas } from './scan.js';

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };

/** Bijschrift onder (of boven) een beeld. */
export const CAPTION_RE = /^(Figuur|Fig\.|Afbeelding|Afb\.|Grafiek|Diagram|Schema|Tabel|Foto|Kaart|Illustratie|Bron|Figure|Table|Image|Source)\b/i;

/** Tekstregels uit de Tesseract-uitvoer (regels met minstens drie zekere woorden). */
function textLines(blocks) {
  const out = [];
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const ws = (l.words || []).filter(w => w.text && w.text.trim());
    let good = ws.filter(w => w.confidence >= 60 && /\p{L}{2}/u.test(w.text));
    // Een "woord" dat veel hoger is dan de rest is een stuk van een grafiek, geen letter.
    const mh = median(good.map(w => w.bbox.y1 - w.bbox.y0));
    good = good.filter(w => w.bbox.y1 - w.bbox.y0 <= mh * 1.6);
    if (good.length < 3) continue;
    const conf = good.reduce((s, w) => s + w.confidence, 0) / good.length;
    if (conf < 70) continue;
    // Woorden staan dicht bij elkaar in een gewone regel; labels op een as staan ver uit elkaar.
    const rh = median(good.map(w => w.bbox.y1 - w.bbox.y0));
    const span = good[good.length - 1].bbox.x1 - good[0].bbox.x0;
    const letters = good.reduce((s, w) => s + w.text.length, 0);
    if (span > letters * rh * 1.6) continue;
    out.push({ x0: Math.min(...good.map(w => w.bbox.x0)), x1: Math.max(...good.map(w => w.bbox.x1)),
      y0: Math.min(...good.map(w => w.bbox.y0)), y1: Math.max(...good.map(w => w.bbox.y1)), h: rh });
  }
  return out;
}

/**
 * Zoekt beelden op een voorbewerkte pagina.
 * gray: { g, W, H } (papier wit, inkt zwart, zoals Tesseract hem krijgt)
 * tone: (x, y) => helderheid 0–255 van de oorspronkelijke foto op dat punt van de pagina (of null)
 * blocks: Tesseract-blokken in dezelfde coördinaten
 * Geeft [{ x0, y0, x1, y1 }] terug (pixels van de pagina).
 */
export function detectFigures(gray, tone, blocks) {
  const { g, W, H } = gray;
  const lines = textLines(blocks);
  const lh = median(lines.map(l => l.h)) || H / 60;
  const s = Math.max(4, Math.round(Math.min(lh * 0.6, W / 120)));
  const gw = Math.ceil(W / s), gh = Math.ceil(H / s), N = gw * gh;

  // Inkt per vakje (uit het zwart-witbeeld).
  const ink = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] < 140) ink[((y / s) | 0) * gw + ((x / s) | 0)]++;
  for (let i = 0; i < N; i++) ink[i] /= s * s;

  // Toon per vakje uit de foto, vergeleken met het papier in de buurt (foto's, gekleurde vlakken).
  const dark = new Uint8Array(N);
  if (tone) {
    const t = new Float32Array(N);
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      let v = 0, n = 0;
      for (const fy of [0.25, 0.75]) for (const fx of [0.25, 0.75]) {
        const val = tone(Math.min(W - 1, (cx + fx) * s), Math.min(H - 1, (cy + fy) * s));
        if (val != null) { v += val; n++; }
      }
      t[cy * gw + cx] = n ? v / n : 255;
    }
    // Papier = lichtste waarde in een ruime buurt (licht van de lamp verloopt geleidelijk).
    const R = Math.max(3, Math.round(gw / 8));
    const paper = new Float32Array(N);
    const tmp = new Float32Array(N);
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      let m = 0; for (let d = -R; d <= R; d++) { const xx = cx + d; if (xx >= 0 && xx < gw) m = Math.max(m, t[cy * gw + xx]); }
      tmp[cy * gw + cx] = m;
    }
    for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
      let m = 0; for (let d = -R; d <= R; d++) { const yy = cy + d; if (yy >= 0 && yy < gh) m = Math.max(m, tmp[yy * gw + cx]); }
      paper[cy * gw + cx] = m;
    }
    for (let i = 0; i < N; i++) dark[i] = t[i] < paper[i] * 0.8 ? 1 : 0;
  }

  // Vakjes van gewone tekstregels.
  const text = new Uint8Array(N);
  for (const l of lines) {
    const pad = l.h * 0.35;
    const cx0 = Math.max(0, Math.floor((l.x0 - pad) / s)), cx1 = Math.min(gw - 1, Math.floor((l.x1 + pad) / s));
    const cy0 = Math.max(0, Math.floor((l.y0 - pad) / s)), cy1 = Math.min(gh - 1, Math.floor((l.y1 + pad) / s));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) text[cy * gw + cx] = 1;
  }

  // Vakjes onder een herkend woord, ook een onzeker (lichte of onscherpe tekst).
  const wordy = new Uint8Array(N);
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) {
    if (w.confidence < 40 || !/\p{L}{2}/u.test(w.text || '')) continue;
    const bb = w.bbox;
    if (bb.y1 - bb.y0 > lh * 2.5) continue;
    for (let cy = Math.max(0, (bb.y0 / s) | 0); cy <= Math.min(gh - 1, (bb.y1 / s) | 0); cy++)
      for (let cx = Math.max(0, (bb.x0 / s) | 0); cx <= Math.min(gw - 1, (bb.x1 / s) | 0); cx++) wordy[cy * gw + cx] = 1;
  }

  const cand = new Uint8Array(N);
  for (let i = 0; i < N; i++) cand[i] = !text[i] && (ink[i] > 0.02 || dark[i]) ? 1 : 0;

  // Stukken die bij elkaar horen (staven, assen, labels) samennemen: uitzetten met ongeveer een regel.
  const r = Math.max(1, Math.round(lh * 1.2 / s));
  const grown = dilate(cand, gw, gh, r);
  const seen = new Int32Array(N).fill(-1);
  const boxes = [];
  for (let i = 0; i < N; i++) {
    if (!grown[i] || seen[i] >= 0) continue;
    const id = boxes.length, stack = [i];
    seen[i] = id;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0, nd = 0, nw = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % gw, y = (p / gw) | 0;
      if (cand[p]) { n++; nd += dark[p]; nw += wordy[p]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= N || seen[q] >= 0 || !grown[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === gw - 1)) continue;
        seen[q] = id; stack.push(q);
      }
    }
    boxes.push({ x0, y0, x1, y1, n, nd, nw });
  }

  const out = [];
  for (const b of boxes) {
    if (b.x1 < 0) continue;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, area = bw * bh;
    // Groot genoeg: minstens een zesde van de breedte en vier regels hoog.
    if (bw * s < W * 0.16 || bh * s < Math.max(H * 0.05, lh * 4)) continue;
    // Raakt de rand van de foto: bureau, lampkap, hand of buurpagina.
    if (b.x0 <= 0 || b.y0 <= 0 || b.x1 >= gw - 1 || b.y1 >= gh - 1) continue;
    if (b.n < area * 0.05) continue;
    // Bestaat het vooral uit woorden (lichte of vage tekst, een inhoudsopgave)? Dan is het tekst.
    if (b.nw > b.n * 0.4) continue;
    // Vooral tekst binnen het vak (een kader met tekst, een tabel van zinnen)? Dan is het geen beeld.
    let tx = 0;
    for (let cy = b.y0; cy <= b.y1; cy++) for (let cx = b.x0; cx <= b.x1; cx++) tx += text[cy * gw + cx];
    if (tx > area * 0.12) continue;
    out.push({ x0: b.x0 * s, y0: b.y0 * s, x1: Math.min(W, (b.x1 + 1) * s), y1: Math.min(H, (b.y1 + 1) * s) });
  }
  const all = allLines(blocks);
  if (globalThis.__dbg) for (const l of all) console.log('[ocr] regel', Math.round(l.x0), Math.round(l.y0), Math.round(l.x1), Math.round(l.y1), l.text);
  return mergeBoxes(mergeBoxes(out.map(b => pad(b, lh * 0.3, W, H)), lh).map(b => growLines(trimLines(b, all, lh), all))).filter(b => b.y1 - b.y0 > lh * 3);
}

/** Alle regels met hun woorden (ook korte), voor het bijsnijden van een beeld. */
function allLines(blocks) {
  const out = [];
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const ws = (l.words || []).filter(w => w.text && w.text.trim() && w.confidence >= 70 && /\p{L}/u.test(w.text));
    if (!ws.length) continue;
    out.push({ ws, text: ws.map(w => w.text).join(' '), x0: Math.min(...ws.map(w => w.bbox.x0)), x1: Math.max(...ws.map(w => w.bbox.x1)),
      y0: Math.min(...ws.map(w => w.bbox.y0)), y1: Math.max(...ws.map(w => w.bbox.y1)) });
  }
  return out;
}

/** Een label dat half buiten het vak steekt (bv. de astitel onder een grafiek), hoort er wel bij. */
function growLines(b, lines) {
  const w = b.x1 - b.x0;
  for (const l of lines) {
    const cx = (l.x0 + l.x1) / 2;
    if (cx < b.x0 || cx > b.x1 || l.x1 - l.x0 > w * 0.6 || CAPTION_RE.test(l.text) || l.x0 - b.x0 < w * 0.08) continue;
    if (l.y0 < b.y1 && l.y1 > b.y1) b = { ...b, y1: l.y1 + 2 };
    else if (l.y1 > b.y0 && l.y0 < b.y0) b = { ...b, y0: l.y0 - 2 };
  }
  return b;
}

/** Een bijschrift of kop die aan de onder- of bovenkant in het vak is beland, hoort er niet bij:
    een regel die links in het vak begint, met een bijschriftwoord ("Figuur") of echte woorden. */
function trimLines(b, lines, lh) {
  const w = b.x1 - b.x0;
  const inside = (l) => Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0) > (l.x1 - l.x0) * 0.5 && (l.y0 + l.y1) / 2 > b.y0 && (l.y0 + l.y1) / 2 < b.y1;
  const textish = (l) => l.x0 - b.x0 < w * 0.08 && (CAPTION_RE.test(l.text)
    || l.ws.filter(x => /\p{L}{3}/u.test(x.text)).length >= 2 || (l.ws.length === 1 && /\p{L}{5}/u.test(l.text) && l.ws[0].confidence >= 85));
  for (let guard = 0; guard < 6; guard++) {
    const ls = lines.filter(inside);
    if (globalThis.__dbg) console.log('[ocr] vak', JSON.stringify([b.x0, b.y0, b.x1, b.y1].map(Math.round)), ls.map(l => `${Math.round(l.x0)},${Math.round(l.y0)}-${Math.round(l.y1)}:${l.text}`).join(' | '));
    if (!ls.length) break;
    const low = ls.reduce((a, l) => (l.y1 > a.y1 ? l : a));
    const high = ls.reduce((a, l) => (l.y0 < a.y0 ? l : a));
    // Alleen als er onder (of boven) die regel geen beeld meer zit: de regel ligt aan de rand van het vak.
    if (textish(low) && b.y1 - low.y1 < lh * 2.5 && low.y0 - b.y0 > lh * 3) { b = { ...b, y1: low.y0 - lh * 0.3 }; continue; }
    if (textish(high) && high.y0 - b.y0 < lh * 2.5 && b.y1 - high.y1 > lh * 3) { b = { ...b, y0: high.y1 + lh * 0.3 }; continue; }
    break;
  }
  return b;
}

function dilate(m, w, h, r) {
  const a = new Uint8Array(m.length), b = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) a[y * w + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) a[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= r) b[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= r) b[y * w + x] = 1; }
  }
  return b;
}

const pad = (b, p, W, H) => ({ x0: Math.max(0, b.x0 - p), y0: Math.max(0, b.y0 - p), x1: Math.min(W, b.x1 + p), y1: Math.min(H, b.y1 + p) });
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** Voegt overlappende vakken samen, en vakken naast elkaar op dezelfde hoogte (twee helften van één grafiek). */
function mergeBoxes(list, lh = 0) {
  const out = [...list];
  const side = (a, b) => {
    const vo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    return vo > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && gap < lh * 2.5;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) for (let j = i + 1; j < out.length; j++) {
      if (!overlaps(out[i], out[j]) && !side(out[i], out[j])) continue;
      const a = out[i], b = out[j];
      out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
      out.splice(j, 1); changed = true; break;
    }
  }
  return out.sort((a, b) => a.y0 - b.y0);
}

/** Valt het midden van een woord binnen een van de beelden? */
export function inFigure(bbox, figs) {
  const cx = (bbox.x0 + bbox.x1) / 2, cy = (bbox.y0 + bbox.y1) / 2;
  return figs.some(f => cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1);
}

/** Haalt de woorden binnen de beelden uit de Tesseract-blokken (aslabels, legenda, tekst in een foto). */
export function dropFigureWords(blocks, figs) {
  if (!figs.length) return blocks;
  for (const b of blocks || []) for (const p of b.paragraphs || []) {
    for (const l of p.lines || []) l.words = (l.words || []).filter(w => !inFigure(w.bbox, figs));
    p.lines = (p.lines || []).filter(l => l.words.length);
  }
  return blocks;
}

/* ---------- Uitknippen in kleur ---------- */

/** Stelt een functie samen die een punt op de voorbewerkte pagina terugrekent naar de foto. */
export function chainBack(steps) {
  const fns = steps.filter(Boolean);
  return (x, y) => { let p = [x, y]; for (let i = fns.length - 1; i >= 0; i--) p = fns[i](p[0], p[1]); return p; };
}

/** Grijswaarde van de foto op een punt van de pagina (voor detectFigures). */
export function toneSampler(src, back) {
  const { d, W, H } = src;
  return (x, y) => {
    const [u, v] = back(x, y);
    if (u < 0 || v < 0 || u >= W - 1 || v >= H - 1) return null;
    const i = ((v | 0) * W + (u | 0)) * 4;
    return (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  };
}

/** Knipt een stuk van de pagina in kleur uit de oorspronkelijke foto. Geeft een canvas terug. */
export function cropColor(src, back, box, scale = 1) {
  const { d, W, H } = src;
  const w = Math.max(1, Math.round((box.x1 - box.x0) * scale)), h = Math.max(1, Math.round((box.y1 - box.y0) * scale));
  const c = newCanvas(w, h), ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h), o = id.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [u, v] = back(box.x0 + (x + 0.5) / scale, box.y0 + (y + 0.5) / scale);
    const k = (y * w + x) * 4;
    if (u < 0 || v < 0 || u >= W - 1 || v >= H - 1) { o[k] = o[k + 1] = o[k + 2] = 255; o[k + 3] = 255; continue; }
    const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0, i = (y0 * W + x0) * 4, j = i + W * 4;
    for (let ch = 0; ch < 3; ch++) {
      o[k + ch] = (d[i + ch] * (1 - tx) + d[i + 4 + ch] * tx) * (1 - ty) + (d[j + ch] * (1 - tx) + d[j + 4 + ch] * tx) * ty;
    }
    o[k + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

export function canvasToJpeg(c, quality = 0.85) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}

/* ---------- Beelden in de tekst ---------- */

/** Markdown voor een beeld op de pagina: ![bijschrift](#beeld-n), met het bijschrift eronder. */
export function figureMarkdown(n, caption) {
  const alt = (caption || 'Afbeelding').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  return `![${alt}](#beeld-${n})` + (caption ? `\n\n*${alt.replace(/\*/g, '')}*` : '');
}

/** Alle verwijzingen naar beelden in een tekst: [{ n, alt, index, length }]. */
export function figureRefs(text) {
  return [...(text || '').matchAll(/!\[([^\]]*)\]\(#beeld-(\d+)\)/g)].map(m => ({ n: +m[2], alt: m[1], index: m.index, length: m[0].length }));
}

/** Haalt een beeld (en het bijschrift eronder) uit de tekst. */
export function removeFigureRef(text, n) {
  const re = new RegExp(`!\\[([^\\]]*)\\]\\(#beeld-${n}\\)(\\n\\n\\*([^*\\n]*)\\*)?`);
  return text.replace(re, (all, alt, capBlock, cap) => (capBlock && cap.trim() !== alt.trim() ? capBlock.trim() : ''))
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Zet een nieuw beeld in de tekst, ongeveer op de hoogte waar het op de pagina staat (0–1). */
export function insertFigureRef(text, n, yRel, caption = '') {
  const parts = (text || '').split('\n\n').filter(p => p.trim());
  const at = Math.max(0, Math.min(parts.length, Math.round(yRel * parts.length)));
  parts.splice(at, 0, figureMarkdown(n, caption));
  return parts.join('\n\n');
}
