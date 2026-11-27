// Test van de hele flow op de computer, met een nagemaakte iPhone-camera.
// Gebruik (vanuit de hoofdmap):  npm i --no-save peer  &&  node tests/run-flow-test.mjs
// Nodig: Node, Playwright, ffmpeg en het npm-pakket `peer` (eigen koppelserver).
// Wat er gebeurt: twee testfoto's worden een nepcamerabeeld; de "iPhone" (lamp.html) koppelt met
// de computer, neemt vanzelf op, en op de computer wordt geklikt, nagekeken, gedraaid, opgeslagen
// en geëxporteerd. Ook wordt gemeten of de pagina tijdens de herkenning blijft reageren.
import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { PeerServer } = require('peer');

const root = process.cwd();
const out = join(root, 'tests/out');
await mkdir(out, { recursive: true });
const cam = join(out, 'camera.mjpeg');
if (!await stat(cam).catch(() => null)) {
  // Liggend 4K-beeld zoals de iPhone op de lamp; elke foto ±4 seconden.
  const parts = [];
  for (const f of ['k1', 'k3']) {
    const p = join(out, `${f}.mjpeg`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', join(root, `tests/fixtures/${f}.jpg`), '-frames:v', '120', '-vf', 'transpose=2,format=yuvj420p', '-q:v', '7', p]);
    parts.push(await readFile(p));
  }
  await (await import('node:fs/promises')).writeFile(cam, Buffer.concat(parts));
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    let p = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(root)) throw new Error('buiten repo');
    if (p.endsWith('/')) p += 'index.html';
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const peerPort = port + 1;
const peer = PeerServer({ port: peerPort, host: '127.0.0.1', path: '/' });
const BASE = `http://127.0.0.1:${port}/?peerhost=127.0.0.1:${peerPort}`;

const log = (...a) => console.log(...a);
let failed = 0;
const check = (ok, what) => { log(`${ok ? 'OK  ' : 'FOUT'} ${what}`); if (!ok) failed++; };

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cam}`] });
const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
const lamp = await (await browser.newContext({ viewport: { width: 844, height: 390 }, permissions: ['camera'] })).newPage();
for (const [n, p] of [['computer', desk], ['iphone', lamp]]) p.on('pageerror', e => { log(`  ${n}: ${e.message}`); failed++; });

try {
  await desk.goto(BASE + '#/');
  await desk.evaluate(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ entryTypes: ['longtask'] }); });
  await desk.click('text=Nieuw boek');
  await desk.fill('input[name=title]', 'Testboek');
  await desk.fill('input[name=startPage]', '10');
  await desk.click('button[type=submit]');
  await desk.click('text=Scannen met de lamp');
  await desk.waitForSelector('.qr-link', { timeout: 20000 });
  await lamp.goto(await desk.getAttribute('.qr-link', 'href'));
  await lamp.click('#tap');
  await desk.waitForSelector('#link-state.pill-ok', { timeout: 30000 });
  check(true, 'iPhone gekoppeld');
  const rows = () => desk.locator('[data-act=open-shot]').count();
  const t0 = Date.now();
  while (await rows() < 2 && Date.now() - t0 < 25000) await desk.waitForTimeout(500);
  await desk.keyboard.press('KeyA');   // auto uit: het nepbeeld begint steeds opnieuw
  check(await rows() >= 2, `automatisch opgenomen (${await rows()} opnames)`);
  const badge = await desk.locator('#live-badge').innerText().catch(() => '');
  check(/Opgenomen · p\. 1\d–1\d/.test(badge), `melding op het live beeld (${badge})`);
  check(/2 opnames · laatste p\. 12–13/.test(await desk.locator('#shot-count').innerText()), 'teller bij het live beeld');
  check((await desk.locator('.inbox-txt strong').first().innerText()) === '2', 'nieuwste opname bovenaan');
  await desk.screenshot({ path: join(out, 'flow-opnames.png') });

  // Klikken op de tweede opname terwijl de eerste nog herkend wordt.
  const t1 = Date.now();
  await desk.click('[aria-label="Opname 2 nakijken"]');
  await desk.waitForSelector('.view-review');
  check(Date.now() - t1 < 1000, `opname openen tijdens herkenning (${Date.now() - t1} ms)`);
  check(await desk.locator('#pn').innerText() === 'p. 12', 'tweede opname is p. 12');
  await desk.click('a.back');
  await desk.click('[aria-label="Opname 1 nakijken"]');
  await desk.waitForSelector('.view-review');
  check(await desk.locator('#pn').innerText() === 'p. 10', 'gewisseld naar eerste opname, p. 10');
  check(!await desk.locator('#text-wrap').isVisible(), 'geen leeg tekstvak tijdens herkennen');
  await desk.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
  check((await desk.inputValue('#text')).length > 50, 'tekst herkend');
  await desk.click('[data-act=rotate]');
  await desk.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
  check((await desk.inputValue('#text')).length > 50, 'na Draaien opnieuw herkend');
  await desk.click('[data-act=save-next]');
  const next = await desk.waitForFunction(() => document.querySelector('#pn')?.textContent === 'p. 12', null, { timeout: 10000 }).then(() => true, () => false);
  check(next, 'Opslaan & volgende gaat naar p. 12');
  await desk.waitForSelector('#text-wrap:not([hidden])', { timeout: 180000 });
  await desk.click('[data-act=save-next]');
  await desk.waitForSelector('.view-desk');
  const lt = await desk.evaluate(() => window.__lt);
  check(!lt.some(d => d > 300), `pagina bleef reageren (langste blokkade ${Math.round(Math.max(0, ...lt))} ms)`);

  await desk.click('a.back');
  await desk.waitForSelector('.book-h1');
  check((await desk.locator('.pnum').allInnerTexts()).join(',') === '10,11,12,13', "pagina's 10–13 opgeslagen");
  await desk.click('a[href$="/export"]');
  const [dl] = await Promise.all([desk.waitForEvent('download', { timeout: 10000 }).catch(() => null), desk.click('[data-act=share]')]);
  check(!!dl && dl.suggestedFilename() === 'testboek.md', 'export als testboek.md gedownload');
} catch (err) {
  log('FOUT ' + err.message.split('\n')[0]);
  failed++;
  await desk.screenshot({ path: join(out, 'flow-fout.png') }).catch(() => {});
}
await browser.close();
server.close();
peer.close?.();
process.exit(failed ? 1 : 0);
