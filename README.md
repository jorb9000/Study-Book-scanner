# Boekscanner

Een eenvoudige web-app om studieboeken in delen te scannen. Je bedient alles op je computer; de iPhone ligt op een bureaulamp boven het boek en is alleen de camera. De app houdt per boek bij welke pagina's klaar zijn, welke ontbreken en waar je verder moet. De tekst exporteer je als Markdown.

- Werkt zonder account. Boeken en teksten blijven op je computer.
- Tekstherkenning gebeurt op de computer zelf (Nederlands en/of Engels), ook offline. Wil je het nauwkeuriger, dan kan Claude de tekst lezen (zie "Nauwkeuriger lezen met Claude").
- Geen installatie nodig: open de link in Safari of Chrome.

## Opstelling

Zet de iPhone via MagSafe op een bureaulamp, **liggend**, met de lens vrij over de rand en recht boven het boek. Zet op de iPhone **Automatisch slot** op **Nooit** (Instellingen › Scherm en helderheid).

## Een boek scannen

1. Open de Boekscanner op je computer en klik op **Nieuw boek**. Vul de titel in, de eerste pagina en eventueel de laatste pagina, en kies de taal.
2. Klik op **Scannen met de lamp**. Er verschijnt een QR-code.
3. Richt de **Camera-app** van je iPhone op de QR-code en tik op de link. Tik daarna één keer op het scherm van de iPhone en leg hem op de lamp. Een volgende keer kun je de pagina gewoon weer openen: hij onthoudt de koppeling.
4. Op de computer zie je het live beeld. Automatisch opnemen en inzoomen staan bij de start uit, zodat je eerst rustig het boek goed kunt leggen. Klik daarna op **Start automatisch opnemen** (of druk op **A**): blader om en houd stil, de iPhone neemt vanzelf op. Of druk zelf op de **spatiebalk**. Met **R** (of **Draaien**) draai je het live beeld een kwartslag; na de eerste herkende opname gebeurt dat vanzelf. Met **Z** (**Inzoomen**) zoomt het beeld in op de pagina's. Met **S** (**Rechtzetten**) trek je een schuin liggend boek recht in het live beeld, alsof het loodrecht onder de camera ligt; zo zie je makkelijker of het boek goed ligt. Inzoomen en Rechtzetten staan bij de start uit. Dat is alleen de weergave: de iPhone blijft op 1x en de opname is altijd het hele beeld.
5. Elke opname komt direct op de computer binnen en wordt op de achtergrond herkend, ook als je intussen iets anders doet. Na elke opname staat er op het live beeld een groen vinkje met de pagina's ("✓ Opgenomen · p. 12–13 · blader door") tot je omslaat; houd je stil zonder om te slaan, dan zie je "Deze pagina is al opgenomen". Onder het beeld telt de app de opnames mee. In de lijst **Opnames** staat de nieuwste bovenaan, met per opname welke pagina's het waarschijnlijk zijn. Klik op een opname om hem na te kijken, ook als hij nog herkend wordt. Met **Nakijken en opslaan** loop je ze één voor één door. Een opname van een open boek wordt twee pagina's.
6. Stoppen mag op elk moment. De volgende keer staat het boek al op de juiste pagina.

De iPhone laat alleen het camerabeeld en een statuslampje zien (groen: klaar, oranje: zoekt computer of beweging). Na een paar seconden wordt het scherm donker; tik erop om het weer te zien.

iPhone en computer moeten op hetzelfde wifi-netwerk zitten. Alleen de kennismaking loopt via de gratis openbare PeerJS-server; de foto's gaan rechtstreeks van telefoon naar computer. Op een netwerk dat apparaten van elkaar afschermt (zoals eduroam) lukt dat niet: zet dan de hotspot van je iPhone aan en verbind de computer daarmee. Valt de verbinding weg, dan blijven opnames op de telefoon bewaard en worden ze verstuurd zodra de verbinding terug is.

Handig om te weten:
- **Volgende pagina** (− / +) zet je op een ander paginanummer, bijvoorbeeld als je pagina's met alleen plaatjes overslaat.
- Bij **Nog niet gescand** zie je welke pagina's ontbreken. Klik erop om daar verder te gaan.
- **Hoofdstukken** zijn optioneel: geef aan op welke pagina een hoofdstuk begint, dan kun je per hoofdstuk exporteren.
- Ligt de foto gedraaid, dan probeert de app zelf de juiste richting. Lukt dat niet, gebruik dan **Draaien**.
- Koppen, citaten en opsommingen worden herkend en als Markdown opgeslagen (`##`, `>`, `-`).
- Cursief en vet worden in de foto gemeten (schuinte en lijndikte per woord) en komen als `*cursief*` en `**vet**` in de tekst. Een hoofdstuknummer met titel wordt één kop; de terugkerende paginakop bovenaan (bijvoorbeeld de boektitel in kapitalen) valt weg.

### Boeken die nog op de iPhone staan

Heb je eerder op de iPhone zelf gescand? Open de app op de iPhone, tik op **Back-up maken** en zet die back-up op de computer terug met **Back-up terugzetten** (de ••• rechtsboven op het beginscherm).

## Nauwkeuriger lezen met Claude (optioneel)

Standaard leest de computer de tekst zelf: gratis en offline. Bij pagina's met kolommen, foto's of lichtvlekken moet je dan meer nakijken. Wil je dat de tekst meteen vrijwel foutloos is, zet dan de **Claude-modus** aan. Claude leest de pagina zoals een mens: kolom voor kolom, met koppen, cursief en vet, en met elk beeld en bijschrift op de goede plek. De app knipt de beelden daarna zelf uit, net als bij de gewone herkenning.

Zo zet je hem aan:

1. Ga naar [console.anthropic.com](https://console.anthropic.com) en maak een account. Dat staat los van een Claude-abonnement.
2. Kies **Billing** en zet er tegoed op, bijvoorbeeld $5. Onder **Limits** kun je een maandlimiet instellen.
3. Kies **API keys** › **Create key**, noem hem bijvoorbeeld "Boekscanner" en kopieer de sleutel.
4. Open in de Boekscanner op je computer de ••• rechtsboven op het beginscherm (**Back-up en instellingen**). Kies bij **Tekstherkenning** voor **Met Claude**, plak je sleutel en klik op **Sleutel testen**.

Goed om te weten:
- **Kosten** (schatting): met Claude Opus 5.5 (het nauwkeurigst) ongeveer 5 cent per pagina, zo'n $15 voor een boek van 300 pagina's. Claude Sonnet 5.5 kost ongeveer de helft. Claude Haiku 5.5 kost een fractie (ongeveer $0,45 per boek) en is minder nauwkeurig. Je betaalt Anthropic rechtstreeks, per gebruik.
- **Privacy**: in de Claude-modus gaat elke opname naar Anthropic. Je boeken, teksten en back-ups blijven op je computer.
- **Je sleutel** staat alleen in de browser op je computer. Hij staat niet op GitHub en zit niet in de back-up. Lekt hij toch uit, trek hem dan in de Console in en maak een nieuwe.
- Lukt het lezen met Claude even niet (geen internet, sleutel fout, tegoed op), dan leest de computer die opname zelf en zie je een melding.
- Kaders van beelden aanpassen kan ook in de Claude-modus. De tekst van Claude blijft dan staan.

## Exporteren en back-up

- **Exporteren** (bij Pagina's): de hele tekst of één hoofdstuk als Markdown-bestand (`.md`). Met **Downloaden (.md)** komt het bestand in Downloads op je computer. **Kopiëren** zet de tekst op het klembord.
- **Back-up** (de ••• rechtsboven op het beginscherm): sla af en toe een back-up op in iCloud Drive. Daarin staan alle teksten en de voortgang, zonder foto's. Met **Back-up terugzetten** haal je alles terug, ook op een andere computer.

## Publiceren op GitHub Pages

1. Maak op github.com een nieuwe, **openbare** repository aan, bijvoorbeeld `boekscanner`.
2. Zet de bestanden uit deze map erin (`git push`, of upload ze via de website).
3. Ga naar **Settings → Pages**. Kies bij *Source* **Deploy from a branch**, branch `main`, map `/ (root)`, en tik op **Save**.
4. Na een minuut staat de app op `https://<jouw-gebruikersnaam>.github.io/boekscanner/`.

## Techniek (voor wie wil aanpassen)

Gewone HTML, CSS en JavaScript, zonder build-stap.

| Bestand | Wat |
|---|---|
| `index.html` | De pagina |
| `app.js` | Opslag (IndexedDB), schermen, scannen, export |
| `scan.js` | Voorbewerking van de foto: pagina vinden, perspectief, scheefstand, kromme regels, kaderlijnen, grote beginletters |
| `ocr.js` | Tekstherkenning en het opbouwen van de Markdown (alinea's, koppen, citaten, opsommingen) |
| `ocr-worker.js`, `ocr-client.js` | Herkenning in een eigen worker met een wachtrij, zodat de app klikbaar blijft |
| `claude.js` | Claude-modus (optioneel): instellingen, pagina naar de Claude-API, Markdown en beelden terug |
| `koppel.js` | Koppeling iPhone ↔ computer (WebRTC via PeerJS) en opslag van opnames |
| `lamp.html`, `lamp.js` | De camera op de iPhone: live beeld, automatisch opnemen bij stilstand |
| `style.css` | Vormgeving (licht en donker) |
| `sw.js` | Offline werken |
| `vendor/anthropic/` | De officiële Anthropic-SDK (`@anthropic-ai/sdk` 1.14, Apache-2.0) als één bestand, alleen geladen in de Claude-modus |
| `vendor/` | Tesseract.js (tekstherkenning, Apache-2.0) met Nederlandse en Engelse taaldata |

Lokaal testen: `python3 -m http.server 8080` in deze map, en dan naar `http://localhost:8080` gaan.

Tekstherkenning testen: `node tests/run-ocr-tests.mjs` (Node en Playwright nodig). Dit herkent de testfoto's in `tests/fixtures` (scheef, opbollende pagina, omslag, studieboek met kader en opsommingen, en drie echte iPhone-foto's van een dik boek) en controleert de woorden en de opmaak. De uitvoer komt in `tests/out/`.

Nauwkeurigheid meten: `node tests/run-accuracy.mjs`. Dit vergelijkt de herkenning met handmatig nagekeken tekst van tien pagina's uit lampfoto's (`tests/fixtures/referentie/`) en geeft per pagina het percentage woorden dat precies goed is (hoofdletters tellen mee, leestekens niet). `MAXSIDE=2200` meet op iPhone-resolutie (standaard 4096, zoals op de computer), `SHOW=1` toont de fouten.

De hele flow op de computer testen (koppelen, opnemen, nakijken, exporteren) met een nagemaakte iPhone-camera: `npm i --no-save peer && node tests/run-flow-test.mjs` (ook ffmpeg nodig).

Claude-modus testen: `node tests/run-claude-test.mjs`. Dit gebruikt een nagemaakte Claude-API (geen sleutel nodig, er gaat niets naar Anthropic) en controleert de instellingen, het verzoek, de tekst met beelden en de terugval bij een foute sleutel.
