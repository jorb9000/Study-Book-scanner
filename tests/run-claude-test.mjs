// Test van de Claude-modus in de echte app (Chromium), met een nagemaakte Claude-API: er gaat niets
// naar Anthropic en er is geen sleutel nodig. Controleert de instellingen, het verzoek dat de app
// verstuurt (model, foto, koppen), de tekst met beelden op hun plek, en de terugval op de gewone
// herkenning als de sleutel niet klopt.
// Gebruik: node tests/run-claude-test.mjs   (vanuit de hoofdmap van de repo)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
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
const ok = (m) => console.log('  ok', m);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await ctx.addInitScript(() => { navigator.serviceWorker && (navigator.serviceWorker.register = () => Promise.reject(new Error('geen sw in test'))); });

// Nagemaakte API. mode 'ok': een pagina met kolomtekst en een beeld; 'bad-key': 401.
let mode = 'ok';
const calls = [];
await ctx.route('https://api.anthropic.com/**', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } });
  const body = JSON.parse(req.postData() || '{}');
  const h = req.headers();
  calls.push({ body, h });
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  if (mode === 'bad-key') return route.fulfill({ status: 401, headers: cors, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  const parts = Array.isArray(body.messages?.[0]?.content) ? body.messages[0].content : [];
  const img = parts.find(c => c.type === 'image');
  const dims = /(\d+) × (\d+) pixels/.exec(parts.find(c => c.type === 'text')?.text || '');
  const W = +dims?.[1] || 1000, H = +dims?.[2] || 1400;
  const n = calls.length;
  const out = {
    markdown: `## Voorwoord ${n}\n\nWie gember of ginseng gebruikt, zal al snel een associatie maken met China.\n\n[[BEELD 1]]\n\nDe appel uit China werd door Portugese zeevaarders meegenomen naar Europa.`,
    figures: [{ n: 1, caption: 'Fenix, museum voor migratie.', x0: Math.round(W * 0.1), y0: Math.round(H * 0.3), x1: Math.round(W * 0.9), y1: Math.round(H * 0.6) }],
  };
  return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({
    id: 'msg_test' + n, type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text: img ? JSON.stringify(out) : 'ok' }],
    usage: { input_tokens: 5000, output_tokens: 900 },
  }) });
});

const page = await ctx.newPage();
page.on('pageerror', e => fail('paginafout: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('  console:', m.text()); });
await page.goto(`http://localhost:${port}/index.html#/backup`);
await page.waitForSelector('#claude');

// 1. Instellingen: Claude kiezen, sleutel invullen, testen.
await page.check('input[name="engine"][value="claude"]');
await page.fill('#claude-key', 'sk-ant-test-123');
await page.click('[data-act="claude-test"]');
await page.waitForFunction(() => /werkt|Claude:/.test(document.querySelector('#claude-state').textContent), null, { timeout: 30000 });
const st = await page.textContent('#claude-state');
st.includes('werkt') ? ok('sleutel testen: ' + st) : fail('sleutel testen: ' + st);
const priv = await page.textContent('#privacy');
priv.includes('Anthropic') ? ok('melding dat foto\'s naar Anthropic gaan') : fail('privacymelding ontbreekt');
await page.screenshot({ path: 'tests/out/claude-1-instellingen.png', fullPage: true });
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('boekscanner-claude')));
if (!saved.on || saved.key !== 'sk-ant-test-123' || saved.model !== 'claude-opus-5-5') fail('instellingen niet bewaard: ' + JSON.stringify(saved));

// 2. Een open boek herkennen met Claude.
const addDraft = (file) => page.evaluate(async (file) => {
  const img = await (await fetch('/tests/fixtures/' + file)).blob();
  const open = () => new Promise((r, j) => { const q = indexedDB.open('boekscanner', 1); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const d = await open();
  const put = (store, v) => new Promise((r, j) => { const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(v); t.oncomplete = r; t.onerror = () => j(t.error); });
  await put('books', { id: 'b1', title: 'China', lang: 'nld', startPage: 1, totalPages: 200, nextPage: 9, chapters: [], createdAt: Date.now(), updatedAt: Date.now() });
  await put('drafts', { bookId: 'b1', pageNumber: 9, image: img, text: null, text2: null, confidence: null, rotate: 0, createdAt: Date.now() });
}, file);
await page.goto(`http://localhost:${port}/index.html#/`);
await page.waitForSelector('#app .view');
await addDraft('fig-2.jpg');
calls.length = 0;
await page.goto(`http://localhost:${port}/index.html#/boek/b1/scan`);
await page.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
await page.waitForTimeout(500);
const imgCalls = calls.filter(c => Array.isArray(c.body.messages?.[0]?.content) && c.body.messages[0].content.some(x => x.type === 'image'));
console.log(`  ${imgCalls.length} pagina('s) naar de API`);
if (!imgCalls.length) fail('geen verzoek met foto');
for (const c of imgCalls) {
  if (c.body.model !== 'claude-opus-5-5') fail('model ' + c.body.model);
  if (c.h['x-api-key'] !== 'sk-ant-test-123' && c.h['authorization'] !== 'Bearer sk-ant-test-123') fail('sleutel niet meegestuurd');
  if (c.h['anthropic-dangerous-direct-browser-access'] !== 'true') fail('kop voor browsertoegang ontbreekt');
  if (!/server-side-fallback/.test(c.h['anthropic-beta'] || '')) fail('terugval-beta ontbreekt');
  if (c.body.output_config?.format?.type !== 'json_schema') fail('geen gestructureerde uitvoer');
  const im = c.body.messages[0].content.find(x => x.type === 'image');
  if (im.source.media_type !== 'image/jpeg' || im.source.data.length < 10000) fail('foto te klein of verkeerd type');
}
const text = await page.inputValue('#text-wrap textarea');
console.log('  tekst p. 9:', JSON.stringify(text.slice(0, 160)));
if (!text.includes('## Voorwoord')) fail('tekst van Claude staat er niet');
if (!/!\[Fenix, museum voor migratie\.\]\(#beeld-1\)\n\n\*Fenix, museum voor migratie\.\*/.test(text)) fail('beeld met bijschrift niet op zijn plek');
if (text.indexOf('#beeld-1') < text.indexOf('ginseng') || text.indexOf('#beeld-1') > text.indexOf('Portugese')) fail('beeld niet tussen de alinea\'s');
const thumbs = await page.$$eval('.fig-thumb figcaption', els => els.map(e => e.textContent));
thumbs.length >= 1 ? ok(`beelden uitgeknipt: ${thumbs.length}`) : fail('geen beelden uitgeknipt');
const conf = await page.textContent('#conf');
conf.includes('Claude') ? ok('melding: ' + conf) : fail('melding: ' + conf);
await page.screenshot({ path: 'tests/out/claude-2-nakijken.png', fullPage: true });

// 3. Kader aanpassen: de tekst van Claude moet blijven (niet opnieuw met Tesseract lezen).
const before = calls.length;
await page.click('#figs0 [data-act="fig-edit"]');
await page.waitForSelector('.fig-editor .fig-box');
await page.click('.fig-editor [data-act="ok"], .fig-editor button.btn-primary');
await page.waitForTimeout(1500);
const text2 = await page.inputValue('#text-wrap textarea');
text2.includes('## Voorwoord') && calls.length === before ? ok('kader aanpassen houdt de tekst van Claude') : fail('tekst na kader aanpassen: ' + text2.slice(0, 80));

// 4. Verkeerde sleutel: melding en toch herkend met Tesseract.
mode = 'bad-key';
await page.evaluate(() => new Promise((r) => { const q = indexedDB.open('boekscanner', 1); q.onsuccess = () => { const t = q.result.transaction('drafts', 'readwrite'); t.objectStore('drafts').delete('b1'); t.oncomplete = r; }; }));
await page.goto(`http://localhost:${port}/index.html#/`);
await page.waitForSelector('#app .view');
await addDraft('flat.jpg');
await page.goto(`http://localhost:${port}/index.html#/boek/b1/scan`);
const toastP = page.waitForFunction(() => /sleutel klopt niet/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 180000 }).then(() => true, () => false);
await page.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
const t3 = await page.inputValue('#text-wrap textarea');
(await toastP) ? ok('melding bij foute sleutel') : fail('geen melding bij foute sleutel');
t3.split(/\s+/).length > 30 && !t3.includes('Voorwoord') ? ok('terugval op gewone herkenning') : fail('terugval: ' + JSON.stringify(t3.slice(0, 80)) + ' / ' + await page.textContent('#conf'));

await browser.close();
server.close();
console.log(process.exitCode ? 'MISLUKT' : 'Alles goed');
