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
- Woordcontrole (Nederlands): t/r- en e/c-verwarring ("her"→"het", "cen"→"een") terugzetten met een frequentielijst (vendor/lang/nl-woorden.txt, OpenSubtitles via hermitdave/FrequencyWords, CC-BY-SA 4.0)
- Regels die Tesseract in stukken knipt (kromme/onscherpe pagina) weer samenvoegen en bij één kolom van boven naar beneden zetten
- Lampmodus: omslaan (veel beweging) telt altijd als nieuwe pagina, ook als de pagina sterk op de vorige lijkt; status 'stil · zelfde pagina' als hij bewust niet opneemt
- Grote beginletters (initialen) apart herkend en voor het eerste woord gezet
- Opmaak naar Markdown: koppen (## / ###, ook over twee regels), ondertitel cursief, citaten (>), opsommingen (- en 1.); hoofdstuktitel niet dubbel in de export
- Cursief en vet uit de foto gemeten (schuinte en lijndikte per woord, vet vergeleken met de buurwoorden); lopende paginakop weg; hoofdstuknummer + titel als één kop
- Testfoto's + testscript: `node tests/run-ocr-tests.mjs`
- Back-up/terugzetten (JSON, zonder foto's), persistente opslag aangevraagd
- iOS: camera altijd direct vanuit een tik geopend; knoppenbalk verborgen tijdens typen

- Nauwkeuriger herkenning, gemeten met `tests/run-accuracy.mjs` (10 nagekeken pagina's): ontkromming werkt nu ook op 4K-foto's en naast de lampkap, letters vergroot tot een vaste regelhoogte, zwart-wit per buurt (Sauvola) zodat tekst bij de rug heel blijft, rug bij een inhoudsopgave goed gevonden, vlekjes in de marge weg, ontbrekende afbreekstreepjes en aan elkaar geplakte woorden hersteld
- Computer: herkenning in een eigen worker (pagina blijft klikbaar), wachtrij op de achtergrond voor alle opnames, opnames los aanklikbaar met verwachte paginanummers; flowtest met nepcamera (`tests/run-flow-test.mjs`)
- Beelden: foto's, grafieken en schema's worden op de pagina gevonden, in kleur uitgeknipt en als `![bijschrift](#beeld-n)` op hun plek in de tekst gezet, met het bijschrift ("Figuur 3.2 …") eronder; aslabels en legenda verdwijnen uit de lopende tekst (figures.js). In de app: miniaturen onder de tekst, weghalen, kaders aanpassen/toevoegen op de rechtgezette pagina (figure-ui.js). Testfoto's: `node tests/make-figure-fixtures.mjs` (fig-1, fig-2), app-test: `node tests/run-figure-app-test.mjs`
- Export met beelden: zip met .md en map beelden/, en PDF via het afdrukmenu (Bewaar als PDF) met de beelden en bijschriften op hun plek (export.js)
- Claude-modus (optioneel, claude.js): eigen API-sleutel alleen in de browser, per rechtgezette pagina een verzoek aan Claude (standaard Opus 5.5, keuze Sonnet/Haiku), Markdown in leesvolgorde met beelden en bijschriften; beelden worden uitgeknipt uit de rechtgezette pagina; terugval op Tesseract met melding. Test met nep-API: `node tests/run-claude-test.mjs`. Nog niet getest met een echte sleutel.

## Getest (Chromium, iPhone 13-formaat)
- Volledige flow, herladen tijdens beoordelen, opslaan & volgende, gaten en terugspringen, overschrijven, opnieuw scannen
- Offline herladen en offline herkenning
- Back-up maken en terugzetten in een schone omgeving
- Testfoto (scheef, schaduw, ruis): 94% zekerheid, tekst vrijwel foutloos

## Nog niet gedaan
- Publicatie op GitHub Pages (wacht op een repository)
- Test op een echte iPhone (eerste test gedaan; nu opnieuw testen met de verbeterde herkenning)
- Open boek: linkerpagina's van j2–j5 (onscherp, lampschaduw) matig. Lampfoto's k1–m013: gemiddeld ruim 97% woorden goed op de computer (was 91,5%)
