# Spielwiese: Arbeitsplan

Stand: 12.11.2026. Diese Liste wird Schritt für Schritt abgearbeitet. Erledigtes wird abgehakt,
neue Wünsche von Kim kommen unten dazu. Vorbild ist das Unity-Projekt
`iQuest Drive/KlasseB-3d/03_Unity/iQuest-KlasseB` (Skripte unter `Assets/iQuest/Scripts`).

## Regeln

- Vor jedem Push: Bildschirmfoto ansehen (Spielen und Bauen, Leiste offen und zu), dann `tests/start-browser.py`.
- CSS nie per Textschnitt kürzen, ohne danach ein Bildschirmfoto zu prüfen (so ging am 12.11. die Leiste verloren).
- Bei jeder Änderung `ASSET_VERSION` (spielwiese.js) bzw. `V` (gen.py) hochzählen.
- Seiten werden aus `gen.py` erzeugt, nicht von Hand bearbeiten.

## Oberfläche

- [x] Impressum und Datenschutz oben neben dem Namen, getrennt, nicht im Bild
- [x] Leiste mit den Dingen seitlich, auf- und zuklappbar
- [x] Keine Pfeil- und Zusatzknöpfe im Bild, Steuerung nur über Tastatur
- [x] Zwei Modi: Spielen und Bauen, Taste B und Umschalter oben links
- [x] Hinweise je Modus getrennt anzeigen (beide liegen noch übereinander)
- [x] Namen in der Leiste sauber umbrechen

## Bauen (Vogelperspektive)

- [x] Blick von oben, Ziehen verschiebt die Karte, Mausrad zoomt, rechte Maustaste dreht
- [x] Dinge aus der Leiste ziehen, verschieben, drehen (Q/E), löschen (Entf)
- [x] Spiel steht still, Motoren und Martinshorn schweigen

## Spielen

- [x] Klick fängt die Maus, Mausbewegung dreht Kamera und Kim, Esc gibt frei
- [x] Im Fahrzeug dreht die Maus nur die Kamera, gelenkt wird mit A/D; Kamera schwenkt von selbst zurück
- [ ] Prüfen: Rückwärtsgehen mit S bei gefangener Maus

## Kim und Fahrzeuge

- [x] Kim größer (Faktor 1,22), so groß wie der Polizist
- [x] Sitzpose auf dem Sitzanker, Ein- und Aussteigen mit Bewegung
- [x] Füße schauen beim E-Quester Flight unten heraus: Beine nach vorn strecken und unter dem Boden abschneiden (eingebaut, Bild prüfen)
- [x] E-Quester Flight: Leertaste = auf Reiseflughöhe steigen, nochmal = hinuntergleiten (eingebaut, prüfen)
- [x] Türen: Autos mit Scharnieren (`Door_L_Hinge`/`Door_R_Hinge`) öffnen die Tür beim Ein- und Aussteigen.
      Scharniere haben Arian-, Helga-, Mira-Auto und der Streifenwagen (`*_Unity.fbx`); Schweber, Monstertruck, Gokart sind offen und haben keine.
      -> Arians Auto in die Leiste aufnehmen, Streifenwagen aus der FBX mit Scharnieren neu umwandeln
- [x] Pferd reiten wie im Spiel: E aufsteigen (Pferd geht herunter), W Schritt, W halten oder Leertaste (Klaps) Trab und Galopp, S langsamer (eingebaut, Sitz und Beine am Bild prüfen)
- [x] Hubschrauber selbst fliegen: Leertaste hebt ab / landet

## Polizei

- [x] Richtiges Polizeiauto: geschlossener Streifenwagen (`Polizei_NPC_Car`), nicht einsteigbar
- [x] Streife fährt von selbst, verfolgt Kim mit Martinshorn und Blaulicht (eingebaut, prüfen)
- [x] Besatzung im Wagen unsichtbar; steht die Streife bei Kim, steigt ein Polizist aus, verfolgt zu Fuß, steigt wieder ein (eingebaut, prüfen)
- [x] Polizist zu Fuß verfolgt Kim und wirft ihn um
- [x] Hubschrauber kreist über Kim (16 m), Rotor dreht und ist zu hören
- [ ] Später: Schießen (im Spiel schießt der Beifahrer auf die Reifen)

## Drohne und Kind

- [x] Drohne fliegt auf Reiseflughöhe des E-Quester (9 m) eine Acht um das Kind; Zusammenstoß = Feuerball, nach einer Weile neue Drohne (eingebaut, prüfen)
- [x] Kind bewegt sich (schaut sich um)

## Ton

- [x] Vogelstimmen, Schritte im Gras, Motoren, Hupe, Tür, Hufe, Klaps, Schnauben, Martinshorn, Rotor, Schweber-Summen, Knall (eingebaut, prüfen)
- [x] Autoradio: "ODYN - Wald (2026 Remake)" mit Rauschen am Anfang und Klang eines alten Radios; an beim Einsteigen, aus beim Aussteigen, R schaltet um (eingebaut, prüfen)
- [x] Ton-Schalter oben wirkt auf alles

## Danach

- [x] Browser-Test an die Modi anpassen
- [ ] Kim eine Zusammenfassung schreiben: was geht, was nicht, was ich nur am Bild und nicht in echtem Tempo prüfen konnte

## Neu am 12.11. um 17:19

- [x] Aussehen aufwerten: bessere Beleuchtung und Farbwiedergabe (Tonemapping, warmes Sonnenlicht, Himmel mit Verlauf, Gras mit Struktur, weichere Schatten)
- [x] Blumen und Büsche gehen kaputt, wenn man durchfährt oder durchfliegt (zerfetzen, sind dann weg; neu setzen im Baumodus). Bäume nicht.
- [x] Fahrzeuge können kaputtgehen: Zusammenstöße kosten Zustand, bei wenig Zustand Rauch, am Ende Wrack (nicht mehr fahrbar, neu setzen)
- [x] 17:25 Monstertruck: Kim steigt in Stufen hinauf statt zu schweben (auch hinunter in flache Autos)
- [x] 17:30 Startseite "Kurz zu mir": Bildunterschriften "Gelernter Zimmerer" und "Mit meiner Frau"
- [x] 17:33 Drohne: nur ein paar rötliche und orange Funken statt Feuerball
- [x] 17:42 Etwas mehr Abendsonne: Sonne tiefer und wärmer, leichter Schein und Strahlen am Himmel
- [x] 17:43 Umbenannt in "Spielwiese" (Seite spielwiese.html, Dateien, Ordner, Speicher); spielplatz.html leitet weiter

Nur am Standbild und in Zeitlupe geprüft (Software-Grafik), nicht in echtem Tempo und nicht gehört:
Fahrgefühl, Flug, Reiten, Kamera mit gefangener Maus, alle Töne und das Radio.

## Neu am 12.11. um 17:49: Kämpfen

- [ ] Kleine Gegner (Mobs) aus verschiedenen Roadlands-Leveln (KlasseB-3d, `02_Exporte/Characters/Gegner`, `Gegner_L4`, `Tiere`), unterschiedlich stark, keine Level
- [ ] Lebensanzeige über den Köpfen der Gegner
- [ ] Gegner lassen sich im Baumodus aufstellen und tauchen zwischendurch von selbst an manchen Stellen auf
- [ ] Schwert für Kim in der Hand (ein vorhandenes Schwert aus dem Ordner), Schwert ziehen und wegstecken mit den vorhandenen Bewegungen (`Animationen_Neu`: Draw Sword, Sheath Sword, Great Sword Slash ...), auf Kim übertragen
- [ ] Mausklick = Schlag
- [ ] Kim hat Leben; Gegner können ihn verletzen und besiegen
- [ ] Polizei nimmt nicht mehr fest: sie schießt, bis Kim umfällt (kein Blut). Gegen Polizei kann man nicht kämpfen, nur wegrennen.
- [ ] Umgefallen: Bildschirm wird kurz dunkel, Kim steht wieder am Startpunkt. Man verliert nichts.
- [ ] HUD unten: schlicht, passend zur Website, mit Anklängen an Roadlands; wenig Information (Leben, Schwert, im Fahrzeug Zustand)
- [ ] Die vielen Tastenhinweise oben raus; stattdessen eine Taste, die die Steuerung einblendet
