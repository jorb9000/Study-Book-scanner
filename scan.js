/* Voorbewerking van een foto vóór de tekstherkenning. Alles in gewone JavaScript, op het toestel.
   1. Pagina vinden en perspectief rechtzetten (foto schuin van boven genomen).
   2. Belichting gelijkmatig maken, ook voor lichte tekst op een donkere achtergrond (omslagen, kaders).
   3. Scheefstand wegwerken.
   4. Kromme regels rechttrekken (pagina die opbolt bij de rug van een dik boek).
   5. Lange lijnen van kaders weghalen.
   6. Grote beginletters (initialen) opsporen, zodat ze apart herkend kunnen worden. */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const median = (a) => { const b = Float64Array.from(a).sort(); return b.length ? b[b.length >> 1] : 0; };

/* ---------- Hulpjes ---------- */

export function grayFromCanvas(c) {
  const W = c.width, H = c.height;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return { g, W, H };
}

export function canvasFromGray({ g, W, H }) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(W, H), d = id.data;
  for (let i = 0, j = 0; j < g.length; i += 4, j++) { d[i] = d[i + 1] = d[i + 2] = g[j]; d[i + 3] = 255; }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Verkleint met blokgemiddelde (voor snelle analyse). */
function shrink({ g, W, H }, f) {
  const w = Math.max(1, Math.floor(W / f)), h = Math.max(1, Math.floor(H / f));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) { const r = (y * f + dy) * W + x * f; for (let dx = 0; dx < f; dx++) s += g[r + dx]; }
    out[y * w + x] = s / (f * f);
  }
  return { g: out, W: w, H: h };
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = g.length - wB; if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

/* ---------- 1. Pagina vinden en perspectief ---------- */

/** Zoekt het lichte papier tegen een donkere ondergrond. Geeft vier hoeken terug, of null. */
export function findPage(img) {
  const f = Math.max(1, Math.round(Math.max(img.W, img.H) / 400));
  const s = shrink(img, f);
  const { g, W, H } = s;
  const t0 = otsu(g);
  // Alleen zinvol als er echt een donkere ondergrond is.
  let dark = 0, darkSum = 0; for (let i = 0; i < g.length; i++) if (g[i] < t0) { dark++; darkSum += g[i]; }
  if (dark / g.length < 0.06) return null;
  // Drempel wat lager dan Otsu, zodat papier in de schaduw van de rug nog meetelt.
  const t = (t0 + darkSum / dark) / 2;
  // Grootste lichte gebied (4-buren), via een stapel.
  const lab = new Int32Array(W * H).fill(-1);
  let bestSize = 0, bestLab = -1, n = 0;
  const stack = new Int32Array(W * H);
  for (let i = 0; i < g.length; i++) {
    if (lab[i] !== -1 || g[i] < t) continue;
    let sp = 0, size = 0; stack[sp++] = i; lab[i] = n;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % W, y = (p / W) | 0;
      if (x > 0 && lab[p - 1] === -1 && g[p - 1] >= t) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (x < W - 1 && lab[p + 1] === -1 && g[p + 1] >= t) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (y > 0 && lab[p - W] === -1 && g[p - W] >= t) { lab[p - W] = n; stack[sp++] = p - W; }
      if (y < H - 1 && lab[p + W] === -1 && g[p + W] >= t) { lab[p + W] = n; stack[sp++] = p + W; }
    }
    if (size > bestSize) { bestSize = size; bestLab = n; }
    n++;
  }
  const area = bestSize / (W * H);
  if (area < 0.2 || area > 0.95) return null;
  // Loopt de pagina buiten de foto? Dan kloppen de hoeken niet.
  const side = [0, 0, 0, 0];
  for (let x = 0; x < W; x++) { if (lab[x] === bestLab) side[0]++; if (lab[(H - 1) * W + x] === bestLab) side[1]++; }
  for (let y = 0; y < H; y++) { if (lab[y * W] === bestLab) side[2]++; if (lab[y * W + W - 1] === bestLab) side[3]++; }
  if (side[0] > W * 0.05 || side[1] > W * 0.05 || side[2] > H * 0.05 || side[3] > H * 0.05) return null;
  // Hoeken: uiterste punten langs de diagonalen.
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, -Infinity];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lab[y * W + x] !== bestLab) continue;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (y - x > bl[2]) bl = [x, y, y - x];
  }
  const quad = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) * f, (y + 0.5) * f]);
  // Lijkt het gebied op een vierhoek? Anders liever niets doen.
  const qa = Math.abs(quad.reduce((a, p, i) => { const q = quad[(i + 1) % 4]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const ratio = (bestSize * f * f) / qa;
  if (ratio < 0.88 || ratio > 1.12) return null;
  // Al vrijwel recht en paginavullend? Dan is er niets te winnen.
  const shrinkIn = 0.006;
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  return quad.map(([x, y]) => [x + (cx - x) * shrinkIn * 2, y + (cy - y) * shrinkIn * 2]);
}

/**
 * Ruwe rechthoek om de bedrukte pagina's, voor het inzoomen van het live beeld.
 * Zoekt vakjes met tekst (licht papier met veel fijne contrasten). Een effen lampkap,
 * het bureau of een hand tellen daardoor niet mee. Geeft { x, y, w, h } in pixels van img, of null.
 */
export function findBookBox(img) {
  const { g, W, H } = img;
  const c = Math.max(4, Math.round(Math.max(W, H) / 60));   // vakjesgrootte
  const cw = Math.floor(W / c), ch = Math.floor(H / c);
  if (cw < 8 || ch < 8) return null;
  // Drempel tussen ondergrond en papier. Bewust laag: de lamp verlicht de ene pagina
  // veel feller dan de andere, en ook de donkere pagina moet meetellen.
  const hist = new Uint32Array(256); for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const pct = (q) => { let n = 0; for (let v = 0; v < 256; v++) { n += hist[v]; if (n >= q * g.length) return v; } return 255; };
  const lo = pct(0.1), hi = pct(0.95);
  if (hi - lo < 40) return null;
  const t = lo + (hi - lo) * 0.25;
  const text = new Uint8Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let sum = 0, edge = 0;
    for (let y = cy * c; y < cy * c + c; y++) for (let x = cx * c; x < cx * c + c; x++) {
      const p = y * W + x;
      sum += g[p];
      if (x + 1 < W) edge += Math.abs(g[p] - g[p + 1]);
      if (y + 1 < H) edge += Math.abs(g[p] - g[p + W]);
    }
    const mean = sum / (c * c), e = edge / (c * c);
    text[cy * cw + cx] = mean > t && e > 6 ? 1 : 0;
  }
  // Reeks rijen/kolommen met genoeg tekstvakjes. Gaten tot 15% (de rug, witregels) mogen;
  // van de reeksen telt die met de meeste tekst.
  const run = (counts, min) => {
    const maxGap = Math.max(2, Math.round(counts.length * 0.15));
    let best = null, cur = null, gap = 0;
    const close = () => { if (cur && (!best || cur.n > best.n)) best = cur; cur = null; };
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] >= min) {
        if (cur) cur.end = i; else cur = { start: i, end: i, n: 0 };
        cur.n += counts[i]; gap = 0;
      } else if (cur && ++gap > maxGap) { close(); gap = 0; }
    }
    close();
    return best && [best.start, best.end];
  };
  const cols = new Array(cw).fill(0), rows = new Array(ch).fill(0);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) if (text[cy * cw + cx]) { cols[cx]++; rows[cy]++; }
  const xr = run(cols, Math.max(2, ch * 0.15)), yr = run(rows, Math.max(2, cw * 0.15));
  if (!xr || !yr) return null;
  // Uitbreiden zolang de rand ernaast vooral (bedrukt) papier is: zo komen ook flauwe
  // tekst in het felle licht en de paginamarge mee, maar niet het bureau of de schaduw.
  let [x0, x1] = xr, [y0, y1] = yr;
  const paper = (cx0, cx1, cy0, cy1) => {
    let on = 0, n = 0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      n++;
      let sum = 0;
      for (let y = cy * c; y < cy * c + c; y += 2) for (let x = cx * c; x < cx * c + c; x += 2) sum += g[y * W + x];
      if (sum / Math.ceil(c / 2) ** 2 > t) on++;
    }
    return n && on / n > 0.6;
  };
  for (let grew = true; grew;) {
    grew = false;
    if (y0 > 0 && paper(x0, x1, y0 - 1, y0 - 1)) { y0--; grew = true; }
    if (y1 < ch - 1 && paper(x0, x1, y1 + 1, y1 + 1)) { y1++; grew = true; }
    if (x0 > 0 && paper(x0 - 1, x0 - 1, y0, y1)) { x0--; grew = true; }
    if (x1 < cw - 1 && paper(x1 + 1, x1 + 1, y0, y1)) { x1++; grew = true; }
  }
  const box = { x: x0 * c, y: y0 * c, w: (x1 - x0 + 1) * c, h: (y1 - y0 + 1) * c };
  if (box.w * box.h < 0.08 * W * H) return null;
  return box;
}

/** Homografie die (0,0),(w,0),(w,h),(0,h) afbeeldt op de vier hoeken. */
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) { // Gauss-eliminatie
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let k2 = c; k2 < 8; k2++) A[r][k2] -= k * A[c][k2];
      b[r] -= k * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

export function warpPage(img, quad) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.round(Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])));
  const h = Math.round(Math.max(d(quad[0], quad[3]), d(quad[1], quad[2])));
  const [a, b2, c, dd, e, f, g2, h2] = homography(w, h, quad);
  const out = new Uint8ClampedArray(w * h);
  const { g, W, H } = img;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const z = g2 * x + h2 * y + 1;
    const u = (a * x + b2 * y + c) / z, v = (dd * x + e * y + f) / z;
    const x0 = clamp(Math.floor(u), 0, W - 2), y0 = clamp(Math.floor(v), 0, H - 2);
    const tx = clamp(u - x0, 0, 1), ty = clamp(v - y0, 0, 1), i = y0 * W + x0;
    out[y * w + x] = (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + W] * (1 - tx) + g[i + W + 1] * tx) * ty;
  }
  return { g: out, W: w, H: h };
}

/* ---------- 2. Belichting ---------- */

/** Deelt elk pixel door de lokale achtergrond, zodat papier wit en inkt zwart wordt.
    Haalt schaduwen, vignettering en donkere randen weg. Met invert: true wordt lichte tekst op een
    donkere ondergrond (omslag, gekleurd kader) juist donker op wit. */
export function normalizeLight({ g, W, H }, { invert = false } = {}) {
  const px = invert ? (i) => 255 - g[i] : (i) => g[i];
  const B = Math.max(16, Math.round(Math.max(W, H) / 60));
  const gw = Math.ceil(W / B), gh = Math.ceil(H / B);
  const grid = new Float32Array(gw * gh);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = ((y / B) | 0) * gw + ((x / B) | 0), v = px(y * W + x);
    if (v > grid[k]) grid[k] = v;
  }
  const sm = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < gh && xx >= 0 && xx < gw) { sum += grid[yy * gw + xx]; n++; }
    }
    sm[y * gw + x] = Math.max(sum / n, 1);
  }
  const out = new Uint8ClampedArray(W * H);
  const at = (x, y) => sm[Math.min(gh - 1, y) * gw + Math.min(gw - 1, x)];
  for (let y = 0; y < H; y++) {
    const fy = clamp(y / B - 0.5, 0, gh - 1), y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = clamp(x / B - 0.5, 0, gw - 1), x0 = fx | 0, tx = fx - x0;
      const bg = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      const v = px(y * W + x) / bg; // 1 = papier
      out[y * W + x] = v >= 0.9 ? 255 : Math.max(0, (v - 0.35) / 0.55) * 255;
    }
  }
  return { g: out, W, H };
}

/** Maakt donkere vlekken die de rand raken wit (rand van de pagina, tafel, vinger). */
export function clearBorders({ g, W, H }) {
  const stack = [];
  const push = (i) => { if (g[i] < 128) { g[i] = 255; stack.push(i); } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  let n = 0;
  while (stack.length) {
    const p = stack.pop(); n++;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) push(p - 1); if (x < W - 1) push(p + 1);
    if (y > 0) push(p - W); if (y < H - 1) push(p + W);
  }
  return n;
}

/** Knipt smalle stroken tekst van de buurpagina aan de linker- en rechterrand weg. */
export function cropSides(img) {
  const f = 4;
  const { g, W, H } = shrink(img, f);
  const col = new Float64Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] < 140) col[x]++;
  const r = Math.max(1, Math.round(W * 0.006));
  const sm = col.map((_, x) => { let v = 0, n = 0; for (let d = -r; d <= r; d++) if (x + d >= 0 && x + d < W) { v += col[x + d]; n++; } return v / n; });
  const thr = Math.max(...sm) * 0.04;
  // Aaneengesloten stukken met inkt; kleine tussenruimtes horen er nog bij.
  const segs = [];
  let start = -1, lastInk = -1;
  for (let x = 0; x <= W; x++) {
    const on = x < W && sm[x] > thr;
    if (on) { if (start < 0) start = x; lastInk = x; }
    else if (start >= 0 && (x === W || x - lastInk > W * 0.015)) { segs.push([start, lastInk]); start = -1; }
  }
  if (segs.length < 2) return { img, cropped: false };
  const main = Math.max(...segs.map(([a, b]) => b - a));
  const edge = W * 0.03;
  const keep = segs.filter(([a, b]) => !((b - a) < main * 0.25 && (a <= edge || b >= W - 1 - edge)));
  if (keep.length === segs.length || !keep.length) return { img, cropped: false };
  const pad = Math.round(W * 0.015);
  // Wit maken in plaats van bijsnijden, zodat de afmetingen gelijk blijven.
  const xa = Math.max(0, keep[0][0] - pad) * f, xb = Math.min(W, keep[keep.length - 1][1] + 1 + pad) * f;
  const out = Uint8ClampedArray.from(img.g);
  for (let y = 0; y < img.H; y++) { out.fill(255, y * img.W, y * img.W + xa); out.fill(255, y * img.W + xb, (y + 1) * img.W); }
  return { img: { g: out, W: img.W, H: img.H }, cropped: true };
}

/* ---------- 2b. Twee pagina's tegelijk (open boek) en kwartslagen ---------- */

/** Zoekt de rug tussen twee pagina's (een liggende foto van een open boek).
    Geeft de x van de rug terug, of null als er maar één pagina op staat. */
export function findGutter(img, photo = null) {
  const { W: W0, H: H0 } = img;
  if (W0 < H0 * 1.1) return null;
  const sm = shrink(img, 4);
  // Eerst: een strook zonder tekst tussen de pagina's. Lukt dat niet (kleine letters, schaduw in de
  // rug), dan de schaduw van de vouw zelf: een smal, donkerder dal in de helderheid van de foto.
  let x = gutterPass(sm, 0, 0.06);
  if (x == null && photo) x = foldValley(shrink(photo, 4));
  return x == null ? null : Math.round(x * 4);
}

function foldValley({ g, W, H }) {
  const y0 = Math.round(H * 0.15), y1 = Math.round(H * 0.85);
  const b = new Float64Array(W);
  for (let x = 0; x < W; x++) { let s = 0; for (let y = y0; y < y1; y++) s += g[y * W + x]; b[x] = s / (y1 - y0); }
  const r = Math.max(1, Math.round(W * 0.003));
  const sb = b.map((_, x) => { let v = 0, n = 0; for (let d = -r; d <= r; d++) if (x + d >= 0 && x + d < W) { v += b[x + d]; n++; } return v / n; });
  const win = Math.round(W * 0.04);
  let best = null, bd = 0;
  for (let x = Math.round(W * 0.3); x <= Math.round(W * 0.7); x++) {
    let ml = 0, mr = 0;
    for (let d = 1; d <= win; d++) { ml = Math.max(ml, sb[x - d] ?? 0); mr = Math.max(mr, sb[x + d] ?? 0); }
    const dip = Math.min(ml, mr) / Math.max(1, sb[x]) - 1;
    if (dip > bd) { bd = dip; best = x; }
  }
  // Pagina's zelf moeten licht zijn, en het dal duidelijk.
  return best != null && bd >= 0.08 && sb[best] > 60 ? best : null;
}

function gutterPass({ g, W, H }, edge, lowF) {
  // Lange staande lijnen (vouw, schaduw van de rug, paginarand) tellen niet als tekst.
  const col = new Float64Array(W);
  const maxRun = H * 0.08;
  const yA = Math.round(H * edge), yB = H - yA;
  for (let x = 0; x < W; x++) {
    let y = yA;
    while (y < yB) {
      if (g[y * W + x] >= 140) { y++; continue; }
      let e = y; while (e < yB && g[e * W + x] < 140) e++;
      if (e - y < maxRun) col[x] += e - y;
      y = e;
    }
  }
  const r = Math.max(1, Math.round(W * 0.004));
  const sm = col.map((_, x) => { let v = 0, n = 0; for (let d = -r; d <= r; d++) if (x + d >= 0 && x + d < W) { v += col[x + d]; n++; } return v / n; });
  const inked = Array.from(sm).filter(v => v > 0).sort((p, q) => p - q);
  if (!inked.length) return null;
  const typical = inked[Math.floor(inked.length * 0.75)];
  const low = typical * lowF;
  // Langste leeg stuk in het middengebied.
  let best = null, start = -1;
  const a = Math.round(W * 0.25), b = Math.round(W * 0.75);
  for (let x = a; x <= b; x++) {
    const empty = x < b && sm[x] <= low;
    if (empty) { if (start < 0) start = x; }
    else if (start >= 0) { if (!best || x - start > best[1] - best[0]) best = [start, x]; start = -1; }
  }
  if (!best || best[1] - best[0] < W * 0.012) return null;
  const mid = (best[0] + best[1]) / 2;
  let left = 0, right = 0;
  for (let x = 0; x < W; x++) (x < mid ? (left += col[x]) : (right += col[x]));
  if (Math.min(left, right) < (left + right) * 0.15) return null;
  return mid;
}

/** Knipt een stuk [x0, x1) uit een grijsbeeld. */
export function cropX({ g, W, H }, x0, x1) {
  const w = x1 - x0, out = new Uint8ClampedArray(w * H);
  for (let y = 0; y < H; y++) out.set(g.subarray(y * W + x0, y * W + x1), y * w);
  return { g: out, W: w, H };
}

/** Draait een grijsbeeld een kwartslag (90 = met de klok mee) of 180 graden. */
export function turn({ g, W, H }, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return { g, W, H };
  const swap = deg !== 180, w = swap ? H : W, h = swap ? W : H;
  const out = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = g[y * W + x];
    if (deg === 90) out[x * w + (H - 1 - y)] = v;
    else if (deg === 270) out[(W - 1 - x) * w + y] = v;
    else out[(H - 1 - y) * W + (W - 1 - x)] = v;
  }
  return { g: out, W: w, H: h };
}

/* ---------- 3. Scheefstand ---------- */

/** Hoek (graden) waarbij de regels het scherpst horizontaal liggen. */
export function estimateSkew(img) {
  const f = Math.max(1, Math.round(img.W / 900));
  const { g, W, H } = shrink(img, f);
  const pts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (g[y * W + x] < 140) pts.push(x - W / 2, y - H / 2);
  if (pts.length < 200) return 0;
  const step = Math.max(1, Math.floor(pts.length / 2 / 60000)) * 2;
  const bins = new Float64Array(H * 2 + 10);
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += step) bins[(pts[i + 1] * c - pts[i] * s + H + 4) | 0]++;
    let v = 0; for (let i = 1; i < bins.length; i++) v += (bins[i] - bins[i - 1]) ** 2;
    return v;
  };
  let best = 0, bs = -1;
  for (let d = -15; d <= 15; d += 0.5) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  const c0 = best;
  for (let d = c0 - 0.5; d <= c0 + 0.5; d += 0.1) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  return best;
}

export function rotate(img, deg) {
  const { g, W, H } = img;
  const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
  const out = new Uint8ClampedArray(W * H);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // Bron = draai het doelpunt terug.
    const dx = x - cx, dy = y - cy;
    const u = dx * c - dy * s + cx, v = dx * s + dy * c + cy;
    if (u < 0 || v < 0 || u >= W - 1 || v >= H - 1) { out[y * W + x] = 255; continue; }
    const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0, i = y0 * W + x0;
    out[y * W + x] = (g[i] * (1 - tx) + g[i + 1] * tx) * (1 - ty) + (g[i + W] * (1 - tx) + g[i + W + 1] * tx) * ty;
  }
  return { g: out, W, H };
}

/* ---------- 4. Kromme regels rechttrekken ---------- */

/** Volgt elke tekstregel vanaf het midden naar links en rechts, en schuift elke kolom pixels
    zo omhoog of omlaag dat de regels weer recht liggen (tussen de regels wordt geïnterpoleerd). */
export function dewarp(img) {
  const f = 2;
  const s = shrink(img, f);
  const { g, W, H } = s;
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) ink[i] = g[i] < 150 ? 1 : 0;
  // Tekstgebied (zonder lege marges).
  const colInk = new Float64Array(W), rowInk = new Float64Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) { colInk[x]++; rowInk[y]++; }
  const span = (arr) => {
    const tot = arr.reduce((a, b) => a + b, 0); let acc = 0, lo = 0, hi = arr.length - 1;
    for (let i = 0; i < arr.length; i++) { acc += arr[i]; if (acc > tot * 0.004) { lo = i; break; } }
    acc = 0; for (let i = arr.length - 1; i >= 0; i--) { acc += arr[i]; if (acc > tot * 0.004) { hi = i; break; } }
    return [lo, hi, tot];
  };
  const [x0, x1, tot] = span(colInk), [y0, y1] = span(rowInk);
  if (tot < 2000 || x1 - x0 < 100 || y1 - y0 < 100) return { img, warped: false };
  // Regelafstand uit de autocorrelatie van het rijprofiel in het midden.
  const mid = new Float64Array(H);
  const mx0 = x0 + ((x1 - x0) * 0.3) | 0, mx1 = x0 + ((x1 - x0) * 0.7) | 0;
  for (let y = y0; y <= y1; y++) { let c = 0; for (let x = mx0; x < mx1; x++) c += ink[y * W + x]; mid[y] = c; }
  let mean = 0; for (let y = y0; y <= y1; y++) mean += mid[y]; mean /= (y1 - y0 + 1);
  const ac = (lag) => { let v = 0; for (let y = y0; y + lag <= y1; y++) v += (mid[y] - mean) * (mid[y + lag] - mean); return v; };
  const maxLag = Math.min(150, Math.floor((y1 - y0) / 3));
  const acs = new Float64Array(maxLag + 2);
  for (let lag = 3; lag <= maxLag + 1; lag++) acs[lag] = ac(lag);
  let top = 0; for (let lag = 5; lag <= maxLag; lag++) top = Math.max(top, acs[lag]);
  let spacing = 0;
  for (let lag = 5; lag <= maxLag; lag++) {
    if (acs[lag] >= acs[lag - 1] && acs[lag] >= acs[lag + 1] && acs[lag] > top * 0.6) { spacing = lag; break; }
  }
  if (!spacing) spacing = 20;
  // Per rij de cumulatieve inkt, zodat inkt in een venster snel te tellen is.
  const W1 = W + 1, cum = new Int32Array(W1 * H);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { c += ink[y * W + x]; cum[y * W1 + x + 1] = c; } }
  const winInk = (y, xa, xb) => (y < 0 || y >= H) ? 0 : cum[y * W1 + xb] - cum[y * W1 + xa];

  // Monsterkolommen over de breedte van de tekst.
  const ws = clamp(Math.round(spacing * 1.2), 8, 80), step = Math.max(4, ws >> 1);
  const xs = [];
  for (let x = x0 + ws / 2; x <= x1 - ws / 2; x += step) xs.push(Math.round(x));
  const K = xs.length;
  if (K < 4) return { img, warped: false };
  const win = (k) => [clamp(xs[k] - (ws >> 1), 0, W), clamp(xs[k] + (ws >> 1), 0, W)];

  // Startpunten: regels in de kolom met de meeste inkt rond het midden.
  let kr = K >> 1, best = -1;
  for (let k = Math.floor(K * 0.3); k <= Math.ceil(K * 0.7) && k < K; k++) {
    let m = 0; const [xa, xb] = [clamp(xs[k] - ws * 2, 0, W), clamp(xs[k] + ws * 2, 0, W)];
    for (let y = y0; y <= y1; y++) m += winInk(y, xa, xb);
    if (m > best) { best = m; kr = k; }
  }
  const band = [clamp(xs[kr] - ws * 2, 0, W), clamp(xs[kr] + ws * 2, 0, W)];
  const prof = new Float64Array(H);
  const rad = Math.max(1, Math.round(spacing / 8));
  for (let y = 0; y < H; y++) {
    let v = 0; for (let d = -rad; d <= rad; d++) v += winInk(y + d, band[0], band[1]);
    prof[y] = v;
  }
  let pmax = 0; for (let y = y0; y <= y1; y++) pmax = Math.max(pmax, prof[y]);
  const seeds = [];
  for (let y = Math.max(1, y0 - rad); y < Math.min(H - 1, y1 + rad); y++) {
    if (prof[y] < pmax * 0.25 || prof[y] < prof[y - 1] || prof[y] < prof[y + 1]) continue;
    if (seeds.length && y - seeds[seeds.length - 1] < spacing * 0.6) {
      if (prof[y] > prof[seeds[seeds.length - 1]]) seeds[seeds.length - 1] = y;
      continue;
    }
    seeds.push(y);
  }
  if (seeds.length < 3) return { img, warped: false };

  // Elke regel volgen naar links en rechts.
  const reach = spacing * 0.45;
  const minInk = ws * 0.06;
  const locate = (k, yp) => {
    const [xa, xb] = win(k);
    let bi = -1, bv = 0;
    const ya = Math.round(yp - reach), yb = Math.round(yp + reach);
    const q = (y) => winInk(y - 1, xa, xb) + 2 * winInk(y, xa, xb) + winInk(y + 1, xa, xb);
    for (let y = ya; y <= yb; y++) { const v = q(y); if (v > bv) { bv = v; bi = y; } }
    if (bi < 0 || bv < minInk * 4) return null;
    found.push(bv);
    // Zwaartepunt rond de top, voor een rustiger lijn.
    let sw2 = 0, sy = 0;
    for (let y = bi - Math.round(spacing * 0.25); y <= bi + Math.round(spacing * 0.25); y++) { const v = winInk(y, xa, xb); sw2 += v; sy += v * y; }
    return sw2 ? sy / sw2 : bi;
  };
  const found = [];
  const lines = seeds.map((ys) => {
    const y = new Float64Array(K), ok = new Uint8Array(K), str = new Float64Array(K);
    y[kr] = locate(kr, ys) ?? ys; ok[kr] = 1;
    for (const dir of [1, -1]) {
      let yp = y[kr], slope = 0, miss = 0, lastK = kr;
      for (let k = kr + dir; k >= 0 && k < K; k += dir) {
        const pred = yp + slope * step * dir * (miss + 1);
        const r = miss > 5 ? null : locate(k, pred);
        if (r == null) { y[k] = pred; miss++; continue; }
        yp = r;
        const ns = (r - y[lastK]) / ((k - lastK) * step * dir);
        slope = clamp(slope * 0.3 + ns * 0.7, -1, 1);
        y[k] = r; ok[k] = 1; str[k] = found[found.length - 1]; lastK = k; miss = 0;
      }
    }
    // Uitvlakken (gemiddelde van geldige buren).
    const sm = Float64Array.from(y);
    for (let k = 0; k < K; k++) {
      if (!ok[k]) continue;
      let s2 = 0, n2 = 0;
      for (let j = k - 1; j <= k + 1; j++) if (j >= 0 && j < K && ok[j]) { s2 += y[j]; n2++; }
      sm[k] = s2 / n2;
    }
    str[kr] = Infinity;
    return { target: sm[kr], y: sm, ok, str };
  });
  // Zwakke treffers (weinig inkt vergeleken met gewone tekst) niet vertrouwen.
  const typical = median(found);
  for (const l of lines) for (let k = 0; k < K; k++) if (l.ok[k] && l.str[k] < typical * 0.3) l.ok[k] = 0;
  // Uitschieters: een regel moet ongeveer even ver verschoven zijn als de regels erboven en eronder.
  for (let k = 0; k < K; k++) {
    const v = lines.map((l, i) => (l.ok[k] ? i : -1)).filter(i => i >= 0);
    const bad = [];
    v.forEach((i, j) => {
      const nb = [v[j - 2], v[j - 1], v[j + 1], v[j + 2]].filter(x => x !== undefined).map(x => lines[x].y[k] - lines[x].target);
      if (nb.length >= 2 && Math.abs(lines[i].y[k] - lines[i].target - median(nb)) > spacing * 0.3) bad.push(i);
    });
    for (const i of bad) lines[i].ok[k] = 0;
  }
  // Regels die maar kort te volgen waren, tellen niet mee.
  let good = 0;
  for (const l of lines) { let n = 0; for (let k = 0; k < K; k++) n += l.ok[k]; if (n < K * 0.25) l.ok.fill(0); else good++; }
  if (good < 5) return { img, warped: false };
  // Regels mogen elkaar niet kruisen; anders die monsters negeren.
  for (let k = 0; k < K; k++) {
    let prev = -Infinity;
    for (const l of lines) {
      if (!l.ok[k]) continue;
      if (l.y[k] - prev < spacing * 0.4) { l.ok[k] = 0; continue; }
      prev = l.y[k];
    }
  }

  // Verschuiving per monsterkolom en per doelhoogte (lineair tussen de regels).
  const D = Array.from({ length: K }, () => new Float32Array(H));
  let maxOff = 0;
  for (let k = 0; k < K; k++) {
    const pts = lines.filter(l => l.ok[k]).map(l => [l.target, l.y[k] - l.target]);
    if (!pts.length) { if (k > 0) D[k].set(D[k - 1]); continue; }
    let j = 0;
    for (let yy = 0; yy < H; yy++) {
      while (j < pts.length - 1 && pts[j + 1][0] <= yy) j++;
      let d;
      if (yy <= pts[0][0]) d = pts[0][1];
      else if (j >= pts.length - 1) d = pts[pts.length - 1][1];
      else { const [ta, da] = pts[j], [tb, db] = pts[j + 1]; d = da + (db - da) * (yy - ta) / (tb - ta); }
      D[k][yy] = d;
    }
    for (const [, d] of pts) maxOff = Math.max(maxOff, Math.abs(d));
  }
  // Lege kolommen aan het begin opvullen.
  for (let k = K - 2; k >= 0; k--) if (!lines.some(l => l.ok[k])) D[k].set(D[k + 1]);
  // Geen of een onwaarschijnlijk grote kromming (dan is er iets anders gevolgd dan tekstregels).
  if (maxOff < 1 || maxOff > spacing * 3) return { img, warped: false };

  const { g: G, W: FW, H: FH } = img;
  const srcX = Array.from({ length: FW }, (_, x) => x);
  const OW = FW;

  // Terugrekenen naar volle resolutie en verschuiven.
  const out = new Uint8ClampedArray(OW * FH);
  for (let X = 0; X < OW; X++) {
    const sx = srcX[X], xi = Math.min(FW - 2, sx | 0), tx = sx - xi;
    const fk = clamp((sx / f - xs[0]) / step, 0, K - 1), k0 = Math.min(K - 1, fk | 0), k1 = Math.min(K - 1, k0 + 1), t = fk - k0;
    const A = D[k0], B = D[k1];
    for (let Y = 0; Y < FH; Y++) {
      const yy = Math.min(H - 1, (Y / f) | 0);
      const sy = Y + (A[yy] * (1 - t) + B[yy] * t) * f;
      if (sy < 0 || sy >= FH - 1) { out[Y * OW + X] = 255; continue; }
      const yi = sy | 0, ty = sy - yi, i = yi * FW + xi;
      out[Y * OW + X] = (G[i] * (1 - tx) + G[i + 1] * tx) * (1 - ty) + (G[i + FW] * (1 - tx) + G[i + FW + 1] * tx) * ty;
    }
  }
  return { img: { g: out, W: OW, H: FH }, warped: true, maxOff: maxOff * f, lines: lines.length,
    tracks: lines.map(l => Array.from(l.y, (v, k) => [xs[k] * f, v * f, l.ok[k]])) };
}

/* ---------- 5. Kaderlijnen ---------- */

/** Haalt lange, dunne lijnen weg (kaders, onderstrepingen over de hele breedte). */
export function removeRules({ g, W, H }) {
  const T = Math.max(4, Math.round(Math.min(W, H) * 0.01));
  const Lh = Math.round(W * 0.12), Lv = Math.round(H * 0.12);
  const ink = (i) => g[i] < 128;
  const hrun = new Uint16Array(W * H), vrun = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!ink(y * W + x)) { x++; continue; }
      let e = x; while (e < W && ink(y * W + e)) e++;
      for (let i = x; i < e; i++) hrun[y * W + i] = Math.min(65535, e - x);
      x = e;
    }
  }
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!ink(y * W + x)) { y++; continue; }
      let e = y; while (e < H && ink(e * W + x)) e++;
      for (let i = y; i < e; i++) vrun[i * W + x] = Math.min(65535, e - y);
      y = e;
    }
  }
  let removed = 0;
  for (let i = 0; i < g.length; i++) {
    if (!hrun[i]) continue;
    if ((hrun[i] > Lh && vrun[i] <= T) || (vrun[i] > Lv && hrun[i] <= T)) { g[i] = 255; removed++; }
  }
  return removed;
}

/* ---------- 6. Grote beginletters ---------- */

/** Zoekt initialen: één losse, grote letter links naast de eerste regels van een alinea. */
export function findDropCaps(img) {
  const f = 2;
  const { g, W, H } = shrink(img, f);
  const lab = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let i = 0; i < g.length; i++) {
    if (lab[i] !== -1 || g[i] >= 140) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = i; lab[i] = id;
    let xa = W, xb = 0, ya = H, yb = 0, n = 0;
    while (sp) {
      const p = stack[--sp]; n++;
      const x = p % W, y = (p / W) | 0;
      if (x < xa) xa = x; if (x > xb) xb = x; if (y < ya) ya = y; if (y > yb) yb = y;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1,
        x > 0 && y > 0 ? p - W - 1 : -1, x < W - 1 && y > 0 ? p - W + 1 : -1, x > 0 && y < H - 1 ? p + W - 1 : -1, x < W - 1 && y < H - 1 ? p + W + 1 : -1]) {
        if (q >= 0 && lab[q] === -1 && g[q] < 140) { lab[q] = id; stack[sp++] = q; }
      }
    }
    comps.push({ x0: xa, x1: xb, y0: ya, y1: yb, n, h: yb - ya + 1, w: xb - xa + 1 });
  }
  const letters = comps.filter(c => c.n > 6 && c.h >= 4 && c.h < H / 8 && c.w < W / 6);
  if (letters.length < 50) return [];
  const hm = median(letters.map(c => c.h)); // ongeveer de x-hoogte/kaphoogte van de lopende tekst
  const inkIn = (xa, xb, ya, yb) => {
    let c = 0;
    for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y++) for (let x = Math.max(0, xa); x <= Math.min(W - 1, xb); x++) if (g[y * W + x] < 140) c++;
    return c;
  };
  const out = [];
  for (const c of letters) {
    if (c.h < hm * 2.6 || c.h > hm * 12 || c.w < hm * 0.8 || c.w > c.h * 2) continue;
    // Gevuld genoeg (geen kader of lijn) en geen andere grote letters ernaast (dan is het een kop).
    if (c.n < c.w * c.h * 0.12) continue;
    const big = letters.some(o => o !== c && o.h > hm * 1.7 && o.y1 > c.y0 && o.y0 < c.y1
      && ((o.x0 > c.x1 && o.x0 - c.x1 < c.h * 1.2) || (o.x1 < c.x0 && c.x0 - o.x1 < c.h * 0.8)));
    if (big) continue;
    // Rechts ervan moet bovenaan gewone tekst staan, en ook een regel lager.
    const rx0 = c.x1 + 1, rx1 = c.x1 + Math.round(hm * 8);
    const top = inkIn(rx0, rx1, c.y0 - Math.round(hm * 0.3), c.y0 + Math.round(hm * 1.5));
    const lower = inkIn(rx0, rx1, c.y0 + Math.round(hm * 2.2), c.y1);
    if (top < hm * hm * 1.5 || lower < hm * hm * 1.5) continue;
    // Links ervan: niets op dezelfde hoogte vlakbij (anders staat de letter midden in een zin of kop).
    if (inkIn(c.x0 - Math.round(hm * 3), c.x0 - 2, c.y0, c.y1) > hm * hm * 0.5) continue;
    out.push({ x0: c.x0 * f, y0: c.y0 * f, x1: (c.x1 + 1) * f, y1: (c.y1 + 1) * f, lineHeight: hm * f });
  }
  return out;
}

/** Knipt een stuk uit, verkleind tot gewone tekstgrootte en met witte rand, als canvas. */
export function cropForOcr(img, box, targetH = 48) {
  const { g, W } = img;
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const sc = targetH / bh, pad = 20;
  const c = document.createElement('canvas');
  c.width = Math.round(bw * sc) + pad * 2; c.height = targetH + pad * 2;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const src = canvasFromGray({ g: (() => {
    const a = new Uint8ClampedArray(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) a[y * bw + x] = g[(box.y0 + y) * W + box.x0 + x];
    return a;
  })(), W: bw, H: bh });
  ctx.drawImage(src, pad, pad, c.width - pad * 2, targetH);
  return c;
}

export function whiteOut({ g, W }, box) {
  for (let y = box.y0; y < box.y1; y++) g.fill(255, y * W + box.x0, y * W + box.x1);
}
