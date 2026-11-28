// Zoekt het tekstblok op de lampfoto's en zet ze recht (perspective.js), in Chromium.
// Gebruik (vanuit de hoofdmap): node tests/run-perspective-test.mjs [naam ...]
// Schrijft tests/out/<naam>.hoeken.jpg (gevonden hoeken) en tests/out/<naam>.recht.jpg.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(root)) throw new Error('buiten repo');
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const fixtures = await readdir(join(root, 'tests/fixtures'));
let names = process.argv.slice(2);
// Standaard: de lampfoto's (open boek onder de lamp).
if (!names.length) names = fixtures.filter(f => /^[jkm]\d/.test(f)).map(f => f.replace(/\.\w+$/, ''));
await mkdir(join(root, 'tests/out'), { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[recht]')) console.log('  console:', m.text()); });
await page.goto(`http://localhost:${port}/tests/perspective-test.html`);
await page.waitForFunction(() => window.ready);
if (process.env.DBG) await page.evaluate(() => { globalThis.__dbgRecht = true; });
let found = 0;
for (const name of names) {
  const file = fixtures.find(f => f.replace(/\.\w+$/, '') === name);
  const r = await page.evaluate((u) => window.run(u), `/tests/fixtures/${file}`);
  await writeFile(join(root, `tests/out/${name}.hoeken.jpg`), Buffer.from(r.overlay.split(',')[1], 'base64'));
  if (r.rect) await writeFile(join(root, `tests/out/${name}.recht.jpg`), Buffer.from(r.rect.split(',')[1], 'base64'));
  if (r.dbg) await writeFile(join(root, `tests/out/${name}.inkt.png`), Buffer.from(r.dbg.split(',')[1], 'base64'));
  if (r.found) found++;
  console.log(`${name}: ${r.found ? `gevonden, ${r.found.dev.toFixed(1)}° van recht` : 'niet gevonden'}  (zoeken ${r.tFind} ms, rechtzetten ${r.tWarp} ms)`);
}
console.log(`${found} van ${names.length} gevonden`);
await browser.close();
server.close();
