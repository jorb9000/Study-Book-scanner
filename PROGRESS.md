# Voortgang

## Klaar
- PWA-basis: manifest, iconen, service worker (offline, OCR-bestanden gecachet na eerste gebruik)
- Boeken: aanmaken/bewerken/verwijderen, paginabereik, taal (nld / eng / beide)
- Scanflow: camera → concept (blijft bewaard bij sluiten) → tekst controleren → opslaan / opslaan & volgende
- Voortgang: aantal/totaal, ontbrekende pagina's (klikbaar), volgende pagina instelbaar, slim doorspringen naar de eerstvolgende ongescande pagina
- Hoofdstukken als startpagina-markeringen; export per hoofdstuk of heel boek (Markdown, deelmenu/download, kopiëren)
- OCR: belichting gelijkmatig maken vóór herkenning, regels opbouwen met zekerheid per woord, randruis en paginanummers/koppen weglaten, alinea's en afgebroken woorden herstellen, gedraaide foto's automatisch herkennen
- Back-up/terugzetten (JSON, zonder foto's), persistente opslag aangevraagd
- iOS: camera altijd direct vanuit een tik geopend; knoppenbalk verborgen tijdens typen

## Getest (Chromium, iPhone 13-formaat)
- Volledige flow, herladen tijdens beoordelen, opslaan & volgende, gaten en terugspringen, overschrijven, opnieuw scannen
- Offline herladen en offline herkenning
- Back-up maken en terugzetten in een schone omgeving
- Testfoto (scheef, schaduw, ruis): 94% zekerheid, tekst vrijwel foutloos

## Nog niet gedaan
- Publicatie op GitHub Pages (wacht op een repository)
- Test op een echte iPhone
