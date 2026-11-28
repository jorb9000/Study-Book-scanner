/* Exporteren met beelden: een zip met de Markdown en een map met de beelden, en een PDF via het
   afdrukmenu (Bewaar als PDF). Alles in de browser, zonder extra bibliotheken. */

const FIG_RE = /!\[([^\]]*)\]\(#beeld-(\d+)\)/g;

/** Vervangt de verwijzingen naar beelden in de tekst van een pagina.
    mode 'files': naar beelden/p012-1.jpg (en verzamelt de bestanden); 'urls': naar een object-URL
    (voor de PDF); 'none': het beeld weglaten (het bijschrift blijft staan). */
export function resolveFigures(text, page, mode, out) {
  return text.replace(FIG_RE, (m, alt, n) => {
    const f = (page.figures || []).find(x => x.n === +n);
    if (!f || !f.blob || mode === 'none') return '';
    if (mode === 'urls') {
      const url = URL.createObjectURL(f.blob);
      out.push(url);
      return `![${alt}](${url})`;
    }
    const name = `beelden/p${String(page.pageNumber).padStart(3, '0')}-${n}.jpg`;
    out.push({ name, blob: f.blob });
    return `![${alt}](${name})`;
  }).replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Zip (zonder compressie: foto's zijn al gecomprimeerd) ---------- */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Maakt een zip van [{ name, blob | text }]. */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const data = f.text != null ? enc.encode(f.text) : new Uint8Array(await f.blob.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, 0, true); head.setUint16(10, time, true); head.setUint16(12, date, true);
    head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    parts.push(head, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/* ---------- PDF (via afdrukken) ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');

/** Eenvoudige Markdown naar HTML: koppen, alinea's, citaten, opsommingen, beelden met bijschrift. */
export function markdownToHtml(md) {
  const blocks = md.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const img = b.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      // Bijschrift: de cursieve regel direct eronder.
      const next = blocks[i + 1] || '';
      const cap = /^\*[^*].*\*$/.test(next) && !/^\*p\. \d+\*$/.test(next) ? next.slice(1, -1) : '';
      if (cap) i++;
      out.push(`<figure><img src="${esc(img[2])}" alt="${esc(img[1])}">${cap ? `<figcaption>${inline(cap)}</figcaption>` : ''}</figure>`);
      continue;
    }
    const h = b.match(/^(#{1,6}) (.*)$/s);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^\*p\. \d+\*$/.test(b)) { out.push(`<p class="pn">${esc(b.slice(1, -1))}</p>`); continue; }
    if (b.startsWith('> ')) { out.push(`<blockquote>${inline(b.replace(/^> ?/gm, ''))}</blockquote>`); continue; }
    const lines = b.split('\n');
    if (lines.every(l => /^- /.test(l))) { out.push(`<ul>${lines.map(l => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`); continue; }
    if (lines.every(l => /^\d{1,3}\. /.test(l))) { out.push(`<ol start="${parseInt(lines[0], 10)}">${lines.map(l => `<li>${inline(l.replace(/^\d+\. /, ''))}</li>`).join('')}</ol>`); continue; }
    out.push(`<p>${inline(b).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

/** Zet het boek klaar als nette pagina's en opent het afdrukmenu (daar: Bewaar als PDF). */
export async function printMarkdown(title, md) {
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = `<article class="print-book">${markdownToHtml(md)}</article>`;
  document.body.appendChild(root);
  document.body.classList.add('printing');
  // Wachten tot de beelden geladen zijn, anders staan ze niet in de PDF.
  await Promise.all([...root.querySelectorAll('img')].map(im => (im.complete ? null : new Promise(r => { im.onload = im.onerror = r; }))));
  const old = document.title;
  document.title = title;
  return new Promise((resolve) => {
    const done = () => {
      if (!root.isConnected) return;
      document.title = old;
      document.body.classList.remove('printing');
      root.remove();
      window.removeEventListener('afterprint', done);
      resolve();
    };
    window.addEventListener('afterprint', done);
    window.print();
    // Sommige browsers sturen geen afterprint; dan na een tijdje opruimen.
    setTimeout(done, 120000);
  });
}
