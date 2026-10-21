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
