# 34i-Quest

Lernspiel zur Sachkundeprüfung Immobiliardarlehensvermittlung (§ 34i GewO).
Die Fragen sind **eigene, prüfungsnahe Fragen** auf Basis der BWB-Lernskripte, des DIHK-Rahmenplans und der ImmVermV – **keine Original-IHK-Prüfungsfragen**.

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
data/chapters.json    Kapitelliste + contentVersion
data/<kapitel>/       learn.json, questions.json, boss.json
tools/check-content.mjs  Datenprüfung vor dem Hochladen
```

## Neues Kapitel hinzufügen

1. Ordner `data/2.3/` mit `learn.json`, `questions.json`, `boss.json` anlegen (Format wie 2.2).
2. In `data/chapters.json` das Kapitel auf `"available": true` setzen und `contentVersion` um 1 erhöhen.
3. `node tools/check-content.mjs` ausführen – muss „Alles sauber.“ melden.

## App-Code aktualisieren
`STATIC_VERSION` in `sw.js` erhöhen. Die App zeigt dann „Neue Version bereit – Jetzt laden“.

## Einstellungen im Code
- `BOSS_REQUIRES_STORY` in `js/game.js`: Bossfight erst nach gewonnenem Storymode (Standard: an).
- `MODES` in `js/game.js`: Fragenanzahl, Leben, Sekunden je Modus.
