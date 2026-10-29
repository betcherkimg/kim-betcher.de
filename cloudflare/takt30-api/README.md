# TAKT Nr. 30 – Ticket- und Einlass-API

Eigenständiger Cloudflare Worker mit eigener D1-Datenbank `takt30`. Er berührt weder SmartADM noch Office.
Die Oberfläche (GitHub Pages): `taktnr30/tickets/` (Startseite, `ticket/`, `bedingungen/`, `datenschutz/`),
`taktnr30/admin/` und `taktnr30/scanner/` (installierbare Scanner-App). Alte Pfade unter `tickets/` leiten weiter.

## Kontingente (serverseitig erzwungen)

- 70 reguläre Tickets: 1 Ticket 20 €, 2 Tickets 35 €. Höchstens 2 Plätze je Einladung, auch über mehrere Käufe.
- 30 2TAKT-Freitickets, nur vom Admin. Nie mehr als 30 gleichzeitig gültig.
- 20 Helfer-Tickets, eigenes Kontingent. Anmeldung über den Einladungslink; ein Helferplatz zählt zum
  2er-Limit der Einladung. Aufgaben und Plätze je Aufgabe pflegt der Admin.
- Reservierung 15 Minuten. Gesamt- und Einladungskontingent werden in einer atomaren SQL-Anweisung geprüft.
  Eine verspätete Zahlung ohne freien Platz führt zu automatischer Erstattung (PayPal) bzw. „Erstattung nötig“.

## Verkaufsmodi

`closed` (Standard) · `test` (Kauf simuliert, Tickets als TEST markiert; nur wenn `ALLOW_TEST_PAYMENTS=true`) ·
`live` (nur mit PayPal-Zugangsdaten; mit `PAYPAL_ENV=live` zusätzlich nur bei `ALLOW_LIVE_PAYMENTS=true`).
Testdaten lassen sich im Admin löschen, sobald der Testmodus beendet ist.

## Rollen

- Hauptadministrator: Clerk-ID in `MAIN_ADMIN_ID`.
- Ticketverwaltung / Einlass: weitere Clerk-Konten in `admin_users` (im Admin unter Einstellungen).
- Einlasshelfer ohne Konto: persönlicher Zugang (`taktnr30/scanner/#k=…` oder Zugangs-QR), gespeichert nur als SHA-256, sperrbar.

Rollen werden ausschließlich im Worker geprüft. Kritische Aktionen landen in `audit_logs`.

## Variablen und Geheimnisse

| Name | Art | Zweck |
|---|---|---|
| `DB` | D1-Binding | Datenbank `takt30` |
| `MAIN_ADMIN_ID` | Variable | Clerk-ID des Hauptadministrators |
| `ALLOW_TEST_PAYMENTS` | Variable | `true` erlaubt den Testmodus |
| `PAYPAL_ENV` | Variable | `sandbox` oder `live` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET` | Geheimnis | PayPal-App (Sandbox bzw. Live getrennt) |
| `PAYPAL_WEBHOOK_ID` | Geheimnis | Webhook auf `https://takt30-api.betcherkimg.workers.dev/paypal/webhook` (Events: `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`) |
| `ALLOW_LIVE_PAYMENTS` | Variable | erst nach ausdrücklicher Freigabe auf `true` |
| `RESEND_API_KEY` | Geheimnis | Ticket-Mails |
| `MAIL_FROM` | Variable | z. B. `TAKT Nr. 30 <tickets@kim-betcher.de>` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Variable / Geheimnis | optional, Schutz der Formulare |
| `IP_SALT` | Geheimnis | optional, Salz für die gehashte IP im Rate Limit |

Tabellen legt der Worker beim ersten Aufruf selbst an (`CREATE TABLE IF NOT EXISTS`).

## Deployment

Dashboard: Worker `takt30-api` anlegen → „Edit code“ → `worker.js` einfügen → Deploy → D1-Binding `DB` und
Variablen setzen. Oder `npx wrangler deploy --config cloudflare/takt30-api/wrangler.jsonc` (vorher `database_id` eintragen).

## Tests

- `node --test tests/takt30-worker.test.mjs` – Kontingente, gleichzeitige Käufe des letzten Tickets, Ausverkauf bei 70,
  30 Freitickets, Helfer-Kontingent, Einlass (gültig, doppelt, gleichzeitig, ungültig, ersetzt, gesperrt, Testticket),
  Rechte, Rate Limit, PayPal-Capture, doppelter Webhook, Erstattung, CSV-Injection, eindeutige Ticketnummern.
- `python3 tests/takt30-browser.py` – echte Seiten in Chromium (PC und Handy 360/390 px), Testkauf, PDF,
  Helfer-Anmeldung, Einlass mit echtem QR-Code über Fake-Kamera, Offline-Fall (gelb), Namenssuche.
