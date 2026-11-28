// Maakt nagebootste foto's van studieboekpagina's met grafieken en foto's (tests/fixtures/fig-*.jpg).
// Gebruik: node tests/make-figure-fixtures.mjs   (vanuit de hoofdmap van de repo)
// De pagina's worden in Chromium opgemaakt en daarna "gefotografeerd": perspectief, kromming bij
// de rug, ongelijk licht en een donkere ondergrond.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.jpg': 'image/jpeg', '.js': 'text/javascript' }[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const css = `
  body { margin: 0; background: #fbf8f1; }
  .page { width: 1100px; height: 1560px; padding: 110px 120px 90px; box-sizing: border-box; font: 25px/1.48 Georgia, 'Times New Roman', serif; color: #1c1c1c; background: #fbf8f1; position: relative; }
  .head { font: 17px Arial, sans-serif; letter-spacing: .12em; color: #666; text-align: right; margin-bottom: 40px; }
  h2 { font: bold 42px Arial, sans-serif; margin: 0 0 22px; }
  h3 { font: bold 30px Arial, sans-serif; margin: 30px 0 10px; }
  p { margin: 0; text-align: justify; text-indent: 1.4em; }
  p.first { text-indent: 0; }
  figure { margin: 30px 0 26px; }
  figcaption { font: 20px/1.35 Arial, sans-serif; margin-top: 10px; color: #222; }
  figcaption b { margin-right: .5em; }
  .num { position: absolute; bottom: 50px; left: 0; right: 0; text-align: center; font-size: 20px; }
  img.photo { width: 100%; height: 330px; object-fit: cover; display: block; filter: saturate(1.1); }
`;

const bars = (w, h) => {
  const data = [['2018', 42, 30], ['2019', 48, 33], ['2020', 31, 38], ['2021', 55, 41], ['2022', 61, 44]];
  const x0 = 80, y0 = h - 50, cw = (w - x0 - 20) / data.length;
  let s = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" font-family="Arial" font-size="18">`;
  for (let v = 0; v <= 60; v += 20) {
    const y = y0 - v * (h - 90) / 60;
    s += `<line x1="${x0}" x2="${w - 10}" y1="${y}" y2="${y}" stroke="#bbb" stroke-width="1"/><text x="${x0 - 12}" y="${y + 6}" text-anchor="end">${v}</text>`;
  }
  data.forEach(([lab, a, b], i) => {
    const x = x0 + i * cw + cw * 0.18, bw = cw * 0.3;
    s += `<rect x="${x}" y="${y0 - a * (h - 90) / 60}" width="${bw}" height="${a * (h - 90) / 60}" fill="#2f6db5"/>`;
    s += `<rect x="${x + bw + 4}" y="${y0 - b * (h - 90) / 60}" width="${bw}" height="${b * (h - 90) / 60}" fill="#e3893a"/>`;
    s += `<text x="${x + bw}" y="${y0 + 28}" text-anchor="middle">${lab}</text>`;
  });
  s += `<line x1="${x0}" x2="${x0}" y1="20" y2="${y0}" stroke="#333" stroke-width="2"/><line x1="${x0}" x2="${w - 10}" y1="${y0}" y2="${y0}" stroke="#333" stroke-width="2"/>`;
  s += `<rect x="${w - 260}" y="14" width="18" height="18" fill="#2f6db5"/><text x="${w - 234}" y="30">Vraag</text>`;
  s += `<rect x="${w - 150}" y="14" width="18" height="18" fill="#e3893a"/><text x="${w - 124}" y="30">Aanbod</text>`;
  return s + '</svg>';
};

const lines = (w, h) => {
  const pts = (f) => Array.from({ length: 11 }, (_, i) => [70 + i * (w - 100) / 10, h - 50 - f(i) * (h - 90)]);
  const path = (p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  let s = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" font-family="Arial" font-size="17">`;
  s += `<line x1="70" x2="70" y1="10" y2="${h - 50}" stroke="#333" stroke-width="2"/><line x1="70" x2="${w - 20}" y1="${h - 50}" y2="${h - 50}" stroke="#333" stroke-width="2"/>`;
  for (let i = 0; i <= 10; i += 2) s += `<text x="${70 + i * (w - 100) / 10}" y="${h - 22}" text-anchor="middle">${i * 10}</text>`;
  s += `<text x="${w / 2}" y="${h - 2}" text-anchor="middle">prijs (euro)</text>`;
  s += `<path d="${path(pts(i => 0.9 - i * 0.075))}" fill="none" stroke="#c0392b" stroke-width="4"/>`;
  s += `<path d="${path(pts(i => 0.1 + i * 0.07))}" fill="none" stroke="#1f7a4d" stroke-width="4" stroke-dasharray="10 6"/>`;
  s += `<text x="${w - 120}" y="60" fill="#c0392b">vraag</text><text x="${w - 120}" y="${h - 110}" fill="#1f7a4d">aanbod</text>`;
  return s + '</svg>';
};

const P = [
  'De markt brengt vragers en aanbieders samen. Als de prijs van een product stijgt, zijn consumenten minder bereid het te kopen, terwijl producenten juist meer willen leveren. Waar beide wensen elkaar ontmoeten, ontstaat de evenwichtsprijs.',
  'In de praktijk verschuiven vraag en aanbod voortdurend. Een warme zomer laat de vraag naar ijs stijgen, een slechte oogst maakt het aanbod van aardappelen kleiner. Elke verschuiving leidt tot een nieuwe evenwichtsprijs en een andere hoeveelheid die wordt verhandeld.',
  'Economen beschrijven dit met een eenvoudig model. Het model laat veel weg, maar juist daardoor zie je goed welke krachten de prijs bepalen. Je kunt het gebruiken om te voorspellen wat er gebeurt als de overheid een belasting invoert of een minimumprijs vaststelt.',
  'Niet elke markt werkt zo soepel. Soms is er maar één aanbieder, of hebben kopers niet genoeg informatie om goed te kiezen. In die gevallen spreken we van marktfalen, en kan ingrijpen door de overheid nodig zijn om de uitkomst te verbeteren.',
  'Een groenteveiling is een mooi voorbeeld van een markt waar de prijs elke ochtend opnieuw wordt bepaald. Handelaars bieden tegelijk op dezelfde partij, en de klok loopt terug tot iemand op de knop drukt.',
];

const pageA = `<div class="page"><div class="head">HOOFDSTUK 3 · MARKTEN</div>
  <h2>3.2 Vraag en aanbod</h2>
  <p class="first">${P[0]}</p><p>${P[1]}</p>
  <figure>${bars(860, 360)}<figcaption><b>Figuur 3.2</b>Vraag en aanbod van fietsen in Nederland (x 1000)</figcaption></figure>
  <p>${P[2]}</p><p>${P[3]}</p>
  <div class="num">47</div></div>`;

const pageB = `<div class="page"><div class="head">VRAAG EN AANBOD</div>
  <p class="first">${P[4]} ${P[0]}</p>
  <figure><img class="photo" src="/tests/fixtures/j1-omslag.jpg" style="object-position: 50% 12%"><figcaption><b>Afbeelding 3.3</b>De veilingklok in Aalsmeer</figcaption></figure>
  <h3>Het marktevenwicht</h3>
  <p class="first">${P[1]}</p>
  <figure>${lines(860, 320)}<figcaption><b>Figuur 3.4</b>Vraaglijn en aanbodlijn</figcaption></figure>
  <div class="num">48</div></div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 1560 } });
await page.goto(`http://localhost:${port}/tests/ocr-test.html`);
const shot = async (html) => {
  await page.setContent(`<style>${css}</style>${html}`);
  await page.waitForLoadState('networkidle');
  return (await page.screenshot({ type: 'png' })).toString('base64');
};
const a = await shot(pageA), b = await shot(pageB);

// "Fotograferen" in de browser: elk doelpixel terugrekenen naar de pagina.
await page.goto(`http://localhost:${port}/tests/ocr-test.html`);
const photo = (opts) => page.evaluate(async ({ srcs, W, H, spread }) => {
  const load = (s) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
  const ims = await Promise.all(srcs.map(load));
  const px = ims.map(im => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return { d: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height }; });
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const g = out.getContext('2d'); const id = g.createImageData(W, H); const o = id.data;
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 46, gg = 38, bb = 34, k = (y * W + x) * 4;
    let u, v, which = 0;
    if (!spread) {
      // Perspectief: bovenkant iets smaller, licht gedraaid.
      const t = y / H, inset = 140 - 60 * t;
      u = (x - inset - 10 * t) / (W - 2 * inset); v = (y - 90) / (H - 180);
      u = 0.5 + (u - 0.5) * (1 + 0.04 * Math.sin(Math.PI * v)); // lichte bolling
    } else {
      // Open boek: twee pagina's naast elkaar, rug in het midden, pagina's buigen naar de rug toe.
      const half = W / 2, bx0 = W * 0.08, bx1 = W * 0.92, by0 = H * 0.06, by1 = H * 0.94;
      const s = (x - bx0) / (bx1 - bx0);
      which = s < 0.5 ? 0 : 1;
      u = which ? (s - 0.5) * 2 : s * 2;
      const dist = which ? u : 1 - u; // 0 bij de rug
      const lift = Math.exp(-dist * 9) * 0.035; // regels buigen bij de rug omhoog
      v = (y - by0) / (by1 - by0);
      v = v + lift * (v - 0.5) * 2 - lift * 0.5;
    }
    if (u >= 0 && u < 1 && v >= 0 && v < 1) {
      const p = px[which], sx = u * (p.w - 1), sy = v * (p.h - 1), i = ((sy | 0) * p.w + (sx | 0)) * 4;
      let light = 0.95 - 0.25 * Math.hypot(x / W - 0.35, y / H - 0.3);
      if (spread) { const dist = which ? u : 1 - u; light *= 1 - 0.45 * Math.exp(-dist * 22); }
      r = p.d[i] * light; gg = p.d[i + 1] * light; bb = p.d[i + 2] * light * 0.96;
    }
    const n = (rnd() - 0.5) * 10;
    o[k] = r + n; o[k + 1] = gg + n; o[k + 2] = bb + n; o[k + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return out.toDataURL('image/jpeg', 0.9).split(',')[1];
}, opts);

await writeFile(join(root, 'tests/fixtures/fig-1.jpg'), Buffer.from(await photo({ srcs: [a], W: 1800, H: 2400, spread: false }), 'base64'));
await writeFile(join(root, 'tests/fixtures/fig-2.jpg'), Buffer.from(await photo({ srcs: [a, b], W: 3840, H: 2700, spread: true }), 'base64'));
await browser.close();
server.close();
console.log('klaar: tests/fixtures/fig-1.jpg, fig-2.jpg');
