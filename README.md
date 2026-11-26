# Boekscanner

Een eenvoudige iPhone-app (web-app) om studieboeken in delen te scannen. De app houdt per boek bij welke pagina's klaar zijn, welke ontbreken en waar je verder moet. De tekst exporteer je als Markdown.

- Werkt zonder account en zonder server. Alles blijft op je telefoon.
- Tekstherkenning gebeurt op de telefoon zelf (Nederlands en/of Engels), ook offline.
- Geen installatie via de App Store nodig.

## Op je iPhone zetten

1. Open de link van de app in **Safari** (niet in Chrome).
2. Tik op het **deelknopje** (vierkant met pijl omhoog).
3. Kies **Zet op beginscherm** en tik op **Voeg toe**.
4. Open Boekscanner voortaan via het icoon. De eerste keer vraagt iOS of de app de camera mag gebruiken.

> Let op: de app op je beginscherm heeft zijn eigen opslag, los van Safari. Gebruik dus steeds het icoon.

## Een boek scannen

1. Tik op **Nieuw boek**. Vul de titel in, de eerste pagina en eventueel de laatste pagina, en kies de taal.
2. Tik op **Scan pagina …**. Leg het boek plat, zorg voor goed licht en fotografeer **één pagina recht van boven**.
3. De tekst wordt herkend. Controleer hem en verbeter waar nodig.
4. Tik op **Opslaan & volgende**. De camera gaat meteen open voor de volgende pagina.
5. Stoppen mag op elk moment. De volgende keer staat de knop al op de juiste pagina.

Handig om te weten:
- **Volgende pagina** (− / +) zet je op een ander paginanummer, bijvoorbeeld als je pagina's met alleen plaatjes overslaat.
- Bij **Nog niet gescand** zie je welke pagina's ontbreken. Tik erop om daar verder te gaan.
- **Hoofdstukken** zijn optioneel: geef aan op welke pagina een hoofdstuk begint, dan kun je per hoofdstuk exporteren.
- Ligt de foto gedraaid, dan probeert de app zelf de juiste richting. Lukt dat niet, gebruik dan **Draaien**.
- Een iets schuine foto of een pagina die bij de rug opbolt is geen probleem: de app zoekt de pagina, zet hem recht en trekt kromme regels recht. Zorg wel dat de hele pagina in beeld is, met wat tafel eromheen.
- Koppen, citaten en opsommingen worden herkend en als Markdown opgeslagen (`##`, `>`, `-`). Een grote beginletter (initiaal) wordt apart herkend en weer voor het woord gezet.
- Een niet-opgeslagen scan blijft bewaard, ook als je de app sluit.

## Lampmodus (telefoon boven het boek)

Voor een vaste opstelling, bijvoorbeeld met de telefoon via MagSafe op een bureaulamp boven het boek. Open **Lampmodus** onderaan het beginscherm (of `lamp.html`).

1. Leg de telefoon **liggend** op de lamp, met de lens vrij over de rand. De dubbele pagina moet bijna de hele breedte van het beeld vullen.
2. Zet **Automatisch slot** op **Nooit** (Instellingen › Scherm en helderheid). De app vraagt zelf ook om het scherm aan te houden.
3. Tik op **Camera starten**. Linksboven staat de resolutie; groen betekent 4K.
4. Blader om en houd stil. Na ongeveer een seconde stilstand volgt een piep en een flits: de opname is gemaakt. Een hand die stil op de rand ligt is geen probleem. Stilhouden zonder om te slaan geeft geen dubbele opname.
5. Bij **Opnames** zie je alles terug. **Alles delen** stuurt de foto's via AirDrop naar je computer.

Dit is fase 1 van de opstelling met bediening vanaf de computer. In een volgende stap komen de opnames rechtstreeks op de computer binnen.

## Exporteren en back-up

- **Exporteren** (bij Pagina's): de hele tekst of één hoofdstuk als Markdown-bestand (`.md`). Via het deelmenu kun je het bewaren in Bestanden/iCloud Drive of openen in een notitie-app. **Kopiëren** zet de tekst op het klembord.
- **Back-up** (de ••• rechtsboven op het beginscherm): sla af en toe een back-up op in iCloud Drive. Daarin staan alle teksten en de voortgang, zonder foto's. Met **Back-up terugzetten** haal je alles terug, ook op een nieuwe telefoon.

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
| `style.css` | Vormgeving (licht en donker) |
| `sw.js` | Offline werken |
| `vendor/` | Tesseract.js (tekstherkenning, Apache-2.0) met Nederlandse en Engelse taaldata |

Lokaal testen: `python3 -m http.server 8080` in deze map, en dan naar `http://localhost:8080` gaan.

Tekstherkenning testen: `node tests/run-ocr-tests.mjs` (Node en Playwright nodig). Dit herkent de testfoto's in `tests/fixtures` (scheef, opbollende pagina, omslag, studieboek met kader en opsommingen, en drie echte iPhone-foto's van een dik boek) en controleert de woorden en de opmaak. De uitvoer komt in `tests/out/`.
