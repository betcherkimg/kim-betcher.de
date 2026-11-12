# Persönliche Website – Vorschau

Vorschau: https://kim-betcher.de/1293e128973/

Dieser Ordner enthält die vollständige neue Website einschließlich ihrer Assets.
Die bisherige Startseite außerhalb dieses Ordners bleibt erhalten. Alle drei
Vorschauseiten enthalten `noindex, nofollow`; die Vorschau ist per Link öffentlich.

## Bearbeiten

- `index.html`: persönliche Startseite, Projekte, Juschkin Labs und Kontakt.
- `portfolio.css`: Gestaltung und responsive Ansichten.
- `portfolio.js`: Navigation, Projektgalerie, Kontaktadresse kopieren und
  YouTube-Player nach Klick laden.
- `impressum.html`, `datenschutz.html`: Rechtstexte der persönlichen Vorschau.
- `assets/heimello/`: aktuelle Originalgrafiken und Logo; keine älteren
  App-Screenshots aus dem ersten heimello.-Paket.
- `assets/fonts/`: Bricolage Grotesque (variabel, wie bei Juschkin Labs) und Jersey 10 für Spiel-Beschriftungen, lokal geladen, mit OFL-Lizenzen.
- `assets/topo.svg`: Höhenlinien-Hintergrund (Weltkarten-Anmutung) für Einstieg und Kontakt.
- `assets/juschkinlabs-logo.png`: bereitgestelltes Original-Logo.
- `ressources/`: unverändertes Porträt und Projektansichten aus der bestehenden Website.

Interne URLs und Schriftpfade enthalten ausdrücklich `/1293e128973/`.
Beim späteren Wechsel an die Domainwurzel müssen diese Präfixe sowie Canonical-
und Open-Graph-URLs angepasst und `noindex` für die finale Startseite entfernt
werden. Die alte Beratung soll erst bei diesem Wechsel nach `/beratung/` ziehen.

Roadlands zeigt vorerst eine als Illustration gekennzeichnete SVG-Konzeptkarte.
Die im Chat gezeigten Roadlands-Originalbilder waren nicht als Dateien im
Arbeitsordner verfügbar; sie wurden nicht nachgeneriert. Vorgesehener Titel:
`Roadlands – The Last Exam`. Entwicklungsprojekt, noch nicht spielbar.

## Lokal ansehen und prüfen

Im Repository: `python3 -m http.server 8765`, dann
http://localhost:8765/1293e128973/ öffnen.

Syntax: `node --check 1293e128973/portfolio.js`

Browserprüfung: `python tests/portfolio-browser.py` mit installiertem Playwright
und Chromium. Der Test prüft unter anderem, dass vor dem Klick kein YouTube-
Player geladen wird. Der externe Player wird für diesen Funktionstest simuliert;
die tatsächliche Videowiedergabe muss zusätzlich im normalen Browser geprüft werden.

Veröffentlichung erfolgt über den bestehenden GitHub-Pages-Zweig `KimBetcher`.
Es gibt keinen Build-Schritt und keine neuen Produktionsabhängigkeiten.
