# Juschkin Labs – Neuaufbau (Vorschau)

Vorschau: https://kim-betcher.de/1293e128973/

Dieser Ordner enthält den Neuaufbau der Website von Juschkin Labs (juschkinlabs.de)
mit allen Assets. Er liegt vorerst als Vorschau auf kim-betcher.de, bis er fertig
ist. Die bisherige Startseite außerhalb dieses Ordners bleibt erhalten. Alle
Vorschauseiten enthalten `noindex, nofollow`; die Vorschau ist per Link öffentlich.
Besucher werden geduzt. Preise stehen nicht auf der Seite („auf Anfrage“).

## Bearbeiten

- `index.html`: Startseite mit Lab und Charakterauswahl (Kim und Maksim), Leistungen,
  Web-Apps, eigenen Projekten (iQuest mit Umschalter auf iQuest Classic, SmartADM,
  heimello., Roadlands), Einblick, Ablauf, Team und Kontakt.
- `datenintegration-automatisierung.html`: Unterseite Datenintegration &
  Automatisierung mit Aufgaben, Projektablauf, Arbeitsprobe und häufigen Fragen.
- `portfolio.css`: Gestaltung und responsive Ansichten.
- `portfolio.js`: Navigation, Charakterleiste, Bildergalerien, Projekt-Karussell,
  Versionsumschalter (`data-variants`), Kontaktadresse kopieren und YouTube-Player
  erst nach Klick laden (Video-ID steht in `data-video`).
- `character.js`: 3D-Spielfiguren, Lab und Stimmen (siehe unten).
- `impressum.html`, `datenschutz.html`: Rechtstexte von Juschkin Labs (beide
  Inhaber, Website juschkinlabs.de). Absätze mit `data-preview-only` gelten nur für
  die Vorschau und fallen beim Livegang weg.
- `assets/lab/`: Lab-Hintergrund (`labor-3840.webp`) und die
  Vordergrundmaske (`labor-vorne.webp`, Torbogen und vordere Säule) samt Lage im
  Gesamtbild (`labor-vorne.json`).
- `assets/figuren/`: `kim.glb` und `maksim.glb`.
- `assets/logos/`: Logos von iQuest, iQuest Classic, SmartADM und Roadlands. Auf der
  dunklen Seite stehen helle Fassungen ohne Hintergrundfläche (`…-hell.webp`,
  `iquest-classic-…webp`).
- `assets/heimello/`: Logo (dunkel und hell) und `app/` mit Bildschirmfotos der App.
- `assets/roadlands/`: Titelmotiv und Bilder aus dem Entwicklungsstand.
- `assets/leistungen/`, `assets/webapps/`, `assets/editor/`: Bilder, Icons und
  Texturen für Leistungen, Web-Apps und den Charakter-Editor.
- `assets/stimmen/`: Sprachaufnahmen, `kim_<zeile>.mp3` und `maksim_<zeile>.mp3`.
- `assets/fonts/`: Saira (variabel, Breite und Stärke), lokal geladen, mit OFL-Lizenz.
- `assets/juschkinlabs-logo.png`: Original-Logo (Open Graph); `assets/jl-logo.png`
  ist die verkleinerte Fassung für die Kopfzeile. `assets/jl-mark.svg` und
  `assets/jl-touch.png` sind die Seitensymbole.
- `vendor/three/`: three.js r169 (MIT-Lizenz), lokal ausgeliefert.
- `ressources/coding/`: Projektansichten (iQuest, SmartADM). Kein Porträtfoto auf dieser Seite.

Alle Pfade sind relativ. Der Ordner funktioniert deshalb unter
`kim-betcher.de/1293e128973/` genauso wie später direkt unter `juschkinlabs.de`.

## Lab

- Das Lab ist ein gerendertes Bild aus Blender (`JuschkinLabs_Assets.blend`,
  Szene `start-hintergrund`, 3840 × 1600). `character.js` baut die Blender-Kamera in
  three.js nach (Position, Neigung, Brennweite 29 mm, Sensor 36 mm), deshalb steht
  die Figur passgenau auf dem Podest. Der Bildausschnitt wird über
  `setViewOffset` und eine CSS-Transformation des Hintergrunds gemeinsam bewegt.
- Die Figuren sind im Lab um `LAB.scale` (1,75) vergrößert, also rund 3,2 m groß.
  Der goldene Rahmen im Tor liegt bei 4,0 bis 4,7 m; größer sollte die Figur nicht
  werden. Im Begleiter unten links bleibt sie in Originalgröße.
- Ausschnitte (`FOCUS_WIDE`, `FOCUS_NARROW`): `k` ist die Figurhöhe im Verhältnis
  zur Lab-Höhe. Das Bild füllt immer die ganze Breite, auf breiten Bildschirmen wird
  die Figur dadurch größer.
- Nach „Fertig“ blenden Profil und Fähigkeiten aus. Die Figur läuft vom Podest in
  die Gasse zwischen den Lichtleisten und mittig durchs Tor (`LAB.exit`, Blender-
  Koordinaten umgerechnet auf Y nach oben). Die Vordergrundmaske verdeckt sie hinter
  Säule und Bogen. Danach scrollt die Seite zu den Leistungen und die Figur kommt
  unten links als Begleiter hereingelaufen.
- Ohne WebGL zeigt das Lab nur das Bild, die Bühne das Monogramm (KB bzw. MJ).

## 3D-Spielfiguren

- Quelle sind die Blender-Dateien `Kim_Kleidung_v1.blend` und
  `Maksim_Kleidung_v1.blend` (Desktop, Ordner Fahrlehrer). Beide nutzen dasselbe
  24-Knochen-Rig. Walk, Run, Wave, Talk und Jump wurden pro Bild im Weltraum
  übertragen, hängende Arme dabei näher an den Körper geholt. Die Ruhepose (Idle)
  ist selbst gebaut: aufrecht, Arme locker, Füße hüftbreit, 5 Sekunden Atmen.
- Export als glTF, danach mit gltf-transform: dedup, Texturen auf 2048 px,
  WebP (Qualität 86), meshopt. Vor dem Export wird die Hauttextur gesäubert:
  Bartkanten laufen weich aus, und Alpha ist nie ganz 0, weil WebP sonst die
  Farben unter transparenten Pixeln verwirft (das machte den Bart fleckig).
  Nach einem neuen Export `FIGURE_VERSION` in `character.js` hochzählen. Clipnamen beginnen mit `Kim_` bzw. `Maksim_`,
  Frisuren heißen `Frisur_<Name>_<Frisur>`.
- Färbbare Materialien (`Haut`, `Oberteil`, `Hose`, `Schuhe`) tragen im
  Alphakanal der Textur eine Maske; die Seite multipliziert dort die gewählte
  Farbe. Das Haar nutzt die Vertex-Farbe `Grau`. Bei der Originalfrisur ist die
  Haarfarbe gesperrt.
- Editor: Reiter für Frisur, Haare, Haut, Oberteil, Hose und Schuhe; die Kamera
  zoomt im Lab auf den Körperteil. Die Frisur-Karten werden im Browser live aus
  der Figur gerendert (mit aktueller Haar- und Hautfarbe). „Zufall“ würfelt ein
  Aussehen. Die Auswahl liegt nur im Browser (`localStorage`, Schlüssel
  `jl-figuren-v1`).

## Stimmen

Aufnahmen aus ElevenLabs in `assets/stimmen/`. Der Ton ist standardmäßig aus; der
Schalter „Ton an“ in der Kopfzeile merkt sich die Wahl (`localStorage`, Schlüssel
`jl-ton`). Beim Wechsel der Figur grüßt sie (`hallo`), im Editor sagt Kim `editor`
bzw. `gesperrt`, als Begleiter spricht die Figur je Abschnitt einmal ihre Zeile
(Zuordnung in `LINES` in `character.js`) und nach 40 Sekunden Ruhe `warten`. Ohne
Aufnahme winkt sie stattdessen.

## Livegang auf juschkinlabs.de

`python3 tools/juschkinlabs_release.py` (im Repository) baut
`dist/JuschkinLabs_live.zip`: Kopie dieses Ordners ohne alles, was mit
`data-preview-only` markiert ist (z. B. `noindex`, Vorschau-Hinweise), dazu
`robots.txt`, `sitemap.xml` und `.htaccess` (Dateitypen, Weiterleitung der alten
`fakten.html`). Den Inhalt der ZIP ins Hauptverzeichnis von juschkinlabs.de laden.
Der Testbericht `datenimport-arbeitsbeleg.5d3c9ccf91b5.pdf`, der auf dem Server von
juschkinlabs.de liegt, muss dort bleiben; die Unterseite verlinkt ihn.
`dist/` wird nicht eingecheckt.

## Lokal ansehen und prüfen

Im Repository: `python3 -m http.server 8765`, dann
http://localhost:8765/1293e128973/ öffnen.

Syntax: `node --check 1293e128973/portfolio.js 1293e128973/character.js`

Browserprüfung: `python tests/portfolio-browser.py` mit installiertem Playwright
und Chromium. Der Test prüft unter anderem relative Pfade, Charakterauswahl, Lab und
3D-Editor (falls WebGL verfügbar), die Galerien von heimello. und Roadlands, den
Umschalter auf iQuest Classic, Unterseite mit FAQ, Kontaktadressen und dass vor dem
Klick kein YouTube-Player geladen wird. Der externe Player wird dabei simuliert.

Die Vorschau wird über den GitHub-Pages-Zweig `KimBetcher` veröffentlicht. Für die
Vorschau gibt es keinen Build-Schritt und keine Produktionsabhängigkeiten.
