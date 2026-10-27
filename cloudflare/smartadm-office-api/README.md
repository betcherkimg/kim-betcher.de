# SmartADM Office API

The source was retrieved from the production Worker on 21 October 2026 before adding weekly planning and contact-detail requests. This is the complete Worker, including the existing Office and SmartADM 5 endpoints. Authentication, D1 binding, and existing push keys remain unchanged. Credentials must be supplied as environment secrets, never committed here.

`wrangler.jsonc` records the existing account and D1 database. The fifteen-minute cron runs the existing attendance checks and the new weekly planning checks. Work planning uses Berlin local time, including daylight-saving changes.

## Weekly planning

- One persistent task per employee and week is created from Friday onwards. Friday and Saturday postponements are stored in the existing user preferences across devices; Sunday has no postponement.
- `/plans/week/confirm` validates one to three saved workdays and requires a reason whenever the total differs from six hours. Completion is recorded in the additive `week_planning` table and completes the corresponding task.
- Duration and the week reason use readable prefixes in the existing plan notes. Legacy plans count as two hours per day. Recorded work time and payroll calculations are not derived from these planned durations.
- Sunday reminders run at 09:00, 13:00, and 17:00 Europe/Berlin while planning remains incomplete. Unique delivery flags prevent duplicate notifications in the same slot. Failed deliveries can retry; delayed runs do not send a backlog of all missed slots.

## Contact details

The request target is versioned inside the existing script metadata. `/calls/:id/contact-details` checks ownership and request mode, validates at least one phone number or email address, and returns the contact with a readable receipt. The existing `R_TA_oT` database status is retained for compatibility; the interface displays “Kontaktdaten erhalten”. These returns do not count as appointments. Normal appointment completion is rejected for these requests, including from older cached clients.

## Checks and deployment

Run `node --test tests/*.test.cjs` from the repository root. `python tests/office-browser-flows.py` additionally exercises the actual page in Chromium at desktop and phone widths using local Clerk/API fixtures; it requires Playwright and `/usr/bin/chromium`. It makes no production customer writes.

Deploy the Worker before publishing its matching Office page. The new table is created idempotently by `ensureHr`; existing tables and customer data do not need to be rewritten. Retain the current Worker bindings and secrets on upload, and retain any existing cron schedules when adding the fifteen-minute schedule. Wrangler deployments use `npx wrangler deploy --config cloudflare/smartadm-office-api/wrangler.jsonc`. Push configuration continues to use the existing `push_config` table or configured VAPID secrets.

## Contributions and submission evidence

Office computes a draft automatically from the current month projection; manual gross overrides are explicit. Past dates alone remain a provisional actual balance. A saved monthly closing supplies the final gross and frozen payroll profile. Sasi's existing live profile has `employee_rv=0` and `employer_rv=1`: no employee RV deduction, but the 15% employer lump sum remains in field 0500. No employee-specific hardcoding or historical payroll rewrite is needed.

Preparation never submits anything to the SV-Meldeportal. Moving to submitted/paid requires a real submission date, an explicit operator confirmation and matching reviewed portal amounts. Old local records are not silently promoted into submission evidence. Confirmed report amounts, dates and calculation profiles are immutable, including against a concurrent stale draft save. Payment recording requires a plausible actual date. Drafts and unavailable previous-month closings cannot create a credit. A finalized previous month contributes its actual-minus-estimated balance to each portal field; the previous month's already-carried balance is not deducted a second time. Unavailable payroll inputs block saving rather than substituting zero.

Authoritative references checked 2026-10-23:

- [Minijob-Zentrale: contribution payment, periods and offsets](https://www.minijob-zentrale.de/DE/fuer-gewerbetreibende/beitragszahlung-und-fristen/detailseite)
- [Minijob-Zentrale: 2026 deadlines](https://www.minijob-zentrale.de/DE/service/online-services/faelligkeitstermine)
- [2026 marginal employment guidelines: 0100 is full RV, 0500 is employer lump sum when exempt](https://www.minijob-zentrale.de/SharedDocs/Downloads/DE/Rundschreiben/Geringfuegigkeitsrichtlinien-2026.pdf?__blob=publicationFile)

## Independent security monitor

`cloudflare/security-monitor/wrangler.jsonc` deploys a separate `smartadm-security-monitor` Worker from the same audited source. `SECURITY_MONITOR_ONLY=true` disables its public application endpoints and runs only monitoring on a fifteen-minute cron. It shares the existing D1 binding and push configuration, so no credential is embedded in source and an Office API deployment failure does not disable the independent checker.

The monitor verifies HTTPS availability and pinned SHA-256 hashes of nine public files, API/database health, anonymous admin rejection, and hourly counts of rejected or unapproved-account accesses and handler errors. Two consecutive failed checks create one boss inbox task and push notification; unchanged states stay quiet, recovery resolves the task and sends one recovery notification. Failed push delivery retries while the persistent task remains visible. Aggregated counters contain no tokens, IP addresses or request bodies and expire after seven days. Worker invocation logs persist in Cloudflare with query strings redacted. View checks in Office → Einstellungen → Sicherheitsmonitor or `GET /admin/security-monitor` (boss only); checks older than 45 minutes are shown as overdue.

Before publishing monitored files, run `python scripts/update-security-baseline.py`. Commit/push that exact source; deploy the API before its matching page and deploy the monitor after Pages has published the new assets. Preserve existing API bindings/secrets and cron schedules. Deploy monitor with `npx wrangler deploy --config cloudflare/security-monitor/wrangler.jsonc`. Do not accept a live file as a new baseline merely because it changed: review the repository change first.

This is availability, integrity and application-access monitoring, not a claim that GitHub Pages is protected by a Cloudflare WAF. The website currently responds from GitHub Pages and no `kim-betcher.de` zone is visible to the configured token. Changing DNS or nameservers is not part of this change. The monitor itself relies on Cloudflare cron and D1; an account-wide Cloudflare failure requires an external observer. External Clerk script updates and advisories beyond the pinned dependency audit are not continuously checked.

## Contact archive and import history

Contact deletion endpoints now archive records; completing an unreachable contact also retains it in the customer archive. Reopening preserves the attempt log. Removed package contacts get an `archived_at` timestamp and remain separate from active packages. Package-to-call transfers still remove the queue row, with its full snapshot preserved.

Before any contact route executes, `ensureContactHistory` installs additive, transactional SQLite triggers and backfills the existing stock into `office_contact_history`. Inserts and updates save a full version, and a database trigger rejects physical deletion of calls. Setup failures block the route. There is no automatic history purge. Existing history from `round_log` is also displayed; already-deleted records and previously overwritten notes cannot be reconstructed.

The boss-only `/admin/contact-history` endpoint uses ascending ID cursors (250 versions per page). Excel import reloads the complete history and active packages before matching; an incomplete Office read blocks import instead of claiming that contacts are new. Possible shared-number/name matches remain separate people and can be inspected. Both Office versions and full Sales protocols open in the preview without changing row selection. Sales entries with the same date/status but different protocols are retained separately; absent protocols are labelled explicitly.

Regression coverage: `node --test tests/*.test.cjs`, `python3 tests/office-browser-flows.py` and `python3 tests/office-contact-history-browser.py`. Browser tests use synthetic data and intercept all external authentication/API requests.
