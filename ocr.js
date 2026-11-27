/* Tekstherkenning: foto voorbewerken, Tesseract.js (lokaal) en tekst opbouwen als Markdown. */

import {
  grayFromCanvas, canvasFromGray, findPage, warpPage, normalizeLight, estimateSkew, rotate,
  dewarp, removeRules, clearBorders, cropSides, findDropCaps, cropForOcr, whiteOut,
  findGutter, cropX, turn,
} from './scan.js';

/* ---------- Tekst opbouwen ---------- */

const isPageNum = (t) => /^\s*[-–—]?\s*(\d{1,4}|[ivxlc]{1,6})\s*[-–—]?\s*$/i.test(t);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
const LIST_RE = /^([•·▪■●◦‣∙*–—-]|\d{1,2}[.)]|[a-z][.)])\s+/;

/** Regels uit de Tesseract-uitvoer, zonder randruis. */
function collectLines(blocks) {
  const lines = [];
  (blocks || []).forEach((b, bi) => { for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    let w = (l.words || []).filter(x => x.text && x.text.trim());
    // Opsommingsteken (•, ▪, –) dat Tesseract vaak als los, onzeker tekentje ziet.
    const rh0 = l.rowAttributes?.rowHeight || 20;
    const bullet = w.length > 1 && /^[•·▪■●◦‣∙*+◆►–—\-eo°«»]$/.test(w[0].text) && !/^\p{Lu}$/u.test(w[0].text)
      && w[1].bbox.x0 - w[0].bbox.x1 > rh0 * 0.3 && /^[\p{L}\d]/u.test(w[1].text);
    const hasLetter = (x) => /[\p{L}\p{N}]/u.test(x.text);
    const junk = (x) => (x.confidence < 55 && (x.text.length <= 2 || !hasLetter(x))) || (!hasLetter(x) && x.confidence < 85)
      || x.confidence < 25;
    while (w.length && junk(w[0])) w.shift();
    while (w.length && junk(w[w.length - 1])) w.pop();
    if (!w.length) continue;
    const rh = l.rowAttributes?.rowHeight || median(w.map(x => x.bbox.y1 - x.bbox.y0));
    // Losse tekentjes ver van de rest (schaduw, rand van de pagina) weglaten.
    const far = (a, b) => b.bbox.x0 - a.bbox.x1 > rh * 1.6;
    while (w.length > 1 && w[0].text.length <= 2 && far(w[0], w[1])) w.shift();
    while (w.length > 1 && w[w.length - 1].text.length <= 2 && far(w[w.length - 2], w[w.length - 1])) w.pop();
    const conf = w.reduce((a, x) => a + x.confidence, 0) / w.length;
    const text = w.map(x => x.text).join(' ');
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    if (conf < 50 || (w.length <= 2 && conf < 70 && !isPageNum(text))) continue;
    if (letters === 0 && !isPageNum(text)) continue;
    lines.push({
      text, block: bi, conf, size: rh, words: w.length, bullet,
      x0: w[0].bbox.x0, x1: w[w.length - 1].bbox.x1,
      y0: Math.min(...w.map(x => x.bbox.y0)), y1: Math.max(...w.map(x => x.bbox.y1)),
    });
  } });
  return reorder(lines);
}

/** Tesseract knipt regels op een kromme of onscherpe pagina soms in stukken, verdeeld over
    verschillende blokken, waardoor de volgorde niet meer klopt. Stukken op dezelfde hoogte
    worden weer één regel; bij één tekstkolom komen de regels daarna gewoon van boven naar beneden. */
function reorder(lines) {
  if (lines.length < 3) return lines;
  const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const sorted = [...lines].sort((a, b) => a.x0 - b.x0);
  const out = [];
  for (const l of sorted) {
    const h = l.y1 - l.y0;
    const m = out.find(o => {
      const gap = l.x0 - o.x1;
      return vOverlap(o, l) > 0.6 * Math.min(h, o.y1 - o.y0) && gap > -o.size * 0.5 && gap < Math.max(o.size, l.size) * 2.5;
    });
    if (!m) { out.push({ ...l }); continue; }
    const n = m.words + l.words;
    m.conf = (m.conf * m.words + l.conf * l.words) / n;
    if (l.words > m.words) m.block = l.block;
    m.text = `${m.text} ${l.text}`;
    m.words = n; m.x1 = Math.max(m.x1, l.x1);
    m.y0 = Math.min(m.y0, l.y0); m.y1 = Math.max(m.y1, l.y1);
  }
  const full = out.filter(l => l.words >= 4);
  if (full.length >= 5) {
    const c0 = median(full.map(l => l.x0)), c1 = median(full.map(l => l.x1));
    const inCol = (l) => Math.min(l.x1, c1) - Math.max(l.x0, c0) > 0.5 * (l.x1 - l.x0);
    if (full.filter(inCol).length >= full.length * 0.85) {
      out.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
      // Eén kolom: Tesseracts blokindeling is dan willekeurig; alinea's volgen uit inspringen en witregels.
      const cnt = {};
      for (const l of out) cnt[l.block] = (cnt[l.block] || 0) + l.words;
      const main = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      for (const l of out) l.block = main;
      return out;
    }
  }
  // Meer kolommen: Tesseracts volgorde aanhouden.
  return lines.map(l => out.find(o => o.text.startsWith(l.text)) || null).filter((o, i, a) => o && a.indexOf(o) === i);
}

/** Bouwt Markdown uit de regels die Tesseract vindt: alinea's, koppen, citaten en opsommingen.
    dropCaps: [{ letter, x0, y0, x1, y1 }] (grote beginletters die apart zijn herkend).
    sparse: losse tekst (omslag, kaders) — elke regel blijft een eigen regel. */
export function buildText(blocks, { dropCaps = [], sparse = false } = {}) {
  const lines = collectLines(blocks);
  // Kopregel bovenaan in hoofdletters (bv. "3 · GEHEUGEN") is meestal een terugkerende paginakop.
  const isRunningHead = (t) => t.split(' ').length <= 6 && /\p{Lu}{3}/u.test(t) && t === t.toUpperCase();
  if (!sparse) {
    const bodySize0 = median(lines.filter(l => l.words >= 4).map(l => l.size));
    while (lines.length && (isPageNum(lines[0].text) || (isRunningHead(lines[0].text) && lines[0].size < bodySize0 * 1.3))) lines.shift();
  }
  while (lines.length && isPageNum(lines[lines.length - 1].text)) lines.pop();
  if (!lines.length) return '';

  // Grote beginletters terugzetten vóór de regel ernaast.
  for (const cap of dropCaps) {
    if (!cap.letter) continue;
    let best = null, bd = Infinity;
    for (const l of lines) {
      if (l.x0 < cap.x1 - cap.lineHeight || l.x0 > cap.x1 + cap.lineHeight * 6) continue;
      const d = Math.abs(l.y0 - cap.y0);
      if (d < bd && d < cap.lineHeight * 2.5) { bd = d; best = l; }
    }
    if (best) {
      best.text = cap.letter + best.text;
      best.x0 = cap.x0;
      for (const l of lines) if (l !== best && l.y0 < cap.y1 && l.y0 > best.y0 && l.x0 > cap.x0) l.besideCap = true;
    }
  }

  const full = lines.filter(l => l.words >= 5);
  const body = full.length ? full : lines;
  const bodySize = median(body.map(l => l.size)) || 1;
  // Marges per blok (kolom), met de hele pagina als terugvaloptie.
  const marg = (ls) => ({ left: median(ls.map(l => l.x0)), right: median(ls.map(l => l.x1)) });
  const pageM = marg(body);
  const blockM = {};
  for (const l of lines) {
    if (blockM[l.block]) continue;
    const ls = full.filter(x => x.block === l.block);
    // Eigen marges alleen voor een echt andere kolom; een ingesprongen citaat houdt de paginamarges.
    const bm = ls.length >= 3 ? marg(ls) : pageM;
    const pw = Math.max(1, pageM.right - pageM.left);
    blockM[l.block] = Math.abs(bm.left - pageM.left) > pw * 0.2 || Math.abs(bm.right - pageM.right) > pw * 0.2 ? bm : pageM;
  }
  const gaps = lines.slice(1).map((l, i) => l.y0 - lines[i].y1).filter(g => g > 0);
  const gap = median(gaps) || 10;

  // Soort per regel bepalen.
  for (const l of lines) {
    const m = blockM[l.block], width = Math.max(1, m.right - m.left);
    l.m = m; l.width = width;
    const rel = l.size / bodySize;
    const centered = Math.abs((l.x0 + l.x1) / 2 - (m.left + m.right) / 2) < width * 0.05 && l.x1 - l.x0 < width * 0.8
      && l.x0 > m.left + width * 0.06;
    l.kind = 'text';
    const headingLike = l.words <= 14 && !/[,;]$/.test(l.text);
    if (rel >= 1.35 && headingLike) l.kind = rel >= 1.6 ? 'h2' : 'h3';
    else if (rel >= 1.18 && l.words <= 8 && headingLike && !/[.!?]$/.test(l.text)) l.kind = 'h3';
    else if (l.bullet || LIST_RE.test(l.text)) l.kind = 'item';
    else if (centered && l.words <= 12 && !sparse) l.kind = 'center';
    l.indentL = (l.x0 - m.left) / width;
    l.indentR = (m.right - l.x1) / width;
  }
  // Paginakop: een korte eerste regel in gewone (of kleinere) letter, gecentreerd, met witruimte eronder.
  if (!sparse && lines.length >= 8) {
    const [h, n] = lines;
    if (h.kind === 'center' && h.size < bodySize * 1.15 && n.y0 - h.y1 > gap * 1.5) lines.shift();
  }
  // Citaten: minstens twee regels die links verder inspringen dan de tekst (bij weinig inspringen
  // alleen met extra witruimte erboven), of één kleinere regel die aan beide kanten inspringt.
  if (!sparse) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind !== 'text' || l.besideCap || l.indentL < 0.025) continue;
      let j = i;
      while (j + 1 < lines.length && lines[j + 1].kind === 'text' && !lines[j + 1].besideCap
        && Math.abs(lines[j + 1].indentL - l.indentL) < 0.015 && lines[j + 1].y0 - lines[j].y1 < gap * 1.8 + 4) j++;
      const n = j - i + 1;
      const spaced = i > 0 && l.y0 - lines[i - 1].y1 > gap * 1.8 + 4;
      const smaller = l.size < bodySize * 0.93;
      if ((n >= 2 && (l.indentL >= 0.045 || spaced)) || (smaller && l.indentR > 0.04 && /^[‘'“"„«]/.test(l.text)))
        for (let k = i; k <= j; k++) lines[k].kind = 'quote';
      i = j;
    }
  }

  // Samenvoegen tot blokken.
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  lines.forEach((l, i) => {
    const prev = lines[i - 1];
    const bigGap = prev && l.y0 - prev.y1 > gap * 1.8 + 4;
    let join = false;
    if (cur && prev) {
      if (l.kind.startsWith('h') && cur.kind.startsWith('h') && prev.kind.startsWith('h')) {
        join = l.y0 - prev.y1 < Math.max(l.size, prev.size) * 0.9;
        if (join && l.kind === 'h2') cur.kind = 'h2';
      } else if (sparse) {
        join = false;
      } else if (l.kind === cur.kind && (l.kind === 'text' || l.kind === 'quote') && l.block === prev.block || (l.kind === 'text' && cur.kind === 'item' && l.indentL > 0.02)) {
        const m = l.m, width = l.width;
        const short = prev.x1 < m.right - width * 0.1;
        const indent = l.x0 > m.left + width * 0.03 && l.x0 - prev.x0 > width * 0.03;
        join = !(short && /[.!?:;”"')\]]$/.test(prev.text)) && !bigGap && !(indent && short && cur.kind === 'text');
        if (short && prev.words <= 6 && !/[-,]$/.test(prev.text) && cur.kind === 'text' && cur.lines === 1) join = false;
      } else if (l.kind === 'center' && cur.kind === 'center') {
        join = /[\p{L}]-$/u.test(prev.text) && !bigGap;
      }
    }
    if (!join) { flush(); cur = { kind: l.kind, text: l.text, lines: 1, bullet: l.bullet }; return; }
    cur.lines++;
    if (/[\p{L}][-­]$/u.test(cur.text) && /^\p{Ll}/u.test(l.text)) cur.text = cur.text.slice(0, -1) + l.text; // afgebroken woord
    else cur.text += ' ' + l.text;
  });
  flush();

  const md = out.map((b, i) => {
    const t = clean(b.text);
    switch (b.kind) {
      case 'h2': return '## ' + t;
      case 'h3': return '### ' + t;
      case 'quote': return '> ' + t;
      case 'item': {
        const num = t.match(/^(\d{1,2})[.)]\s+/);
        if (num) return `${num[1]}. ` + t.slice(num[0].length);
        return '- ' + (b.bullet ? t : t.replace(LIST_RE, ''));
      }
      case 'center': return out[i - 1]?.kind?.startsWith('h') ? `*${t}*` : t;
      default: return t;
    }
  });
  // Opeenvolgende opsommingstekens zonder lege regel ertussen.
  const isItem = (x) => /^(- |\d{1,2}\. )/.test(x);
  return md.reduce((acc, s, i) => acc + (i ? (isItem(s) && isItem(md[i - 1]) ? '\n' : '\n\n') : '') + s, '');
}

function clean(t) {
  return t.replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim();
}

/** Kleine opschoning, ook bruikbaar voor platte tekst. */
export function tidy(t) {
  return t.replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1')
    .split('\n\n').map(s => s.trim()).filter(Boolean).join('\n\n');
}

/* ---------- Afbeeldingen ---------- */

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Afbeelding kon niet worden geladen')); };
    img.src = url;
  });
}

export async function resizeToBlob(blob, maxSide, quality = 0.85, rotate = 0) {
  const img = await loadImage(blob);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const swap = rotate % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rotate * Math.PI) / 180);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}

async function grayOf(blob) {
  const im = await loadImage(blob);
  const scale = Math.min(1, 2200 / Math.max(im.naturalWidth, im.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(im.naturalWidth * scale); c.height = Math.round(im.naturalHeight * scale);
  c.getContext('2d', { willReadFrequently: true }).drawImage(im, 0, 0, c.width, c.height);
  return grayFromCanvas(c);
}

/** Maakt de foto klaar voor herkenning: pagina rechtzetten, belichting, scheefstand, kromming,
    kaderlijnen en grote beginletters. Staan er twee pagina's op (open boek), dan wordt de foto
    bij de rug in tweeën geknipt. Geeft { pages: [...], steps, canvas } terug. */
export async function prepareForOcr(blob) {
  let img = await grayOf(blob);
  const steps = [];
  const quad = findPage(img);
  if (quad) { img = warpPage(img, quad); steps.push('pagina'); }
  let photo = img;
  img = normalizeLight(img);
  // Twee pagina's? Eerst het geheel rechtzetten, dan de rug zoeken.
  let halves = [[img, photo]];
  if (img.W > img.H * 1.1) {
    const a = estimateSkew(img);
    const straight = Math.abs(a) >= 0.3 ? rotate(img, a) : img;
    const gx = findGutter(straight);
    if (gx) {
      const sp = Math.abs(a) >= 0.3 ? rotate(photo, a) : photo;
      halves = [[cropX(straight, 0, gx), cropX(sp, 0, gx)], [cropX(straight, gx, straight.W), cropX(sp, gx, sp.W)]];
      steps.push("twee pagina's");
    }
  }
  const pages = halves.map(([g, p]) => preparePage(g, p, steps, halves.length > 1));
  return { pages, steps, canvas: pages[0].canvas };
}

function preparePage(img, photo, steps, half = false) {
  const cs = cropSides(img);
  if (cs.cropped) { img = cs.img; steps.push('buurpagina weg'); }
  let angle = estimateSkew(img);
  // Bij een open boek is het geheel al rechtgezet; een grote hoek per pagina is dan ruis (rand, tafel).
  if (half && Math.abs(angle) > 6) angle = 0;
  if (Math.abs(angle) >= 0.3) { img = rotate(img, angle); steps.push(`scheef ${angle.toFixed(1)}°`); }
  const dw = dewarp(img);
  if (dw.warped) { img = dw.img; steps.push(`krom ${Math.round(dw.maxOff)}px`); }
  clearBorders(img);
  if (removeRules(img) > 0) steps.push('lijnen');
  const dropCaps = findDropCaps(img);
  const crops = dropCaps.map(b => cropForOcr(img, b));
  for (const b of dropCaps) whiteOut(img, b);
  if (dropCaps.length) steps.push(`initiaal ×${dropCaps.length}`);
  // Omgekeerde versie (lichte tekst op donker), alleen gemaakt als het nodig blijkt.
  const inverted = () => {
    let inv = normalizeLight(photo, { invert: true });
    if (Math.abs(angle) >= 0.3) inv = rotate(inv, angle);
    clearBorders(inv);
    return canvasFromGray(inv);
  };
  return { canvas: canvasFromGray(img), dropCaps, crops, inverted };
}

/* ---------- Tekstherkenning (Tesseract.js, lokaal) ---------- */

/** Voegt de regels van twee herkenningen samen; bij overlap wint de zekerste. */
function mergeBlocks(a, b) {
  const lines = (bl) => bl.flatMap(x => (x.paragraphs || []).flatMap(p => p.lines || []))
    .map(l => ({ l, conf: (l.words || []).reduce((s, w) => s + w.confidence, 0) / Math.max(1, (l.words || []).length) }))
    .filter(x => x.conf > 40);
  const all = [...lines(a), ...lines(b)].sort((x, y) => y.conf - x.conf);
  const kept = [];
  const overlap = (p, q) => Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0)) * Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0));
  for (const x of all) {
    const bb = x.l.bbox, area = (bb.x1 - bb.x0) * (bb.y1 - bb.y0);
    if (kept.some(k => overlap(k.l.bbox, bb) > area * 0.3)) continue;
    kept.push(x);
  }
  kept.sort((x, y) => x.l.bbox.y0 - y.l.bbox.y0 || x.l.bbox.x0 - y.l.bbox.x0);
  return kept.map(x => ({ paragraphs: [{ lines: [x.l] }] }));
}

/** Hoeveel bruikbare tekst een resultaat bevat (om twee pogingen te vergelijken). */
function score(blocks) {
  let s = 0;
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || [])
    for (const w of l.words || []) if (w.confidence > 60 && /\p{L}{2}/u.test(w.text)) s += w.text.length * w.confidence / 100;
  return s;
}

/* ---------- Woordcontrole (Nederlands) ---------- */

// Tesseract verwart in sommige boekletters de t met een r en de e met een c ("her" voor "het",
// "cen" voor "een"). Met een frequentielijst van Nederlandse woorden zetten we dat terug, maar
// alleen als de verbeterde vorm veel gewoner is (of het gelezen woord niet bestaat).
let freqList = null;
export function loadWordFreq() {
  if (!freqList) {
    freqList = fetch(new URL('vendor/lang/nl-woorden.txt', import.meta.url))
      .then(r => (r.ok ? r.text() : ''))
      .then(t => {
        const m = new Map();
        for (const line of t.split('\n')) {
          if (!line || line[0] === '#') continue;
          const [b, ...ws] = line.split(' ');
          for (const w of ws) if (!m.has(w)) m.set(w, +b);
        }
        return m;
      })
      .catch(() => new Map());
  }
  return freqList;
}

const SWAPS = [['r', 't'], ['c', 'e']];
// Echte woorden die op een verbetering lijken: niet aankomen.
const KEEP = new Set(['war', 'staar', 'gaar', 'weren', 'roe', 'wc', 'doc', 'ic', 'four', 'rot', 'rand', 'ras', 'rap']);

function variants(w) {
  const out = new Set();
  for (const [a, b] of SWAPS) {
    const idx = [];
    for (let i = 0; i < w.length && idx.length < 4; i++) if (w[i] === a) idx.push(i);
    for (let mask = 1; mask < 1 << idx.length; mask++) {
      const l = [...w];
      idx.forEach((i, k) => { if (mask & (1 << k)) l[i] = b; });
      out.add(l.join(''));
    }
  }
  return out;
}

const matchCase = (orig, w) => orig === orig.toUpperCase() && orig.length > 1 ? w.toUpperCase()
  : orig[0] === orig[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w;

export function fixWords(text, freq) {
  let fixed = 0;
  if (!freq || !freq.size) return { text, fixed };
  const out = text.replace(/\p{L}+/gu, (orig) => {
    const w = orig.toLowerCase();
    // Hoofdletterwoorden (afkortingen, namen in kapitalen) laten we staan.
    if (!/[rc]/.test(w) || KEEP.has(w) || w.length > 16 || (orig.length > 1 && orig === orig.toUpperCase())) return orig;
    const own = freq.has(w) ? freq.get(w) : -1;
    if (own < 0 && !/[aeiouyáéëïóöü]/.test(w)) return orig; // geen klinker: geen woord om te verbeteren
    let best = null, bb = -1;
    for (const v of variants(w)) { const b = freq.get(v); if (b != null && b > bb) { bb = b; best = v; } }
    // Onbekend woord: verbeteren als de andere vorm gewoon voorkomt. Bekend woord: alleen als
    // de andere vorm minstens zo'n 64 keer vaker voorkomt (6 frequentiebanden).
    if (!best || (own < 0 ? bb < 7 : bb - own < 6)) return orig;
    fixed++;
    return matchCase(orig, best);
  });
  return { text: out, fixed };
}

/** Strenger: alleen gewone woorden in kleine letters met een klinker (onzin uit een gedraaide foto valt weg). */
function wordScore(blocks) {
  let s = 0;
  for (const b of blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || [])
    for (const w of l.words || []) {
      const t = w.text.replace(/^[‘’'"“”(\[]+|[‘’'"“”)\].,;:!?]+$/g, '');
      if (w.confidence >= 75 && /^\p{Ll}{3,}$/u.test(t) && /[aeiouyáéëïóöü]/.test(t)) s += t.length;
    }
  return s;
}

export const ocr = {
  worker: null,
  lang: null,
  ready: null,
  onProgress: null,
  async get(lang) {
    if (this.worker && this.lang === lang) return this.worker;
    if (this.ready) await this.ready.catch(() => {});
    if (this.worker && this.lang === lang) return this.worker;
    const base = new URL('vendor/', import.meta.url).href;
    this.ready = (async () => {
      if (this.worker) { await this.worker.terminate(); this.worker = null; }
      const w = await Tesseract.createWorker(lang.split('+'), 1, {
        workerPath: base + 'tesseract/worker.min.js',
        corePath: base + 'tesseract/',
        langPath: base + 'lang',
        workerBlobURL: false,
        gzip: true,
        logger: (m) => this.onProgress && this.onProgress(m),
      });
      // Geen staande tekst zoeken: anders leest Tesseract een gedraaide foto soms half, en kiezen we de verkeerde richting.
      await w.setParameters({ preserve_interword_spaces: '0', textord_tabfind_vertical_text: '0' });
      this.worker = w;
      this.lang = lang;
      return w;
    })();
    try { return await this.ready; } finally { this.ready = null; }
  },
  /** Welke kant is boven? Leest een stuk uit het midden van de foto in vier richtingen
      (eerst gewoon; de rest alleen als dat weinig oplevert). Geeft 0, 90, 180 of 270 terug. */
  async orientation(blob, lang) {
    const w = await this.get(lang);
    const img = normalizeLight(await grayOf(blob));
    // Eén tekstblok (modus 6): de automatische opmaakherkenning leest gedraaide regels soms toch, en dan kiezen we fout.
    await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' });
    const tries = [];
    for (const deg of [0, 90, 270, 180]) {
      // Draaien, scheefstand eruit, dan een vierkant uit het midden lezen.
      let t = turn(img, deg);
      const a = estimateSkew(t);
      if (Math.abs(a) >= 0.3) t = rotate(t, a);
      const side = Math.round(Math.min(t.W, t.H) * 0.7);
      const x0 = Math.round((t.W - side) / 2), y0 = Math.round((t.H - side) / 2);
      const sq = cropX({ g: t.g.subarray(y0 * t.W, (y0 + side) * t.W), W: t.W, H: side }, x0, x0 + side);
      const { data } = await w.recognize(canvasFromGray(sq), {}, { text: true, blocks: true });
      tries.push({ deg, s: wordScore(data.blocks), c: data.confidence });
      if (deg === 0 && tries[0].s > 150) break;
    }
    await w.setParameters({ tessedit_pageseg_mode: '3' });
    console.debug('[ocr] richting', tries.map(t => `${t.deg}:${Math.round(t.s)}/${Math.round(t.c)}`).join(' '));
    tries.sort((a, b) => b.s - a.s);
    const base = tries.find(t => t.deg === 0)?.s ?? 0;
    return tries[0].s >= 20 && tries[0].s > base * 1.3 ? tries[0].deg : 0;
  },
  async recognize(blob, lang, onProgress) {
    const w = await this.get(lang);
    const deg = await this.orientation(blob, lang);
    let image = null;
    if (deg) { image = await resizeToBlob(blob, 2200, 0.92, deg); blob = image; }
    const prep = await prepareForOcr(blob);
    if (deg) prep.steps.unshift(`gedraaid ${deg}°`);
    const pages = [];
    for (let i = 0; i < prep.pages.length; i++) {
      pages.push(await this.recognizePage(w, prep.pages[i], prep.steps, onProgress && ((m) => {
        onProgress(m.status === 'recognizing text' ? { ...m, progress: (i + m.progress) / prep.pages.length } : m);
      })));
    }
    if (lang.split('+').includes('nld')) {
      const freq = await loadWordFreq();
      let n = 0;
      for (const p of pages) { const r = fixWords(p.text, freq); p.text = r.text; n += r.fixed; }
      if (n) prep.steps.push(`woorden ×${n}`);
    }
    const text = pages.map(p => p.text).join('\n\n');
    const confidence = Math.round(pages.reduce((s, p) => s + p.confidence, 0) / pages.length);
    console.debug('[ocr]', prep.steps.join(', ') || 'geen voorbewerking', `${confidence}%`);
    return { text, confidence, steps: prep.steps, pages, image, rotated: deg };
  },
  async recognizePage(w, prep, steps, onProgress) {
    // Grote beginletters los herkennen, als één hoofdletter.
    for (let i = 0; i < prep.dropCaps.length; i++) {
      await w.setParameters({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÄÉÈÊËÍÏÓÖÔÚÜ' });
      const { data } = await w.recognize(prep.crops[i], {}, { text: true });
      const t = (data.text || '').trim();
      if (/^\p{Lu}$/u.test(t) && data.confidence > 30) prep.dropCaps[i].letter = t;
    }
    await w.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
    this.onProgress = onProgress;
    let { data } = await w.recognize(prep.canvas, {}, { text: true, blocks: true });
    this.onProgress = null;
    let text = data.blocks ? buildText(data.blocks, { dropCaps: prep.dropCaps }) : tidy(data.text || '');
    let confidence = data.confidence;
    // Weinig of onzekere tekst (omslag, kaders, tekst rond een plaatje)? Probeer losse-tekstmodus,
    // zowel op de gewone als op de omgekeerde versie (lichte letters op een donkere ondergrond).
    if (data.blocks && (confidence < 65 || text.split(/\s+/).length < 40)) {
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const a = (await w.recognize(prep.canvas, {}, { text: true, blocks: true })).data;
      const b = (await w.recognize(prep.inverted(), {}, { text: true, blocks: true })).data;
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      const blocks = mergeBlocks(a.blocks || [], b.blocks || []);
      if (score(blocks) > score(data.blocks) * 1.15) {
        text = buildText(blocks, { dropCaps: prep.dropCaps, sparse: true });
        confidence = Math.max(a.confidence, b.confidence);
        if (!steps.includes('losse tekst')) steps.push('losse tekst');
      }
    }
    return { text, confidence: Math.round(confidence) };
  },
};
