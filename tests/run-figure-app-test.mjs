// Doorloopt de beelden in de echte app (Chromium, computerformaat): een open boek met grafieken
// en een foto herkennen, de beelden nakijken, een kader aanpassen, opslaan en exporteren als zip en PDF.
// Gebruik: node tests/run-figure-app-test.mjs   (vanuit de hoofdmap van de repo)
// Schermafbeeldingen en de export komen in tests/out/app-*.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const body = await readFile(p.endsWith('/') ? join(p, 'index.html') : p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;
await mkdir(join(root, 'tests/out'), { recursive: true });

const fail = (m) => { console.log('FOUT', m); process.exitCode = 1; };
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
await ctx.addInitScript(() => { navigator.serviceWorker && (navigator.serviceWorker.register = () => Promise.reject(new Error('geen sw in test'))); });
const page = await ctx.newPage();
page.on('pageerror', e => fail('paginafout: ' + e.message));
page.on('console', m => { if (m.type() === 'error') console.log('  console:', m.text()); });
await page.goto(`http://localhost:${port}/index.html`);
await page.waitForSelector('#app .view');

// Boek met een concept (de foto van een open boek), zoals na een opname.
const bookId = await page.evaluate(async () => {
  const img = await (await fetch('/tests/fixtures/fig-2.jpg')).blob();
  const open = () => new Promise((r, j) => { const q = indexedDB.open('boekscanner', 1); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const d = await open();
  const put = (store, v) => new Promise((r, j) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = r; t.onerror = () => j(t.error); });
  const id = 'b1';
  await put('books', { id, title: 'Economie', lang: 'nld', startPage: 1, totalPages: 200, nextPage: 47, chapters: [], createdAt: Date.now(), updatedAt: Date.now() });
  await put('drafts', { bookId: id, pageNumber: 47, image: img, text: null, text2: null, confidence: null, rotate: 0, createdAt: Date.now() });
  return id;
});
await page.goto(`http://localhost:${port}/index.html#/boek/${bookId}/scan`);
await page.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
await page.waitForTimeout(500);
const thumbs = await page.$$eval('.fig-thumb figcaption', els => els.map(e => e.textContent));
console.log('  beelden:', JSON.stringify(thumbs));
if (thumbs.length !== 3) fail(`3 beelden verwacht, ${thumbs.length} gevonden`);
await page.screenshot({ path: 'tests/out/app-1-nakijken.png', fullPage: true });

// Kader van het eerste beeld op pagina 48 aanpassen: na "Klaar" wordt opnieuw herkend.
await page.click('#figs1 [data-act="fig-edit"]');
await page.waitForSelector('.fig-editor .fig-box');
await page.waitForTimeout(300);
await page.screenshot({ path: 'tests/out/app-2-kaders.png' });
// Een extra kader tekenen in de lege ruimte onderaan.
const pg = await page.$eval('.fig-editor-page', el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(pg.x + pg.w * 0.2, pg.y + pg.h * 0.02);
await page.mouse.down();
await page.mouse.move(pg.x + pg.w * 0.6, pg.y + pg.h * 0.07, { steps: 5 });
await page.mouse.up();
const nBoxes = await page.$$eval('.fig-editor .fig-box', els => els.length);
if (nBoxes !== 3) fail(`3 kaders verwacht na tekenen, ${nBoxes}`);
// En het nieuwe weer weghalen.
await page.click('.fig-editor .fig-box.sel .fig-x');
await page.click('.fig-editor [data-a="ok"]');
await page.waitForSelector('#status:not([hidden])', { timeout: 10000 });
await page.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
await page.waitForTimeout(500);
const thumbs2 = await page.$$eval('.fig-thumb', els => els.length);
if (thumbs2 !== 3) fail(`na aanpassen 3 beelden verwacht, ${thumbs2}`);

// Eén beeld weghalen uit de tekst van pagina 48 en weer kijken.
const before = await page.$eval('#text2', el => el.value);
await page.click('#figs1 .fig-thumb:last-of-type .fig-del');
await page.waitForTimeout(600);
const after = await page.$eval('#text2', el => el.value);
if (!before.includes('#beeld-2') || after.includes('#beeld-2')) fail('beeld 2 niet uit de tekst gehaald');

await page.click('[data-act="save"]');
await page.waitForFunction(() => location.hash.includes('/lamp') || location.hash.endsWith('/b1'), null, { timeout: 15000 });

// Opgeslagen pagina bekijken.
await page.goto(`http://localhost:${port}/index.html#/boek/${bookId}/p/47`);
await page.waitForSelector('.fig-thumb');
await page.screenshot({ path: 'tests/out/app-3-pagina.png', fullPage: true });

// Exporteren als zip.
await page.goto(`http://localhost:${port}/index.html#/boek/${bookId}/export`);
await page.waitForSelector('[data-act="share"]');
await page.screenshot({ path: 'tests/out/app-4-export.png', fullPage: true });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="share"]')]);
const zipPath = join(root, 'tests/out/app-export.zip');
await dl.saveAs(zipPath);
console.log('  zip:', dl.suggestedFilename());

// PDF: afdrukken onderscheppen en de afdrukweergave als PDF bewaren.
await page.evaluate(() => { window.print = () => { window.__printed = true; }; });
await page.click('[data-act="pdf"]');
await page.waitForFunction(() => window.__printed);
await page.emulateMedia({ media: 'print' });
await page.pdf({ path: 'tests/out/app-export.pdf', format: 'A4' });
await page.emulateMedia({ media: 'screen' });
await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
console.log('  pdf: tests/out/app-export.pdf');

await browser.close();
server.close();
if (!process.exitCode) console.log('OK   beelden in de app');
