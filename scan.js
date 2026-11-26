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

/** Vergelijkt het regelpatroon in smalle verticale stroken met dat van een referentiestrook,
    en schuift elke strook omhoog of omlaag zodat de regels weer recht liggen. */
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
    for (let i = 0; i < arr.length; i++) { acc += arr[i]; if (acc > tot * 0.02) { lo = i; break; } }
    acc = 0; for (let i = arr.length - 1; i >= 0; i--) { acc += arr[i]; if (acc > tot * 0.02) { hi = i; break; } }
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
  const strip = clamp(Math.round(spacing * 2), 16, 60);
  const K = Math.max(3, Math.floor((x1 - x0) / strip));
  const sw = (x1 - x0) / K;
  const M = clamp(Math.round((y1 - y0) / (spacing * 5)), 1, 10);
  const bh = (y1 - y0 + 1) / M;
  const pad = Math.ceil(spacing);
  const maxShift = Math.max(2, Math.floor(spacing * 0.4));

  // Profielen per strook (over de hele hoogte, met wat rand zodat verschuiven kan).
  const prof = [];
  const mass = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    const p = new Float64Array(H);
    const xa = Math.round(x0 + k * sw), xb = Math.round(x0 + (k + 1) * sw);
    for (let y = 0; y < H; y++) { let c = 0; for (let x = xa; x < xb; x++) c += ink[y * W + x]; p[y] = c; mass[k] += c; }
    const q = new Float64Array(H); // licht vervagen
    for (let y = 2; y < H - 2; y++) q[y] = (p[y - 2] + 2 * p[y - 1] + 3 * p[y] + 2 * p[y + 1] + p[y + 2]) / 9;
    prof.push(q);
  }
  // Referentie: de strook met de meeste inkt in het midden van het tekstgebied.
  let ref = K >> 1, rb = -1;
  for (let k = Math.floor(K * 0.2); k <= Math.ceil(K * 0.8) && k < K; k++) if (mass[k] > rb) { rb = mass[k]; ref = k; }

  const off = Array.from({ length: M }, () => new Float64Array(K));
  for (let m = 0; m < M; m++) {
    const ya = Math.round(y0 + m * bh), yb = Math.round(y0 + (m + 1) * bh);
    const energy = (p, sh) => { let e = 0; for (let y = Math.max(0, ya + sh); y < Math.min(H, yb + sh); y++) e += p[y]; return e; };
    const minEnergy = sw * (yb - ya) * 0.01;
    const shift = (pa, pb, base) => {
      // pa: strook met bekende verschuiving base; zoek beste extra verschuiving voor pb.
      if (energy(pa, Math.round(base)) < minEnergy || energy(pb, Math.round(base)) < minEnergy) return null;
      const scores = [];
      for (let sh = -maxShift; sh <= maxShift; sh++) {
        let v = 0, na = 0, nb = 0;
        for (let y = Math.max(pad, ya); y < Math.min(H - pad, yb); y++) {
          const ia = y + Math.round(base), ib = ia + sh;
          if (ia < 0 || ib < 0 || ia >= H || ib >= H) continue;
          v += pa[ia] * pb[ib]; na += pa[ia] * pa[ia]; nb += pb[ib] * pb[ib];
        }
        scores.push(na && nb ? v / Math.sqrt(na * nb) : 0);
      }
      let bi = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
      if (scores[bi] < 0.3) return null;
      let sub = 0;
      if (bi > 0 && bi < scores.length - 1) {
        const a = scores[bi - 1], b = scores[bi], c = scores[bi + 1], den = a - 2 * b + c;
        if (den < 0) sub = clamp(0.5 * (a - c) / den, -0.5, 0.5);
      }
      return bi - maxShift + sub;
    };
    for (const dir of [-1, 1]) {
      for (let k = ref + dir; k >= 0 && k < K; k += dir) {
        const prevOff = off[m][k - dir];
        const d = shift(prof[k - dir], prof[k], prevOff);
        off[m][k] = prevOff + (d == null ? 0 : d);
      }
    }
  }
  // Uitvlakken in x (twee keer een 3-puntsgemiddelde) en in y.
  for (let m = 0; m < M; m++) for (let r = 0; r < 2; r++) {
    const o = off[m], c = Float64Array.from(o);
    for (let k = 0; k < K; k++) o[k] = (c[Math.max(0, k - 1)] + c[k] + c[Math.min(K - 1, k + 1)]) / 3;
  }
  if (M >= 3) {
    const c = off.map(o => Float64Array.from(o));
    for (let m = 0; m < M; m++) for (let k = 0; k < K; k++)
      off[m][k] = (c[Math.max(0, m - 1)][k] + 2 * c[m][k] + c[Math.min(M - 1, m + 1)][k]) / 4;
  }
  let maxOff = 0;
  for (const o of off) for (const v of o) maxOff = Math.max(maxOff, Math.abs(v));
  if (maxOff < 1) return { img, warped: false };

  // Terugrekenen naar volle resolutie en verschuiven.
  const { g: G, W: FW, H: FH } = img;
  const out = new Uint8ClampedArray(FW * FH);
  const colOff = Array.from({ length: M }, () => new Float32Array(FW));
  for (let m = 0; m < M; m++) for (let x = 0; x < FW; x++) {
    const fk = clamp((x / f - x0) / sw - 0.5, 0, K - 1), k0 = Math.min(K - 1, fk | 0), k1 = Math.min(K - 1, k0 + 1), t = fk - k0;
    colOff[m][x] = (off[m][k0] * (1 - t) + off[m][k1] * t) * f;
  }
  for (let y = 0; y < FH; y++) {
    const fm = clamp((y / f - y0) / bh - 0.5, 0, M - 1), m0 = Math.min(M - 1, fm | 0), m1 = Math.min(M - 1, m0 + 1), t = fm - m0;
    const A = colOff[m0], Bo = colOff[m1];
    for (let x = 0; x < FW; x++) {
      const sy = y + A[x] * (1 - t) + Bo[x] * t;
      if (sy < 0 || sy >= FH - 1) { out[y * FW + x] = 255; continue; }
      const yi = sy | 0, ty = sy - yi;
      out[y * FW + x] = G[yi * FW + x] * (1 - ty) + G[(yi + 1) * FW + x] * ty;
    }
  }
  return { img: { g: out, W: FW, H: FH }, warped: true, maxOff: maxOff * f };
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
