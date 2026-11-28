/* Offline: app-bestanden vooraf, tekstherkenning bij eerste gebruik. */
const VERSION = 'v15';
const SHELL = `boekscanner-shell-${VERSION}`;
const OCR = 'boekscanner-ocr-v1';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'ocr.js', 'ocr-client.js', 'ocr-worker.js', 'scan.js', 'perspective.js', 'figures.js', 'figure-ui.js', 'export.js', 'koppel.js', 'lamp.html', 'lamp.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/tesseract/tesseract.min.js', 'vendor/tesseract/worker.min.js',
  'vendor/peerjs/peerjs.min.js', 'vendor/qrcode/qrcode.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== OCR) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Grote OCR-bestanden: eenmaal ophalen, daarna uit de cache.
  if (url.pathname.includes('/vendor/') && !FILES.some(f => url.pathname.endsWith(f))) {
    e.respondWith(caches.open(OCR).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // App: eerst netwerk (zodat updates binnenkomen), anders cache.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(SHELL)).put(e.request, res.clone());
      return res;
    } catch {
      return (await caches.match(e.request, { ignoreSearch: true })) || caches.match('index.html');
    }
  })());
});
