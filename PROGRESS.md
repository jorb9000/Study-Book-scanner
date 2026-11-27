# Voortgang

## Klaar
- PWA-basis: manifest, iconen, service worker (offline, OCR-bestanden gecachet na eerste gebruik)
- Boeken: aanmaken/bewerken/verwijderen, paginabereik, taal (nld / eng / beide)
- Scanflow: camera → concept (blijft bewaard bij sluiten) → tekst controleren → opslaan / opslaan & volgende
- Voortgang: aantal/totaal, ontbrekende pagina's (klikbaar), volgende pagina instelbaar, slim doorspringen naar de eerstvolgende ongescande pagina
- Hoofdstukken als startpagina-markeringen; export per hoofdstuk of heel boek (Markdown, deelmenu/download, kopiëren)
- OCR: belichting gelijkmatig maken vóór herkenning, regels opbouwen met zekerheid per woord, randruis en paginanummers/koppen weglaten, alinea's en afgebroken woorden herstellen, gedraaide foto's automatisch herkennen
- Voorbewerking (scan.js): pagina vinden en perspectief rechtzetten, scheefstand, kromme regels rechttrekken (opbollende pagina), donkere randen en kaderlijnen weg, lichte tekst op donker (omslag) via omgekeerde poging
- Richting van de foto automatisch: een stuk uit het midden wordt in vier richtingen gelezen, de leesbaarste wint (liggende foto's uit lampmodus, omslag op z'n kop)
- Open boek op de foto (twee pagina's): geheel rechtzetten, rug zoeken, beide helften apart herkennen; in de app twee tekstvakken en opslaan als pagina n en n+1 (met knop "Toch één pagina")
- Grote beginletters (initialen) apart herkend en voor het eerste woord gezet
- Opmaak naar Markdown: koppen (## / ###, ook over twee regels), ondertitel cursief, citaten (>), opsommingen (- en 1.); hoofdstuktitel niet dubbel in de export
- Testfoto's + testscript: `node tests/run-ocr-tests.mjs`
- Back-up/terugzetten (JSON, zonder foto's), persistente opslag aangevraagd
- iOS: camera altijd direct vanuit een tik geopend; knoppenbalk verborgen tijdens typen

## Getest (Chromium, iPhone 13-formaat)
- Volledige flow, herladen tijdens beoordelen, opslaan & volgende, gaten en terugspringen, overschrijven, opnieuw scannen
- Offline herladen en offline herkenning
- Back-up maken en terugzetten in een schone omgeving
- Testfoto (scheef, schaduw, ruis): 94% zekerheid, tekst vrijwel foutloos

## Nog niet gedaan
- Publicatie op GitHub Pages (wacht op een repository)
- Test op een echte iPhone (eerste test gedaan; nu opnieuw testen met de verbeterde herkenning)
- Open boek: linkerpagina's van de lampmodus-foto's (j2–j5) zijn nog matig (onscherp en krom bij de rug, schaduw van de lamp); rechterpagina's goed
