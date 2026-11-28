/* Twijfelwoorden bij het nakijken: woorden waar de herkenning onzeker over is, licht gemarkeerd
   in het tekstvak. Met "Volgende" spring je erlangs en zie je dat stukje van de foto vergroot,
   zodat je niet de hele pagina hoeft te lezen. Een woord dat je aanpast, verliest zijn markering. */

const escHtml = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Waar de twijfelwoorden nu in de tekst staan (de tekst kan intussen zijn aangepast). */
export function locateDoubts(text, doubts) {
  const out = [];
  let cursor = 0, drift = 0;
  for (const d of [...(doubts || [])].sort((a, b) => a.i - b.i)) {
    const want = d.i + drift;
    let pos = text.indexOf(d.word, Math.max(cursor, want - 300));
    // Te ver weg of in een ander woord: dan is het woord aangepast.
    const isWord = (p) => p >= 0 && !/[\p{L}\p{N}]/u.test(text[p - 1] || '') && !/[\p{L}\p{N}]/u.test(text[p + d.word.length] || '');
    while (pos >= 0 && !isWord(pos) && pos - want < 300) pos = text.indexOf(d.word, pos + 1);
    if (pos < 0 || Math.abs(pos - want) > 300 || !isWord(pos)) continue;
    out.push({ ...d, a: pos, b: pos + d.word.length });
    drift = pos - d.i;
    cursor = pos + d.word.length;
  }
  return out;
}

/**
 * Zet een markeerlaag achter het tekstvak en een balk eronder.
 * ta: het tekstvak; doubts(): de twijfelwoorden; scan(): de rechtgezette pagina (Blob) of null.
 */
export function attachDoubts(ta, doubts, scan) {
  const wrap = document.createElement('div');
  wrap.className = 'doubt-wrap';
  ta.parentNode.insertBefore(wrap, ta);
  const back = document.createElement('div');
  back.className = 'doubt-back';
  back.setAttribute('aria-hidden', 'true');
  wrap.append(back, ta);
  // Onder het tekstvak, maar zichtbaar blijvend onderin beeld zolang je in dit tekstvak bezig bent.
  const dock = document.createElement('div');
  dock.className = 'doubt-dock';
  const peek = document.createElement('canvas');
  peek.className = 'doubt-peek';
  peek.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'doubt-bar';
  bar.hidden = true;
  bar.innerHTML = `<span class="doubt-count"></span><button type="button" class="chip doubt-next">Volgende</button>`;
  dock.append(peek, bar);
  wrap.after(dock);

  let marks = [], at = -1, bmp = null, bmpOf = null;
  const render = () => {
    marks = locateDoubts(ta.value, doubts());
    const t = ta.value;
    let html = '', p = 0;
    marks.forEach((m, k) => { html += escHtml(t.slice(p, m.a)) + `<mark${k === at ? ' class="on"' : ''}>${escHtml(t.slice(m.a, m.b))}</mark>`; p = m.b; });
    back.innerHTML = html + escHtml(t.slice(p)) + '\n';
    bar.hidden = !marks.length;
    if (at >= marks.length) at = marks.length - 1;
    const n = marks.length === 1 ? '1 twijfelwoord' : `${marks.length} twijfelwoorden`;
    bar.querySelector('.doubt-count').textContent = at >= 0 ? `${at + 1} van ${n}` : n;
    if (!marks.length) peek.hidden = true;
  };
  const show = async (m) => {
    const blob = scan();
    if (!m.box || !blob) { peek.hidden = true; return; }
    if (bmpOf !== blob) { bmp = await createImageBitmap(blob); bmpOf = blob; }
    const [x0, y0, x1, y1] = m.box;
    const h = (y1 - y0) * bmp.height;
    // Het woord met wat tekst eromheen, zodat je ziet waar het staat.
    const sx = Math.max(0, x0 * bmp.width - h * 6), ex = Math.min(bmp.width, x1 * bmp.width + h * 6);
    const sy = Math.max(0, y0 * bmp.height - h * 0.8), ey = Math.min(bmp.height, y1 * bmp.height + h * 0.8);
    const sc = Math.min(3, 900 / Math.max(1, ex - sx));
    peek.width = Math.round((ex - sx) * sc); peek.height = Math.round((ey - sy) * sc);
    const g = peek.getContext('2d');
    g.drawImage(bmp, sx, sy, ex - sx, ey - sy, 0, 0, peek.width, peek.height);
    g.strokeStyle = 'rgba(180,83,42,0.9)'; g.lineWidth = 2;
    g.strokeRect((x0 * bmp.width - sx) * sc - 3, (y0 * bmp.height - sy) * sc - 3, (x1 - x0) * bmp.width * sc + 6, h * sc + 6);
    peek.hidden = false;
  };
  bar.querySelector('.doubt-next').addEventListener('click', () => {
    if (!marks.length) return;
    at = (at + 1) % marks.length;
    const m = marks[at];
    render();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(m.a, m.b);
    const mk = back.querySelectorAll('mark')[at];
    if (mk) mk.scrollIntoView({ block: 'center', behavior: 'smooth' });
    show(m);
  });
  ta.addEventListener('input', render);
  return { render };
}
