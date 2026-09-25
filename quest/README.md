# 34i-Quest

Lernspiel zur Sachkundeprüfung Immobiliardarlehensvermittlung (§ 34i GewO).
Die Lerninhalte und Fragen sind **eigenständig formuliert** und orientieren sich fachlich an den einschlägigen Gesetzen und Verordnungen sowie am offiziellen Prüfungsrahmen – **keine Original-IHK-Prüfungsfragen**.

## Starten (localhost)

```bash
cd 34i-quest
python -m http.server 8080
```
Dann in **Chrome oder Edge** öffnen: http://localhost:8080
(Nicht per Doppelklick – `file://` funktioniert nicht, weil Module, fetch() und Service Worker einen Server brauchen.)

Demo ohne Spielstand-Datei: http://localhost:8080/#demo → „Ohne Speichern ausprobieren“.

## Ordner

```
index.html            App-Shell (keine Inhalte)
manifest.json, sw.js  PWA / Offline / Updates
css/style.css         Design, Fonts lokal in css/fonts (DSGVO, offline)
js/app.js             Screens, Rendering, Spielfluss, Effekte
js/game.js            Spiellogik: Fragenauswahl, Runs, XP, Ränge, Erfolge, Countdown
js/savegame.js        Spielstand smartadm_34i.json (File System Access API)
js/content-loader.js  loadChapterContent(), Validierung, Cache
data/chapters.json    Levelliste + contentVersion
data/<level-id>/       learn.json, questions.json, boss.json
tools/check-content.mjs  Datenprüfung vor dem Hochladen
```

## Spielregeln

- Ein Level ist erst abgeschlossen, wenn Lernskript, Storymode, Versus und Bossfight geschafft sind.
- Bossfight bleibt gesperrt, bis der Storymode gewonnen wurde.
- Verlorener Storymode: −25 % HP, Versus: −33 % HP, Bossfight: −50 % HP. Solange das Level noch nicht abgeschlossen ist, setzt eine Niederlage die bereits gewonnenen Spielmodi dieses Levels zurück.
- Richtige Fragen können abhängig von der Schwierigkeit Heilitems droppen: leicht → kleiner Heiltrank (+25 %), mittel → mittlerer Heiltrank (+33 %), schwer → großer Heiltrank (+50 %). Bei schweren Fragen kann sehr selten ein Lebensfunke fallen, der bei 0 HP automatisch auf volle HP wiederbelebt.
- Ein falscher Lernskript-Checkpoint kostet einmalig 10 HP. Danach folgt eine leichte Rettungsfrage; bei richtiger Antwort gibt sie 5 HP zurück.
- Nach dem erstmaligen vollständigen Abschluss eines Levels werden die HP auf Maximum aufgefüllt.

## Neues Level hinzufügen

1. Technischen Datenordner für das nächste Level mit `learn.json`, `questions.json`, `boss.json` anlegen (Format wie beim vorhandenen Level 2). Die internen IDs sind nur technische Schlüssel; in der Oberfläche werden ausschließlich die eigenen Level-Bezeichnungen angezeigt.
2. In `data/chapters.json` das Level auf `"available": true` setzen und `contentVersion` um 1 erhöhen.
3. `node tools/check-content.mjs` ausführen – muss „Alles sauber.“ melden.

## App-Code aktualisieren
`STATIC_VERSION` in `sw.js` erhöhen. Die App zeigt dann „Neue Version bereit – Jetzt laden“.

## Einstellungen im Code
- `BOSS_REQUIRES_STORY` in `js/game.js`: Bossfight erst nach gewonnenem Storymode (Standard: an).
- `MODES` in `js/game.js`: Fragenanzahl, Leben, Sekunden je Modus.

## Spielregeln (Stand: HP-Update)

- **HP** stehen oben rechts in der Kopfzeile. Klick aufs Herz öffnet das Inventar mit den Heiltränken.
- **Niederlage** kostet HP: Storymode −25 %, Versus −33 %, Bossfight −50 %. Die Spielmodi des Levels werden zurückgesetzt, solange das Level noch nicht abgeschlossen ist.
- **Aufgeben** zählt als Niederlage, sobald eine Frage beantwortet wurde (beim Boss: sobald der Kampf begonnen hat).
- **0 HP:** Die Spielmodi sind gesperrt. Heiltrank trinken oder die **Rettungsmission** spielen (3 leichte Fragen in Folge richtig → +30 HP, ohne Risiko).
- **Tränke** fallen zufällig bei richtigen Antworten, je nach Schwierigkeit. Der **Lebensfunke** fällt selten bei den schwersten Fragen und belebt bei 0 HP automatisch wieder.
- **Level abgeschlossen** (Lernskript + Story + Versus + Boss) füllt die HP komplett auf.

### Bossfight
- **Intro-Sequenz** (~3 s, überspringbar mit Klick/Enter/Leertaste): Silhouette steigt auf, Blitz, Name, getippter Spruch, dann Regeln. Der Timer startet erst mit „Kampf beginnen“ (Enter). Zurück aus dem Intro kostet nichts.
- **Boss-Bilder** in `boss.json`: `image` (Ganzkörper), `bust` (Arena), `accent` (Farbstimmung, z. B. `#E9A400`). Ohne Bild erscheint das Siegel.
- **Testphase:** `BOSS_REQUIRES_STORY = false` in `js/game.js` – Bossfights sind ohne Storysieg spielbar. Für den Echtbetrieb auf `true` setzen.
- **Kritischer Treffer** bei Antwort mit mindestens 6 Sekunden Restzeit.
- **Fokus** (Taste F): einmal pro Kampf +5 Sekunden.
- **Wut-Phase** bei der finalen Frage oder wenn der Boss nur noch 1 Leben hat.
- **Siegtruhe** nach dem Sieg: garantierter Heiltrank – 3 Sterne groß, 2 mittel, 1 klein.
- Sprüche des Bosses stehen optional in `boss.json` unter `boss.taunts` (intro, hit, miss, timeout, final, low, defeat, victory).

Stellschrauben in `js/game.js`: `MODE_HP_LOSS`, `RESCUE_HEAL`, `BOSS_CRIT_SECONDS`, `BOSS_FOCUS_SECONDS`, `BOSS_CHEST`.
