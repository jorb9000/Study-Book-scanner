/* Versie van de app: bij elke wijziging die live gaat hier ophogen (en alleen hier).
   De service worker gebruikt hem voor zijn cache; de app en de lamppagina tonen hem klein
   rechtsonder, zodat je kunt zien of je de nieuwste versie hebt. */
self.APP_VERSION = 'v21';
if (typeof document !== 'undefined') {
  const el = document.getElementById('app-version');
  if (el) el.textContent = self.APP_VERSION;
}
