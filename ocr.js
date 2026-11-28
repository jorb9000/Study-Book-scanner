/* Tekstherkenning: foto voorbewerken, Tesseract.js (lokaal) en tekst opbouwen als Markdown. */

import {
  grayFromCanvas, canvasFromGray, findPage, warpPage, normalizeLight, estimateSkew, rotate,
  dewarp, removeRules, clearBorders, cropSides, findDropCaps, cropForOcr, whiteOut,
  findGutter, cropX, turn, measureWords, lineSpacing,
  bookCrop, newCanvas,
} from './scan.js';
import {
  CAPTION_RE, detectFigures, dropFigureWords, chainBack, toneSampler, cropColor, canvasToJpeg, figureMarkdown,
} from './figures.js';

/* ---------- Tekst opbouwen ---------- */

const isPageNum = (t) => /^\s*[-–—]?\s*(\d{1,4}|[ivxlc]{1,6})\s*[-–—]?\s*$/i.test(t);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
const LIST_RE = /^([•·▪■●◦‣∙*–—-]|\d{1,2}[.)]|[a-z][.)])\s+/;

// Interne tekens voor cursief en vet; pas aan het eind worden het * en **.
const I0 = '\uE001', I1 = '\uE002', B0 = '\uE003', B1 = '\uE004';

/** Zet opeenvolgende woorden met dezelfde stijl samen tussen stijltekens, met leestekens erbuiten. */
function styleWords(w) {
  const out = [];
  for (let i = 0; i < w.length;) {
    let j = i; while (j + 1 < w.length && !!w[j + 1].italic === !!w[i].italic && !!w[j + 1].bold === !!w[i].bold) j++;
    let t = w.slice(i, j + 1).map(x => x.text).join(' ');
    if (w[i].italic || w[i].bold) {
      const lead = t.match(/^[‘'“"„(«\[]*/)[0], trail = t.match(/[.,;:!?’'”")»\]]*$/)[0];
      const core = t.slice(lead.length, t.length - trail.length);
      if (core) {
        const [a, b] = w[i].bold && w[i].italic ? [B0 + I0, I1 + B1] : w[i].bold ? [B0, B1] : [I0, I1];
        t = lead + a + core + b + trail;
      }
    }
    out.push(t);
    i = j + 1;
  }
  return out.join(' ');
}

/** Stijltekens naar Markdown, met aangrenzende stukken samengevoegd. */
function styleToMd(t) {
  // Een woord dat over de regel is afgebroken kan half cursief zijn ("rim-" + "boe"): de tekens
  // dan naar de woordgrens schuiven, zodat het hele woord cursief is.
  t = t.replace(/(\p{L}+)([\uE001\uE003])(?=\p{L})/gu, '$2$1').replace(/(\p{L})([\uE002\uE004])(\p{L}+)/gu, '$1$3$2');
  return t.replace(new RegExp(`${I1}(\\s*)${I0}`, 'g'), '$1').replace(new RegExp(`${B1}(\\s*)${B0}`, 'g'), '$1')
    .replace(/[\uE001\uE002]/g, '*').replace(/[\uE003\uE004]/g, '**');
}
const unstyle = (t) => t.replace(/[\uE001-\uE004]/g, '');

/** Markeert woorden als cursief of vet, gemeten in het voorbewerkte beeld. */
export function markStyles(blocks, gray) {
  if (!gray || !blocks) return;
  const lines = [];
  for (const b of blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const rh = l.rowAttributes?.rowHeight || 0;
    for (const w of l.words || []) w._rh = rh || (w.bbox.y1 - w.bbox.y0);
    lines.push(l.words || []);
  }
  const words = lines.flat();
  const m = measureWords(gray, words.map(w => w.bbox));
  // Lijndikte ten opzichte van de regelhoogte, zodat grotere letters niet als vet tellen.
  words.forEach((w, i) => { w._m = m[i]; if (m[i]) m[i].stroke /= w._rh; });
  const ok = words.filter(w => w._m && /\p{L}{3}/u.test(w.text) && w.confidence > 60);
  if (ok.length < 15) return;
  const slant0 = median(ok.map(w => w._m.slant));
  const stroke0 = median(ok.map(w => w._m.stroke));
  const h0 = median(ok.map(w => w._m.h));
  if (globalThis.__dbg) { for (const ws of lines) { const r = ws.map(w => w._m ? `${w.text}:${(w._m.stroke/stroke0).toFixed(2)}/${(w._m.slant-slant0).toFixed(2)}/${w._m.gain.toFixed(2)}` : w.text); console.log('[ocr] ' + r.join(' ')); } }
  for (const w of words) {
    const x = w._m;
    if (!x || !/\p{L}{2}/u.test(w.text)) continue;
    w.italic = x.slant - slant0 >= 0.15 && x.gain >= 1.06;
  }
  // Een licht scheve of kromme foto geeft een schuinte die geleidelijk over de regel verloopt.
  // Daarom ook vergelijken met de rechtopstaande buren: dan valt zo'n verloop weg, terwijl een
  // helemaal cursieve regel (geen rechte buren) gewoon cursief blijft.
  for (const ws of lines) {
    const flag = ws.map(w => !!w.italic);
    ws.forEach((w, i) => {
      if (!flag[i]) return;
      const nb = ws.filter((o, j) => !flag[j] && Math.abs(j - i) <= 4 && o._m && /\p{L}{3}/u.test(o.text)).map(o => o._m.slant);
      if (nb.length >= 2 && w._m.slant - median(nb) < 0.12) w.italic = false;
    });
  }
  // Vet: veel dikkere lijnen dan de woorden er direct omheen. Belichting en scherpte verlopen over
  // een foto, dus alleen vergelijken met de buren in dezelfde regel (en niet te weinig daarvan).
  for (const ws of lines) {
    ws.forEach((w, i) => {
      const x = w._m;
      if (!x || !/\p{L}{4}/u.test(w.text) || x.stroke < stroke0 * 1.35) return;
      const nb = ws.filter((o, j) => j !== i && Math.abs(j - i) <= 4 && o._m && /\p{L}{3}/u.test(o.text)).map(o => o._m.stroke);
      w.bold = nb.length >= 3 && x.stroke >= median(nb) * 1.4;
    });
  }
  // Korte woordjes (van, de, en) binnen een cursief stuk zijn moeilijk te meten: die horen erbij,
  // ook twee achter elkaar ("De sigaren van de Farao").
  for (const ws of lines) {
    for (const k of ['italic', 'bold']) {
      for (let i = 0; i < ws.length; i++) {
        if (!ws[i][k]) continue;
        let j = i + 1;
        while (j < ws.length && !ws[j][k] && ws[j].text.length <= 4 && j - i <= 2) j++;
        if (j < ws.length && j > i + 1 && ws[j][k]) for (let q = i + 1; q < j; q++) ws[q][k] = true;
      }
    }
    // Lidwoord met hoofdletter vlak vóór een cursief stuk is het begin van een titel
    // ("in De sigaren van de Farao"); zulke korte woorden zijn zelf niet te meten.
    for (let i = 1; i < ws.length; i++) {
      const a = ws[i - 1];
      if (ws[i].italic && !a.italic && /^(De|Het|Een)$/.test(a.text) && i >= 2 && !/[.!?:]$/.test(ws[i - 2].text)) a.italic = true;
    }
    // Eén los cursief woordje van 2 letters is meestal ruis.
    for (const w of ws) if (w.italic && w.text.replace(/[^\p{L}]/gu, '').length <= 2 && !ws.some(o => o !== w && o.italic)) w.italic = false;
  }
}

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
    // Het opsommingsteken zelf hoort niet in de tekst (de regel wordt een '- ' opsomming).
    if (bullet) w = w.slice(1);
    // Een lang woord in een verder goed gelezen regel blijft staan, ook als Tesseract er zelf aan twijfelt
    // (bv. "'egenwoordig" met 0%): beter een woord met één verkeerde letter dan een gat in de zin.
    const solid = w.length >= 5 && w.filter(x => x.confidence >= 85).length >= w.length - 1;
    const keepLong = (x) => solid && (x.text.match(/\p{Ll}/gu) || []).length >= 5;
    while (w.length && junk(w[0]) && !keepLong(w[0])) w.shift();
    while (w.length && junk(w[w.length - 1]) && !keepLong(w[w.length - 1])) w.pop();
    if (!w.length) continue;
    const rh = l.rowAttributes?.rowHeight || median(w.map(x => x.bbox.y1 - x.bbox.y0));
    // Losse tekentjes ver van de rest (schaduw, rand van de pagina) weglaten.
    const far = (a, b) => b.bbox.x0 - a.bbox.x1 > rh * 1.6;
    while (w.length > 1 && w[0].text.length <= 2 && far(w[0], w[1])) w.shift();
    while (w.length > 1 && w[w.length - 1].text.length <= 2 && far(w[w.length - 2], w[w.length - 1])) w.pop();
    const conf = w.reduce((a, x) => a + x.confidence, 0) / w.length;
    const text = w.map(x => x.text).join(' ');
    const styled = styleWords(w);
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    if (conf < 50 || (w.length <= 2 && conf < 70 && !isPageNum(text))) { if (globalThis.__dbg) console.log('[ocr] weg', Math.round(conf), text.slice(0, 80)); continue; }
    if (letters === 0 && !isPageNum(text)) continue;
    lines.push({
      text, styled, block: bi, conf, size: rh, words: w.length, bullet,
      x0: w[0].bbox.x0, x1: w[w.length - 1].bbox.x1,
      y0: Math.min(...w.map(x => x.bbox.y0)), y1: Math.max(...w.map(x => x.bbox.y1)),
    });
  } });
  // Losse cijfertjes die veel kleiner zijn dan de tekst (vlekjes in de marge, vooral bij de rug)
  // zijn geen paginanummer; ze zouden anders aan een regel worden geplakt ("Ondoordring- 1 bare").
  const body = median(lines.filter(l => l.words >= 4).map(l => l.size));
  const noise = (l) => body && !/\p{L}/u.test(l.text) && (l.size < body * 0.6 || (l.text.trim().length === 1 && l.conf < 80));
  return reorder(lines.filter(l => !noise(l)));
}

/** Zoekt tekstkolommen: stroken die geen enkele regel (op een enkele kop na) oversteekt.
    Geeft de tussenruimtes terug als [{ a, b }] (van links naar rechts), leeg bij één kolom. */
function findColumnGaps(lines, size) {
  const ls = lines.filter(l => l.words >= 2 && /\p{L}/u.test(l.text));
  if (ls.length < 6 || !size) return [];
  const minX = Math.min(...ls.map(l => l.x0)), maxX = Math.max(...ls.map(l => l.x1));
  const bin = Math.max(2, size / 4), n = Math.ceil((maxX - minX) / bin) + 1;
  const cov = new Uint16Array(n);
  for (const l of ls) for (let i = Math.floor((l.x0 - minX) / bin); i <= Math.floor((l.x1 - minX) / bin); i++) cov[i]++;
  const gaps = [];
  let i = 0;
  while (i < n) {
    // Een tussenruimte: bijna geen regel loopt erdoorheen, vergeleken met de tekst ernaast.
    const peakL = Math.max(0, ...cov.subarray(0, i)), peakR = Math.max(0, ...cov.subarray(i));
    const low = Math.max(1, Math.floor(0.15 * Math.min(peakL, peakR)));
    if (!(cov[i] <= low && peakL >= 4 && peakR >= 4)) { i++; continue; }
    let j = i; while (j < n && cov[j] <= low) j++;
    if (j < n && (j - i) * bin >= size * 0.6) gaps.push({ a: minX + i * bin, b: minX + j * bin });
    i = j;
  }
  // Aan beide kanten moet een echte kolom staan: een paar regels van behoorlijke breedte.
  const edges = [minX, ...gaps.flatMap(g => [g.a, g.b]), maxX];
  const ok = gaps.filter((g, k) => [[edges[2 * k], g.a], [g.b, edges[2 * k + 3]]].every(([x0, x1]) =>
    x1 - x0 >= size * 4 && ls.filter(l => l.words >= 3 && l.x0 >= x0 - size && l.x1 <= x1 + size).length >= 3));
  return ok;
}

/** Tesseract knipt regels op een kromme of onscherpe pagina soms in stukken, verdeeld over
    verschillende blokken, waardoor de volgorde niet meer klopt. Stukken op dezelfde hoogte in dezelfde
    kolom worden weer één regel. Bij één tekstkolom komen de regels daarna van boven naar beneden; bij
    meer kolommen kolom voor kolom, met koppen die over meer kolommen lopen ertussen. */
function reorder(lines) {
  if (lines.length < 3) return lines;
  const size = median(lines.filter(l => l.words >= 4).map(l => l.size));
  const gaps = findColumnGaps(lines, size);
  // Kolom van een regel, of -1 als hij over een tussenruimte heen loopt (of geen letters heeft).
  const colOf = (l) => {
    if (!/\p{L}/u.test(l.text)) return -1;
    let c = 0;
    for (const g of gaps) { if (l.x0 < g.a && l.x1 > g.b) return -1; if (l.x0 >= (g.a + g.b) / 2) c++; }
    return c;
  };
  const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const sorted = [...lines].sort((a, b) => a.x0 - b.x0);
  const out = [], owner = new Map();
  for (const l of sorted) {
    const h = l.y1 - l.y0, cl = colOf(l);
    const m = out.find(o => {
      const gap = l.x0 - o.x1;
      if (vOverlap(o, l) <= 0.6 * Math.min(h, o.y1 - o.y0) || gap <= -o.size * 0.5) return false;
      // Niet over de ruimte tussen twee kolommen heen plakken, behalve stukken van een grote kop.
      if (gaps.length && colOf(o) !== cl) return Math.min(o.size, l.size) >= size * 1.3 && gap < Math.max(o.size, l.size) * 1.5;
      return gap < Math.max(o.size, l.size) * 2.5;
    });
    if (!m) { const o = { ...l }; out.push(o); owner.set(l, o); continue; }
    owner.set(l, m);
    const n = m.words + l.words;
    m.conf = (m.conf * m.words + l.conf * l.words) / n;
    if (l.words > m.words) m.block = l.block;
    m.text = `${m.text} ${l.text}`;
    m.styled = `${m.styled ?? m.text} ${l.styled ?? l.text}`;
    m.words = n; m.x1 = Math.max(m.x1, l.x1);
    m.y0 = Math.min(m.y0, l.y0); m.y1 = Math.max(m.y1, l.y1);
  }
  const yc = (l) => l.y0 + l.y1;
  // Binnen één kolom staat op elke hoogte maar één regel: stukken op dezelfde hoogte (bv. door een
  // lichtvlek van de lamp ver uit elkaar) worden van links naar rechts één regel.
  const rowsOf = (ls) => {
    const rows = [];
    for (const l of [...ls].sort((a, b) => yc(a) - yc(b))) {
      const r = rows[rows.length - 1];
      if (r && vOverlap(r, l) > 0.5 * Math.min(r.y1 - r.y0, l.y1 - l.y0)) r.parts.push(l), r.y0 = Math.min(r.y0, l.y0), r.y1 = Math.max(r.y1, l.y1);
      else rows.push({ parts: [l], y0: l.y0, y1: l.y1 });
    }
    return rows.map(({ parts }) => {
      if (parts.length === 1) return parts[0];
      parts.sort((a, b) => a.x0 - b.x0);
      const m = { ...parts[parts.reduce((bi, p, i) => (p.words > parts[bi].words ? i : bi), 0)] };
      m.text = parts.map(p => p.text).join(' ');
      m.styled = parts.map(p => p.styled ?? p.text).join(' ');
      m.words = parts.reduce((n, p) => n + p.words, 0);
      m.conf = parts.reduce((n, p) => n + p.conf * p.words, 0) / m.words;
      m.x0 = parts[0].x0; m.x1 = Math.max(...parts.map(p => p.x1));
      m.y0 = Math.min(...parts.map(p => p.y0)); m.y1 = Math.max(...parts.map(p => p.y1));
      return m;
    });
  };
  if (gaps.length) {
    if (globalThis.__dbg) console.log('[ocr] kolommen', gaps.map(g => `${Math.round(g.a)}-${Math.round(g.b)}`).join(' '));
    // Regels over de volle breedte (koppen) delen de pagina in banden; per band kolom voor kolom.
    const span = out.filter(l => colOf(l) < 0).sort((a, b) => yc(a) - yc(b));
    const inCols = out.filter(l => colOf(l) >= 0);
    const res = [];
    let band = 0;
    for (let k = 0; k <= span.length; k++) {
      const top = k ? yc(span[k - 1]) : -Infinity, bottom = k < span.length ? yc(span[k]) : Infinity;
      let first = true;
      for (let c = 0; c <= gaps.length; c++) {
        const col = rowsOf(inCols.filter(l => colOf(l) === c && yc(l) > top && yc(l) <= bottom));
        col.forEach((l, i) => { l.block = `k${band}-${c}`; l.newCol = i === 0 && !first; });
        if (col.length) first = false;
        res.push(...col);
      }
      band++;
      if (k < span.length) { span[k].block = `s${k}`; res.push(span[k]); }
    }
    return res;
  }
  const full = out.filter(l => l.words >= 4);
  if (full.length >= 5) {
    const c0 = median(full.map(l => l.x0)), c1 = median(full.map(l => l.x1));
    const inCol = (l) => Math.min(l.x1, c1) - Math.max(l.x0, c0) > 0.5 * (l.x1 - l.x0);
    if (full.filter(inCol).length >= full.length * 0.85) {
      out.sort((a, b) => yc(a) - yc(b));
      // Eén kolom: Tesseracts blokindeling is dan willekeurig; alinea's volgen uit inspringen en witregels.
      const cnt = {};
      for (const l of out) cnt[l.block] = (cnt[l.block] || 0) + l.words;
      const main = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
      for (const l of out) l.block = main;
      return out;
    }
  }
  // Geen duidelijke kolommen (kaders, tabellen): Tesseracts volgorde aanhouden.
  return lines.map(l => owner.get(l)).filter((o, i, a) => a.indexOf(o) === i);
}

/** Bouwt Markdown uit de regels die Tesseract vindt: alinea's, koppen, citaten en opsommingen.
    dropCaps: [{ letter, x0, y0, x1, y1 }] (grote beginletters die apart zijn herkend).
    sparse: losse tekst (omslag, kaders) — elke regel blijft een eigen regel. */
export function buildText(blocks, { dropCaps = [], sparse = false, freq = null, figures = [] } = {}) {
  const lines = collectLines(blocks);
  // Kopregel bovenaan in hoofdletters (bv. "3 · GEHEUGEN") is meestal een terugkerende paginakop.
  const isRunningHead = (t) => {
    const L = t.replace(/[^\p{L}]/gu, ''), U = L.replace(/[^\p{Lu}]/gu, '');
    return t.split(' ').length <= 8 && L.length >= 3 && U.length >= L.length * 0.7;
  };
  if (!sparse) {
    const bodySize0 = median(lines.filter(l => l.words >= 4).map(l => l.size));
    // Paginanummer bovenaan weg, maar een groot hoofdstuknummer laten staan.
    while (lines.length && ((isPageNum(lines[0].text) && lines[0].size < bodySize0 * 1.35) || (isRunningHead(lines[0].text) && lines[0].size < bodySize0 * 1.3))) lines.shift();
  }
  while (lines.length && isPageNum(lines[lines.length - 1].text)) lines.pop();
  placeFigures(lines, figures);
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
      // Het woord na de beginletter loopt gewoon door: "B" + "Oven" wordt "Boven".
      const low = (t) => t.replace(/^([\uE001-\uE004]*)(\p{Lu})(?=\p{Ll})/u, (_, a, c) => a + c.toLowerCase());
      best.text = cap.letter + low(best.text);
      if (best.styled != null) best.styled = low(best.styled).replace(/^([\uE001-\uE004]*)/, `$1${cap.letter}`);
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
    if (l.kind === 'figure') continue;
    const m = blockM[l.block], width = Math.max(1, m.right - m.left);
    l.m = m; l.width = width;
    const rel = l.size / bodySize;
    const centered = Math.abs((l.x0 + l.x1) / 2 - (m.left + m.right) / 2) < width * 0.05 && l.x1 - l.x0 < width * 0.8
      && l.x0 > m.left + width * 0.06;
    l.kind = 'text';
    const letters = l.text.replace(/[^\p{L}]/gu, '').length;
    const chapterNo = /^\d{1,2}$/.test(l.text.trim()) && rel >= 1.35;
    const headingLike = l.words <= 14 && !/[,;]$/.test(l.text) && (letters >= 3 || chapterNo);
    const iPrev = lines.indexOf(l) - 1;
    const spaceAbove = iPrev < 0 || l.newCol || l.y0 - lines[iPrev].y1 > gap * 1.3;
    if (rel >= 1.35 && headingLike) l.kind = rel >= 1.6 ? 'h2' : 'h3';
    else if (rel >= 1.18 && l.words <= 8 && headingLike && spaceAbove && !/[.!?]$/.test(l.text)) l.kind = 'h3';
    else if (l.bullet || LIST_RE.test(l.text)) l.kind = 'item';
    else if (centered && l.words <= 12 && !sparse) l.kind = 'center';
    l.indentL = (l.x0 - m.left) / width;
    l.indentR = (m.right - l.x1) / width;
  }
  // Paginakop (lopende kop): een korte eerste regel in gewone of kleinere letter, gecentreerd of in
  // kapitalen, met witruimte eronder. Bijvoorbeeld "EEN SUMATRAANSE TIJGER AAN DE MUUR".
  if (!sparse && lines.length >= 8) {
    const [h, n] = lines;
    const caps = isRunningHead(h.text) && h.size < bodySize * 1.3;
    const centered = h.kind === 'center' && h.size < bodySize * 1.15 && h.words <= 8;
    if ((caps || centered) && n.y0 - h.y1 > gap * 1.3) lines.shift();
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
        // Hoofdstuknummer boven de titel hoort er altijd bij.
        join = l.y0 - prev.y1 < Math.max(l.size, prev.size) * 0.9 || (/^\d{1,2}$/.test(cur.text.trim()) && l.y0 - prev.y1 < l.size * 4);
        if (join && l.kind === 'h2') cur.kind = 'h2';
      } else if (sparse) {
        join = false;
      } else if (l.kind === cur.kind && (l.kind === 'text' || l.kind === 'quote') && (l.block === prev.block || l.newCol) || (l.kind === 'text' && cur.kind === 'item' && l.indentL > 0.02)) {
        // l.newCol: bovenaan de volgende kolom loopt de alinea van onder in de vorige kolom door.
        const m = l.m, width = l.width;
        const short = prev.x1 < (prev.m || m).right - (prev.width || width) * 0.1;
        const indent = l.x0 > m.left + width * 0.03 && (l.newCol || l.x0 - prev.x0 > width * 0.03);
        join = !(short && /[.!?:;”"')\]]$/.test(prev.text)) && !bigGap && !(indent && short && cur.kind === 'text');
        if (short && prev.words <= 6 && !/[-,]$/.test(prev.text) && cur.kind === 'text' && cur.lines === 1) join = false;
      } else if (l.kind === 'center' && cur.kind === 'center') {
        join = /[\p{L}]-$/u.test(prev.text) && !bigGap;
      }
    }
    const st = l.styled ?? l.text;
    if (!join) { flush(); cur = { kind: l.kind, text: l.text, styled: st, lines: 1, bullet: l.bullet }; return; }
    cur.lines++;
    if (/[\p{L}][-­]$/u.test(cur.text) && /^\p{Ll}/u.test(l.text)) { // afgebroken woord
      cur.text = cur.text.slice(0, -1) + l.text;
      cur.styled = cur.styled.replace(/[-­]([\uE001-\uE004]*)$/, '$1') + st;
    } else if (freq && !/[\uE001-\uE004]$/.test(cur.styled) && brokenWord(cur.text, l.text, freq) >= 0) {
      // Afbreekstreepje niet (goed) gelezen: "bescher:" + "ming".
      const cut = brokenWord(cur.text, l.text, freq);
      cur.text = cur.text.slice(0, cur.text.length - cut) + l.text;
      cur.styled = cur.styled.slice(0, cur.styled.length - cut) + st;
    } else { cur.text += ' ' + l.text; cur.styled += ' ' + st; }
  });
  flush();
  // Een alinea die om een beeld heen doorloopt: eerst de hele alinea, dan het beeld.
  for (let i = 0; i + 2 < out.length; i++) {
    const a = out[i], b = out[i + 1], c = out[i + 2];
    if (sparse || b.kind !== 'figure' || a.kind !== 'text' || c.kind !== 'text') continue;
    if (/[.!?:”"')\]]$/.test(a.text) || !/^\p{Ll}/u.test(c.text)) continue;
    if (/[\p{L}][-­]$/u.test(a.text)) {
      a.text = a.text.slice(0, -1) + c.text;
      a.styled = a.styled.replace(/[-­]([\uE001-\uE004]*)$/, '$1') + c.styled;
    } else { a.text += ' ' + c.text; a.styled += ' ' + c.styled; }
    a.lines += c.lines;
    out.splice(i + 2, 1);
  }
  // Een blok dat midden in een woord eindigt ("bet-") loopt door in het volgende blok ("gen te zien"),
  // ook als dat als citaat of nieuwe alinea is gezien (inspringing, grote beginletter).
  for (let i = out.length - 2; i >= 0; i--) {
    const a = out[i], b = out[i + 1];
    if (sparse || a.kind.startsWith('h') || b.kind.startsWith('h')) continue;
    if (!/[\p{L}][-­]$/u.test(a.text) || !/^\p{Ll}/u.test(b.text)) continue;
    a.text = a.text.slice(0, -1) + b.text;
    a.styled = a.styled.replace(/[-­]([\uE001-\uE004]*)$/, '$1') + b.styled;
    a.lines += b.lines;
    out.splice(i + 1, 1);
  }

  const md = out.map((b, i) => {
    // Opmaak binnen de tekst alleen in gewone alinea's, citaten en opsommingen.
    const t = clean(!sparse && ['text', 'quote', 'item'].includes(b.kind) ? styleToMd(b.styled) : b.text);
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
      case 'figure': return b.text;
      default: return t;
    }
  });
  // Opeenvolgende opsommingstekens zonder lege regel ertussen.
  const isItem = (x) => /^(- |\d{1,2}\. )/.test(x);
  return md.reduce((acc, s, i) => acc + (i ? (isItem(s) && isItem(md[i - 1]) ? '\n' : '\n\n') : '') + s, '');
}

/** Zet de beelden als eigen regel tussen de tekstregels, op de plek waar ze op de pagina staan,
    en haalt hun bijschrift ("Figuur 3.2 …") uit de lopende tekst. Nummert de beelden (fig.n) in
    leesvolgorde en bewaart het bijschrift in fig.caption. */
function placeFigures(lines, figures) {
  if (!figures || !figures.length) return;
  const body = median(lines.filter(l => l.words >= 4).map(l => l.size)) || 20;
  for (const f of figures) {
    f.n = 0; f.caption = '';
    const hov = (l) => Math.min(l.x1, f.x1) - Math.max(l.x0, f.x0) > 0.3 * Math.min(l.x1 - l.x0, f.x1 - f.x0);
    const isText = (l) => l && l.kind !== 'figure';
    // Bijschrift: eerst eronder zoeken, dan erboven (tabellen).
    let i = lines.findIndex(l => isText(l) && hov(l) && l.y0 >= f.y1 - body && l.y0 - f.y1 < body * 3 && CAPTION_RE.test(l.text));
    if (i < 0) i = lines.findIndex(l => isText(l) && hov(l) && l.y1 <= f.y0 + body && f.y0 - l.y1 < body * 3 && CAPTION_RE.test(l.text));
    if (i >= 0) {
      let j = i;
      // Een bijschrift over meer regels: kleinere letter, dicht op elkaar, de zin loopt door.
      while (isText(lines[j + 1]) && lines[i].size < body * 0.95 && lines[j + 1].size < body * 0.95
        && lines[j + 1].y0 > lines[j].y0 && lines[j + 1].y0 - lines[j].y1 < body * 0.8 && hov(lines[j + 1])) j++;
      const cap = lines.splice(i, j - i + 1);
      f.caption = cap.map(l => l.text).join(' ').replace(/(\p{L})- (\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
    }
    // Plek: na de laatste regel erboven (in dezelfde kolom), anders vóór de eerste eronder.
    let at = -1;
    lines.forEach((l, k) => { if (hov(l) && l.y1 <= f.y0 + body * 0.5) at = k + 1; });
    if (at < 0) { at = lines.findIndex(l => hov(l) && l.y0 >= f.y1 - body); }
    if (at < 0) { const cy = (f.y0 + f.y1) / 2; at = lines.findIndex(l => (l.y0 + l.y1) / 2 > cy); }
    if (at < 0) at = lines.length;
    lines.splice(at, 0, { kind: 'figure', fig: f, text: '', styled: '', words: 0, size: body, block: -1, conf: 100,
      x0: f.x0, x1: f.x1, y0: f.y0, y1: f.y1 });
  }
  let n = 0;
  for (const l of lines) if (l.kind === 'figure') { l.fig.n = ++n; l.text = l.styled = figureMarkdown(n, l.fig.caption); }
}

/** Hoort het laatste woord van regel a bij het eerste van regel b, terwijl het afbreekstreepje niet
    (of als punt of dubbele punt) is gelezen? Geeft het stuk terug dat van a af moet, of -1. */
function brokenWord(a, b, freq) {
  const m = a.match(/(\p{L}+)([.:]?)$/u), y = b.match(/^(\p{Ll}+)(?![\p{L}-])/u)?.[1];
  if (!m || !y) return -1;
  const x = m[1];
  const k = (w) => freq.get(w.toLowerCase()) ?? -1;
  // Samen een bekend woord, en een van de stukken bestaat los niet ("bescher" + "ming").
  if (k(x + y) >= 7 && (k(x) < 0 || k(y) < 0)) return m[2].length;
  // Een regel die midden in een onbekend woord eindigt op '.' of ':' terwijl de volgende met een
  // kleine letter begint: dat was een afbreekstreepje ("tabakshisto." + "riën").
  if (m[2] && x.length >= 5 && k(x) < 0) return 1;
  return -1;
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

/** Laadt een foto. In een worker (geen document) als ImageBitmap, met naturalWidth/-Height erbij. */
export function loadImage(blob) {
  if (typeof document === 'undefined') {
    return createImageBitmap(blob).then((b) => Object.assign(b, { naturalWidth: b.width, naturalHeight: b.height }),
      () => { throw new Error('Afbeelding kon niet worden geladen'); });
  }
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
  const c = newCanvas(swap ? h : w, swap ? w : h);
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate((rotate * Math.PI) / 180);
  g.drawImage(img, -w / 2, -h / 2, w, h);
  img.close?.();
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise(r => c.toBlob(r, 'image/jpeg', quality));
}

/** Grootste zijde (pixels) waarmee een foto wordt herkend. Op de computer hoger, zodat een
    4K-opname van een open boek vanaf de lamp niet onnodig wordt verkleind. */
export const ocrConfig = {
  maxSide: 2200,
  // Vergroten tot de regelafstand zo veel pixels is (0 = niet), of een vaste factor (upscale).
  lineHeight: 100, upscale: 0,
  // Zwart-witomzetting per buurt (Sauvola) in plaats van één drempel voor de hele pagina:
  // houdt de letters bij de rug en in de lampschaduw heel.
  params: { thresholding_method: '2' },
};

function scaleCanvas(c, f) {
  const o = newCanvas(Math.round(c.width * f), Math.round(c.height * f));
  const g = o.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(c, 0, 0, o.width, o.height);
  return o;
}

/** Zet de vakjes van Tesseract terug naar de schaal van het voorbewerkte beeld. */
function scaleBoxes(blocks, f) {
  const sb = (o) => { if (o?.bbox) for (const k of ['x0', 'y0', 'x1', 'y1']) o.bbox[k] *= f; if (o?.rowAttributes) for (const k in o.rowAttributes) o.rowAttributes[k] *= f; if (o?.baseline) for (const k of ['x0', 'y0', 'x1', 'y1']) if (k in o.baseline) o.baseline[k] *= f; };
  for (const b of blocks || []) { sb(b); for (const p of b.paragraphs || []) { sb(p); for (const l of p.lines || []) { sb(l); for (const w of l.words || []) { sb(w); for (const s of w.symbols || []) sb(s); } } } }
}

async function grayOf(blob) {
  const im = await loadImage(blob);
  const scale = Math.min(1, ocrConfig.maxSide / Math.max(im.naturalWidth, im.naturalHeight));
  const c = newCanvas(Math.round(im.naturalWidth * scale), Math.round(im.naturalHeight * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, c.width, c.height);
  im.close?.();
  const gray = grayFromCanvas(c);
  // De kleuren blijven bewaard om beelden later in kleur uit te knippen.
  gray.src = { d: ctx.getImageData(0, 0, c.width, c.height).data, W: c.width, H: c.height };
  return gray;
}

/** Maakt de foto klaar voor herkenning: pagina rechtzetten, belichting, scheefstand, kromming,
    kaderlijnen en grote beginletters. Staan er twee pagina's op (open boek), dan wordt de foto
    bij de rug in tweeën geknipt. Geeft { pages: [...], steps, canvas } terug. */
export async function prepareForOcr(blob) {
  let img = await grayOf(blob);
  const src = img.src;
  const steps = [];
  // Elke stap die de pagina verplaatst, onthoudt hoe je terugrekent naar de foto (voor de beelden).
  const base = [];
  const quad = findPage(img);
  if (quad) { img = warpPage(img, quad); base.push(img.back); steps.push('pagina'); }

  let photo = img;
  img = normalizeLight(img);
  // Twee pagina's? Eerst het geheel rechtzetten, dan de rug zoeken.
  let halves = [[img, photo, []]];
  // Veel omgeving in beeld (lampopstelling: bureau, lampkap, hand)? Dan zoeken we de scheefstand
  // en de rug alleen binnen het boek. Anders kan de rand van de lampkap voor de rug worden
  // aangezien, en trekt de lampkap de scheefstand scheef. Er wordt niets weggeknipt.
  let x0 = 0, x1 = img.W;
  if (!quad) {
    const box = bookCrop(photo);
    if (box) {
      const ex = box.w * 0.05;
      const a0 = Math.max(0, Math.round(box.x - ex)), a1 = Math.min(img.W, Math.round(box.x + box.w + ex));
      if (a1 - a0 < img.W * 0.95) { x0 = a0; x1 = a1; }
    }
  }
  const inBook = (im) => (x0 > 0 || x1 < im.W ? cropX(im, x0, x1) : im);
  const book = inBook(img);
  if (book.W > book.H * 1.1) {
    const a = estimateSkew(book);
    const straight = Math.abs(a) >= 0.3 ? rotate(img, a) : img;
    const sp = Math.abs(a) >= 0.3 ? rotate(photo, a) : photo;
    const inner = findGutter(inBook(straight), inBook(sp));
    if (inner) {
      const gx = x0 + inner;
      const rot = Math.abs(a) >= 0.3 ? straight.back : null;
      const L = cropX(straight, 0, gx), R = cropX(straight, gx, straight.W);
      halves = [[L, cropX(sp, 0, gx), [rot, L.back]], [R, cropX(sp, gx, sp.W), [rot, R.back]]];
      steps.push(x0 > 0 || x1 < img.W ? "twee pagina's (rug binnen het boek)" : "twee pagina's");
    }
  }
  const pages = halves.map(([g, p, ch], i) => preparePage(g, p, steps, halves.length > 1 ? (i ? 'left' : 'right') : false, [...base, ...ch], src));
  return { pages, steps, canvas: pages[0].canvas };
}

// half: false bij één pagina, anders de kant van de rug ('left' of 'right').
function preparePage(img, photo, steps, half = false, chain = [], src = null) {
  chain = [...chain];
  let smooth = null;
  const cs = cropSides(img, { inner: half || null });
  if (cs.cropped) { img = cs.img; steps.push('buurpagina weg'); }
  let angle = estimateSkew(img);
  // Bij een open boek is het geheel al rechtgezet; een grote hoek per pagina is dan ruis (rand, tafel).
  if (half && Math.abs(angle) > 6) angle = 0;
  if (Math.abs(angle) >= 0.3) { img = rotate(img, angle); chain.push(img.back); steps.push(`scheef ${angle.toFixed(1)}°`); }
  const dw = dewarp(img);
  if (dw.warped) { img = dw.img; chain.push(img.back); smooth = [...chain.slice(0, -1), img.backSmooth]; steps.push(`krom ${Math.round(dw.maxOff)}px`); }
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
  return { canvas: canvasFromGray(img), gray: img, dropCaps, crops, inverted, src, back: chainBack(chain), backCrop: chainBack(smooth || chain) };
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

// Korte woorden die Tesseract soms aan een buurwoord plakt ("perweek", "regelis"). Geen voorzetsels
// die ook een werkwoord kunnen beginnen (op, aan, in, uit, om ...): "opwaaien" moet heel blijven.
const GLUE_A = new Set(['de', 'het', 'een', 'en', 'is', 'ik', 'al', 'wij', 'zij', 'hij', 'uw', 'ter', 'dat', 'die', 'als', 'per', 'of', 'ook', 'nog', 'niet', 'was', 'mijn']);
// Als tweede deel geen 'de', 'en', 'er', 'te': dat zijn ook gewone uitgangen ("lezende", "oerwouden").
const GLUE_B = new Set(['is', 'het', 'een', 'die', 'dat', 'niet', 'ook', 'nog', 'was', 'én']);
// Alleen accenten die in gewone Nederlandse tekst bijna nooit voorkomen (é en á wel: één, dáár).
const ACCENTS = { à: 'a', è: 'e', í: 'i', ì: 'i', ò: 'o', ù: 'u' };

/** Herstelt woorden die niet bestaan maar wel bestaan zonder los accent ("níet") of als twee woorden
    waarvan één een kort, veelvoorkomend woord is ("perweek" → "per week"). */
export function fixSpacing(text, freq) {
  let fixed = 0;
  if (!freq || !freq.size) return { text, fixed };
  const known = (w, min = 0) => (freq.get(w) ?? -1) >= min;
  const out = text.replace(/\p{L}{2,}/gu, (orig) => {
    const w = orig.toLowerCase();
    if (known(w) || (orig.length > 1 && orig === orig.toUpperCase())) return orig;
    // Los accent op een woord dat zonder accent gewoon bestaat.
    const plain = w.replace(/[àèíìòù]/g, (c) => ACCENTS[c]);
    if (plain !== w && known(plain, 10) && !/^(een|en|of|die|dat|voor)$/.test(plain)) { fixed++; return matchCase(orig, plain); }
    if (w.length < 4) return orig;
    let best = null, bs = -1;
    for (let i = 2; i <= w.length - 2; i++) {
      const a = w.slice(0, i), b = w.slice(i);
      const glueA = GLUE_A.has(a), glueB = GLUE_B.has(b);
      if (!glueA && !glueB) continue;
      const other = glueA ? b : a;
      if (other.length < 2 || !known(other, other.length <= 3 ? 14 : 9)) continue;
      const sc = Math.min(freq.get(a), freq.get(b));
      if (sc > bs) { bs = sc; best = [orig.slice(0, i), orig.slice(i)]; }
    }
    if (!best) return orig;
    fixed++;
    return best.join(' ');
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
  /** opts.figures: per pagina de kaders van de beelden (0–1 van de pagina), als je ze zelf hebt
      aangepast; anders zoekt de herkenning ze zelf. */
  async recognize(blob, lang, onProgress, opts = {}) {
    const w = await this.get(lang);
    const deg = await this.orientation(blob, lang);
    let image = null;
    if (deg) { image = await resizeToBlob(blob, ocrConfig.maxSide, 0.92, deg); blob = image; }
    const prep = await prepareForOcr(blob);
    if (deg) prep.steps.unshift(`gedraaid ${deg}°`);
    const pages = [];
    for (let i = 0; i < prep.pages.length; i++) {
      pages.push(await this.recognizePage(w, prep.pages[i], prep.steps, onProgress && ((m) => {
        onProgress(m.status === 'recognizing text' ? { ...m, progress: (i + m.progress) / prep.pages.length } : m);
      }), opts.figures?.[i]));
    }
    // Beelden in kleur uitknippen, en de rechtgezette pagina bewaren (om kaders later aan te passen).
    let nf = 0;
    for (let i = 0; i < pages.length; i++) {
      const pp = prep.pages[i], p = pages[i], { W, H } = pp.gray;
      if (!pp.src) continue;
      for (const f of p.figures) {
        const sc = Math.min(1, 1600 / Math.max(f.x1 - f.x0, f.y1 - f.y0));
        f.blob = await canvasToJpeg(cropColor(pp.src, pp.backCrop, f, sc), 0.88);
        f.box = [f.x0 / W, f.y0 / H, f.x1 / W, f.y1 / H];
        nf++;
      }
      p.figures = p.figures.map(({ n, caption, box, blob }) => ({ n, caption, box, blob }));
      p.scan = await canvasToJpeg(cropColor(pp.src, pp.backCrop, { x0: 0, y0: 0, x1: W, y1: H }, Math.min(1, 2000 / Math.max(W, H))), 0.8);
    }
    if (nf) prep.steps.push(`beelden ×${nf}`);
    if (lang.split('+').includes('nld')) {
      const freq = await loadWordFreq();
      let n = 0;
      for (const p of pages) { const r = fixWords(p.text, freq); const r2 = fixSpacing(r.text, freq); p.text = r2.text; n += r.fixed + r2.fixed; }
      if (n) prep.steps.push(`woorden ×${n}`);
    }
    const text = pages.map(p => p.text).join('\n\n');
    const confidence = Math.round(pages.reduce((s, p) => s + p.confidence, 0) / pages.length);
    console.debug('[ocr]', prep.steps.join(', ') || 'geen voorbewerking', `${confidence}%`);
    return { text, confidence, steps: prep.steps, pages, image, rotated: deg };
  },
  async recognizePage(w, prep, steps, onProgress, manual = null) {
    // Grote beginletters los herkennen, als één hoofdletter.
    for (let i = 0; i < prep.dropCaps.length; i++) {
      await w.setParameters({ tessedit_pageseg_mode: '10', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÁÂÄÉÈÊËÍÏÓÖÔÚÜ' });
      const { data } = await w.recognize(prep.crops[i], {}, { text: true });
      const t = (data.text || '').trim();
      if (/^\p{Lu}$/u.test(t) && data.confidence > 30) prep.dropCaps[i].letter = t;
    }
    await w.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '', ...(ocrConfig.params || {}) });
    this.onProgress = onProgress;
    // Tesseract leest het best als de letters groot genoeg zijn: vergroten tot de regelafstand ongeveer
    // ocrConfig.lineHeight pixels is (een liggende 4K-opname van een open boek heeft er zo'n 40).
    const sp = lineSpacing(prep.gray);
    const up = ocrConfig.upscale || (sp && ocrConfig.lineHeight ? Math.min(2.5, Math.max(1, ocrConfig.lineHeight / sp)) : 1);
    if (globalThis.__dbg) console.log('[ocr] regelafstand', sp, 'vergroting', up.toFixed(2));
    let { data } = await w.recognize(up !== 1 ? scaleCanvas(prep.canvas, up) : prep.canvas, {}, { text: true, blocks: true });
    if (up !== 1) scaleBoxes(data.blocks, 1 / up);
    this.onProgress = null;
    markStyles(data.blocks, prep.gray);
    // Beelden zoeken (of de kaders gebruiken die je zelf hebt getekend) en hun woorden uit de tekst halen.
    const { W: PW, H: PH } = prep.gray;
    let figures = [];
    if (manual) figures = manual.map(([a, b, c, d]) => ({ x0: a * PW, y0: b * PH, x1: c * PW, y1: d * PH }));
    else if (data.blocks && ocrConfig.figures !== false) {
      try { figures = detectFigures(prep.gray, prep.src ? toneSampler(prep.src, prep.back) : null, data.blocks); }
      catch (err) { console.warn('[ocr] beelden zoeken mislukt', err); }
    }
    if (figures.length) dropFigureWords(data.blocks, figures);
    const freq = this.lang?.split('+').includes('nld') ? await loadWordFreq() : null;
    let text = data.blocks ? buildText(data.blocks, { dropCaps: prep.dropCaps, freq, figures }) : tidy(data.text || '');
    let confidence = data.confidence;
    // Weinig of onzekere tekst (omslag, kaders, tekst rond een plaatje)? Probeer losse-tekstmodus,
    // zowel op de gewone als op de omgekeerde versie (lichte letters op een donkere ondergrond).
    if (data.blocks && (confidence < 65 || text.split(/\s+/).length < 40)) {
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const a = (await w.recognize(prep.canvas, {}, { text: true, blocks: true })).data;
      const b = (await w.recognize(prep.inverted(), {}, { text: true, blocks: true })).data;
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      const blocks = mergeBlocks(dropFigureWords(a.blocks || [], figures), dropFigureWords(b.blocks || [], figures));
      if (score(blocks) > score(data.blocks) * 1.15) {
        text = buildText(blocks, { dropCaps: prep.dropCaps, sparse: true, figures });
        confidence = Math.max(a.confidence, b.confidence);
        if (!steps.includes('losse tekst')) steps.push('losse tekst');
      }
    }
    return { text, confidence: Math.round(confidence), figures: figures.filter(f => f.n) };
  },
};
