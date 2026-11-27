# Boekscanner

Een eenvoudige web-app om studieboeken in delen te scannen. Je bedient alles op je computer; de iPhone ligt op een bureaulamp boven het boek en is alleen de camera. De app houdt per boek bij welke pagina's klaar zijn, welke ontbreken en waar je verder moet. De tekst exporteer je als Markdown.

- Werkt zonder account. Boeken en teksten blijven op je computer.
- Tekstherkenning gebeurt op de computer zelf (Nederlands en/of Engels), ook offline.
- Geen installatie nodig: open de link in Safari of Chrome.

## Opstelling

Zet de iPhone via MagSafe op een bureaulamp, **liggend**, met de lens vrij over de rand en recht boven het boek. Zet op de iPhone **Automatisch slot** op **Nooit** (Instellingen › Scherm en helderheid).

## Een boek scannen

1. Open de Boekscanner op je computer en klik op **Nieuw boek**. Vul de titel in, de eerste pagina en eventueel de laatste pagina, en kies de taal.
2. Klik op **Scannen met de lamp**. Er verschijnt een QR-code.
3. Richt de **Camera-app** van je iPhone op de QR-code en tik op de link. Tik daarna één keer op het scherm van de iPhone en leg hem op de lamp. Een volgende keer kun je de pagina gewoon weer openen: hij onthoudt de koppeling.
4. Op de computer zie je het live beeld. Blader om en houd stil: de iPhone neemt vanzelf op. Of druk op de **spatiebalk**. Met **A** zet je automatisch opnemen aan of uit.
5. Elke opname komt direct op de computer binnen en wordt op de achtergrond herkend. Met **Nakijken en opslaan** loop je ze één voor één door. Een opname van een open boek wordt twee pagina's.
6. Stoppen mag op elk moment. De volgende keer staat het boek al op de juiste pagina.

De iPhone laat alleen het camerabeeld en een statuslampje zien (groen: klaar, oranje: zoekt computer of beweging). Na een paar seconden wordt het scherm donker; tik erop om het weer te zien.

iPhone en computer moeten op hetzelfde wifi-netwerk zitten. Alleen de kennismaking loopt via de gratis openbare PeerJS-server; de foto's gaan rechtstreeks van telefoon naar computer. Op een netwerk dat apparaten van elkaar afschermt (zoals eduroam) lukt dat niet: zet dan de hotspot van je iPhone aan en verbind de computer daarmee. Valt de verbinding weg, dan blijven opnames op de telefoon bewaard en worden ze verstuurd zodra de verbinding terug is.

Handig om te weten:
- **Volgende pagina** (− / +) zet je op een ander paginanummer, bijvoorbeeld als je pagina's met alleen plaatjes overslaat.
- Bij **Nog niet gescand** zie je welke pagina's ontbreken. Klik erop om daar verder te gaan.
- **Hoofdstukken** zijn optioneel: geef aan op welke pagina een hoofdstuk begint, dan kun je per hoofdstuk exporteren.
- Ligt de foto gedraaid, dan probeert de app zelf de juiste richting. Lukt dat niet, gebruik dan **Draaien**.
- Koppen, citaten en opsommingen worden herkend en als Markdown opgeslagen (`##`, `>`, `-`).

### Boeken die nog op de iPhone staan

Heb je eerder op de iPhone zelf gescand? Open de app op de iPhone, tik op **Back-up maken** en zet die back-up op de computer terug met **Back-up terugzetten** (de ••• rechtsboven op het beginscherm).

## Exporteren en back-up

- **Exporteren** (bij Pagina's): de hele tekst of één hoofdstuk als Markdown-bestand (`.md`). Het bestand komt in Downloads op je computer. **Kopiëren** zet de tekst op het klembord.
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
| `koppel.js` | Koppeling iPhone ↔ computer (WebRTC via PeerJS) en opslag van opnames |
| `lamp.html`, `lamp.js` | De camera op de iPhone: live beeld, automatisch opnemen bij stilstand |
| `style.css` | Vormgeving (licht en donker) |
| `sw.js` | Offline werken |
| `vendor/` | Tesseract.js (tekstherkenning, Apache-2.0) met Nederlandse en Engelse taaldata |

Lokaal testen: `python3 -m http.server 8080` in deze map, en dan naar `http://localhost:8080` gaan.

Tekstherkenning testen: `node tests/run-ocr-tests.mjs` (Node en Playwright nodig). Dit herkent de testfoto's in `tests/fixtures` (scheef, opbollende pagina, omslag, studieboek met kader en opsommingen, en drie echte iPhone-foto's van een dik boek) en controleert de woorden en de opmaak. De uitvoer komt in `tests/out/`.
