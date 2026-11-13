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

- [x] Kleine Gegner (Mobs) aus verschiedenen Roadlands-Leveln (KlasseB-3d, `02_Exporte/Characters/Gegner`, `Gegner_L4`, `Tiere`), unterschiedlich stark, keine Level
- [x] Lebensanzeige über den Köpfen der Gegner
- [x] Gegner lassen sich im Baumodus aufstellen und tauchen zwischendurch von selbst an manchen Stellen auf
- [x] Schwert für Kim in der Hand (ein vorhandenes Schwert aus dem Ordner), Schwert ziehen und wegstecken mit den vorhandenen Bewegungen (`Animationen_Neu`: Draw Sword, Sheath Sword, Great Sword Slash ...), auf Kim übertragen
- [x] Mausklick = Schlag
- [x] Kim hat Leben; Gegner können ihn verletzen und besiegen
- [x] Polizei nimmt nicht mehr fest: sie schießt, bis Kim umfällt (kein Blut). (18:45 geändert: Polizisten kann man bekämpfen und besiegen.)
- [x] Umgefallen: Bildschirm wird kurz dunkel, Kim steht wieder am Startpunkt. Man verliert nichts.
- [x] HUD unten: schlicht, passend zur Website, mit Anklängen an Roadlands; wenig Information (Leben, Schwert, im Fahrzeug Zustand)
- [x] Die vielen Tastenhinweise oben raus; stattdessen eine Taste, die die Steuerung einblendet

## Neu am 12.11. um 18:23: Handysteuerung

- [x] Die Spielwiese darf nicht von der Fensterbreite abhängen (schmales Fenster am PC = weiterhin Tastatur und Maus; Finger werden am Zeiger erkannt, nicht an der Breite)
- [x] Finger auf die Wiese legen und ziehen: Kim läuft in diese Richtung; je weiter der Finger von Kim weg ist, desto schneller (gehen, rennen)
- [x] Beim Ziehen dreht die Kamera von selbst mit
- [x] Tippen auf ein Fahrzeug oder das Pferd: hinlaufen und einsteigen
- [x] Tippen auf einen Gegner: zuschlagen (mehrfach tippen = mehrfach schlagen)
- [x] Im Fahrzeug mit dem Finger lenken und Gas geben, aussteigen über den Knopf; abheben und Klaps über einen Knopf
- [ ] Am echten Handy prüfen (bei mir nur nachgestellt: Hochformat 390 px, Finger-Ereignisse über den Testbrowser)

## Neu am 12.11. zwischen 18:34 und 19:13

- [x] Fehler: Füße fliegen im Gokart (Beinhaltung drehte mit der Fahrtrichtung und addierte sich auf)
- [x] Fehler: beim Aussteigen im Boden stecken (Höhe hängt jetzt an der Aufsteh-Bewegung)
- [x] Fehler: nach dem Umfallen schräg in der Luft liegen (legt sich flach hin)
- [x] Bäume hingen an der Randwand: Bäume am Rand weg, Rand ist jetzt ein Bergrand (Fels, Grate). Karte bleibt klein.
- [x] Jeder hat Leben und eine Lebensanzeige und lässt sich angreifen: Polizist (150, wehrt sich), Mann mit Fernsteuerung (rennt weg), Fuchs, Reh, Pferd (rennen weg)
- [x] Erwachsener statt Junge an der Drohne ("Mann mit Fernsteuerung")
- [x] Überfahren: Ziel nimmt viel Schaden, Fahrzeug keinen
- [x] Polizei ist friedlich, bis Kim etwas anstellt (Leute, Tiere, Polizisten angreifen oder anfahren, harter Aufprall). Gegner bekämpfen stört nicht. Dann Sirene, Polizisten, Streife und Hubschrauber greifen an.
- [x] Hubschrauber schießt und ist übermächtig
- [x] Licht: leichte Abenddämmerung, einen Hauch rötlicher und gedämpfter; Spiegelungen aus dem Himmel
- [x] Wind: Gras, Blumen, Büsche und Bäume wiegen sich
- [x] Maus fangen klappt schon beim Drücken (vorher erst beim Loslassen, ein leicht verrutschter Klick zählte als Ziehen)

Werte zum Nachstellen (alles in `spielwiese.js`): Kim 100 Leben, Schwert 25, schwerer Hieb 34, Überfahren Tempo x 7.
Gegner: Pilzling 30/6, Parkuhr-Wicht 45/8, Kreiselwicht 55/10, Lolli 70/12, Mülltonnen-Mimik 85/15 (Leben/Schaden).
Polizist 150 Leben, Schuss 14; Hubschrauber Schuss 10 alle 0,2 s. Mann 60, Fuchs 30, Reh 45, Pferd 110.

Nur am Standbild und in Zeitlupe geprüft (Software-Grafik mit etwa 2 Bildern je Sekunde), nicht in echtem Tempo und nicht gehört:
Kampfgefühl, Tempo der Schläge, Schüsse, Wind, alle neuen Töne, Fingersteuerung am echten Gerät, Maus fangen im echten Browser.

## Neu am 13.11. um 03:59

- [x] Steuerungsfenster aufgeräumt: drei gleich breite Spalten, einzelne Tasten, Maus und Finger umrandet; es steht nur, was gerade gilt (Spielen, Finger oder Bauen)
- [x] Beine werden beim Aussteigen sofort wieder ganz gezeigt (Schnittebene sinkt, sobald Kim aus dem Fahrzeug kommt)
- [x] Fuchs und Reh bleiben drin; Leben und Schaden bleiben so; Wind ist selbst gebaut
- [x] Sprechzeilen: 38 Aufnahmen von Kim eingebaut (assets/stimmen). Begleiter: Packen, Hängen (nach knapp 4 s), Sturz, im Liegen gepackt, beim dritten Packen in Folge sauer. Spielwiese: Treffer (nicht jeder), wenig Leben, Schwert, Sieg, Polizei, Umfallen, Start, Fahren, Fliegen, Pferd, Crash, Wrack. Sieben leise Aufnahmen im Pegel angehoben.

## Neu am 13.11. um 05:20: helles Design und Skins

Entscheidungen von Kim: alle Seiten außer /beratung; vorhandene Texte, neu geordnet entlang seines Wegs; helles Holz und Schieferblau.

- [x] Werkstatt-Szene (Zimmerer_Charakterauswahl) statt des dunklen Labs: Hintergrund, Vordergrund mit Pergola, Podest und Laufweg
- [x] Farben und Schrift: warmes Weiß, Holz, Schieferblau; Überschriften in Bitter, Text in Source Sans 3 (`start.css`, Variablen oben; die dunkle Fassung liegt in der Git-Geschichte)
- [x] Startseite als Geschichte: „Mein Weg" ist der rote Faden (Zollstock links), vier Stationen führen in ihre Abschnitte: Die Wurzeln, Das eigene Haus → Was mich erdet, Der Wendepunkt → Wofür ich stehe, Das Machen → Was ich baue. Texte unverändert.
- [x] Private Einblicke, Impressum, Datenschutz und der Rahmen der Spielwiese im hellen Design; /beratung unverändert
- [x] Skins (nur kim-betcher.de): Zimmerer-Kluft mit Hut und Anzug aus `Kim_Skins_v1.blend` (`assets/figuren/kim-skins.glb`, Bau: `tools/figuren/export_skins.py`). Mit Skin sind nur Hautfarbe, Haarfarbe und Frisur anpassbar; unter dem Hut enden die Haare an der Krempe. Gilt auch für Begleiter und Spielwiese.
- [ ] Von Kim ansehen lassen: Farben, Schrift, Reihenfolge der Abschnitte, Skins in Bewegung (bei mir nur an Standbildern geprüft)

## LETZTER SCHRITT – IMMER, NIE ENTFERNEN

Vor jedem Veröffentlichen, Pushen oder Abgeben: alle neuen oder geänderten Texte nach AI-SMELL.md (Teil A, B, C) prüfen und den Bericht ausgeben. Wortlaut der Regel: siehe `CLAUDE.md` im Hauptordner.
Dieser Punkt bleibt immer der letzte auf der Liste. Er wird nie gelöscht, abgehakt oder übersprungen.
