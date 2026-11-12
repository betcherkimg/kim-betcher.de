# Juschkin Labs – Neuaufbau (Vorschau)

Vorschau: https://kim-betcher.de/1293e128973/

Dieser Ordner enthält den Neuaufbau der Website von Juschkin Labs (juschkinlabs.de)
mit allen Assets. Er liegt vorerst als Vorschau auf kim-betcher.de, bis er fertig
ist. Die bisherige Startseite außerhalb dieses Ordners bleibt erhalten. Alle
Vorschauseiten enthalten `noindex, nofollow`; die Vorschau ist per Link öffentlich.
Besucher werden geduzt. Preise stehen nicht auf der Seite („auf Anfrage“).

## Bearbeiten

- `index.html`: Startseite mit Charakterauswahl (Kim und Maksim), Leistungen,
  Web-Apps, eigenen Projekten (iQuest, SmartADM, heimello., Roadlands), Einblick,
  Ablauf, Team und Kontakt.
- `datenintegration.html`: Unterseite Datenintegration & Automatisierung mit
  Aufgaben, Projektablauf, Arbeitsprobe und häufigen Fragen.
- `portfolio.css`: Gestaltung und responsive Ansichten.
- `portfolio.js`: Navigation, Charakterleiste, Projektgalerie, Level-Karussell,
  Kontaktadresse kopieren und YouTube-Player nach Klick laden.
- `character.js`: 3D-Spielfiguren (siehe unten).
- `impressum.html`, `datenschutz.html`: Rechtstexte der Vorschau (Betreiber der
  Vorschau ist Kim Betcher).
- `assets/figuren/`: `kim.glb` und `maksim.glb`.
- `assets/heimello/`: aktuelle Originalgrafiken und Logo.
- `assets/fonts/`: Saira (variabel, Breite und Stärke), lokal geladen, mit OFL-Lizenz.
- `assets/juschkinlabs-logo.png`: bereitgestelltes Original-Logo (Open Graph);
  `assets/jl-logo.png` ist die verkleinerte Fassung für die Kopfzeile.
  `assets/jl-mark.svg` und `assets/jl-touch.png` sind die Seitensymbole.
- `vendor/three/`: three.js r169 (MIT-Lizenz), lokal ausgeliefert.
- `ressources/`: Porträt und Projektansichten aus der bestehenden Website.

## 3D-Spielfiguren

- Quelle sind die Blender-Dateien `Kim_Kleidung_v1.blend` und
  `Maksim_Kleidung_v1.blend` (Desktop, Ordner Fahrlehrer). Beide nutzen dasselbe
  24-Knochen-Rig. Walk, Run, Wave, Talk und Jump wurden pro Bild im Weltraum
  übertragen, hängende Arme dabei näher an den Körper geholt. Die Ruhepose (Idle)
  ist selbst gebaut: aufrecht, Arme locker, Füße hüftbreit, 5 Sekunden Atmen.
- Export als glTF, danach mit gltf-transform: dedup, Texturen auf 2048 px,
  WebP (Qualität 86), meshopt. Clipnamen beginnen mit `Kim_` bzw. `Maksim_`,
  Frisuren heißen `Frisur_<Name>_<Frisur>`.
- Färbbare Materialien (`Haut`, `Oberteil`, `Hose`, `Schuhe`) tragen im
  Alphakanal der Textur eine Maske; die Seite multipliziert dort die gewählte
  Farbe. Das Haar nutzt die Vertex-Farbe `Grau`. Bei der Originalfrisur ist die
  Haarfarbe gesperrt.
- Editor: Reiter für Frisur, Haare, Haut, Oberteil, Hose und Schuhe; die Kamera
  zoomt jeweils auf den Körperteil. Die Frisur-Karten werden im Browser live aus
  der Figur gerendert (mit aktueller Haar- und Hautfarbe). „Zufall“ würfelt ein
  Aussehen. Die Codex-Icons und -Texturen aus der Asset-Liste ersetzen später
  die gezeichneten Icons und flachen Farbkugeln.
- Nach „Charakter erstellen“ → „Fertig“ läuft die Figur vom Podest und begleitet
  unten links beim Scrollen (Gehen oder Laufen je nach Tempo, Winken pro
  Abschnitt, Klick für Gesten). Die Auswahl liegt nur im Browser
  (`localStorage`, Schlüssel `jl-figuren-v1`).
- Ohne WebGL bleibt das Porträt bzw. das Monogramm sichtbar.

## Sprachausgabe (geplant)

Für Kim und Maksim gibt es Stimmen aus ElevenLabs. Sobald die Dateien vorliegen,
kommen sie nach `assets/stimmen/` und werden standardmäßig stumm, erst nach
„Ton an“ abgespielt.

## Vor dem Umzug auf juschkinlabs.de

- Präfixe `/1293e128973/` in allen Pfaden, Canonical- und Open-Graph-URLs sowie
  `ROOT` in `character.js` und die Importmap anpassen.
- Impressum und Datenschutz durch die Fassungen von Juschkin Labs ersetzen
  (Anbieter Maksim Juschkin) und den Abschnitt zu den 3D-Spielfiguren übernehmen.
- `noindex` entfernen.
- Den Testbericht (`datenimport-arbeitsbeleg…pdf`) mit umziehen; er ist derzeit
  von der Live-Seite verlinkt.

Roadlands zeigt vorerst eine als Illustration gekennzeichnete SVG-Konzeptkarte.
Entwicklungsprojekt, noch nicht spielbar.

## Lokal ansehen und prüfen

Im Repository: `python3 -m http.server 8765`, dann
http://localhost:8765/1293e128973/ öffnen.

Syntax: `node --check 1293e128973/portfolio.js 1293e128973/character.js`

Browserprüfung: `python tests/portfolio-browser.py` mit installiertem Playwright
und Chromium. Der Test prüft unter anderem Charakterauswahl, 3D-Editor (falls
WebGL verfügbar), Unterseite mit FAQ, Kontaktadressen und dass vor dem Klick kein
YouTube-Player geladen wird. Der externe Player wird dabei simuliert.

Veröffentlichung erfolgt über den bestehenden GitHub-Pages-Zweig `KimBetcher`.
Es gibt keinen Build-Schritt und keine neuen Produktionsabhängigkeiten.
