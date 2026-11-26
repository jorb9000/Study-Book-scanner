/* Boekscanner — scan een boek in delen, met voortgang per boek.
   Alles blijft lokaal op het toestel (IndexedDB). Geen build-stap nodig. */

import { ocr, resizeToBlob } from './ocr.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const cameraInput = $('#camera');
const importInput = $('#import-file');

const LANGS = {
  nld: 'Nederlands',
  eng: 'Engels',
  'nld+eng': 'Nederlands + Engels',
};

/* ---------- Opslag (IndexedDB) ---------- */

const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('boekscanner', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('books', { keyPath: 'id' });
        const pages = d.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('bookId', 'bookId');
        d.createObjectStore('drafts', { keyPath: 'bookId' });
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let result;
      const r = fn(s);
      if (r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  get: (store, key) => db.tx(store, 'readonly', s => s.get(key)),
  all: (store) => db.tx(store, 'readonly', s => s.getAll()),
  put: (store, val) => db.tx(store, 'readwrite', s => s.put(val)),
  del: (store, key) => db.tx(store, 'readwrite', s => s.delete(key)),
  pagesOf: (bookId) => db.tx('pages', 'readonly', s => s.index('bookId').getAll(bookId)),
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pageId = (bookId, n) => `${bookId}:${n}`;

/* ---------- Hulpjes ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show'); setTimeout(() => (t.hidden = true), 250); }, 2200);
}

function sheet({ title, body = '', actions = [] }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-grip"></div>
        ${title ? `<h2 class="sheet-title">${esc(title)}</h2>` : ''}
        ${body ? `<div class="sheet-body">${body}</div>` : ''}
        <div class="sheet-actions">
          ${actions.map((a, i) => `<button class="btn ${a.style || 'btn-quiet'}" data-i="${i}">${esc(a.label)}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const close = (val) => {
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 260);
      resolve(val);
    };
    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return close(null);
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const a = actions[+b.dataset.i];
      const form = {};
      wrap.querySelectorAll('input, select, textarea').forEach(el => { if (el.name) form[el.name] = el.value; });
      if (a.onClick) a.onClick(form, close); else close({ action: a.value, form });
    });
    const first = wrap.querySelector('input');
    if (first) setTimeout(() => first.focus(), 280);
  });
}

async function confirmSheet(title, text, okLabel = 'Doorgaan', danger = false) {
  const r = await sheet({
    title,
    body: text ? `<p>${esc(text)}</p>` : '',
    actions: [
      { label: okLabel, value: 'ok', style: danger ? 'btn-danger' : 'btn-primary' },
      { label: 'Annuleren', value: 'cancel' },
    ],
  });
  return r?.action === 'ok';
}

/** Compacte weergave van paginanummers: [1,2,3,7,9,10] → "1–3, 7, 9–10" */
function ranges(nums) {
  const out = [];
  let start = null, prev = null;
  for (const n of nums) {
    if (start === null) { start = prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}–${prev}`);
  return out.join(', ');
}

function progressOf(book, pages) {
  const done = pages.map(p => p.pageNumber).sort((a, b) => a - b);
  const set = new Set(done);
  const first = Math.min(book.startPage || 1, done[0] ?? Infinity);
  const last = done[done.length - 1] ?? 0;
  const missing = [];
  for (let n = first; n < last; n++) if (!set.has(n)) missing.push(n);
  const total = book.totalPages ? book.totalPages - (book.startPage || 1) + 1 : null;
  return { done, set, missing, total, count: done.length };
}

function nextUnscanned(from, set, book) {
  let n = from;
  while (set.has(n)) n++;
  if (book.totalPages && n > book.totalPages) {
    // Achteraan klaar? Kijk dan of er gaten zijn.
    for (let m = book.startPage || 1; m <= book.totalPages; m++) if (!set.has(m)) return m;
    return book.totalPages;
  }
  return n;
}

function chapterFor(book, n) {
  let ch = null;
  for (const c of [...(book.chapters || [])].sort((a, b) => a.start - b.start)) if (c.start <= n) ch = c;
  return ch;
}

function chapterRanges(book) {
  const chs = [...(book.chapters || [])].sort((a, b) => a.start - b.start);
  return chs.map((c, i) => ({ ...c, end: chs[i + 1] ? chs[i + 1].start - 1 : (book.totalPages || Infinity) }));
}

/* ---------- Scannen ---------- */

let pendingCapture = null;  // { bookId, after: Promise }

/** Moet direct vanuit een tik worden aangeroepen (iOS eist een gebruikersgebaar). */
function openCamera(bookId, after = Promise.resolve()) {
  pendingCapture = { bookId, after };
  cameraInput.value = '';
  cameraInput.click();
}

cameraInput.addEventListener('change', async () => {
  const file = cameraInput.files && cameraInput.files[0];
  const cap = pendingCapture;
  pendingCapture = null;
  if (!file || !cap) return;
  await cap.after;
  const book = await db.get('books', cap.bookId);
  if (!book) return;
  const image = await resizeToBlob(file, 2200, 0.88);
  await db.put('drafts', {
    bookId: book.id,
    pageNumber: book.nextPage,
    image,
    text: null,
    rotate: 0,
    createdAt: Date.now(),
  });
  go(`#/boek/${book.id}/scan`);
});

/* ---------- Router ---------- */

function go(hash, replace = false) {
  if (replace) history.replaceState(null, '', hash);
  else if (location.hash !== hash) { location.hash = hash; return; }
  route();
}

let cleanup = null;
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const parts = (location.hash.replace(/^#\/?/, '').split('?')[0] || '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (!parts.length) return await viewHome();
    if (parts[0] === 'nieuw') return await viewBookForm();
    if (parts[0] === 'backup') return await viewBackup();
    if (parts[0] === 'boek' && parts[1]) {
      const id = parts[1];
      if (!parts[2]) return await viewBook(id);
      if (parts[2] === 'bewerk') return await viewBookForm(id);
      if (parts[2] === 'scan') return await viewReview(id);
      if (parts[2] === 'p' && parts[3]) return await viewPage(id, +parts[3]);
      if (parts[2] === 'export') return await viewExport(id);
    }
    go('#/', true);
  } catch (err) {
    console.error(err);
    app.innerHTML = `<section class="view"><p class="muted">Er ging iets mis: ${esc(err.message)}</p><a class="btn btn-quiet" href="#/">Terug</a></section>`;
  }
}
window.addEventListener('hashchange', route);

function render(html) {
  app.innerHTML = html;
  app.firstElementChild?.classList.add('enter');
}

/* ---------- Weergaven ---------- */

async function viewHome() {
  const books = (await db.all('books')).sort((a, b) => b.updatedAt - a.updatedAt);
  const allPages = await db.all('pages');
  const drafts = await db.all('drafts');
  const byBook = {};
  for (const p of allPages) (byBook[p.bookId] ||= []).push(p);

  render(`
    <section class="view">
      <header class="top">
        <h1 class="wordmark">Boekscanner</h1>
        <a class="icon-btn" href="#/backup" aria-label="Back-up en instellingen">${icon('more')}</a>
      </header>

      ${books.length ? `
        <ul class="books">
          ${books.map(b => {
            const pr = progressOf(b, byBook[b.id] || []);
            const pct = pr.total ? Math.min(100, Math.round((pr.count / pr.total) * 100)) : null;
            const hasDraft = drafts.some(d => d.bookId === b.id);
            return `
            <li>
              <a class="book-card" href="#/boek/${b.id}">
                <div class="book-spine" aria-hidden="true"></div>
                <div class="book-info">
                  <div class="book-title">${esc(b.title)}</div>
                  <div class="book-meta">
                    ${pr.count} ${pr.count === 1 ? 'pagina' : "pagina's"}${pr.total ? ` van ${pr.total}` : ''}
                    · verder bij p. ${b.nextPage}${hasDraft ? ' · <span class="accent">scan open</span>' : ''}
                  </div>
                  ${pct !== null ? `<div class="bar"><span style="width:${pct}%"></span></div>` : ''}
                </div>
                <span class="chev" aria-hidden="true">${icon('chev')}</span>
              </a>
            </li>`;
          }).join('')}
        </ul>` : `
        <div class="empty">
          <p class="empty-lead">Scan een boek in rustige stukken. De app onthoudt waar je bent.</p>
          <ol class="steps">
            <li><span>1</span>Maak een boek aan</li>
            <li><span>2</span>Fotografeer een pagina</li>
            <li><span>3</span>Controleer de tekst en ga door</li>
          </ol>
        </div>`}
    </section>
    <footer class="dock">
      <a class="btn btn-primary btn-block" href="#/nieuw">${icon('plus')} Nieuw boek</a>
    </footer>
  `);
}

async function viewBookForm(id) {
  const book = id ? await db.get('books', id) : null;
  const lang = book?.lang || 'nld';
  render(`
    <section class="view">
      <header class="top">
        <a class="back" href="${book ? `#/boek/${book.id}` : '#/'}">${icon('back')} ${book ? 'Boek' : 'Boeken'}</a>
      </header>
      <h1 class="h1">${book ? 'Boek bewerken' : 'Nieuw boek'}</h1>
      <form id="book-form" class="form" autocomplete="off">
        <label class="field">
          <span>Titel</span>
          <input name="title" required maxlength="120" placeholder="Bijv. Inleiding psychologie" value="${esc(book?.title || '')}">
        </label>
        <div class="row-2">
          <label class="field">
            <span>Begin bij pagina</span>
            <input name="startPage" type="number" inputmode="numeric" min="1" value="${book?.startPage || 1}">
          </label>
          <label class="field">
            <span>Tot en met <em>(optioneel)</em></span>
            <input name="totalPages" type="number" inputmode="numeric" min="1" placeholder="—" value="${book?.totalPages || ''}">
          </label>
        </div>
        <fieldset class="field">
          <span>Taal van de tekst</span>
          <div class="segmented">
            ${Object.entries(LANGS).map(([k, v]) => `
              <label><input type="radio" name="lang" value="${k}" ${k === lang ? 'checked' : ''}><span>${k === 'nld+eng' ? 'Beide' : v}</span></label>`).join('')}
          </div>
          <small class="hint">Kies "Beide" alleen als het nodig is; één taal herkent sneller.</small>
        </fieldset>
      </form>
      ${book ? `<button class="btn btn-text-danger" data-act="delete-book">Boek verwijderen</button>` : ''}
    </section>
    <footer class="dock">
      <button class="btn btn-primary btn-block" form="book-form" type="submit">${book ? 'Opslaan' : 'Boek aanmaken'}</button>
    </footer>
  `);

  $('#book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const title = f.get('title').trim();
    if (!title) return;
    const startPage = Math.max(1, parseInt(f.get('startPage'), 10) || 1);
    let totalPages = parseInt(f.get('totalPages'), 10) || null;
    if (totalPages && totalPages < startPage) totalPages = null;
    const now = Date.now();
    if (book) {
      Object.assign(book, { title, startPage, totalPages, lang: f.get('lang'), updatedAt: now });
      if (book.nextPage < startPage) book.nextPage = startPage;
      await db.put('books', book);
      go(`#/boek/${book.id}`);
    } else {
      const nb = { id: uid(), title, startPage, totalPages, lang: f.get('lang'), nextPage: startPage, chapters: [], createdAt: now, updatedAt: now };
      await db.put('books', nb);
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      go(`#/boek/${nb.id}`, true);
    }
  });

  if (book) $('[data-act="delete-book"]').addEventListener('click', async () => {
    if (!await confirmSheet('Boek verwijderen?', `“${book.title}” en alle gescande pagina's worden van dit toestel verwijderd.`, 'Verwijderen', true)) return;
    const pages = await db.pagesOf(book.id);
    for (const p of pages) await db.del('pages', p.id);
    await db.del('drafts', book.id);
    await db.del('books', book.id);
    toast('Boek verwijderd');
    go('#/', true);
  });
}

async function viewBook(id) {
  const book = await db.get('books', id);
  if (!book) return go('#/', true);
  const pages = (await db.pagesOf(id)).sort((a, b) => a.pageNumber - b.pageNumber);
  const draft = await db.get('drafts', id);
  const pr = progressOf(book, pages);
  const pct = pr.total ? Math.min(100, Math.round((pr.count / pr.total) * 100)) : null;
  const chs = chapterRanges(book);
  const finished = pr.total && pr.count >= pr.total;

  render(`
    <section class="view">
      <header class="top">
        <a class="back" href="#/">${icon('back')} Boeken</a>
        <a class="icon-btn" href="#/boek/${id}/bewerk" aria-label="Boek bewerken">${icon('edit')}</a>
      </header>

      <h1 class="h1 book-h1">${esc(book.title)}</h1>
      <p class="muted small">${LANGS[book.lang]}${book.totalPages ? ` · p. ${book.startPage || 1}–${book.totalPages}` : ''}</p>

      <div class="progress">
        <div class="progress-num"><strong>${pr.count}</strong>${pr.total ? `<span> / ${pr.total}</span>` : ''}</div>
        <div class="progress-label">${pr.count === 1 ? 'pagina gescand' : "pagina's gescand"}${pct !== null ? ` · ${pct}%` : ''}</div>
        ${pct !== null ? `<div class="bar bar-lg"><span style="width:${pct}%"></span></div>` : ''}
        ${pr.missing.length ? `<p class="missing">Nog niet gescand: <button class="link" data-act="goto-missing" data-n="${pr.missing[0]}">${esc(ranges(pr.missing))}</button></p>` : ''}
      </div>

      ${draft ? `
        <a class="notice" href="#/boek/${id}/scan">
          <span class="dot"></span>
          <span>Scan van p. ${draft.pageNumber} is nog niet opgeslagen</span>
          <span class="chev">${icon('chev')}</span>
        </a>` : ''}

      <div class="next">
        <span class="muted small">Volgende pagina</span>
        <div class="stepper">
          <button class="step" data-act="next-dec" aria-label="Eén pagina terug">−</button>
          <button class="step-val" data-act="next-set" aria-label="Paginanummer kiezen">p. ${book.nextPage}</button>
          <button class="step" data-act="next-inc" aria-label="Eén pagina verder">+</button>
        </div>
      </div>

      <section class="block">
        <div class="block-head">
          <h2>Hoofdstukken</h2>
          <button class="link" data-act="add-chapter">${icon('plus')} Toevoegen</button>
        </div>
        ${chs.length ? `<ul class="list">
          ${chs.map(c => {
            const n = pr.done.filter(x => x >= c.start && x <= c.end).length;
            const size = isFinite(c.end) ? c.end - c.start + 1 : null;
            return `<li class="list-row">
              <button class="list-main" data-act="chapter" data-cid="${c.id}">
                <span class="list-title">${esc(c.title)}</span>
                <span class="list-sub">p. ${c.start}${isFinite(c.end) ? `–${c.end}` : ' en verder'} · ${n}${size ? `/${size}` : ''} gescand</span>
              </button>
            </li>`;
          }).join('')}
        </ul>` : `<p class="muted small pad">Optioneel. Markeer waar een hoofdstuk begint om per hoofdstuk te exporteren.</p>`}
      </section>

      <section class="block">
        <div class="block-head">
          <h2>Pagina's</h2>
          ${pages.length ? `<a class="link" href="#/boek/${id}/export">${icon('share')} Exporteren</a>` : ''}
        </div>
        ${pages.length ? `<ul class="list">
          ${pages.map(p => `<li class="list-row">
            <a class="list-main" href="#/boek/${id}/p/${p.pageNumber}">
              <span class="pnum">${p.pageNumber}</span>
              <span class="excerpt">${esc((p.text || '').slice(0, 90)) || '<em>leeg</em>'}</span>
            </a>
          </li>`).join('')}
        </ul>` : `<p class="muted small pad">Nog niets gescand. Leg het boek plat, zorg voor goed licht en fotografeer één pagina recht van boven.</p>`}
      </section>
    </section>

    <footer class="dock">
      <button class="btn btn-primary btn-block" data-act="scan">${draft ? `Scan van p. ${draft.pageNumber} afronden` : `${icon('camera')} ${finished ? 'Pagina opnieuw scannen' : `Scan pagina ${book.nextPage}`}`}</button>
    </footer>
  `);

  const setNext = async (n) => {
    book.nextPage = Math.max(1, n);
    book.updatedAt = Date.now();
    await db.put('books', book);
    $('[data-act="next-set"]').textContent = `p. ${book.nextPage}`;
    if (!draft) $('[data-act="scan"]').innerHTML = `${icon('camera')} Scan pagina ${book.nextPage}`;
  };

  app.addEventListener('click', onClick);
  cleanup = () => app.removeEventListener('click', onClick);

  async function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'scan') {
      if (draft) return go(`#/boek/${id}/scan`);
      openCamera(id); // direct binnen de tik, anders opent iOS de camera niet
      ocr.get(book.lang).catch(() => {}); // alvast opwarmen terwijl de camera open is
      return;
    }
    if (act === 'next-inc') return setNext(book.nextPage + 1);
    if (act === 'next-dec') return setNext(book.nextPage - 1);
    if (act === 'goto-missing') { await setNext(+el.dataset.n); toast(`Volgende pagina: ${el.dataset.n}`); return; }
    if (act === 'next-set') {
      const r = await sheet({
        title: 'Verder bij pagina',
        body: `<label class="field"><input name="n" type="number" inputmode="numeric" min="1" value="${book.nextPage}"></label>`,
        actions: [{ label: 'Instellen', value: 'ok', style: 'btn-primary' }, { label: 'Annuleren', value: 'x' }],
      });
      if (r?.action === 'ok' && +r.form.n > 0) setNext(+r.form.n);
      return;
    }
    if (act === 'add-chapter' || act === 'chapter') {
      const c = act === 'chapter' ? book.chapters.find(x => x.id === el.dataset.cid) : null;
      const r = await sheet({
        title: c ? 'Hoofdstuk' : 'Nieuw hoofdstuk',
        body: `
          <label class="field"><span>Naam</span><input name="title" maxlength="100" placeholder="Bijv. 3. Geheugen" value="${esc(c?.title || '')}"></label>
          <label class="field"><span>Begint op pagina</span><input name="start" type="number" inputmode="numeric" min="1" value="${c?.start || book.nextPage}"></label>`,
        actions: [
          { label: 'Opslaan', value: 'ok', style: 'btn-primary' },
          ...(c ? [{ label: 'Exporteer dit hoofdstuk', value: 'export' }, { label: 'Verwijderen', value: 'del', style: 'btn-text-danger' }] : []),
          { label: 'Annuleren', value: 'x' },
        ],
      });
      if (!r) return;
      if (r.action === 'export') return go(`#/boek/${id}/export?h=${c.id}`);
      if (r.action === 'del') { book.chapters = book.chapters.filter(x => x !== c); }
      else if (r.action === 'ok') {
        const title = (r.form.title || '').trim() || `Hoofdstuk ${book.chapters.length + 1}`;
        const start = Math.max(1, parseInt(r.form.start, 10) || 1);
        if (c) Object.assign(c, { title, start }); else book.chapters.push({ id: uid(), title, start });
      } else return;
      book.updatedAt = Date.now();
      await db.put('books', book);
      route();
    }
  }
}

/** Beoordelen van een verse scan (concept). */
async function viewReview(id) {
  const book = await db.get('books', id);
  const draft = await db.get('drafts', id);
  if (!book) return go('#/', true);
  if (!draft) return go(`#/boek/${id}`, true);

  const scanned = new Set((await db.pagesOf(id)).map(p => p.pageNumber));
  const imgUrl = URL.createObjectURL(draft.image);
  let alive = true;
  cleanup = () => { alive = false; URL.revokeObjectURL(imgUrl); };

  render(`
    <section class="view view-review">
      <header class="top">
        <a class="back" href="#/boek/${id}">${icon('back')} ${esc(book.title)}</a>
        <button class="icon-btn" data-act="discard" aria-label="Scan weggooien">${icon('trash')}</button>
      </header>

      <div class="review-head">
        <div class="stepper">
          <button class="step" data-act="pn-dec" aria-label="Paginanummer omlaag">−</button>
          <span class="step-val" id="pn">p. ${draft.pageNumber}</span>
          <button class="step" data-act="pn-inc" aria-label="Paginanummer omhoog">+</button>
        </div>
        <span class="muted small" id="chap">${esc(chapterFor(book, draft.pageNumber)?.title || '')}</span>
      </div>

      <figure class="photo" id="photo">
        <img src="${imgUrl}" alt="Foto van pagina ${draft.pageNumber}">
        <div class="photo-tools">
          <button class="chip" data-act="rotate">${icon('rotate')} Draaien</button>
          <button class="chip" data-act="retake">${icon('camera')} Opnieuw</button>
        </div>
      </figure>

      <div class="ocr-status" id="status" hidden>
        <div class="bar"><span id="ocr-bar" style="width:0%"></span></div>
        <p class="muted small" id="ocr-label">Tekst herkennen…</p>
      </div>

      <label class="text-wrap" id="text-wrap" hidden>
        <span class="sr-only">Herkende tekst</span>
        <textarea id="text" spellcheck="true" lang="${book.lang === 'eng' ? 'en' : 'nl'}"></textarea>
      </label>
      <p class="muted small" id="conf"></p>
    </section>

    <footer class="dock dock-2">
      <button class="btn btn-quiet" data-act="save" disabled>Opslaan</button>
      <button class="btn btn-primary" data-act="save-next" disabled>Opslaan &amp; volgende</button>
    </footer>
  `);

  const ta = $('#text');
  const status = $('#status');
  const setButtons = (on) => app.querySelectorAll('[data-act="save"], [data-act="save-next"]').forEach(b => (b.disabled = !on));

  const showText = (t) => {
    $('#text-wrap').hidden = false;
    ta.value = t;
    autosize();
    setButtons(true);
  };
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.max(220, ta.scrollHeight + 2) + 'px'; };
  ta.addEventListener('input', () => {
    autosize();
    clearTimeout(ta._t);
    ta._t = setTimeout(() => { draft.text = ta.value; db.put('drafts', draft); }, 400);
  });

  async function runOcr(auto = true) {
    setButtons(false);
    $('#text-wrap').hidden = true;
    status.hidden = false;
    $('#conf').textContent = '';
    const bar = $('#ocr-bar'), label = $('#ocr-label');
    try {
      const res = await ocr.recognize(draft.image, book.lang, (m) => {
        if (!alive) return;
        if (m.status === 'recognizing text') {
          bar.style.width = Math.round(m.progress * 100) + '%';
          label.textContent = `Tekst herkennen… ${Math.round(m.progress * 100)}%`;
        } else if (/loading|initializ/i.test(m.status)) {
          label.textContent = 'Tekstherkenning voorbereiden…';
        }
      });
      if (!alive) return;
      let best = res;
      // Zeer lage zekerheid? Waarschijnlijk ligt de foto gedraaid: probeer zelf de andere richtingen.
      if (res.confidence < 45 && auto) {
        for (const deg of [90, 270, 180]) {
          label.textContent = 'Foto ligt gedraaid? Andere richting proberen…';
          bar.style.width = '0%';
          const img = await resizeToBlob(draft.image, 2200, 0.9, deg);
          const r = await ocr.recognize(img, book.lang, (m) => {
            if (alive && m.status === 'recognizing text') bar.style.width = Math.round(m.progress * 100) + '%';
          });
          if (!alive) return;
          if (r.confidence > best.confidence + 10) { best = r; draft.image = img; $('#photo img').src = URL.createObjectURL(img); }
          if (best.confidence >= 75) break;
        }
      }
      draft.text = best.text;
      draft.confidence = best.confidence;
      await db.put('drafts', draft);
      status.hidden = true;
      showText(draft.text);
      showConf();
      if (!draft.text) $('#conf').textContent = 'Geen tekst gevonden. Probeer draaien of maak een nieuwe foto met meer licht.';
    } catch (err) {
      console.error(err);
      if (!alive) return;
      label.textContent = 'Herkennen mislukt. Probeer het opnieuw.';
      showText(draft.text || '');
    }
  }
  const showConf = () => {
    if (draft.confidence == null) return;
    const c = draft.confidence;
    $('#conf').textContent = c >= 85 ? `Herkenning ${c}% zeker`
      : c >= 60 ? `Herkenning ${c}% zeker. Controleer de tekst goed.`
      : `Herkenning ${c}% zeker. Probeer een nieuwe foto: recht van boven, met meer licht.`;
  };

  if (draft.text == null) runOcr();
  else { showText(draft.text); showConf(); }

  const setPn = async (n) => {
    draft.pageNumber = Math.max(1, n);
    $('#pn').textContent = `p. ${draft.pageNumber}`;
    $('#chap').textContent = chapterFor(book, draft.pageNumber)?.title || '';
    await db.put('drafts', draft);
  };

  async function save() {
    draft.text = ta.value;
    const id_ = pageId(id, draft.pageNumber);
    const existing = await db.get('pages', id_);
    const thumb = await resizeToBlob(draft.image, 1100, 0.72);
    await db.put('pages', {
      id: id_, bookId: id, pageNumber: draft.pageNumber,
      text: draft.text.trim(), confidence: draft.confidence ?? null,
      image: thumb, savedAt: Date.now(), createdAt: existing?.createdAt || Date.now(),
    });
    await db.del('drafts', id);
    const pages = await db.pagesOf(id);
    const set = new Set(pages.map(p => p.pageNumber));
    book.nextPage = nextUnscanned(draft.pageNumber + 1, set, book);
    book.updatedAt = Date.now();
    await db.put('books', book);
    return existing;
  }

  const onClick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'pn-inc') return setPn(draft.pageNumber + 1);
    if (act === 'pn-dec') return setPn(draft.pageNumber - 1);
    if (act === 'rotate') {
      draft.image = await resizeToBlob(draft.image, 2200, 0.9, 90);
      draft.text = null;
      await db.put('drafts', draft);
      $('#photo img').src = URL.createObjectURL(draft.image);
      return runOcr(false);
    }
    if (act === 'retake') {
      book.nextPage = draft.pageNumber;
      openCamera(id, Promise.all([db.del('drafts', id), db.put('books', book)]));
      go(`#/boek/${id}`, true); // bij annuleren van de camera sta je weer bij het boek
      return;
    }
    if (act === 'discard') {
      if (!await confirmSheet('Scan weggooien?', 'De foto en de herkende tekst worden niet bewaard.', 'Weggooien', true)) return;
      await db.del('drafts', id);
      return go(`#/boek/${id}`);
    }
    if (act === 'save' || act === 'save-next') {
      let next = act === 'save-next';
      if (scanned.has(draft.pageNumber)) {
        if (!await confirmSheet(`Pagina ${draft.pageNumber} bestaat al`, 'De eerder opgeslagen tekst wordt vervangen.', 'Vervangen')) return;
        next = false; // na een vraag mag iOS de camera niet meer openen; terug naar het boek
      }
      setButtons(false);
      if (next) {
        // Camera direct openen (iOS vereist dit binnen de tik); opslaan loopt parallel.
        const saving = save();
        openCamera(id, saving);
        await saving;
        history.replaceState(null, '', `#/boek/${id}`);
        if (alive) route();
      } else {
        await save();
        toast(`Pagina ${draft.pageNumber} opgeslagen`);
        go(`#/boek/${id}`, true);
      }
    }
  };
  app.addEventListener('click', onClick);
  const prevCleanup = cleanup;
  cleanup = () => { prevCleanup(); app.removeEventListener('click', onClick); };
}

/** Bekijken / bewerken van een opgeslagen pagina. */
async function viewPage(id, n) {
  const book = await db.get('books', id);
  const page = await db.get('pages', pageId(id, n));
  if (!book || !page) return go(`#/boek/${id}`, true);
  const pages = (await db.pagesOf(id)).map(p => p.pageNumber).sort((a, b) => a - b);
  const i = pages.indexOf(n);
  const prev = pages[i - 1], next = pages[i + 1];
  const imgUrl = page.image ? URL.createObjectURL(page.image) : null;

  render(`
    <section class="view view-review">
      <header class="top">
        <a class="back" href="#/boek/${id}">${icon('back')} ${esc(book.title)}</a>
        <button class="icon-btn" data-act="delete" aria-label="Pagina verwijderen">${icon('trash')}</button>
      </header>
      <div class="review-head">
        <div class="pager">
          ${prev != null ? `<a class="step" href="#/boek/${id}/p/${prev}" aria-label="Vorige pagina">‹</a>` : '<span class="step off">‹</span>'}
          <span class="step-val">p. ${n}</span>
          ${next != null ? `<a class="step" href="#/boek/${id}/p/${next}" aria-label="Volgende pagina">›</a>` : '<span class="step off">›</span>'}
        </div>
        <span class="muted small">${esc(chapterFor(book, n)?.title || '')}</span>
      </div>
      ${imgUrl ? `<details class="photo-details"><summary>Foto bekijken</summary><figure class="photo"><img src="${imgUrl}" alt="Foto van pagina ${n}"></figure></details>` : ''}
      <label class="text-wrap">
        <span class="sr-only">Tekst</span>
        <textarea id="text" spellcheck="true" lang="${book.lang === 'eng' ? 'en' : 'nl'}">${esc(page.text)}</textarea>
      </label>
      <p class="muted small" id="saved">Wijzigingen worden automatisch bewaard.</p>
    </section>
    <footer class="dock dock-2">
      <button class="btn btn-quiet" data-act="copy">${icon('copy')} Kopiëren</button>
      <button class="btn btn-quiet" data-act="rescan">${icon('camera')} Nieuwe foto</button>
    </footer>
  `);

  const ta = $('#text');
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.max(260, ta.scrollHeight + 2) + 'px'; };
  autosize();
  ta.addEventListener('input', () => {
    autosize();
    clearTimeout(ta._t);
    ta._t = setTimeout(async () => {
      page.text = ta.value;
      page.savedAt = Date.now();
      await db.put('pages', page);
      $('#saved').textContent = 'Bewaard';
    }, 400);
  });

  const onClick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    if (el.dataset.act === 'copy') { await copyText(ta.value); return; }
    if (el.dataset.act === 'rescan') {
      book.nextPage = n;
      openCamera(id, db.put('books', book));
      ocr.get(book.lang).catch(() => {});
      return;
    }
    if (el.dataset.act === 'delete') {
      if (!await confirmSheet(`Pagina ${n} verwijderen?`, 'Je kunt de pagina daarna opnieuw scannen.', 'Verwijderen', true)) return;
      await db.del('pages', page.id);
      toast(`Pagina ${n} verwijderd`);
      go(`#/boek/${id}`, true);
    }
  };
  app.addEventListener('click', onClick);
  cleanup = () => {
    app.removeEventListener('click', onClick);
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (ta._t) { clearTimeout(ta._t); page.text = ta.value; db.put('pages', page); }
  };
}

/* ---------- Exporteren ---------- */

function buildMarkdown(book, pages, chapterId) {
  const chs = chapterRanges(book);
  const only = chapterId ? chs.find(c => c.id === chapterId) : null;
  const list = pages
    .filter(p => !only || (p.pageNumber >= only.start && p.pageNumber <= only.end))
    .sort((a, b) => a.pageNumber - b.pageNumber);
  const out = [`# ${book.title}`];
  if (only) out.push(`## ${only.title}`);
  let cur = only ? only.id : undefined;
  for (const p of list) {
    if (!only) {
      const ch = chapterFor(book, p.pageNumber);
      if (ch && ch.id !== cur) { out.push(`## ${ch.title}`); cur = ch.id; }
    }
    let text = (p.text || '').trim();
    // Staat de hoofdstuktitel zelf als kop bovenaan de pagina? Dan niet dubbel.
    const ch = chapterFor(book, p.pageNumber);
    const first = text.match(/^#{1,6} (.*)(\n|$)/);
    if (ch && first && same(first[1], ch.title)) text = text.slice(first[0].length).trim();
    out.push(`*p. ${p.pageNumber}*\n\n${text}`);
  }
  return out.join('\n\n') + '\n';
}

const same = (a, b) => {
  const n = (s) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return n(a) === n(b);
};

function slug(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) || 'boek';
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Gekopieerd'); }
  catch {
    const t = document.createElement('textarea');
    t.value = text; document.body.appendChild(t); t.select();
    document.execCommand('copy'); t.remove(); toast('Gekopieerd');
  }
}

async function shareFile(name, text, type = 'text/markdown') {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function viewExport(id) {
  const book = await db.get('books', id);
  if (!book) return go('#/', true);
  const pages = await db.pagesOf(id);
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('h');
  const chs = chapterRanges(book);
  let sel = pre && chs.some(c => c.id === pre) ? pre : '';

  const draw = () => {
    const md = buildMarkdown(book, pages, sel || null);
    const words = md.split(/\s+/).filter(Boolean).length;
    render(`
      <section class="view">
        <header class="top">
          <a class="back" href="#/boek/${id}">${icon('back')} ${esc(book.title)}</a>
        </header>
        <h1 class="h1">Exporteren</h1>
        ${chs.length ? `
          <label class="field">
            <span>Wat wil je exporteren?</span>
            <select id="sel">
              <option value="">Hele boek</option>
              ${chs.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.title)}</option>`).join('')}
            </select>
          </label>` : ''}
        <p class="muted small">Markdown · ${words.toLocaleString('nl-NL')} woorden</p>
        <pre class="preview">${esc(md.length > 4000 ? md.slice(0, 4000) + '\n…' : md)}</pre>
      </section>
      <footer class="dock dock-2">
        <button class="btn btn-quiet" data-act="copy">${icon('copy')} Kopiëren</button>
        <button class="btn btn-primary" data-act="share">${icon('share')} Bewaar / deel</button>
      </footer>
    `);
    $('#sel')?.addEventListener('change', (e) => { sel = e.target.value; draw(); });
    $('[data-act="copy"]').onclick = () => copyText(md);
    $('[data-act="share"]').onclick = () => {
      const ch = chs.find(c => c.id === sel);
      shareFile(`${slug(book.title)}${ch ? '-' + slug(ch.title) : ''}.md`, md);
    };
  };
  draw();
}

/* ---------- Back-up ---------- */

async function viewBackup() {
  let usage = '';
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage) usage = `${(est.usage / 1048576).toFixed(1)} MB in gebruik op dit toestel`;
  } catch {}
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  render(`
    <section class="view">
      <header class="top"><a class="back" href="#/">${icon('back')} Boeken</a></header>
      <h1 class="h1">Back-up</h1>
      <p class="lead">Je boeken staan alleen op deze iPhone. Maak af en toe een back-up, bijvoorbeeld naar iCloud Drive via "Bewaar in Bestanden".</p>
      <div class="stack">
        <button class="btn btn-quiet btn-block" data-act="export">${icon('share')} Back-up maken</button>
        <button class="btn btn-quiet btn-block" data-act="import">Back-up terugzetten</button>
      </div>
      <p class="muted small">De back-up bevat alle teksten, hoofdstukken en voortgang, zonder foto's.</p>
      ${usage ? `<p class="muted small">${usage}${persisted ? ' · opslag beschermd' : ''}</p>` : ''}
      <hr class="rule">
      <p class="muted small">Boekscanner werkt offline. De tekstherkenning gebeurt op je telefoon; er wordt niets verstuurd.</p>
    </section>
  `);

  $('[data-act="export"]').onclick = async () => {
    const data = { app: 'boekscanner', version: 1, exportedAt: new Date().toISOString(), books: await db.all('books'), pages: (await db.all('pages')).map(({ image, ...p }) => p) };
    const d = new Date().toISOString().slice(0, 10);
    shareFile(`boekscanner-backup-${d}.json`, JSON.stringify(data, null, 1), 'application/json');
  };
  $('[data-act="import"]').onclick = () => { importInput.value = ''; importInput.click(); };
}

importInput.addEventListener('change', async () => {
  const f = importInput.files?.[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app !== 'boekscanner' || !Array.isArray(data.books)) throw new Error('Dit is geen Boekscanner-back-up.');
    if (!await confirmSheet('Back-up terugzetten?', `${data.books.length} ${data.books.length === 1 ? 'boek' : 'boeken'} en ${data.pages.length} pagina's. Boeken die al bestaan worden bijgewerkt.`, 'Terugzetten')) return;
    for (const b of data.books) await db.put('books', b);
    for (const p of data.pages) {
      const cur = await db.get('pages', p.id);
      await db.put('pages', { ...p, image: cur?.image || null });
    }
    toast('Back-up teruggezet');
    go('#/');
  } catch (err) {
    toast(err.message || 'Terugzetten mislukt');
  }
});

/* ---------- Iconen (lijn, 1.6px) ---------- */

function icon(name) {
  const p = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 015.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
    share: '<path d="M12 4v11M8 8l4-4 4 4M6 12v7h12v-7"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 011-1h9"/>',
    rotate: '<path d="M20 12a8 8 0 11-2.3-5.6M20 4v4h-4"/>',
    more: '<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>',
  }[name];
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
}

/* Tijdens typen de knoppenbalk verbergen, zodat het toetsenbord de tekst niet bedekt. */
document.addEventListener('focusin', (e) => { if (e.target.matches('textarea')) document.body.classList.add('typing'); });
document.addEventListener('focusout', (e) => { if (e.target.matches('textarea')) document.body.classList.remove('typing'); });

/* ---------- Start ---------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
