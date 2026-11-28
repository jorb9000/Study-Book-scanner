/* Perspectief rechtzetten voor de lampopstelling.
   Ligt het boek een beetje schuin of hangt de camera niet precies loodrecht boven het boek, dan
   lopen de randen van het tekstblok scheef of naar elkaar toe. We zoeken die randen in de tekst
   zelf (de linker- en rechterkant van de regels, en de richting van de bovenste en onderste regels),
   niet aan de hoeken van het papier: die zitten onder de lamp vaak achter de lampkap.
   Daarna trekken we het beeld zo recht dat het tekstblok een rechthoek wordt, alsof het boek
   loodrecht onder de camera ligt. */

import { findBookBox } from './scan.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// Waarom het niet lukte (alleen met globalThis.__dbgRecht, voor de tests).
const why = (s) => { if (globalThis.__dbgRecht) console.log('[recht] ' + s); return null; };

/** Grijswaarden van een canvas, verkleind tot hooguit maxSide. Geeft { g, W, H, k } (k = schaal). */
export function grayOf(src, maxSide = 1000) {
  const sw = src.width, sh = src.height;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const W = Math.max(1, Math.round(sw * k)), H = Math.max(1, Math.round(sh * k));
  const c = typeof document === 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return { g, W, H, k };
}

/** Inkt: pixels duidelijk donkerder dan hun omgeving (zo telt een schaduw of de lampkap niet mee). */
function inkMask({ g, W, H }, box) {
  const r = Math.max(6, Math.round(Math.max(W, H) / 70));
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += g[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; }
  }
  const ink = new Uint8Array(W * H);
  const { x: bx, y: by, w: bw, h: bh } = box;
  for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
    const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    const mean = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    // Alleen op papier (niet in het donker naast het boek) en flink donkerder dan de omgeving.
    if (mean > 70 && g[y * W + x] < mean * 0.86) ink[y * W + x] = 1;
  }
  // Alleen letters houden: kleine losse vlekjes. Lange randen (papierrand, rug, lampkap,
  // schaduwen, een vinger) zijn grote samenhangende stukken en vallen zo weg.
  const maxC = Math.max(W, H) * 0.035;
  const stack = new Int32Array(W * H), comp = [];
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] !== 1) continue;
    let sp = 0, x0 = W, x1 = 0, y0 = H, y1 = 0, n = 0;
    stack[sp++] = i; ink[i] = 2;
    const members = [];
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p / W) | 0;
      members.push(p); n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && ink[p - 1] === 1) { ink[p - 1] = 2; stack[sp++] = p - 1; }
      if (x < W - 1 && ink[p + 1] === 1) { ink[p + 1] = 2; stack[sp++] = p + 1; }
      if (y > 0 && ink[p - W] === 1) { ink[p - W] = 2; stack[sp++] = p - W; }
      if (y < H - 1 && ink[p + W] === 1) { ink[p + W] = 2; stack[sp++] = p + W; }
    }
    const ok = n >= 2 && x1 - x0 < maxC && y1 - y0 < maxC;
    if (!ok) for (const p of members) ink[p] = 3;
  }
  for (let i = 0; i < ink.length; i++) ink[i] = ink[i] === 2 ? 1 : 0;
  return ink;
}

/** Hoek (graden) waarbij de inktpunten de scherpste regels vormen. */
function lineAngle(pts, H, range = 12, withScore = false) {
  if (pts.length < 400) return null;
  const step = Math.max(1, Math.floor(pts.length / 2 / 40000)) * 2;
  const bins = new Float64Array(H * 3 + 10);
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += step) bins[(pts[i + 1] * c - pts[i] * s + H * 1.5 + 4) | 0]++;
    let v = 0; for (let i = 1; i < bins.length; i++) v += (bins[i] - bins[i - 1]) ** 2;
    return v;
  };
  let best = 0, bs = -1;
  for (let d = -range; d <= range; d += 0.5) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  const c0 = best;
  for (let d = c0 - 0.5; d <= c0 + 0.5; d += 0.1) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  return withScore ? { deg: best, score: bs } : best;
}

/** Robuuste lijn x = a·y + b door punten [y, x]: de lijn met de meeste punten dichtbij, dan kleinste kwadraten. */
function fitLine(pts, tol) {
  if (pts.length < 4) return null;
  let best = null, bestN = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const [y1, x1] = pts[i], [y2, x2] = pts[j];
    if (Math.abs(y2 - y1) < 1) continue;
    const a = (x2 - x1) / (y2 - y1), b = x1 - a * y1;
    let n = 0; for (const [y, x] of pts) if (Math.abs(a * y + b - x) < tol) n++;
    if (n > bestN) { bestN = n; best = [a, b]; }
  }
  if (!best || bestN < Math.max(4, pts.length * 0.5)) return null;
  const inl = pts.filter(([y, x]) => Math.abs(best[0] * y + best[1] - x) < tol);
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (const [y, x] of inl) { sy += y; sx += x; syy += y * y; sxy += x * y; }
  const n = inl.length, den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-9) return best;
  const a = (n * sxy - sy * sx) / den;
  return [a, (sx - a * sy) / n];
}

/** Zoekt de vier hoeken van het tekstblok in een grijsbeeld met regels die ongeveer horizontaal lopen.
    Geeft [[x,y] ×4] (linksboven, rechtsboven, rechtsonder, linksonder) of null. */
function quadHorizontal(img, ink, box) {
  const { W, H } = img;
  const { x: bx, y: by, w: bw, h: bh } = box;
  // Rijen met tekst: begin en eind van het tekstblok.
  const rowInk = new Float64Array(H);
  for (let y = by; y < by + bh; y++) { let n = 0; for (let x = bx; x < bx + bw; x++) n += ink[y * W + x]; rowInk[y] = n; }
  const rows = [];
  for (let y = by; y < by + bh; y++) if (rowInk[y] > bw * 0.01) rows.push(y);
  if (rows.length < 20) return why('te weinig tekstrijen');
  const top = rows[Math.floor(rows.length * 0.01)], bot = rows[Math.ceil(rows.length * 0.99) - 1];
  const th = bot - top;
  if (th < H * 0.2) return why('tekstblok te laag');
  // Linker- en rechterrand per strook: de buitenste inkt (met een klein percentiel tegen losse vlekjes).
  const N = 18, L = [], R = [];
  for (let k = 0; k < N; k++) {
    const y0 = Math.round(top + (th * k) / N), y1 = Math.round(top + (th * (k + 1)) / N);
    const col = new Uint32Array(W); let tot = 0;
    for (let y = y0; y < y1; y++) for (let x = bx; x < bx + bw; x++) if (ink[y * W + x]) { col[x]++; tot++; }
    if (tot < (y1 - y0) * 3) continue;
    // De rand van de tekst: de eerste kolom waarna de kolommen grotendeels inkt hebben.
    // Losse vlekjes (stof, de rand van de lampkap) hebben dat niet.
    const win = Math.max(6, Math.round(W * 0.02));
    const dense = (x, dir) => { let n = 0; for (let i = 0; i < win; i++) { const c = x + dir * i; if (c >= bx && c < bx + bw && col[c]) n++; } return n >= win * 0.45; };
    let xl = -1, xr = -1;
    for (let x = bx; x < bx + bw; x++) if (col[x] && dense(x, 1)) { xl = x; break; }
    for (let x = bx + bw - 1; x >= bx; x--) if (col[x] && dense(x, -1)) { xr = x; break; }
    const yc = (y0 + y1) / 2;
    if (xl >= 0) L.push([yc, xl]);
    if (xr >= 0) R.push([yc, xr]);
  }
  // Ingesprongen regels en korte slotregels wijken naar binnen af: houd per kant de buitenste helft.
  const outer = (P, sign) => {
    if (P.length < 8) return P;
    const s = [...P].sort((p, q) => sign * (q[1] - p[1]));
    return s.slice(0, Math.max(6, Math.ceil(P.length * 0.6)));
  };
  if (globalThis.__dbgRecht) globalThis.__dbgInfo = { ink, W, H, L, R, box };
  const tol = Math.max(3, W * 0.008);
  const left = fitLine(outer(L, -1), tol), right = fitLine(outer(R, 1), tol);
  if (!left || !right) return why(`rand niet gevonden L=${!!left} R=${!!right} (${L.length}/${R.length})`);
  // Richting van de regels bovenin en onderin het tekstblok.
  const band = (y0, y1) => {
    const pts = [];
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = bx; x < bx + bw; x++) if (ink[y * W + x]) pts.push(x - W / 2, y - H / 2);
    return lineAngle(pts, H);
  };
  const aTop = band(top, top + th * 0.3), aBot = band(bot - th * 0.3, bot);
  if (aTop == null || aBot == null) return why('regelrichting niet gevonden');
  // Lijn door het uiterste inktpunt in die richting: y = tan(a)·x + c.
  const edge = (deg, y0, y1, pick) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const cs = [];
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = bx; x < bx + bw; x++) if (ink[y * W + x]) cs.push(y - t * x);
    if (cs.length < 50) return null;
    cs.sort((p, q) => p - q);
    return [t, cs[clamp(Math.round(cs.length * pick), 0, cs.length - 1)]];
  };
  const eT = edge(aTop, top, top + th * 0.3, 0.003), eB = edge(aBot, bot - th * 0.3, bot, 0.997);
  if (!eT || !eB) return why('boven/onderrand niet gevonden');
  // Snijpunt van x = a·y + b en y = t·x + c.
  const cut = ([a, b], [t, c]) => { const y = (t * b + c) / (1 - t * a); return [a * y + b, y]; };
  return [cut(left, eT), cut(right, eT), cut(right, eB), cut(left, eB)];
}

/** Hoeken rechtsom zetten, beginnend linksboven (in beeldcoördinaten, y naar beneden). */
function order(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const s = [...q].sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
  let i0 = 0; for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[i0][0] + s[i0][1]) i0 = i;
  return [0, 1, 2, 3].map(i => s[(i0 + i) % 4]);
}

/** Klopt de vierhoek? Bol, groot genoeg en niet te vreemd. Geeft hoe scheef hij is (0 = recht) of -1. */
function check(q, W, H) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let sgn = 0, maxDev = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cr = v1[0] * v2[1] - v1[1] * v2[0];
    if (sgn && Math.sign(cr) !== sgn) return -1;
    sgn = Math.sign(cr);
    const ang = Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2)), -1, 1)) * 180 / Math.PI;
    if (Math.abs(ang - 90) > 15) { why(`hoek ${ang.toFixed(0)}°`); return -1; }
    maxDev = Math.max(maxDev, Math.abs(ang - 90));
  }
  const r1 = d(q[0], q[1]) / d(q[3], q[2]), r2 = d(q[0], q[3]) / d(q[1], q[2]);
  if (r1 < 0.8 || r1 > 1.25 || r2 < 0.8 || r2 > 1.25) { why(`verhouding ${r1.toFixed(2)} ${r2.toFixed(2)}`); return -1; }
  const area = Math.abs(q.reduce((a, p, i) => { const n = q[(i + 1) % 4]; return a + p[0] * n[1] - n[0] * p[1]; }, 0) / 2);
  if (area < 0.1 * W * H) { why('te klein'); return -1; }
  return maxDev;
}

/**
 * Zoekt de hoeken van het tekstblok in een beeld (canvas, ImageBitmap of video-frame).
 * Werkt voor een open boek en voor één pagina, in elke kwartslag. Geeft de hoeken in pixels
 * van het bronbeeld (rechtsom vanaf linksboven), of null als het niet betrouwbaar lukt.
 */
export function findTextQuad(src, maxSide = 1000) {
  const img = grayOf(src, maxSide);
  const b = findBookBox(img);
  if (!b) return why('geen boek');
  const m = Math.round(0.03 * Math.max(b.w, b.h));
  const box = { x: Math.max(0, b.x - m), y: Math.max(0, b.y - m) };
  box.w = Math.min(img.W, b.x + b.w + m) - box.x; box.h = Math.min(img.H, b.y + b.h + m) - box.y;
  const ink = inkMask(img, box);
  // Lopen de regels horizontaal of verticaal? Kijk in welke richting (met een kleine draaiing erbij)
  // de inkt de scherpste regels vormt.
  const ph0 = [], pv0 = [];
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    if (!ink[y * img.W + x]) continue;
    ph0.push(x - img.W / 2, y - img.H / 2); pv0.push(y - img.H / 2, x - img.W / 2);
  }
  const sH = lineAngle(ph0, Math.max(img.W, img.H), 12, true), sV = lineAngle(pv0, Math.max(img.W, img.H), 12, true);
  if (!sH || !sV) return why('te weinig inkt');
  const ph = sH.score, pv = sV.score;
  // Geen duidelijke richting (omslag, plaatje, weinig tekst)? Dan liever niets doen.
  if (Math.max(ph, pv) < 1.25 * Math.min(ph, pv)) return why(`richting onduidelijk ${ph.toExponential(2)} / ${pv.toExponential(2)}`);
  let q;
  why(`regels liggend ${ph.toExponential(2)} staand ${pv.toExponential(2)}`);
  if (ph >= pv) q = quadHorizontal(img, ink, box);
  else {
    // Gekanteld: beeld transponeren, zoeken, en de hoeken terugzetten.
    const T = { g: new Uint8ClampedArray(img.g.length), W: img.H, H: img.W };
    const tInk = new Uint8Array(ink.length);
    for (let y = 0; y < img.H; y++) for (let x = 0; x < img.W; x++) { T.g[x * img.H + y] = img.g[y * img.W + x]; tInk[x * img.H + y] = ink[y * img.W + x]; }
    const tq = quadHorizontal(T, tInk, { x: box.y, y: box.x, w: box.h, h: box.w });
    q = tq && tq.map(([x, y]) => [y, x]);
  }
  if (!q) return null;
  q = order(q);
  const dev = check(q, img.W, img.H);
  if (dev < 0) return why('vierhoek klopt niet: ' + JSON.stringify(q.map(p => p.map(Math.round))));
  return { quad: q.map(([x, y]) => [x / img.k, y / img.k]), dev };
}

/** Homografie die (0,0),(w,0),(w,h),(0,h) afbeeldt op de vier hoeken q. */
function homography(w, h, q) {
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
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

/**
 * Afbeelding van het rechtgezette beeld: even groot als de foto, met het tekstblok als rechthoek
 * op dezelfde plek en in dezelfde grootte. De rest van de foto (bureau, lampkap, rug) gaat mee
 * rechtgetrokken, zodat de herkenning daarna precies zo werkt als op een gewone lampfoto.
 * Geeft { w, h, map(x, y) → [u, v] in de bron }.
 */
export function plan(quad, srcW, srcH) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const qw = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / 2;
  const qh = (d(quad[0], quad[3]) + d(quad[1], quad[2])) / 2;
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const [a, b, c, dd, e, f, g, h] = homography(qw, qh, quad);
  const ox = cx - qw / 2, oy = cy - qh / 2;
  const map = (x, y) => {
    const X = x - ox, Y = y - oy;
    const z = g * X + h * Y + 1;
    return [(a * X + b * Y + c) / z, (dd * X + e * Y + f) / z];
  };
  return { w: srcW, h: srcH, map };
}

/** Zet een RGBA-beeld recht. src: ImageData-achtig { data, width, height }. */
export function warpRGBA(src, p) {
  const { data: s, width: SW, height: SH } = src;
  const out = new Uint8ClampedArray(p.w * p.h * 4);
  for (let y = 0; y < p.h; y++) {
    // Per regel alleen de twee uiteinden exact; daartussen is de afbeelding bijna lineair, maar
    // niet helemaal: elke 16 pixels opnieuw exact.
    for (let x = 0; x < p.w; x += 16) {
      const xe = Math.min(p.w, x + 16);
      const [u0, v0] = p.map(x, y), [u1, v1] = p.map(xe, y);
      const du = (u1 - u0) / (xe - x), dv = (v1 - v0) / (xe - x);
      for (let i = x; i < xe; i++) {
        const u = u0 + du * (i - x), v = v0 + dv * (i - x);
        const o = (y * p.w + i) * 4;
        // Buiten de foto: zwart, zoals de donkere ondergrond naast het boek.
        if (u < 0 || v < 0 || u > SW - 1.001 || v > SH - 1.001) { out[o + 3] = 255; continue; }
        const x0 = u | 0, y0 = v | 0, tx = u - x0, ty = v - y0;
        const i00 = (y0 * SW + x0) * 4, i10 = i00 + 4, i01 = i00 + SW * 4, i11 = i01 + 4;
        for (let ch = 0; ch < 3; ch++) {
          out[o + ch] = (s[i00 + ch] * (1 - tx) + s[i10 + ch] * tx) * (1 - ty) + (s[i01 + ch] * (1 - tx) + s[i11 + ch] * tx) * ty;
        }
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

/** Rechtgezette kopie van een canvas/bitmap op een nieuw canvas, of null als het niet lukt. */
export const MIN_DEV = 1.5;   // graden: minder scheef dan dit is het rechtzetten de lichte vervaging niet waard

export function rectify(src, found = findTextQuad(src)) {
  if (!found || found.dev < MIN_DEV) return null;
  const p = plan(found.quad, src.width, src.height);
  const sc = typeof document === 'undefined' ? new OffscreenCanvas(src.width, src.height) : Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0);
  const id = sctx.getImageData(0, 0, src.width, src.height);
  const px = warpRGBA(id, p);
  const out = typeof document === 'undefined' ? new OffscreenCanvas(p.w, p.h) : Object.assign(document.createElement('canvas'), { width: p.w, height: p.h });
  out.getContext('2d').putImageData(new ImageData(px, p.w, p.h), 0, 0);
  return out;
}
