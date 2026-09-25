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
- **Quest-Coins** gibt es für jeden gewonnenen Modus: Story 10, Versus 20, Boss 50. Der erste Sieg je Modus und Level zählt doppelt (resetfest), 3 Sterne geben +5 / +10 / +25, ein abgeschlossenes Level +100.
- **Shop** (Coin-Anzeige oder Herz oben rechts): Kleiner Trank 50, mittlerer 100, großer 200, Lebensfunke 500 (max. 1 im Inventar).
- **Tränke als Beute** sind sehr selten (2 % bei leichten und mittleren Fragen, 1,5 % großer Trank und 0,3 % Lebensfunke bei den schwersten). Die Siegtruhe enthält Coins und mit etwas Glück einen Trank.
- **Level abgeschlossen** (Lernskript + Story + Versus + Boss) füllt die HP komplett auf.

### Bossfight
- **Intro-Sequenz** (~3 s, überspringbar mit Klick/Enter/Leertaste): Silhouette steigt auf, Blitz, Name, getippter Spruch, dann Regeln. Der Timer startet erst mit „Kampf beginnen“ (Enter). Zurück aus dem Intro kostet nichts.
- **Boss-Bilder** in `boss.json`: `image` (Ganzkörper), `bust` (Arena), `accent` (Farbstimmung, z. B. `#E9A400`). Ohne Bild erscheint das Siegel.
- **Testphase:** `BOSS_REQUIRES_STORY = false` in `js/game.js` – Bossfights sind ohne Storysieg spielbar. Für den Echtbetrieb auf `true` setzen.
- **Kritischer Treffer** bei Antwort innerhalb von 4 Sekunden (mind. 11 s Restzeit).
- **4 von 6:** Der Kampf endet, sobald du 4 richtig hast (Sieg) oder 3 Fehler (Niederlage). Übersprungene Fragen zählen nicht als richtig – reichen die restlichen Fragen nicht mehr für 4 Treffer, ist der Kampf verloren.
- **Fokus** (F1): +10 Sekunden. Jeden Tag gibt es beim Öffnen des Spielstands einen Fokus geschenkt.
- **Wut-Phase** bei der finalen Frage oder wenn der Boss nur noch 1 Leben hat.
- **Siegtruhe** nach dem Sieg: Quest-Coins, dazu mit 4–15 % Chance (je nach Sternen) ein Trank.
- Sprüche des Bosses stehen optional in `boss.json` unter `boss.taunts` (intro, hit, miss, timeout, final, low, defeat, victory).

Stellschrauben in `js/game.js`: `MODE_HP_LOSS`, `RESCUE_HEAL`, `BOSS_CRIT_SECONDS`, `BOSS_FOCUS_SECONDS`, `BOSS_CHEST_POTION_CHANCE`, `COIN_REWARDS`, `COIN_FIRST_WIN_MULTIPLIER`, `COIN_LEVEL_COMPLETE`, `SHOP`, Beute-Chancen in `rollQuestionReward`.


## Modi

| Modus | Fragen | Leben | Timer | Bei Niederlage |
|---|---|---|---|---|
| Story | 10 in Lernreihenfolge | 3 | – | −25 % HP, Level-Reset |
| Versus | 5 zufällig | 1 | – | −33 % HP, Level-Reset |
| Boss | 6 Bossfragen – 4 richtig = Sieg, 3 Fehler = Niederlage | 3 | 15 s | −50 % HP, Level-Reset |
| Karussell | alle Fragen des Levels, leicht → Boss | 3 | – | keine Strafe |

**Karussell:** Belohnung nach Anteil richtiger Antworten – Holztruhe ab 25 % (15 Coins), Silber ab 50 % (35, 10 % kleiner Trank), Gold ab 75 % (75, 25 % mittlerer Trank), Legendär bei 100 % (150 + großer Trank, 5 % Lebensfunke). „Beenden“ wertet den bisherigen Stand aus. Zufallsbeute gibt es im Karussell nicht. Für den Level-Abschluss zählt das Karussell nicht.

## Kampf-Items (Hotbar unten, F1–F4)

| Taste | Item | Preis | Wirkung | Modi |
|---|---|---|---|---|
| F1 | Fokus | 30 | +10 s für die aktuelle Frage (1× pro Frage) · 1× täglich gratis | Boss |
| F2 | Pauser | 60 | Timer hält an – ohne kritischen Treffer | Boss |
| F3 | Herz | 120 | +1 Leben, auch direkt nach dem letzten verlorenen Leben | Story, Versus, Boss, Karussell |
| F4 | Überspringer | 250 | Frage überspringen, kein Lebensverlust | Story, Versus, Boss, Karussell |

Nicht im Inventar → ausgegraut mit Preis; Taste/Klick kauft und setzt sofort ein. Zu wenig Coins → Preis rot.
Sterne zählen Fehler, nicht verlorene Leben – ein Herz kauft also keine Sterne zurück.

## Audio

Alle Geräusche und die Musik entstehen live per Web-Audio-Synthese (`js/audio.js`) – keine fremden Aufnahmen, keine Lizenzfragen.
Musik: ruhig im Menü, Abenteuer in Story/Versus/Karussell, Kampf im Boss; jedes Stück wechselt nach 8 Takten die Akkordfolge.
Effekte: Münzklimpern (Coins erhalten/ausgeben), „Ouuw“ (Schaden), Schlucken (Trank), Truhe, Items.
Schalter oben rechts: ♪ = Musik, Lautsprecher = Effekte.
