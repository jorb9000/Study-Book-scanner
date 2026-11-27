// Draait de tekstherkenning op de testfoto's in tests/fixtures in Chromium (Playwright).
// Gebruik: node tests/run-ocr-tests.mjs [naam ...]   (vanuit de hoofdmap van de repo)
// Schrijft de herkende tekst naar tests/out/<naam>.md en de voorbewerkte foto naar tests/out/<naam>.jpg
// (bij een open boek met twee pagina's: <naam>-1.jpg en <naam>-2.jpg).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm' };
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

const expected = JSON.parse(await readFile(join(root, 'tests/fixtures/expected.json'), 'utf8'));
let names = process.argv.slice(2);
if (!names.length) names = (await readdir(join(root, 'tests/fixtures'))).filter(f => /\.(jpe?g|png)$/.test(f)).map(f => f.replace(/\.\w+$/, ''));
await mkdir(join(root, 'tests/out'), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('response', r => { if (r.status() >= 400) console.log('  http', r.status(), r.url()); });
page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[ocr]')) console.log('  console:', m.text()); });
await page.goto(`http://localhost:${port}/tests/ocr-test.html`);
await page.waitForFunction(() => window.ready);

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
let failed = 0;
for (const name of names) {
  const file = (await readdir(join(root, 'tests/fixtures'))).find(f => f.replace(/\.\w+$/, '') === name);
  const res = await page.evaluate(([u, d]) => { globalThis.__dbg = d; return window.runOcr(u); }, [`/tests/fixtures/${file}`, !!process.env.DBG]);
  const prep = await page.evaluate(([u]) => window.prepared(u), [`/tests/fixtures/${file}`]);
  await writeFile(join(root, `tests/out/${name}.md`), res.text + '\n');
  for (let i = 0; i < prep.length; i++) {
    await writeFile(join(root, `tests/out/${name}${prep.length > 1 ? '-' + (i + 1) : ''}.jpg`), Buffer.from(prep[i].split(',')[1], 'base64'));
  }
  const exp = expected[name] || {};
  const got = new Set(words(res.text));
  const want = words(exp.words || '');
  const found = want.filter(w => got.has(w)).length;
  const recall = want.length ? Math.round((100 * found) / want.length) : 100;
  const missing = (exp.contains || []).filter(s => !res.text.includes(s));
  for (const s of exp.notContains || []) if (res.text.includes(s)) missing.push(`mag niet voorkomen: ${s}`);
  if (exp.startsWith && !res.text.startsWith(exp.startsWith)) missing.push(`begint met ${exp.startsWith} (nu: ${res.text.slice(0, 40)})`);
  const ok = recall >= (exp.minRecall ?? 90) && !missing.length;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FOUT'} ${name}: woorden ${recall}%, zekerheid ${res.confidence}%, ${res.ms} ms`);
  for (const m of missing) console.log(`     ontbreekt: ${JSON.stringify(m)}`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
