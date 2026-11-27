/* Boekscanner — koppeling tussen de iPhone (camera op de lamp) en de computer.
   Rechtstreeks via WebRTC over het eigen netwerk. Alleen de eerste kennismaking
   loopt via de gratis openbare PeerJS-server; foto's gaan nooit via een server.
   Vereist vendor/peerjs/peerjs.min.js (globale `Peer`). */

/* ---------- Opslag van opnames (gedeeld door telefoon en computer) ---------- */

export const shots = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('boekscanner-lamp', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('shots', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('shots', mode);
      const r = fn(t.objectStore('shots'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  },
  all() { return this.run('readonly', s => s.getAll()); },
  get(id) { return this.run('readonly', s => s.get(id)); },
  count() { return this.run('readonly', s => s.count()); },
  put(v) { return this.run('readwrite', s => s.put(v)); },
  del(id) { return this.run('readwrite', s => s.delete(id)); },
  clear() { return this.run('readwrite', s => s.clear()); },
};

/* ---------- Verbinding ---------- */

/** Instellingen voor PeerJS. `?peerhost=localhost:9000` gebruikt een eigen server (voor tests). */
function peerOptions() {
  const q = new URLSearchParams(location.search).get('peerhost');
  if (!q) return { debug: 1 };
  const [host, port] = q.split(':');
  return { host, port: +port || 9000, path: '/', secure: false, debug: 1 };
}

const newId = () => 'boekscanner-' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');

/**
 * Computer: wacht op de telefoon. Houdt dezelfde code vast (localStorage),
 * zodat de QR-code na herladen geldig blijft.
 * on: { ready(id), open(), close(), message(msg), error(text) }
 */
export function host(on) {
  let peer = null, conn = null, stopped = false;
  const start = (id) => {
    peer = new Peer(id, peerOptions());
    peer.on('open', (pid) => { localStorage.setItem('boekscanner-koppelcode', pid); on.ready(pid); });
    peer.on('connection', (c) => {
      if (conn && conn.open) conn.close();   // één telefoon tegelijk: de nieuwste wint
      conn = c;
      c.on('open', () => on.open());
      c.on('data', (m) => on.message(m));
      c.on('close', () => { if (conn === c) { conn = null; on.close(); } });
      c.on('error', () => {});
    });
    peer.on('disconnected', () => { if (!stopped) setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000); });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') { peer.destroy(); localStorage.removeItem('boekscanner-koppelcode'); return start(newId()); }
      if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') on.error('Geen verbinding met de koppelserver. Controleer of je online bent.');
      else if (err.type !== 'peer-unavailable') on.error(`Koppelen mislukt (${err.type}).`);
    });
  };
  start(localStorage.getItem('boekscanner-koppelcode') || newId());
  return {
    send(m) { if (conn && conn.open) conn.send(m); },
    get connected() { return !!(conn && conn.open); },
    stop() { stopped = true; if (peer) peer.destroy(); peer = null; conn = null; },
  };
}

/**
 * Telefoon: verbindt met de computer met de code uit de QR-code en blijft het opnieuw proberen.
 * on: { open(), close(), message(msg) }
 */
export function join(code, on) {
  let peer = null, conn = null, stopped = false, timer = null;
  const retry = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(connect, 3000); };
  const connect = () => {
    if (stopped) return;
    if (!peer || peer.destroyed) {
      peer = new Peer(peerOptions());
      peer.on('open', connect);
      peer.on('disconnected', () => { if (!stopped && !peer.destroyed) peer.reconnect(); });
      peer.on('error', () => { if (!conn || !conn.open) retry(); });
      return;
    }
    if (!peer.open) return;
    const c = peer.connect(code, { reliable: true, serialization: 'binary' });
    conn = c;
    const t = setTimeout(() => { if (conn === c && !c.open) { conn = null; c.close(); retry(); } }, 12000);
    c.on('open', () => { clearTimeout(t); on.open(); });
    c.on('data', (m) => on.message(m));
    c.on('close', () => { if (conn === c) { conn = null; on.close(); retry(); } });
    c.on('error', () => retry());
  };
  connect();
  return {
    send(m) { if (conn && conn.open) { conn.send(m); return true; } return false; },
    get connected() { return !!(conn && conn.open); },
    /** Bytes die nog onderweg zijn; voorbeeldbeelden worden overgeslagen als dit oploopt. */
    get buffered() { return (conn && conn.dataChannel && conn.dataChannel.bufferedAmount) || 0; },
    stop() { stopped = true; clearTimeout(timer); if (peer) peer.destroy(); peer = null; conn = null; },
  };
}

/** Blob → ArrayBuffer en terug (voor verzenden). */
export const toBuffer = (blob) => blob.arrayBuffer();
export const toBlob = (buf, type = 'image/jpeg') => new Blob([buf], { type });
