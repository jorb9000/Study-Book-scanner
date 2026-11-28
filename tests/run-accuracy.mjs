// Meet de woordnauwkeurigheid van de herkenning tegen handmatig nagekeken referentietekst.
// Gebruik (vanuit de hoofdmap):  node tests/run-accuracy.mjs [naam ...]
//   MAXSIDE=4096   grootste zijde waarmee een foto wordt herkend (standaard 4096, zoals op de computer)
//   RECHT=1        eerst het perspectief rechtzetten (perspective.js), zoals de knop Rechtzetten
//   SHOW=1         toon per pagina de fouten (verwacht → gelezen)
//
// Referenties staan in tests/fixtures/referentie/<foto>-<pagina>.txt (pagina 1 = links, 2 = rechts).
// De maat: woorden van de referentie die exact goed in de uitkomst staan, op volgorde
// (Levenshtein op woordniveau: vervangen, weglaten en toevoegen tellen elk als één fout).
// Hoofdletters tellen mee; leestekens, Markdown-tekens (#, *, >) en afbreekstreepjes aan het
// regeleinde niet. Paginanummers en de lopende paginakop staan niet in de referentie.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(root)) throw new Error('buiten repo');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const refDir = join(root, 'tests/fixtures/referentie');
const refs = {};
for (const f of (await readdir(refDir)).filter(f => f.endsWith('.txt'))) {
  const m = f.match(/^(.+)-(\d)\.txt$/);
  (refs[m[1]] ||= {})[+m[2]] = await readFile(join(refDir, f), 'utf8');
}
let names = process.argv.slice(2);
if (!names.length) names = Object.keys(refs).sort();
await mkdir(join(root, 'tests/out'), { recursive: true });

const words = (s) => s
  .replace(/[-]/g, '')
  .replace(/(\p{L})[-­]\s*\n\s*(\p{Ll})/gu, '$1$2')        // afbreekstreepje aan het regeleinde
  .replace(/[‘’'"“”„«»()[\]{}.,;:!?…*#>|_•·–—]/g, ' ')
  .replace(/(^|\s)-(?=\s|$)/g, ' ')
  .split(/\s+/).filter(Boolean);

function align(ref, hyp) {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, (_, i) => { const r = new Uint32Array(m + 1); r[0] = i; return r; });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  // Terugzoeken voor de foutenlijst.
  const errs = [], bad = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      if (ref[i - 1] !== hyp[j - 1]) { errs.push(`${ref[i - 1]} → ${hyp[j - 1]}`); bad.push(hyp[j - 1]); }
      i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) { errs.push(`${ref[i - 1]} → (weg)`); i--; }
    else { errs.push(`(extra) → ${hyp[j - 1]}`); bad.push(hyp[j - 1]); j--; }
  }
  return { dist: d[n][m], errs: errs.reverse(), bad };
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || (process.env.DBG && m.text().startsWith('[ocr]'))) console.log('  console:', m.text()); });
await page.goto(`http://localhost:${port}/tests/ocr-test.html`);
await page.waitForFunction(() => window.ready);
if (process.env.DBG) await page.evaluate(() => { globalThis.__dbg = true; });
await page.evaluate((c) => window.setConfig(c), { maxSide: +(process.env.MAXSIDE || 4096), ...(process.env.CFG ? JSON.parse(process.env.CFG) : {}) });
if (process.env.DOUBT) await page.evaluate(async (g) => { const m = await import("/ocr.js"); Object.assign(m.DOUBT, g); }, JSON.parse(process.env.DOUBT));

if (process.env.RECHT) await page.evaluate(() => { window.recht = true; });
let totWords = 0, totErr = 0, totMs = 0, dBad = 0, dCaught = 0, dFlag = 0, dRight = 0;
const fixtures = await readdir(join(root, 'tests/fixtures'));
for (const name of names) {
  const file = fixtures.find(f => f.replace(/\.\w+$/, '') === name);
  const res = await page.evaluate((u) => window.runOcr(u), `/tests/fixtures/${file}`);
  totMs += res.ms;
  await writeFile(join(root, `tests/out/${name}.acc.md`), res.text + '\n');
  const pages = res.pages?.length ? res.pages.map(p => p.text) : [res.text];
  for (const [pi, ref] of Object.entries(refs[name] || {})) {
    const got = pages[pi - 1] ?? (pages.length === 1 ? pages[0] : '');
    const r = words(ref), h = words(got);
    const { dist, errs, bad } = align(r, h);
    // Twijfelwoorden: hoeveel van de foute woorden de app markeert, en hoeveel markeringen echt fout zijn.
    const allD = res.pages?.[pi - 1]?.doubts || [];
    if (process.env.DOUBT_ALL) { const info = new Map(); for (const d of allD) for (const q of words(d.word)) if (!info.has(q)) info.set(q, d); console.log('     fout:', bad.map(b => { const d = info.get(b); return d ? `${b}[${d.conf}${d.known ? '' : ',?'}${d.doubt ? ',T' : ''}]` : `${b}[-]`; }).join(' ')); }
    const flagged = allD.filter(d => d.doubt !== false).flatMap(d => words(d.word));
    const badLeft = [...bad];
    for (const f of flagged) { const k = badLeft.indexOf(f); if (k >= 0) { badLeft.splice(k, 1); dRight++; } }
    if (process.env.DOUBT_ALL) { const b2 = [...bad]; console.log('     vals alarm:', allD.filter(d => d.doubt).filter(d => { const q = words(d.word)[0]; const k = b2.indexOf(q); if (k >= 0) { b2.splice(k, 1); return false; } return true; }).map(d => `${d.word}[${d.conf}${d.known ? '' : ',?'}]`).join(' ')); }
    dBad += bad.length; dCaught += bad.length - badLeft.length; dFlag += flagged.length;
    totWords += r.length; totErr += dist;
    const acc = Math.max(0, 100 * (1 - dist / r.length));
    console.log(`${name} p${pi}: ${acc.toFixed(1)}%  (${dist} fouten op ${r.length} woorden)${flagged.length || bad.length ? `, twijfel ${flagged.length} (${bad.length - badLeft.length} van ${bad.length} fouten)` : ''}`);
    if (process.env.SHOW && flagged.length) console.log('     twijfel: ' + flagged.join(' '));
    if (process.env.SHOW) console.log('     ' + errs.join(' | '));
  }
  console.log(`  ${res.ms} ms${process.env.RECHT ? (await page.evaluate(() => window.lastRecht) ? ', rechtgezet' : ', niet rechtgezet') : ''}`);
}
console.log(`TOTAAL: ${(100 * (1 - totErr / totWords)).toFixed(2)}%  (${totErr} fouten op ${totWords} woorden, ${Math.round(totMs / 1000)} s)`);
if (dBad || dFlag) console.log(`TWIJFELWOORDEN: ${dFlag} gemarkeerd (${(100 * dRight / Math.max(1, dFlag)).toFixed(0)}% echt fout), ${dCaught} van ${dBad} foute woorden gemarkeerd (${(100 * dCaught / Math.max(1, dBad)).toFixed(0)}%)`);
await browser.close();
server.close();
