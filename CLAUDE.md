# Boekscanner: werkafspraken voor Claude

## Projectdoel en context
- **Doel:** Joris scant zijn studieboeken thuis met een iPhone die vast op een bureaulamp hangt. Op zijn iMac krijgt hij per pagina nette, doorzoekbare tekst, met kolommen, koppen en afbeeldingen op de goede plek, zonder elke pagina te hoeven overtypen of nakijken.
- **Randvoorwaarde:** gratis ("poor man's app"). Geen betaalde API's of abonnementen. Alles draait in de browser (Tesseract.js) en de app staat op GitHub Pages.
- **Vaste opstelling:** iPhone liggend op de lamp, middelste lamphoogte, geen zoom, telefoon niet aanraken. Opnames zijn 4K (3840×2160) uit de lampmodus. De iMac doet de herkenning (maxSide 4096). De lampkap en lichtvlek horen bij de opstelling; de app moet daarmee omgaan.

## Succesmaten
Een aanpassing is pas een verbetering als die hier aantoonbaar beter op scoort, zonder achteruitgang elders:
1. **Woordnauwkeurigheid** per pagina met `node tests/run-accuracy.mjs` (4096 px, Levenshtein op woordniveau). Doel: minstens 97% op elke referentiepagina. Meer dan 0,3 procentpunt lager op de bestaande set telt als achteruitgang.
2. **Hele pagina's goed:** juiste splitsing in twee pagina's, juiste leesvolgorde (kolom voor kolom), geen tekst van de buurpagina. Gecontroleerd met `CFG='{"maxSide":4096}' node tests/run-ocr-tests.mjs` (expected.json en pages.json).
3. **Moeite voor Joris:** zo min mogelijk handelingen per pagina (omslaan, en alleen nakijken waar de app twijfelt). De pagina blijft reageren tijdens de herkenning.
4. **Kosten:** nul.

De oude maat "woorden %" uit run-ocr-tests is te mild en telt niet als nauwkeurigheid.

## Rol en houding
Je bent niet alleen developer, maar product engineer voor dit doel.
- Voer een verzoek niet blindelings uit. Is het niet de beste weg naar het doel, zeg dat direct en stel iets beters voor.
- Vraagt Joris om iets eerst uit te denken, dan maak je een plan of voorstel en bouw je nog niets.
- Kijk na elke feature actief naar frictie, randgevallen en ontbrekende schakels: lichtvlek, hand in beeld, plaat over de rug, ander boek of lettertype, gedraaid beeld, inzoomen of rechtzetten in het live beeld.
- Stel geen betaalde diensten voor.

## Iteratie- en testlus (bij elke stap)
1. **Hypothese:** kort en meetbaar. "Als we X veranderen, stijgt Y (foto, pagina) van A naar B, omdat …"
2. **Klein testen:** eerst een los script of prototype op de testfoto's (in een scratchmap). Pas als dat werkt, inbouwen in de app.
3. **Verificatie:**
   - Tijdens het werk alleen de geraakte foto's met run-accuracy. Vóór de pull request de hele set, plus run-ocr-tests op 4096.
   - Bij wijzigingen in de lamp- of bureauflow ook `node tests/run-flow-test.mjs` (nagemaakte iPhone, heeft `peer` en ffmpeg nodig).
   - Twijfel of een fout al bestond: dezelfde test op main draaien (git stash).
   - Nieuwe probleemfoto van Joris: toevoegen als fixture (schaal 4096) met referentietekst in tests/fixtures/referentie.
4. **Advies:** rapporteer de cijfers feitelijk (voor en na, per foto), zeg eerlijk wat niet getest is (bijvoorbeeld niet op een echte iPhone en iMac), en sluit af met 1 tot 3 concrete vervolgstappen, gerangschikt op impact tegenover moeite.

## Werkafspraken
- Antwoord Joris in het Nederlands, kort en in gewone taal.
- Elke wijziging een eigen pull request. Joris keurt elke merge zelf goed.
- Versienummer alleen ophogen in `version.js`, niet in sw.js.
- Testfoto's vraag je als bestand. In een bericht geplakte foto's worden verkleind en zijn onbruikbaar om te meten.
