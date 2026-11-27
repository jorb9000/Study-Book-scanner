/* Boekscanner — scan een boek in delen, met voortgang per boek.
   Alles blijft lokaal op het toestel (IndexedDB). Geen build-stap nodig. */

import { ocr, ocrConfig, resizeToBlob } from './ocr.js';
import { shots, host, toBlob } from './koppel.js';
import { grayFromCanvas, findBookBox } from './scan.js';

// Op de computer foto's minder verkleinen: 4K-opnames van de lamp blijven dan scherp genoeg.
if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) ocrConfig.maxSide = 4096;

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
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

/* ---------- iPhone: alleen camera ---------- */

// Op de iPhone is de Boekscanner alleen nog camera op de lamp; alles wordt op de computer bediend.
const PHONE = /iPhone|iPod|Android/i.test(navigator.userAgent);

async function viewPhone() {
  const n = (await db.all('books')).length;
  if (!n) { location.replace('lamp.html'); return; }
  // Oude boeken van vóór de lampopstelling: via een back-up naar de computer verhuizen.
  render(`
    <section class="view">
      <header class="top"><h1 class="wordmark">Boekscanner</h1></header>
      <p class="lead">Deze iPhone is nu alleen nog camera op de lamp. Boeken, nakijken en exporteren doe je op je computer.</p>
      <p class="lead">Er ${n === 1 ? 'staat nog 1 boek' : `staan nog ${n} boeken`} op deze iPhone. Maak een back-up, zet het bestand in iCloud Drive en kies op je computer <strong>Back-up terugzetten</strong>.</p>
    </section>
    <footer class="dock">
      <a class="btn btn-quiet btn-block" href="#/backup">Back-up maken</a>
      <a class="btn btn-primary btn-block" href="lamp.html">Naar de camera</a>
    </footer>
  `);
}

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
    if (PHONE && parts[0] !== 'backup') return await viewPhone();
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
      if (parts[2] === 'lamp') return await viewDesk(id);
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
            <li><span>2</span>Scan met de iPhone op de lamp</li>
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
  const inboxN = (await inboxOf(id)).length;
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

      ${inboxN ? `
        <a class="notice" href="#/boek/${id}/lamp">
          <span class="dot"></span>
          <span>${inboxN} ${inboxN === 1 ? 'opname' : 'opnames'} van de lamp om na te kijken</span>
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
        </ul>` : `<p class="muted small pad">Nog niets gescand. Leg het boek open onder de lamp en kies <strong>Scannen met de lamp</strong>.</p>`}
      </section>
    </section>

    <footer class="dock">
      ${draft ? `<a class="btn btn-primary btn-block" href="#/boek/${id}/scan">Scan van p. ${draft.pageNumber} afronden</a>`
        : `<a class="btn btn-primary btn-block" href="#/boek/${id}/lamp">${icon('camera')} Scannen met de lamp</a>`}
    </footer>
  `);

  const setNext = async (n) => {
    book.nextPage = Math.max(1, n);
    book.updatedAt = Date.now();
    await db.put('books', book);
    $('[data-act="next-set"]').textContent = `p. ${book.nextPage}`;
  };

  app.addEventListener('click', onClick);
  cleanup = () => app.removeEventListener('click', onClick);

  async function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
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
        <span class="page-label" id="pl1" hidden></span>
        <span class="sr-only">Herkende tekst</span>
        <textarea id="text" spellcheck="true" lang="${book.lang === 'eng' ? 'en' : 'nl'}"></textarea>
      </label>
      <label class="text-wrap" id="text-wrap2" hidden>
        <span class="page-label" id="pl2"></span>
        <textarea id="text2" spellcheck="true" lang="${book.lang === 'eng' ? 'en' : 'nl'}"></textarea>
      </label>
      <button class="chip" data-act="unsplit" id="unsplit" hidden>Toch één pagina</button>
      <p class="muted small" id="conf"></p>
    </section>

    <footer class="dock dock-2">
      <button class="btn btn-quiet" data-act="save" disabled>Opslaan</button>
      <button class="btn btn-primary" data-act="save-next" disabled>Opslaan &amp; volgende</button>
    </footer>
  `);

  const ta = $('#text');
  const ta2 = $('#text2');
  const status = $('#status');
  // Open boek op de foto: de tekst staat in twee vakken en wordt als twee pagina's opgeslagen.
  const isSpread = () => draft.text2 != null;
  const pageLabels = () => {
    $('#pl1').textContent = `Pagina ${draft.pageNumber}`;
    $('#pl2').textContent = `Pagina ${draft.pageNumber + 1}`;
  };
  const setButtons = (on) => app.querySelectorAll('[data-act="save"], [data-act="save-next"]').forEach(b => (b.disabled = !on));

  const showText = (t) => {
    $('#text-wrap').hidden = false;
    ta.value = t;
    const two = isSpread();
    $('#pl1').hidden = !two;
    $('#text-wrap2').hidden = !two;
    $('#unsplit').hidden = !two;
    if (two) { ta2.value = draft.text2; pageLabels(); }
    autosize();
    setButtons(true);
  };
  const grow = (el) => { el.style.height = 'auto'; el.style.height = Math.max(220, el.scrollHeight + 2) + 'px'; };
  const autosize = () => { grow(ta); if (isSpread()) grow(ta2); };
  ta.addEventListener('input', () => {
    grow(ta);
    clearTimeout(ta._t);
    ta._t = setTimeout(() => { draft.text = ta.value; db.put('drafts', draft); }, 400);
  });
  ta2.addEventListener('input', () => {
    grow(ta2);
    clearTimeout(ta2._t);
    ta2._t = setTimeout(() => { draft.text2 = ta2.value; db.put('drafts', draft); }, 400);
  });
  const useResult = (r) => {
    if (r.image) { draft.image = r.image; $('#photo img').src = URL.createObjectURL(r.image); }
    if (r.pages && r.pages.length === 2) { draft.text = r.pages[0].text; draft.text2 = r.pages[1].text; }
    else { draft.text = r.text; draft.text2 = null; }
    draft.confidence = r.confidence;
  };

  async function runOcr(auto = true) {
    setButtons(false);
    $('#text-wrap').hidden = true;
    status.hidden = false;
    $('#conf').textContent = '';
    const bar = $('#ocr-bar'), label = $('#ocr-label');
    try {
      await deskJob; // de herkenning op de achtergrond (lamp) eerst laten afronden
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
      if (res.image) { draft.image = res.image; $('#photo img').src = URL.createObjectURL(res.image); }
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
          if (r.confidence > best.confidence + 10) {
            best = r;
            draft.image = r.image || img;
            $('#photo img').src = URL.createObjectURL(draft.image);
          }
          if (best.confidence >= 75) break;
        }
      }
      useResult({ ...best, image: null });
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
    if (isSpread()) pageLabels();
    await db.put('drafts', draft);
  };

  async function save() {
    draft.text = ta.value;
    const texts = [draft.text];
    if (isSpread()) { draft.text2 = ta2.value; texts.push(draft.text2); }
    const thumb = await resizeToBlob(draft.image, 1100, 0.72);
    let existing = null;
    for (let i = 0; i < texts.length; i++) {
      const n = draft.pageNumber + i, id_ = pageId(id, n);
      const old = await db.get('pages', id_);
      existing = existing || old;
      await db.put('pages', {
        id: id_, bookId: id, pageNumber: n,
        text: texts[i].trim(), confidence: draft.confidence ?? null,
        image: thumb, savedAt: Date.now(), createdAt: old?.createdAt || Date.now(),
      });
    }
    await db.del('drafts', id);
    const pages = await db.pagesOf(id);
    const set = new Set(pages.map(p => p.pageNumber));
    book.nextPage = nextUnscanned(draft.pageNumber + texts.length, set, book);
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
    if (act === 'unsplit') {
      draft.text = [ta.value, ta2.value].filter(t => t.trim()).join('\n\n');
      draft.text2 = null;
      await db.put('drafts', draft);
      return showText(draft.text);
    }
    if (act === 'rotate') {
      draft.image = await resizeToBlob(draft.image, 2200, 0.9, 90);
      draft.text = null; draft.text2 = null;
      await db.put('drafts', draft);
      $('#photo img').src = URL.createObjectURL(draft.image);
      return runOcr(false);
    }
    if (act === 'retake') {
      book.nextPage = draft.pageNumber;
      await Promise.all([db.del('drafts', id), db.put('books', book)]);
      toast('Leg de pagina terug en neem hem opnieuw op');
      return go(`#/boek/${id}/lamp`);
    }
    if (act === 'discard') {
      if (!await confirmSheet('Scan weggooien?', 'De foto en de herkende tekst worden niet bewaard.', 'Weggooien', true)) return;
      await db.del('drafts', id);
      return go(`#/boek/${id}`);
    }
    if (act === 'save' || act === 'save-next') {
      let next = act === 'save-next';
      const taken = [draft.pageNumber, ...(isSpread() ? [draft.pageNumber + 1] : [])].filter(n => scanned.has(n));
      if (taken.length) {
        const title = taken.length > 1 ? `Pagina ${taken[0]} en ${taken[1]} bestaan al` : `Pagina ${taken[0]} bestaat al`;
        if (!await confirmSheet(title, 'De eerder opgeslagen tekst wordt vervangen.', 'Vervangen')) return;
      }
      setButtons(false);
      // Na opslaan meteen de volgende opname van de lamp nakijken, anders terug naar het bureau.
      await save();
      toast(isSpread() ? `Pagina ${draft.pageNumber} en ${draft.pageNumber + 1} opgeslagen` : `Pagina ${draft.pageNumber} opgeslagen`);
      if (next && await takeFromInbox(id)) return go(`#/boek/${id}/scan`, true);
      return go(`#/boek/${id}/lamp`, true);
    }
  };
  app.addEventListener('click', onClick);
  const prevCleanup = cleanup;
  cleanup = () => { prevCleanup(); app.removeEventListener('click', onClick); };
}

/* ---------- Bureau: iPhone op de lamp, bediening op de computer ---------- */

let deskJob = Promise.resolve();   // herkenning die op de achtergrond loopt

/** Opnames van de lamp die bij dit boek horen, op volgorde van opname. */
async function inboxOf(bookId) {
  return (await shots.all()).filter(s => s.bookId === bookId).sort((a, b) => a.id - b.id);
}

/** Zet de oudste opname van de lamp klaar als concept, zodat hij in het gewone nakijkscherm opent. */
async function takeFromInbox(bookId) {
  const book = await db.get('books', bookId);
  const [s] = await inboxOf(bookId);
  if (!book || !s) return false;
  const done = s.status === 'done';
  await db.put('drafts', {
    bookId, pageNumber: book.nextPage,
    image: (done && s.rotated) || s.image,
    text: done ? s.text : null,
    text2: done ? (s.text2 ?? null) : null,
    confidence: done ? s.confidence : null,
    rotate: 0, createdAt: Date.now(), fromLamp: true,
  });
  await shots.del(s.id);
  return true;
}

/** De verbinding met de iPhone blijft bestaan zolang de app openstaat, ook tijdens het nakijken. */
let desk = null;
function ensureDesk(bookId) {
  if (!desk) {
    const d = desk = { bookId, ui: null, code: null };
    d.link = host({
      ready(code) { d.code = code; d.ui?.ready(code); },
      open() { d.ui?.open(); },
      close() { d.ui?.close(); },
      error(text) { d.ui?.error(text); },
      async message(m) {
        if (!m || typeof m !== 'object') return;
        if (m.t === 'shot') {
          if (!await shots.get(m.id)) {
            await shots.put({ id: m.id, bookId: d.bookId, width: m.w, height: m.h, image: toBlob(m.img), createdAt: m.createdAt, status: 'new' });
          }
          d.link.send({ t: 'ack', id: m.id });
          if (d.ui) d.ui.shot(); else toast('Nieuwe opname van de lamp ontvangen');
          return;
        }
        d.ui?.message(m);
      },
    });
  }
  desk.bookId = bookId;
  return desk;
}

async function viewDesk(id) {
  const book = await db.get('books', id);
  if (!book) return go('#/', true);

  render(`
    <section class="view view-desk">
      <header class="top">
        <a class="back" href="#/boek/${id}">${icon('back')} ${esc(book.title)}</a>
      </header>
      <h1 class="h1">Scannen met de lamp</h1>

      <div class="desk">
        <div class="desk-main">
          <div class="pair" id="pair">
            <div class="qr" id="qr"><p class="muted small">Koppelcode maken…</p></div>
            <div class="pair-text">
              <h2>Koppel je iPhone</h2>
              <ol class="muted small">
                <li>Open de Camera-app op je iPhone en richt hem op deze code.</li>
                <li>Tik op de link die verschijnt.</li>
                <li>Tik op het scherm van de iPhone en leg hem liggend op de lamp.</li>
              </ol>
              <p class="muted small">iPhone en computer moeten op hetzelfde wifi-netwerk zitten. Al eerder gekoppeld? Open dan gewoon de Boekscanner-pagina op je iPhone weer.</p>
              <p class="muted small" id="pair-err"></p>
            </div>
          </div>
          <figure class="live" id="live-wrap" hidden>
            <canvas id="live" role="img" aria-label="Live beeld van de iPhone"></canvas>
          </figure>
          <div class="desk-bar">
            <span class="pill" id="link-state">niet gekoppeld</span>
            <span class="pill" id="cam-state" hidden></span>
            <span class="pill pill-warn" id="res-warn" hidden>camera levert geen 4K</span>
            <span class="spacer"></span>
            <button class="btn btn-quiet" data-act="zoom" id="zoom" title="Inzoomen op het boek (alleen in dit beeld; de opname blijft het hele beeld)">Inzoomen <kbd>Z</kbd></button>
            <button class="btn btn-quiet" data-act="turn" id="turn" title="Live beeld een kwartslag draaien">${icon('rotate')} Draaien <kbd>R</kbd></button>
            <button class="btn btn-quiet" data-act="auto" id="auto" disabled>Auto aan <kbd>A</kbd></button>
            <button class="btn btn-primary" data-act="shoot" id="shoot" disabled>Opnemen <kbd>spatie</kbd></button>
          </div>
          <p class="muted small">Blader om en houd stil: de iPhone neemt vanzelf op. Of druk op de spatiebalk.</p>
        </div>

        <aside class="desk-side">
          <div class="block-head">
            <h2>Opnames <span class="muted" id="inbox-n"></span></h2>
          </div>
          <p class="muted small">Volgende pagina: p. <span id="next-p">${book.nextPage}</span>. Elke opname van een open boek wordt twee pagina's.</p>
          <ul class="inbox" id="inbox"></ul>
          <button class="btn btn-primary btn-block" data-act="review" id="review" disabled>Nakijken en opslaan</button>
        </aside>
      </div>
    </section>
  `);

  let alive = true;
  let lastFrame = null;
  const urls = [];
  // Hoe het live beeld gedraaid wordt. Vanzelf uit de eerste herkende opname, of met de hand (onthouden).
  let turn = (() => { try { return JSON.parse(localStorage.getItem('boekscanner-lampdraai')) || { deg: 0, manual: false }; } catch { return { deg: 0, manual: false }; } })();
  const setTurn = (deg, manual) => {
    turn = { deg: ((deg % 360) + 360) % 360, manual: manual || turn.manual };
    localStorage.setItem('boekscanner-lampdraai', JSON.stringify(turn));
    if (lastFrame) drawFrame(lastFrame);
  };
  // Inzoomen op het boek: alleen de weergave, de camera blijft op 1x en de opname is het hele beeld.
  let zoomOn = localStorage.getItem('boekscanner-lampzoom') !== 'uit';
  let box = null;   // gladgestreken uitsnede { x, y, w, h } in pixels van het voorbeeldbeeld
  const probe = document.createElement('canvas');
  const setZoom = (on) => {
    zoomOn = on;
    localStorage.setItem('boekscanner-lampzoom', on ? 'aan' : 'uit');
    $('#zoom').classList.toggle('btn-on', on);
    if (lastFrame) drawFrame(lastFrame);
  };
  function trackBook(bmp) {
    const k = 480 / Math.max(bmp.width, bmp.height);
    probe.width = Math.round(bmp.width * k); probe.height = Math.round(bmp.height * k);
    probe.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, probe.width, probe.height);
    const b = findBookBox(grayFromCanvas(probe));
    if (!b) return;
    // Wat ruimte eromheen, en binnen het beeld blijven.
    const m = 0.03 * Math.max(b.w, b.h);
    let x = Math.max(0, b.x - m), y = Math.max(0, b.y - m);
    const r = { x: x / k, y: y / k, w: (Math.min(probe.width, b.x + b.w + m) - x) / k, h: (Math.min(probe.height, b.y + b.h + m) - y) / k };
    if (!box) { box = r; return; }
    // Rustig volgen: kleine verschuivingen negeren, grotere geleidelijk overnemen.
    const d = Math.max(Math.abs(r.x - box.x), Math.abs(r.y - box.y), Math.abs(r.w - box.w), Math.abs(r.h - box.h));
    if (d < 0.03 * Math.max(bmp.width, bmp.height)) return;
    for (const key of ['x', 'y', 'w', 'h']) box[key] += (r[key] - box[key]) * 0.35;
  }
  function drawFrame(bmp) {
    const c = $('#live');
    if (!c) return;
    const src = zoomOn && box ? box : { x: 0, y: 0, w: bmp.width, h: bmp.height };
    // Niet kleiner tekenen dan het beeld was: bij inzoomen schalen we op tot de oorspronkelijke grootte.
    const scale = Math.max(bmp.width, bmp.height) / Math.max(src.w, src.h);
    const w = Math.round(src.w * scale), h = Math.round(src.h * scale);
    const side = turn.deg % 180 !== 0;
    c.width = side ? h : w;
    c.height = side ? w : h;
    const g = c.getContext('2d');
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.rotate((turn.deg * Math.PI) / 180);
    g.drawImage(bmp, src.x, src.y, src.w, src.h, -w / 2, -h / 2, w, h);
    g.restore();
  }
  const linkState = $('#link-state'), camState = $('#cam-state');

  const setLinked = (on) => {
    linkState.textContent = on ? 'iPhone gekoppeld' : 'niet gekoppeld';
    linkState.className = 'pill ' + (on ? 'pill-ok' : '');
    $('#shoot').disabled = !on;
    $('#auto').disabled = !on;
    if (!on) { $('#live-wrap').hidden = true; $('#pair').hidden = false; camState.hidden = true; }
  };
  const setAuto = (on) => {
    const b = $('#auto');
    b.dataset.on = on ? '1' : '';
    b.innerHTML = (on ? 'Auto aan' : 'Auto uit') + ' <kbd>A</kbd>';
    b.classList.toggle('btn-on', on);
  };

  const d = ensureDesk(id);
  const link = d.link;
  d.ui = {
    ready(code) {
      if (!alive) return;
      const url = new URL('lamp.html', location.href);
      url.search = location.search;   // testinstellingen meenemen
      url.hash = 'koppel=' + code;
      const qr = qrcode(0, 'M');
      qr.addData(url.href);
      qr.make();
      $('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }) + `<a class="muted small qr-link" href="${esc(url.href)}" target="_blank" rel="noopener">link</a>`;
      $('#pair-err').textContent = '';
    },
    open() { setLinked(true); toast('iPhone gekoppeld'); },
    close() {
      setLinked(false);
      $('#pair-err').textContent = 'Verbinding weg. De iPhone probeert het vanzelf opnieuw; scan anders de code nog eens.';
    },
    error(text) { $('#pair-err').textContent = text; },
    async shot() { flash(); await drawInbox(); work(); },
    message(m) {
      if (m.t === 'hello') { setAuto(!!m.auto); return; }
      if (m.t === 'preview') {
        if (m.img) {
          createImageBitmap(toBlob(m.img)).then((bmp) => {
            if (!alive) return bmp.close();
            if (lastFrame) lastFrame.close();
            lastFrame = bmp;
            trackBook(bmp);
            drawFrame(bmp);
          }).catch(() => {});
        }
        $('#pair').hidden = true;
        $('#live-wrap').hidden = false;
        camState.hidden = !m.state;
        camState.textContent = m.state || '';
        if (typeof m.auto === 'boolean') setAuto(m.auto);
        if (m.w) $('#res-warn').hidden = Math.max(m.w, m.h) >= 3840;
      }
    },
  };
  $('#zoom').classList.toggle('btn-on', zoomOn);
  if (d.code) d.ui.ready(d.code);
  if (link.connected) setLinked(true);

  function flash() {
    const w = $('#live-wrap');
    w.classList.remove('flash'); void w.offsetWidth; w.classList.add('flash');
  }

  async function drawInbox() {
    if (!alive) return;
    const items = await inboxOf(id);
    const b = await db.get('books', id);
    $('#next-p').textContent = b ? b.nextPage : '';
    $('#inbox-n').textContent = items.length ? `(${items.length})` : '';
    $('#review').disabled = !items.length;
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    $('#inbox').innerHTML = items.length ? items.map((s, i) => {
      const u = URL.createObjectURL((s.status === 'done' && s.rotated) || s.image); urls.push(u);
      const st = s.status === 'done' ? `klaar · ${s.confidence ?? '?'}% zeker`
        : s.status === 'busy' ? `herkennen… <span data-prog="${s.id}"></span>`
        : s.status === 'error' ? 'herkennen mislukt' : 'wacht';
      return `<li class="inbox-row">
        <img src="${u}" alt="Opname ${i + 1}">
        <span class="inbox-txt"><strong>${i + 1}</strong> <span class="muted small">${st}</span></span>
        <button class="icon-btn" data-act="del-shot" data-id="${s.id}" aria-label="Opname weggooien">${icon('trash')}</button>
      </li>`;
    }).join('') : '<li class="muted small">Nog geen opnames. Ze verschijnen hier zodra de iPhone een pagina opneemt.</li>';
  }

  /** Herkent de opnames één voor één op de achtergrond, zodat nakijken daarna direct kan. */
  let working = false;
  async function work() {
    if (working) return;
    working = true;
    try {
      while (alive) {
        const s = (await inboxOf(id)).find(x => x.status === 'new' || x.status === 'busy');
        if (!s) break;
        s.status = 'busy';
        await shots.put(s);
        await drawInbox();
        let res = null;
        const job = ocr.recognize(s.image, book.lang, (m) => {
          const el = document.querySelector(`[data-prog="${s.id}"]`);
          if (el && m.status === 'recognizing text') el.textContent = Math.round(m.progress * 100) + '%';
        });
        deskJob = job.catch(() => {});
        try { res = await job; } catch (err) { console.error(err); }
        const cur = await shots.get(s.id);
        if (!cur) continue;   // intussen weggegooid of al in het nakijkscherm
        if (res) {
          Object.assign(cur, {
            status: 'done', confidence: res.confidence, rotated: res.image || null,
            text: res.pages && res.pages.length === 2 ? res.pages[0].text : res.text,
            text2: res.pages && res.pages.length === 2 ? res.pages[1].text : null,
          });
        } else cur.status = 'error';
        await shots.put(cur);
        if (res && !turn.manual && res.confidence >= 60) setTurn(res.rotated || 0, false);
        await drawInbox();
      }
    } finally { working = false; }
  }

  const onKey = (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); if (link.connected) link.send({ t: 'capture' }); }
    if (e.code === 'KeyR') setTurn(turn.deg + 90, true);
    if (e.code === 'KeyZ') setZoom(!zoomOn);
    if (e.code === 'KeyA' && link.connected) { const on = !$('#auto').dataset.on; setAuto(on); link.send({ t: 'auto', on }); }
  };
  const onClick = async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'shoot') return link.send({ t: 'capture' });
    if (act === 'turn') return setTurn(turn.deg + 90, true);
    if (act === 'zoom') return setZoom(!zoomOn);
    if (act === 'auto') { const on = !el.dataset.on; setAuto(on); return link.send({ t: 'auto', on }); }
    if (act === 'del-shot') { await shots.del(+el.dataset.id); return drawInbox(); }
    if (act === 'review') {
      if (await db.get('drafts', id)) return go(`#/boek/${id}/scan`);
      if (await takeFromInbox(id)) go(`#/boek/${id}/scan`);
    }
  };
  document.addEventListener('keydown', onKey);
  app.addEventListener('click', onClick);
  cleanup = () => {
    alive = false;
    d.ui = null;   // de verbinding blijft open, zodat opnames binnenkomen terwijl je nakijkt
    document.removeEventListener('keydown', onKey);
    app.removeEventListener('click', onClick);
    if (lastFrame) lastFrame.close();
    urls.forEach(u => URL.revokeObjectURL(u));
  };

  await drawInbox();
  work();
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
      await db.put('books', book);
      toast(`Leg pagina ${n} onder de lamp`);
      return go(`#/boek/${id}/lamp`);
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
