# Unterschriftslinks

Verwaltung: https://kim-betcher.de/unterschriften/admin/ (Kims bestehende Clerk-Anmeldung).

1. Kundenname und Vorgang/Referenz eintragen, „Link erstellen“ wählen.
2. Den einmal angezeigten Link kopieren und an den Kunden schicken.
3. Kunde öffnet `/unterschriften/{Zahlencode}`, unterschreibt und bestätigt das Absenden.
4. Die PNG geht ausschließlich an `kim.betcher@schwaebisch-hall.de`, zusammen mit Name, Vorgang, Zeitpunkt und PNG-Prüfsumme.

Die Oberfläche verwendet das vorhandene Logo und die Farben der Website. Kim Betcher ist als Ansprechpartner und selbstständiger Handelsvertreter genannt. Es handelt sich um den Versand einer Unterschrifts-PNG; das System erstellt oder verändert kein Vertrags-PDF.

## Betrieb

- Frontend auf GitHub Pages; `404.html` leitet ausschließlich 49-stellige Unterschriftscodes zur Anwendung weiter. Nach Laden stellt die Anwendung den ursprünglichen Pfad wieder her.
- API im bestehenden `takt30-api`-Worker mit eigener Tabelle `signature_requests`. Keine Änderung an Office-Kunden, Arbeitszeiten oder Abrechnung.
- 160 Bit zufällige Codes, nur deren SHA-256 wird gespeichert. Link sieben Tage gültig; Sperren in der Verwaltung möglich. Verwaltungsrouten nur für `MAIN_ADMIN_ID`, nicht für Tickethelfer oder Scanner.
- Mailversand über den vorhandenen Resend-Schlüssel, Absender `Kim Betcher <unterschriften@kim-betcher.de>`, fester Empfänger im Servercode. Die Domain muss bei Resend verifiziert sein.
- Erfolg bedeutet: Resend hat den Versand angenommen. Keine Behauptung über Eingang im Postfach.
- PNG wird nach Annahme des Versands gelöscht. Bei Fehler bleibt die erste PNG für Wiederholungen vorübergehend gespeichert; Wiederholung auch in der Verwaltung möglich. Ein Versand-Lock und stabiler Resend-Idempotency-Key verhindern doppelte Nachrichten. Nach 23 Stunden wird nicht mehr wiederholt (Resend-Idempotenzfenster 24 Stunden).
- Stündliche Bereinigung entfernt ausstehende PNGs nach 23 Stunden bzw. Linkablauf; zusätzlicher Cleanup bei Aufruf der Unterschrifts-API. Kein Bild wird öffentlich ausgeliefert. Name, Vorgang, Zeiten und Hash bleiben zur Nachverfolgung erhalten.
- Neu erstellte Links werden nur einmal vollständig ausgegeben. Bei Verlust neuen Link erstellen und alten sperren.

## Prüfungen

`node --test tests/*.test.cjs tests/*.test.mjs` und `python tests/signatures-browser.py`.

Browserprüfungen verwenden simulierte Anmeldung/API, echte Touch-Ereignisse und keine realen Kundendaten oder E-Mails. API-Tests prüfen Empfängerbindung, PNG-Anhang, Zugriffsrechte, abgelaufene/gesperrte Links, Größenlimit, parallele Aufrufe, Mailfehler, Wiederholung und Bildbereinigung.
