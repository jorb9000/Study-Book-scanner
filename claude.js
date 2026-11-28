/* Claude-modus: de tekst laten lezen door Claude in plaats van Tesseract.
   Je eigen API-sleutel staat alleen in deze browser (localStorage). De foto's gaan dan rechtstreeks
   van deze browser naar Anthropic; er zit geen server van ons tussen.
   Per pagina: de rechtgezette kleurenfoto gaat naar Claude, die Markdown teruggeeft (in leesvolgorde,
   kolom voor kolom) met per beeld een kader en bijschrift. De app knipt de beelden daarna zelf uit. */

import { figureMarkdown } from './figures.js';
import { cropFromScan } from './figure-ui.js';

const KEY = 'boekscanner-claude';

/** De modellen waaruit je kunt kiezen, met een schatting van de kosten per pagina (in dollarcent). */
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (nauwkeurigst)', cents: 5 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', cents: 2.5 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (goedkoopst)', cents: 0.15 },
];

export const claudeSettings = {
  get() {
    try { return { on: false, key: '', model: MODELS[0].id, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { return { on: false, key: '', model: MODELS[0].id }; }
  },
  set(patch) {
    const s = { ...this.get(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(s));
    return s;
  },
  /** Staat de Claude-modus aan en is er een sleutel? */
  active() { const s = this.get(); return !!(s.on && s.key); },
};

let sdk = null;
const loadSdk = () => (sdk ||= import('./vendor/anthropic/anthropic.mjs').then(m => m.Anthropic));

async function client(key) {
  const Anthropic = await loadSdk();
  // De sleutel is van de gebruiker zelf en blijft op dit toestel; er is geen eigen server.
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 3 });
}

const LANGS = { nld: 'Nederlands', eng: 'Engels' };

const SYSTEM = `Je zet foto's van pagina's uit (studie)boeken om naar nette Markdown. Neem de tekst letterlijk over, woord voor woord, met de spelling en leestekens van het boek. Verbeter, vertaal of vat niets samen.

Regels:
- Lees in de volgorde waarin een mens de pagina leest: bij kolommen eerst de hele linkerkolom van boven naar beneden, dan de volgende kolom.
- Een woord dat aan het eind van een regel is afgebroken, plak je weer aan elkaar. Gewone regeleinden binnen een alinea worden spaties; tussen alinea's een lege regel.
- Koppen: ## voor een hoofdstuk- of hoofdkop, ### voor een tussenkop. Cursief als *cursief*, vet als **vet**. Citaten met > en opsommingen met - of 1.
- Laat de lopende paginakop (bijvoorbeeld boektitel of hoofdstuknaam bovenaan elke pagina) en het paginanummer weg.
- Is een letter of woord slecht te zien (lichtvlek, schaduw, rug), lees het dan uit de context, zoals een mens dat zou doen.
- Tekst in een kader of marge hoort op de plek waar je hem logisch zou lezen.
- Beelden (foto's, tekeningen, grafieken, schema's, kaarten, tabellen als plaatje): zet op de plek in de tekst waar het beeld hoort een regel met alleen [[BEELD n]] (n = 1, 2, ...). Geef in figures per beeld het kader in pixels van deze foto (x0, y0 linksboven; x1, y1 rechtsonder), ruim genoeg om het hele beeld te bevatten maar zonder de lopende tekst eromheen. Zet het bijschrift in caption en niet nog eens in de tekst. Tekst die in het beeld zelf staat (aslabels, legenda, tekst in een foto) neem je niet op in de lopende tekst.
- Een gewone tabel met tekst mag je ook als Markdown-tabel opnemen in plaats van als beeld.
- Staat er geen tekst op de pagina, geef dan een lege markdown.`;

const SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string', description: 'De tekst van de pagina in Markdown, met [[BEELD n]] waar een beeld staat.' },
    figures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          caption: { type: 'string' },
          x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' },
        },
        required: ['n', 'caption', 'x0', 'y0', 'x1', 'y1'],
        additionalProperties: false,
      },
    },
  },
  required: ['markdown', 'figures'],
  additionalProperties: false,
};

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function sizeOf(blob) {
  const b = await createImageBitmap(blob);
  const s = { w: b.width, h: b.height };
  b.close?.();
  return s;
}

/** Een begrijpelijke melding bij een fout van de API. */
export function explain(err) {
  const st = err?.status;
  if (st === 401) return 'Claude: de API-sleutel klopt niet.';
  if (st === 403) return 'Claude: deze sleutel heeft geen toegang tot dit model.';
  if (st === 429) return 'Claude: even te veel tegelijk, of je tegoed is op.';
  if (st === 400 && /credit|balance/i.test(err?.message || '')) return 'Claude: je tegoed is op. Vul het aan in de Claude Console.';
  if (st >= 500) return 'Claude is even niet bereikbaar.';
  if (err?.refusal) return 'Claude wilde deze pagina niet lezen.';
  if (!navigator.onLine || /fetch|network/i.test(err?.message || '')) return 'Claude: geen internet.';
  return 'Claude: ' + (err?.message || 'onbekende fout');
}

/** Leest één rechtgezette pagina. Geeft { text, figures: [{ n, caption, box, blob }] }. */
async function readPage(api, model, scan, lang) {
  const { w, h } = await sizeOf(scan);
  const talen = lang.split('+').map(l => LANGS[l] || l).join(' en ');
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64(scan) } },
        { type: 'text', text: `Dit is één boekpagina (${w} × ${h} pixels), taal: ${talen}. Zet hem om volgens de regels.` },
      ],
    }],
  };
  // Weigert het model een pagina ten onrechte, dan probeert de API het zelf met een ander model.
  // (Haiku heeft die terugval niet.)
  if (!model.includes('haiku')) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  const msg = await api.beta.messages.create(params);
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('geweigerd'), { refusal: true });
  if (msg.stop_reason === 'max_tokens') throw new Error('antwoord te lang');
  const raw = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const out = JSON.parse(raw);

  // Beelden uitknippen en op hun plek in de tekst zetten, zoals de gewone herkenning dat doet.
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const figures = [];
  const seen = new Set();
  for (const f of out.figures || []) {
    if (seen.has(f.n)) continue;
    const box = [clamp(Math.min(f.x0, f.x1) / w), clamp(Math.min(f.y0, f.y1) / h), clamp(Math.max(f.x0, f.x1) / w), clamp(Math.max(f.y0, f.y1) / h)];
    if (box[2] - box[0] < 0.02 || box[3] - box[1] < 0.02) continue;
    seen.add(f.n);
    figures.push({ n: f.n, caption: (f.caption || '').trim(), box, blob: await cropFromScan(scan, box) });
  }
  let text = String(out.markdown || '').replace(/\[\[BEELD (\d+)\]\]/g, (m, k) => {
    const f = figures.find(x => x.n === +k);
    return f ? '\n\n' + figureMarkdown(f.n, f.caption) + '\n\n' : '';
  });
  // Beelden die Claude wel noemde maar niet in de tekst zette: onderaan toevoegen.
  for (const f of figures) if (!text.includes(`(#beeld-${f.n})`)) text += '\n\n' + figureMarkdown(f.n, f.caption);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, figures, usage: msg.usage };
}

/**
 * Herkent een opname met Claude. prepare(blob, lang) doet de voorbewerking (in de worker) en geeft
 * per pagina een rechtgezette foto. Geeft hetzelfde soort resultaat als de gewone herkenning.
 */
export async function recognizeWithClaude(blob, lang, prepare, onProgress) {
  const s = claudeSettings.get();
  const api = await client(s.key);
  onProgress?.({ status: 'recognizing text', progress: 0.05 });
  const prep = await prepare(blob, lang);
  onProgress?.({ status: 'recognizing text', progress: 0.25 });
  let done = 0;
  const pages = await Promise.all(prep.pages.map(async (p) => {
    const r = await readPage(api, s.model, p.scan, lang);
    onProgress?.({ status: 'recognizing text', progress: 0.25 + 0.75 * (++done / prep.pages.length) });
    return { text: r.text, confidence: 99, figures: r.figures, scan: p.scan, usage: r.usage };
  }));
  const steps = [...prep.steps, `Claude (${s.model})`];
  const nf = pages.reduce((n, p) => n + p.figures.length, 0);
  if (nf) steps.push(`beelden ×${nf}`);
  const tokens = pages.reduce((t, p) => ({ in: t.in + (p.usage?.input_tokens || 0), out: t.out + (p.usage?.output_tokens || 0) }), { in: 0, out: 0 });
  console.debug('[claude]', steps.join(', '), `${tokens.in} tokens in, ${tokens.out} uit`);
  return {
    text: pages.map(p => p.text).join('\n\n'), confidence: 99, steps, image: prep.image, rotated: prep.rotated, engine: 'claude',
    pages: pages.map(({ usage, ...p }) => p),
  };
}

/** Kleine proef om te zien of de sleutel werkt (kost bijna niets). */
export async function testKey(key, model) {
  const api = await client(key);
  await api.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Zeg alleen: ok' }] });
}
