# 34i-Quest

Das Spiel umfasst 24 Lernlevels und die Endboss-Prüfung auf Level 25.

## Starten

Im Quest-Ordner `python -m http.server 8767 --bind 127.0.0.1` starten und `http://127.0.0.1:8767/` öffnen. Für eine Vorschau ohne Spielstand-Datei `#demo` anhängen. Der Spielstand wird in `smartadm_34i.json` gespeichert.

## Fortschritt

- Vermittlerreich: Level 1–12, Start bei Level 1.
- Kreditreich: Level 13–24, eigener Start bei Level 13.
- Lernskript, Story, Versus und Boss abschließen, um das nächste Level derselben Karte zu öffnen. Bereits gespielte und abgeschlossene Inhalte bleiben zum Wiederholen verfügbar.
- Story öffnet Versus, Versus öffnet den Boss. Die frühere Freischaltung aller Modi ist ausgeschaltet.
- Letzte Schwelle: freigeschaltet nach Abschluss aller 24 Levels. Der erste Besuch führt mit einer kurzen Verdunklung auf die Prüfungsinsel. Die Musik bleibt dort düster.

## Endboss-Prüfung

IHK-Präsident Valerian Prüfstein – Prüfer der letzten Schwelle: vier der schwersten Bossfragen pro Level, in der Reihenfolge 1 bis 24. 96 Fragen, 45 Minuten, 150 mögliche Punkte. 54 Fragen zählen doppelt, 42 einfach. Start bei 0 Punkten, bestanden ab 75 Punkten (50 %); Mehrfachauswahl muss vollständig richtig sein.

Bis zur Endauswertung werden keine Lösungen oder erzielten Punkte angezeigt. Bei Zeitablauf wird automatisch abgegeben. Unbeantwortete Fragen zählen 0 Punkte. Bestwert, Versuche, Bestehen und der erste Inselbesuch werden im Spielstand gespeichert.

Der Kartenbutton „Letzte Schwelle · Test“ ist auf Wunsch vorübergehend frei. Das betrifft ausschließlich den Prüfungsmodus. `EXAM_TEST_ACCESS` in `js/exam.js` deaktiviert später den Testzugang. Der Countdown beginnt erst nach dem Endboss-Auftritt mit der ersten Frage.

## Dateien

`assets/`, `css/`, `data/`, `js/`, `index.html`, `manifest.json` und `sw.js` werden für das Spiel benötigt. Die Bilder sind lokal gespeichert; die Musik wird ohne zusätzliche Audiodownloads erzeugt. Die Boss-Ansage erscheint als Text, ohne Sprachausgabe. Statische Version: v45; Inhaltsversion: 20.

PDF-Quellen, Produktionsunterlagen, Prüfwerkzeuge und die bisherige ausführliche Dokumentation liegen seit der Aufräumaktion unter `C:\Website_data\Quest_Daten`. Die Ordnerstruktur der Unterlagen wurde erhalten. Die Datenprüfung dort lässt sich mit `node C:\Website_data\Quest_Daten\tools\check-content.mjs` ausführen.
