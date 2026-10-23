/* ================= Konfiguration ================= */

const CLERK_ISSUER = "https://clerk.kim-betcher.de";
const CLERK_JWKS_URL = `${CLERK_ISSUER}/.well-known/jwks.json`;
const APP_ORIGIN = "https://kim-betcher.de";
const APP_PATH = "/smartadm/office/";

const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_TOLERANCE_S = 60;
const MAX_BACKDATE_DAYS = 7;
const HOURLY_RATE_CENTS = 1390;            // Stundenlohn 2026 (= Mindestlohn)
// Stundenlohn je Abrechnungsmonat: mindestens der gesetzliche Mindestlohn (2027: 14,60 €)
const hourlyRateCents = month => (String(month || "") >= "2027-01" ? 1460 : HOURLY_RATE_CENTS);
const COMMISSION_RATE_CENTS = 500;
const CONTRACT_WEEKLY_HOURS = 6;
const CONTRACT_MAX_WORKDAYS_PER_WEEK = 3;
const PRIORITIES = ["low", "normal", "high"];
const ABSENCE_TYPES = ["vacation", "sick", "holiday", "paid_leave"];

const corsHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

/* ================= Response- & DB-Helfer ================= */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
  });

const err = (message, status = 400) => json({ error: message }, status);
const ok = (extra = {}, status = 200) => json({ success: true, ...extra }, status);
const created = result => ok({ id: result.meta?.last_row_id }, 201);
const changed = (result, notFound = "Eintrag nicht gefunden.") =>
  result.meta?.changes ? ok() : err(notFound, 404);

const readJson = request => request.json().catch(() => null);
const qs = n => Array(n).fill("?").join(", ");

const stmt = (env, sql, args = []) =>
  args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql);
const all = async (env, sql, ...args) => (await stmt(env, sql, args).all()).results || [];
const first = (env, sql, ...args) => stmt(env, sql, args).first();
const run = (env, sql, ...args) => stmt(env, sql, args).run();

/* ================= Auth (Clerk JWT) ================= */

function b64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

const decodePart = part => JSON.parse(new TextDecoder().decode(b64url(part)));

let jwksCache = null;
let jwksCachedAt = 0;

async function getJwks(force = false) {
  if (!force && jwksCache && Date.now() - jwksCachedAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(CLERK_JWKS_URL);
  if (!res.ok) throw new Error("Clerk JWKS konnte nicht geladen werden.");
  jwksCache = await res.json();
  jwksCachedAt = Date.now();
  return jwksCache;
}

async function findKey(kid) {
  const match = jwks => jwks.keys.find(k => k.kid === kid);
  return match(await getJwks()) || match(await getJwks(true));
}

async function verifyClerkToken(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("NO_TOKEN");

  const parts = auth.slice(7).trim().split(".");
  if (parts.length !== 3) throw new Error("INVALID_TOKEN");

  const [h, p, s] = parts;
  const header = decodePart(h);
  const payload = decodePart(p);
  if (header.alg !== "RS256") throw new Error("INVALID_ALGORITHM");

  const jwk = await findKey(header.kid);
  if (!jwk) throw new Error("KEY_NOT_FOUND");

  const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    algo.name, key, b64url(s), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) throw new Error("INVALID_SIGNATURE");

  const now = Math.floor(Date.now() / 1000);
  const checks = [
    [!Number.isFinite(payload.exp) || payload.exp < now - CLOCK_TOLERANCE_S, "TOKEN_EXPIRED"],
    [payload.nbf != null && (!Number.isFinite(payload.nbf) || payload.nbf > now + CLOCK_TOLERANCE_S), "TOKEN_NOT_ACTIVE"],
    [payload.iss !== CLERK_ISSUER, "INVALID_ISSUER"],
    [payload.azp && payload.azp !== APP_ORIGIN, "INVALID_AUTHORIZED_PARTY"],
    [!validUserId(payload.sub) || typeof payload.sub !== "string", "NO_USER"]
  ];
  for (const [failed, code] of checks) if (failed) throw new Error(code);

  return { userId: payload.sub, sessionId: payload.sid || null, claims: payload };
}

const bossIds = env =>
  String(env.BOSS_USER_ID || env.BOSS_USER_IDS || "")
    .split(",").map(v => v.trim()).filter(Boolean);

const isBoss = (env, userId) => bossIds(env).includes(userId);

const roleOf = (env, userId) => (isBoss(env, userId) ? "boss" : "employee");

/* ================= Validierung ================= */

function nonNegInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === m[0];
}

const validTime = value => /^\d{2}:\d{2}$/.test(String(value || ""));

function validUserId(value) {
  const text = String(value || "").trim();
  return text.length > 0 && text.length <= 200;
}

function berlinToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date()).map(x => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function allowedWorkDate(value) {
  if (!validDate(value)) return false;
  const diff = Math.round((Date.parse(berlinToday()) - Date.parse(value)) / 86400000);
  return diff >= 0 && diff <= MAX_BACKDATE_DAYS;
}

function minutesFromTimes(start, end, breakMinutes = 0) {
  const [sh, sm, eh, em] = [...start.split(":"), ...end.split(":")].map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return 0;
  const gross = ((eh * 60 + em) - (sh * 60 + sm) + 1440) % 1440; // über Mitternacht
  return Math.max(0, gross - nonNegInt(breakMinutes));
}

/* ================= Einträge: Arbeitszeit + Leistung ================= */

function parseWorkBody(body) {
  if (!body || !allowedWorkDate(body.work_date) ||
      !validTime(body.start_time) || !validTime(body.end_time)) {
    return { error: "Arbeitszeitdaten ungültig. Das Datum darf nur heute oder innerhalb der letzten 7 Tage liegen." };
  }
  const breakMinutes = nonNegInt(body.break_minutes);
  const workMinutes = minutesFromTimes(body.start_time, body.end_time, breakMinutes);
  if (workMinutes <= 0) {
    return { error: "Arbeitsdauer muss nach Abzug der Pause größer als 0 sein." };
  }
  return { values: [body.work_date, body.start_time, body.end_time, breakMinutes, workMinutes] };
}

function parsePerformanceBody(body) {
  if (!body || !allowedWorkDate(body.work_date)) {
    return { error: "Datum ungültig. Erlaubt sind heute und die letzten 7 Tage." };
  }
  // Jeder gesetzte Termin wird vergütet. Die Spalte commissionable_appointments bleibt
  // bestehen und trägt denselben Wert – gerechnet wird überall mit appointments.
  const appointments = nonNegInt(body.appointments);
  return { values: [body.work_date, appointments, appointments] };
}

function parseEntryBody(body) {
  const work = parseWorkBody(body);
  if (work.error) return work;
  const perf = parsePerformanceBody(body);
  if (perf.error) return perf;
  // work: [date, start, end, break, minutes] · perf: [appointments, appointments]
  return { work: work.values, perf: perf.values.slice(1) };
}

/*
 * Ein Eintrag = eine Zeile in work_entries + die verknüpfte Zeile in
 * performance_entries (work_entry_id). Alle Schreibvorgänge laufen als
 * D1-Batch: Der Batch ist eine Transaktion – entweder alles oder nichts.
 */

const ENTRY_SELECT = `
  SELECT
    w.id, w.work_date, w.start_time, w.end_time, w.break_minutes, w.work_minutes,
    COALESCE(p.appointments, 0) AS appointments,
    COALESCE(p.commissionable_appointments, 0) AS commissionable_appointments,
    w.created_at, w.updated_at
  FROM work_entries w
  LEFT JOIN performance_entries p ON p.work_entry_id = w.id
  WHERE w.clerk_user_id = ?
  ORDER BY w.work_date DESC, w.start_time DESC`;

const listEntries = async ({ env, owner }) => json(await all(env, ENTRY_SELECT, owner));

// Ein abgeschlossener Monat ist eingefroren – sonst stimmt der unterschriebene Gehaltsnachweis nicht mehr.
async function closedMonthError(env, owner, ...dates) {
  const months = [...new Set(dates.filter(Boolean).map(d => String(d).slice(0, 7)))];
  for (const month of months) {
    const row = await first(env, "SELECT id FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?", owner, month).catch(() => null);
    if (row) return err("Dieser Monat ist bereits abgeschlossen – Einträge können nicht mehr geändert werden.", 409);
  }
  return null;
}

async function createEntry({ request, env, owner }) {
  const { error, work, perf } = parseEntryBody(await readJson(request));
  if (error) return err(error);
  const closed = await closedMonthError(env, owner, work[0]);
  if (closed) return closed;

  const [workResult] = await env.DB.batch([
    stmt(env,
      `INSERT INTO work_entries
         (clerk_user_id, work_date, start_time, end_time, break_minutes, work_minutes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [owner, ...work]),
    // In derselben Transaktion ist die höchste ID dieses Nutzers die gerade angelegte.
    stmt(env,
      `INSERT INTO performance_entries
         (clerk_user_id, work_date, appointments, commissionable_appointments, work_entry_id)
       VALUES (?, ?, ?, ?, (SELECT MAX(id) FROM work_entries WHERE clerk_user_id = ?))`,
      [owner, work[0], ...perf, owner])
  ]);

  return created(workResult);
}

// Bestehende Einträge dürfen nur innerhalb der 7-Tage-Frist geändert/gelöscht werden.
async function checkEditable(env, id, owner) {
  const row = await first(env,
    "SELECT work_date FROM work_entries WHERE id = ? AND clerk_user_id = ?", id, owner);
  if (!row) return err("Eintrag nicht gefunden.", 404);
  if (!allowedWorkDate(row.work_date)) {
    return err("Einträge, die älter als 7 Tage sind, können nicht mehr geändert werden.", 403);
  }
  return null;
}

async function updateEntry({ request, env, owner, id }) {
  const { error, work, perf } = parseEntryBody(await readJson(request));
  if (error) return err(error);

  const denied = await checkEditable(env, id, owner);
  if (denied) return denied;
  const old = await first(env, "SELECT work_date FROM work_entries WHERE id = ? AND clerk_user_id = ?", id, owner);
  const closed = await closedMonthError(env, owner, work[0], old?.work_date);
  if (closed) return closed;

  await env.DB.batch([
    stmt(env,
      `UPDATE work_entries
       SET work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, work_minutes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND clerk_user_id = ?`,
      [...work, id, owner]),
    // Legt die Leistungszeile an, falls sie fehlt – sonst Update.
    stmt(env,
      `INSERT INTO performance_entries
         (clerk_user_id, work_date, appointments, commissionable_appointments, work_entry_id)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM work_entries WHERE id = ? AND clerk_user_id = ?)
       ON CONFLICT(work_entry_id) DO UPDATE SET
         work_date = excluded.work_date,
         appointments = excluded.appointments,
         commissionable_appointments = excluded.commissionable_appointments,
         updated_at = CURRENT_TIMESTAMP`,
      [owner, work[0], ...perf, id, id, owner])
  ]);

  return ok();
}

async function deleteEntry({ env, owner, id }) {
  const denied = await checkEditable(env, id, owner);
  if (denied) return denied;
  const old = await first(env, "SELECT work_date FROM work_entries WHERE id = ? AND clerk_user_id = ?", id, owner);
  const closed = await closedMonthError(env, owner, old?.work_date);
  if (closed) return closed;

  await env.DB.batch([
    stmt(env, "DELETE FROM performance_entries WHERE work_entry_id = ? AND clerk_user_id = ?", [id, owner]),
    stmt(env, "DELETE FROM work_entries WHERE id = ? AND clerk_user_id = ?", [id, owner])
  ]);

  return ok();
}

/* ================= Office-Einstellungen (zentral) ================= */

const SETTINGS_DEFAULTS = { goalHours: 24, goalAppointments: 40, cutAppointments: 50 };
const SETTINGS_COLUMNS = {
  goalHours: "goal_hours",
  goalAppointments: "goal_appointments",
  cutAppointments: "cut_appointments"
};

async function getSettings({ env }) {
  const row = await first(env, "SELECT * FROM office_settings WHERE id = 1");
  if (!row) return json(SETTINGS_DEFAULTS);
  return json({
    ...Object.fromEntries(
      Object.entries(SETTINGS_COLUMNS).map(([key, col]) => [key, Number(row[col])])
    ),
    updated_at: row.updated_at
  });
}

async function updateSettings(ctx) {
  const body = (await readJson(ctx.request)) || {};
  const keys = Object.keys(SETTINGS_COLUMNS);
  const cols = Object.values(SETTINGS_COLUMNS);
  const values = keys.map(k =>
    Math.min(1000, Math.max(1, nonNegInt(body[k], SETTINGS_DEFAULTS[k]))));

  await run(ctx.env,
    `INSERT INTO office_settings (id, ${cols.join(", ")}, updated_at)
     VALUES (1, ${qs(cols.length)}, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       ${cols.map(c => `${c} = excluded.${c}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
    ...values);

  return getSettings(ctx);
}

/* ================= Office-Mitglieder ================= */

async function upsertOfficeMember({ request, env, userId }) {
  const body = (await readJson(request)) || {};
  const displayName = String(body.display_name || "").trim().slice(0, 120);
  const email = String(body.email || "").trim().slice(0, 200);

  await run(env,
    `INSERT INTO office_members (clerk_user_id, display_name, email, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(clerk_user_id) DO UPDATE SET
       display_name = excluded.display_name,
       email = excluded.email,
       updated_at = CURRENT_TIMESTAMP`,
    userId, displayName || null, email || null);

  return ok();
}

// Testkonten: laufen wie echte Mitarbeiter, zählen aber nicht für Meldungen (Minijob-Zentrale, BG).
const TEST_EMAILS = ["betcherkimg@gmail.com", "betcherkimg@googlemail.com"];
const isTestEmail = email => TEST_EMAILS.includes(String(email || "").trim().toLowerCase());

async function getAdminUsers({ env }) {
  const rows = await all(env, `
    WITH ids AS (
      SELECT clerk_user_id FROM office_members
      UNION SELECT clerk_user_id FROM work_entries
      UNION SELECT clerk_user_id FROM performance_entries
    )
    SELECT ids.clerk_user_id, m.display_name, m.email
    FROM ids
    LEFT JOIN office_members m ON m.clerk_user_id = ids.clerk_user_id
    ORDER BY COALESCE(m.display_name, m.email, ids.clerk_user_id)`);

  return json(rows.map(u => {
    const role = roleOf(env, u.clerk_user_id);
    return { ...u, role, is_test: role !== "boss" && isTestEmail(u.email) };
  }));
}

/* ================= Abrechnungseinstellungen ================= */

const PAYROLL_FLAGS = {
  employeeRv: "employee_rv",
  rvMinBaseApplies: "rv_min_base_applies",
  flatTax: "flat_tax",
  flatTaxEmployee: "flat_tax_employee",
  employerKv: "employer_kv",
  employerRv: "employer_rv",
  u1: "u1",
  u2: "u2",
  insolvency: "insolvency",
  accident: "accident"
};

const PAYROLL_DEFAULTS = {
  employeeRv: true, rvMinBaseApplies: true, flatTax: true, flatTaxEmployee: false,
  employerKv: true, employerRv: true, u1: true, u2: true,
  insolvency: true, accident: false, accidentRate: 0, accidentRateEstimate: 0
};

function mapPayrollSettings(row, userId) {
  if (!row) return { clerk_user_id: userId, ...PAYROLL_DEFAULTS };
  return {
    clerk_user_id: userId,
    ...Object.fromEntries(
      Object.entries(PAYROLL_FLAGS).map(([key, col]) => [key, Boolean(row[col])])
    ),
    accidentRate: Number(row.accident_rate || 0),
    accidentRateEstimate: Number(row.accident_rate_estimate || 0),
    updated_at: row.updated_at || null
  };
}

async function getPayrollSettings({ env, owner }) {
  const row = await first(env, "SELECT * FROM payroll_settings WHERE clerk_user_id = ?", owner);
  return json(mapPayrollSettings(row, owner));
}

async function updatePayrollSettings(ctx) {
  const body = await readJson(ctx.request);
  if (!body) return err("Ungültige Abrechnungseinstellungen.");

  await ensureMasterColumns(ctx.env);
  const flags = { ...body, flatTaxEmployee: body.flatTax && body.flatTaxEmployee };
  const cols = [...Object.values(PAYROLL_FLAGS), "accident_rate", "accident_rate_estimate"];
  const values = [
    ...Object.keys(PAYROLL_FLAGS).map(k => (flags[k] ? 1 : 0)),
    Math.max(0, Math.min(20, Number(body.accidentRate) || 0)),
    Math.max(0, Math.min(20, Number(body.accidentRateEstimate) || 0))
  ];

  await run(ctx.env,
    `INSERT INTO payroll_settings (clerk_user_id, ${cols.join(", ")}, updated_at)
     VALUES (?, ${qs(cols.length)}, CURRENT_TIMESTAMP)
     ON CONFLICT(clerk_user_id) DO UPDATE SET
       ${cols.map(c => `${c} = excluded.${c}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
    ctx.owner, ...values);

  return getPayrollSettings(ctx);
}

/* ================= Aufgaben ================= */

const TASK_COLS = [
  "id", "assigned_to", "created_by", "title", "description", "due_date",
  "priority", "status", "completed_at", "created_at", "updated_at"
];

const taskOrder = (p = "") => `
  ORDER BY
    CASE ${p}status WHEN 'open' THEN 0 ELSE 1 END,
    CASE ${p}priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
    ${p}due_date IS NULL,
    ${p}due_date ASC,
    ${p}created_at DESC`;

// Aufgaben von Mitarbeitern an den Boss landen im gemeinsamen Boss-Posteingang.
const BOSS_INBOX = "boss";

function parseTaskBody(body) {
  const title = String(body?.title || "").trim().slice(0, 160);
  const description = String(body?.description || "").trim().slice(0, 2000) || null;
  const dueDate = body?.due_date ? String(body.due_date) : null;
  const priority = PRIORITIES.includes(body?.priority) ? body.priority : "normal";

  if (!title) return { error: "Bitte einen Aufgabentitel eingeben." };
  if (dueDate && !validDate(dueDate)) return { error: "Ungültiges Fälligkeitsdatum." };
  return { title, description, dueDate, priority };
}

const runLater = async (exec, job) => {
  if (exec?.waitUntil) exec.waitUntil(job); else await job;
};

async function memberName(env, userId) {
  const m = await first(env, "SELECT display_name, email FROM office_members WHERE clerk_user_id = ?", userId);
  return m?.display_name || m?.email || "Mitarbeiter";
}

/* --- Mitarbeiter --- */

// Eigene Aufgaben + selbst an den Boss geschickte Aufgaben
const mapPlanningTask = t => String(t.created_by || "").startsWith("week-plan:")
  ? {...t, weekPlanning:true, weekStart:t.created_by.slice(10)} : t;

const getOwnTasks = async ({ env, userId }) => {
  if (!isBoss(env,userId)) await ensureWeekPlanningTask(env,userId);
  return json((await all(env,
    `SELECT ${TASK_COLS.join(", ")} FROM office_tasks
     WHERE assigned_to = ? OR (assigned_to = ? AND created_by = ?)
     ${taskOrder()}`,
    userId, BOSS_INBOX, userId)).map(mapPlanningTask));
};

const completeOwnTask = async ({ env, userId, id }) =>
  changed(await run(env,
    `UPDATE office_tasks
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open' AND created_by NOT LIKE 'week-plan:%'`,
    id, userId), "Aufgabe nicht gefunden oder bereits erledigt.");

async function createTaskForBoss({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Als Boss legst du Aufgaben über „Aufgabe erstellen“ an.");

  const task = parseTaskBody(await readJson(request));
  if (task.error) return err(task.error);

  const result = await run(env,
    `INSERT INTO office_tasks (assigned_to, created_by, title, description, due_date, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    BOSS_INBOX, userId, task.title, task.description, task.dueDate, task.priority);

  const id = result.meta?.last_row_id;
  await runLater(exec, (async () => {
    const from = await memberName(env, userId);
    const message = taskPushMessage(id, task.title, task.dueDate, task.priority, `Neue Aufgabe von ${from}`);
    return Promise.all(bossIds(env).map(bossId => notifyUser(env, bossId, message)));
  })());

  return created(result);
}

// Mitarbeiter kann eine noch offene Anfrage an den Boss zurückziehen.
const withdrawTaskForBoss = async ({ env, userId, id }) =>
  changed(await run(env,
    "DELETE FROM office_tasks WHERE id = ? AND created_by = ? AND assigned_to = ? AND status = 'open'",
    id, userId, BOSS_INBOX), "Aufgabe nicht gefunden oder bereits erledigt.");

/* --- Boss --- */

async function getAdminTasks({ env, url, exec }) {
  await syncFkTask(env);
  // Einsatzplan prüfen, falls der Cron-Trigger fehlt oder hängt.
  await checkPlans(env, exec).catch(e => console.error("checkPlans:", e.message));
  const filter = String(url.searchParams.get("user_id") || "").trim();
  const args = validUserId(filter) ? [filter] : [];

  return json(await all(env,
    `SELECT ${TASK_COLS.map(c => `t.${c}`).join(", ")},
            m.display_name, m.email,
            cm.display_name AS creator_name, cm.email AS creator_email
     FROM office_tasks t
     LEFT JOIN office_members m ON m.clerk_user_id = t.assigned_to
     LEFT JOIN office_members cm ON cm.clerk_user_id = t.created_by
     ${args.length ? "WHERE t.assigned_to = ?" : ""}
     ${taskOrder("t.")}`,
    ...args));
}

async function createAdminTask({ request, env, userId, exec }) {
  const body = (await readJson(request)) || {};
  const assignedTo = String(body.assigned_to || "").trim();
  const task = parseTaskBody(body);

  if (!validUserId(assignedTo)) return err("Bitte einen Mitarbeiter auswählen.");
  if (task.error) return err(task.error);
  if (isBoss(env, assignedTo) || assignedTo === BOSS_INBOX) {
    return err("Aufgaben können nur Mitarbeitern zugewiesen werden.");
  }

  const member = await first(env, "SELECT 1 FROM office_members WHERE clerk_user_id = ?", assignedTo);
  if (!member) return err("Mitarbeiter wurde noch nicht in Office registriert.", 404);

  const result = await run(env,
    `INSERT INTO office_tasks (assigned_to, created_by, title, description, due_date, priority, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    assignedTo, userId, task.title, task.description, task.dueDate, task.priority);

  // Push läuft nach der Antwort weiter – die Aufgabe ist sofort gespeichert.
  const id = result.meta?.last_row_id;
  await runLater(exec, notifyUser(env, assignedTo,
    taskPushMessage(id, task.title, task.dueDate, task.priority)));

  return created(result);
}

// Boss hakt eine Aufgabe aus seinem Posteingang ab → Mitarbeiter bekommt Bescheid.
async function completeInboxTask({ env, id, exec }) {
  const row = await first(env,
    `UPDATE office_tasks
     SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open'
     RETURNING created_by, title`,
    id, BOSS_INBOX);
  if (!row) return err("Aufgabe nicht gefunden oder bereits erledigt.", 404);
  // Selbst angelegte Boss-Aufgaben (z. B. aus dem Kein-Kontakt-Archiv) brauchen keine Rückmeldung.
  if (isBoss(env, row.created_by)) return ok();

  await runLater(exec, notifyUser(env, row.created_by, {
    title: "Vom Boss erledigt",
    body: row.title,
    tag: `task-${id}`,
    url: `${APP_PATH}?page=organisation`
  }));
  return ok();
}

const reopenAdminTask = async ({ env, id }) =>
  changed(await run(env,
    `UPDATE office_tasks
     SET status = 'open', completed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'completed'`,
    id), "Aufgabe nicht gefunden oder bereits offen.");

const deleteAdminTask = async ({ env, id }) =>
  changed(await run(env, "DELETE FROM office_tasks WHERE id = ?", id), "Aufgabe nicht gefunden.");

/* ================= Stammdaten für den Gehaltsnachweis ================= */

const cleanText = (value, max) => String(value ?? "").trim().slice(0, max) || null;

const EMPLOYER_FIELDS = ["name", "street", "zip_city", "company_number", "uv_carrier", "uv_member_number", "uv_tariff"];
const EMPLOYEE_FIELDS = [
  "full_name", "personnel_number", "street", "zip_city",
  "birth_date", "insurance_number", "tax_id", "health_insurance", "iban",
  "start_date", "end_date",
  "nationality", "activity_key", "other_employment", "registered_at"
];

// Neue Spalten für Meldedaten – der Worker legt sie beim ersten Zugriff selbst an, kein SQL nötig.
let masterColumnsReady = false;
async function ensureMasterColumns(env) {
  if (masterColumnsReady) return;
  const add = async (table, cols, type = "TEXT") => {
    const have = new Set((await all(env, `PRAGMA table_info(${table})`)).map(c => c.name));
    for (const col of cols) {
      if (!have.has(col)) {
        try { await run(env, `ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch { /* gibt es schon */ }
      }
    }
  };
  await add("employee_profiles", ["nationality", "activity_key", "other_employment", "registered_at"]);
  await add("office_employer", ["uv_carrier", "uv_member_number", "uv_tariff"]);
  await add("payroll_settings", ["accident_rate_estimate"], "REAL");
  masterColumnsReady = true;
}

const mapEmployer = row => Object.fromEntries(EMPLOYER_FIELDS.map(f => [f, row?.[f] ?? null]));
const mapEmployeeProfile = row => Object.fromEntries(EMPLOYEE_FIELDS.map(f => [f, row?.[f] ?? null]));

function parseEmployer(body) {
  const data = {
    name: cleanText(body?.name, 120),
    street: cleanText(body?.street, 120),
    zip_city: cleanText(body?.zip_city, 120),
    company_number: cleanText(String(body?.company_number ?? "").replace(/\s/g, ""), 8),
    uv_carrier: cleanText(body?.uv_carrier, 120),
    uv_member_number: cleanText(body?.uv_member_number, 40),
    uv_tariff: cleanText(body?.uv_tariff, 40)
  };
  if (!data.name) return { error: "Bitte den Namen des Arbeitgebers eingeben." };
  if (data.company_number && !/^\d{8}$/.test(data.company_number)) {
    return { error: "Die Betriebsnummer hat 8 Ziffern." };
  }
  return { data };
}

function parseEmployeeProfile(body) {
  const optionalDate = key => {
    const value = cleanText(body?.[key], 10);
    return value && validDate(value) ? value : value ? false : null;
  };
  const data = {
    full_name: cleanText(body?.full_name, 120),
    personnel_number: cleanText(body?.personnel_number, 30),
    street: cleanText(body?.street, 120),
    zip_city: cleanText(body?.zip_city, 120),
    birth_date: optionalDate("birth_date"),
    insurance_number: cleanText(String(body?.insurance_number ?? "").replace(/\s/g, "").toUpperCase(), 12),
    tax_id: cleanText(String(body?.tax_id ?? "").replace(/\D/g, ""), 11),
    health_insurance: cleanText(body?.health_insurance, 120),
    iban: cleanText(String(body?.iban ?? "").replace(/\s/g, "").toUpperCase(), 34),
    start_date: optionalDate("start_date"),
    end_date: optionalDate("end_date"),
    nationality: cleanText(body?.nationality, 60),
    activity_key: cleanText(String(body?.activity_key ?? "").replace(/\s/g, ""), 9),
    other_employment: ["none", "minijob", "main"].includes(body?.other_employment) ? body.other_employment : null,
    registered_at: optionalDate("registered_at")
  };
  if (!data.full_name) return { error: "Bitte den vollständigen Namen eingeben." };
  if (data.activity_key && !/^\d{9}$/.test(data.activity_key)) {
    return { error: "Der Tätigkeitsschlüssel hat 9 Ziffern." };
  }
  if ([data.birth_date, data.start_date, data.end_date, data.registered_at].includes(false)) {
    return { error: "Bitte gültige Datumsangaben eingeben." };
  }
  if (data.insurance_number && !/^\d{8}[A-Z]\d{3}$/.test(data.insurance_number)) {
    return { error: "Die Rentenversicherungsnummer hat das Format 12 345678 A 123." };
  }
  if (data.tax_id && !/^\d{11}$/.test(data.tax_id)) {
    return { error: "Die Steuer-ID besteht aus 11 Ziffern." };
  }
  if (data.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(data.iban)) {
    return { error: "Bitte eine gültige IBAN eingeben." };
  }
  if (data.start_date && data.end_date && data.end_date < data.start_date) {
    return { error: "Das Austrittsdatum liegt vor dem Eintrittsdatum." };
  }
  return { data };
}

async function getEmployer({ env }) {
  await ensureMasterColumns(env);
  return json(mapEmployer(await first(env, "SELECT * FROM office_employer WHERE id = 1")));
}

async function updateEmployer(ctx) {
  const { error, data } = parseEmployer(await readJson(ctx.request));
  if (error) return err(error);
  await ensureMasterColumns(ctx.env);
  await run(ctx.env,
    `INSERT INTO office_employer (id, ${EMPLOYER_FIELDS.join(", ")}, updated_at)
     VALUES (1, ${qs(EMPLOYER_FIELDS.length)}, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       ${EMPLOYER_FIELDS.map(f => `${f} = excluded.${f}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
    ...EMPLOYER_FIELDS.map(f => data[f]));
  return getEmployer(ctx);
}

async function getEmployeeProfile({ env, owner }) {
  await ensureMasterColumns(env);
  return json(mapEmployeeProfile(
    await first(env, "SELECT * FROM employee_profiles WHERE clerk_user_id = ?", owner)));
}

async function updateEmployeeProfile(ctx) {
  const { error, data } = parseEmployeeProfile(await readJson(ctx.request));
  if (error) return err(error);
  await ensureMasterColumns(ctx.env);
  await run(ctx.env,
    `INSERT INTO employee_profiles (clerk_user_id, ${EMPLOYEE_FIELDS.join(", ")}, updated_at)
     VALUES (?, ${qs(EMPLOYEE_FIELDS.length)}, CURRENT_TIMESTAMP)
     ON CONFLICT(clerk_user_id) DO UPDATE SET
       ${EMPLOYEE_FIELDS.map(f => `${f} = excluded.${f}`).join(", ")},
       updated_at = CURRENT_TIMESTAMP`,
    ctx.owner, ...EMPLOYEE_FIELDS.map(f => data[f]));
  return getEmployeeProfile(ctx);
}

/* ================= Abwesenheiten & Urlaub ================= */

const ABSENCE_COLS = [
  "id", "clerk_user_id", "absence_date", "absence_type",
  "paid_minutes", "paid_amount_cents", "note", "created_at", "updated_at"
];

function parseAbsenceBody(body) {
  const date = String(body?.absence_date || "").trim();
  const type = String(body?.absence_type || "").trim();
  const paidMinutes = nonNegInt(body?.paid_minutes);
  const paidAmountCents = nonNegInt(body?.paid_amount_cents);
  const note = cleanText(body?.note, 240);

  if (!validDate(date)) return { error: "Bitte ein gültiges Abwesenheitsdatum eingeben." };
  if (!ABSENCE_TYPES.includes(type)) return { error: "Unbekannte Abwesenheitsart." };
  if (paidMinutes > 24 * 60) return { error: "Bezahlte Stunden können pro Tag höchstens 24 Stunden betragen." };
  if (paidAmountCents > 10000000) return { error: "Entgeltfortzahlung ist unplausibel hoch." };
  return { values: [date, type, paidMinutes, paidAmountCents, note] };
}

async function listAbsences({ env, owner }) {
  return json(await all(env,
    `SELECT ${ABSENCE_COLS.join(", ")} FROM employee_absences
     WHERE clerk_user_id = ? ORDER BY absence_date DESC, id DESC`, owner));
}

async function ensureNoWorkOnAbsenceDate(env, owner, date, ignoreId = null) {
  const work = await first(env,
    "SELECT id FROM work_entries WHERE clerk_user_id = ? AND work_date = ? LIMIT 1", owner, date);
  if (work) return "Für diesen Tag ist bereits Arbeitszeit erfasst. Ein voller Abwesenheitstag kann nicht gleichzeitig ein Arbeitstag sein.";
  const duplicate = await first(env,
    `SELECT id FROM employee_absences WHERE clerk_user_id = ? AND absence_date = ? ${ignoreId ? "AND id <> ?" : ""} LIMIT 1`,
    ...(ignoreId ? [owner, date, ignoreId] : [owner, date]));
  if (duplicate) return "Für diesen Tag ist bereits eine Abwesenheit erfasst.";
  return null;
}

async function createAbsence({ request, env, owner }) {
  const parsed = parseAbsenceBody(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [date, type, paidMinutes, paidAmountCents, note] = parsed.values;
  const conflict = await ensureNoWorkOnAbsenceDate(env, owner, date);
  if (conflict) return err(conflict);

  const result = await run(env,
    `INSERT INTO employee_absences
       (clerk_user_id, absence_date, absence_type, paid_minutes, paid_amount_cents, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    owner, date, type, paidMinutes, paidAmountCents, note);
  return created(result);
}

async function updateAbsence({ request, env, owner, id }) {
  const parsed = parseAbsenceBody(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [date, type, paidMinutes, paidAmountCents, note] = parsed.values;
  const exists = await first(env,
    "SELECT id FROM employee_absences WHERE id = ? AND clerk_user_id = ?", id, owner);
  if (!exists) return err("Abwesenheit nicht gefunden.", 404);
  const conflict = await ensureNoWorkOnAbsenceDate(env, owner, date, id);
  if (conflict) return err(conflict);

  return changed(await run(env,
    `UPDATE employee_absences
     SET absence_date = ?, absence_type = ?, paid_minutes = ?, paid_amount_cents = ?, note = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND clerk_user_id = ?`,
    date, type, paidMinutes, paidAmountCents, note, id, owner), "Abwesenheit nicht gefunden.");
}

const deleteAbsence = async ({ env, owner, id }) =>
  changed(await run(env,
    "DELETE FROM employee_absences WHERE id = ? AND clerk_user_id = ?", id, owner),
    "Abwesenheit nicht gefunden.");

function absenceTotals(rows = []) {
  const count = type => rows.filter(r => r.absence_type === type).length;
  const money = type => rows.filter(r => r.absence_type === type)
    .reduce((sum, r) => sum + Number(r.paid_amount_cents || 0), 0);
  return {
    paidMinutes: rows.reduce((sum, r) => sum + Number(r.paid_minutes || 0), 0),
    vacationDays: count("vacation"),
    sickDays: count("sick"),
    holidayDays: count("holiday"),
    paidLeaveDays: count("paid_leave"),
    vacationPay: money("vacation"),
    sickPay: money("sick"),
    holidayPay: money("holiday"),
    paidLeavePay: money("paid_leave")
  };
}

function roundVacation(value) {
  const safe = Math.max(0, Number(value) || 0);
  const whole = Math.floor(safe);
  const fraction = safe - whole;
  return fraction >= 0.5 ? whole + 1 : Math.round(safe * 100) / 100;
}

function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// Volle Beschäftigungsmonate: 01.10.–31.10. ist ein voller Monat (§ 5 BUrlG)
function fullMonthsBetween(start, end) {
  if (!start || !end || end < start) return 0;
  const next = new Date(`${end}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = next.toISOString().slice(0, 10).split("-").map(Number);
  let months = (ey - sy) * 12 + (em - sm);
  if (ed < sd) months -= 1;
  return Math.max(0, months);
}

function calculateVacationStats({ workDates = [], absences = [], employment = {}, month }) {
  const year = Number(month.slice(0, 4));
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const asOf = [monthEnd(month), employment.end_date || yearEnd, yearEnd].sort()[0];
  const activeStart = employment.start_date && employment.start_date > yearStart ? employment.start_date : yearStart;

  const worked = new Set(workDates.filter(d => d >= activeStart && d <= asOf));
  const relevantAbsences = absences.filter(a => a.absence_date >= activeStart && a.absence_date <= asOf);
  const equivalent = new Set([...worked, ...relevantAbsences.map(a => a.absence_date)]);

  const activeDays = asOf >= activeStart
    ? Math.max(7, Math.round((Date.parse(asOf) - Date.parse(activeStart)) / 86400000) + 1)
    : 7;
  const avgWorkdaysPerWeek = Math.min(6, equivalent.size / activeDays * 7);
  const annualBase = Math.min(24, avgWorkdaysPerWeek * 4);

  let entitlementFactor = 1;
  if (employment.start_date && employment.start_date >= yearStart) {
    const months = fullMonthsBetween(employment.start_date, asOf);
    if (months < 6) entitlementFactor = Math.min(1, months / 12);
  }
  if (employment.end_date && employment.end_date <= `${year}-06-30`) {
    const from = employment.start_date && employment.start_date > yearStart ? employment.start_date : yearStart;
    entitlementFactor = Math.min(entitlementFactor, fullMonthsBetween(from, employment.end_date) / 12);
  }

  const entitlement = roundVacation(annualBase * entitlementFactor);
  const taken = new Set(relevantAbsences.filter(a => a.absence_type === "vacation").map(a => a.absence_date)).size;
  return {
    year,
    asOf,
    workedDays: worked.size,
    equivalentDays: equivalent.size,
    averageWorkdaysPerWeek: Math.round(avgWorkdaysPerWeek * 100) / 100,
    entitlement,
    taken,
    remaining: Math.round((entitlement - taken) * 100) / 100,
    provisional: asOf < yearEnd && (!employment.end_date || employment.end_date > asOf)
  };
}

function mondayOfWeek(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

function isoWeekLabel(weekStart) {
  const monday = new Date(`${weekStart}T12:00:00Z`);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4, 12));
  const jan4Day = jan4.getUTCDay() || 7;
  const firstMonday = new Date(jan4);
  firstMonday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const week = 1 + Math.round((monday - firstMonday) / 604800000);
  return `KW ${week}/${year}`;
}

function weeklyWorkdayWarnings(entries = [], month = null) {
  const weeks = new Map();
  entries.forEach(entry => {
    const date = entry?.work_date;
    if (!date) return;
    const weekStart = mondayOfWeek(date);
    if (!weeks.has(weekStart)) weeks.set(weekStart, new Set());
    weeks.get(weekStart).add(date);
  });
  return [...weeks.entries()]
    .map(([weekStart, dates]) => ({
      weekStart,
      label: isoWeekLabel(weekStart),
      days: dates.size,
      dates: [...dates].sort()
    }))
    .filter(row => row.days > CONTRACT_MAX_WORKDAYS_PER_WEEK)
    .filter(row => !month || row.dates.some(date => date.slice(0, 7) === month))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

/* ================= Monatsabschlüsse ================= */

const MINIJOB_LIMIT_CENTS = 60300;       // Geringfügigkeitsgrenze 2026 je Monat
const minijobLimitCents = month => (String(month || "") >= "2027-01" ? 63300 : MINIJOB_LIMIT_CENTS);
const RV_MIN_BASE_CENTS = 17500;         // Mindestbeitragsbemessungsgrundlage (§ 163 Abs. 8 SGB VI)
const RV_FULL_RATE = 0.186;
const RV_EMPLOYER_RATE = 0.15;
const RV_EMPLOYEE_RATE = 0.036;

const EMPLOYER_RATES = {
  employerKv: p => (p.employerKv ? 0.13 : 0),
  employerRv: p => (p.employerRv ? RV_EMPLOYER_RATE : 0),
  u1: p => (p.u1 ? 0.008 : 0),
  u2: p => (p.u2 ? 0.0022 : 0),
  insolvency: p => (p.insolvency ? 0.0015 : 0),
  employerFlatTax: p => (p.flatTax && !p.flatTaxEmployee ? 0.02 : 0),
  accident: p => (p.accident ? accidentRatePercent(p) / 100 : 0)
};
// BG-Satz: der genaue Satz hat Vorrang, sonst die Schätzung
const accidentRatePercent = p => (Number(p.accidentRate) > 0 ? Number(p.accidentRate) : Number(p.accidentRateEstimate || 0));

// Sozialversicherungstage im Monat: voller Monat = 30, sonst Kalendertage der Beschäftigung
function insuredDays(month, start, end) {
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth).padStart(2, "0")}`;
  const from = start && start > first ? start : first;
  const to = end && end < last ? end : last;
  if (to < from) return 0;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return days >= daysInMonth ? 30 : Math.min(30, days);
}

const contributionGroup = p => `${p.employerKv ? "6" : "0"}${p.employeeRv ? "1" : "5"}00`;

// Arbeitsstunden × Stundenlohn + alle gesetzten Termine × Terminvergütung
function calculatePayroll({ month, mins, days, appts, profile, employment = {}, absences = [], goalHours = 24 }) {
  const timePay = Math.round((mins * hourlyRateCents(month)) / 60);
  const commission = appts * COMMISSION_RATE_CENTS;
  const absence = absenceTotals(absences);
  const targetBonus = 0;
  const absencePay = absence.vacationPay + absence.sickPay + absence.holidayPay + absence.paidLeavePay;
  const gross = timePay + commission + targetBonus + absencePay;
  const svDays = insuredDays(month, employment.start_date, employment.end_date);

  // RV-Eigenanteil – unter 175 € (anteilig bei Teilmonat) gilt der Mindestbeitrag:
  // 18,6 % der Mindestbemessung abzüglich 15 % Arbeitgeberanteil vom tatsächlichen Entgelt.
  let employeeRv = 0;
  let rvMinBase = 0;
  if (profile.employeeRv && gross > 0) {
    const base = Math.round((RV_MIN_BASE_CENTS * svDays) / 30);
    if (profile.rvMinBaseApplies && gross < base) rvMinBase = base;
    employeeRv = Math.max(0, Math.round((rvMinBase || gross) * RV_FULL_RATE) - Math.round(gross * RV_EMPLOYER_RATE));
  }
  const employee = {
    employeeRv,
    employeeFlatTax: profile.flatTax && profile.flatTaxEmployee ? Math.round(gross * 0.02) : 0
  };

  const employer = Object.fromEntries(
    Object.entries(EMPLOYER_RATES).map(([k, rate]) => [k, Math.round(gross * rate(profile))])
  );
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  const employeeDeductions = sum(employee);
  const employerContributions = sum(employer);

  const cents = {
    timePay, commission, targetBonus,
    vacationPay: absence.vacationPay, sickPay: absence.sickPay,
    holidayPay: absence.holidayPay, paidLeavePay: absence.paidLeavePay,
    absencePay, gross,
    ...employee, employeeDeductions,
    net: gross - employeeDeductions,
    ...employer, employerContributions,
    employerCost: gross + employerContributions,
    rvMinBase
  };

  const euros = Object.fromEntries(Object.entries(cents).map(([k, v]) => [k, v / 100]));
  return {
    cents,
    payroll: {
      // „eligible" = vergütete Termine; der Name bleibt, weil ältere Abschlüsse ihn verwenden.
      mins, days, appts, eligible: appts,
      goalMinutes: Math.round(Number(goalHours || 24) * 60),
      paidMinutes: absence.paidMinutes,
      overtimeMinutes: 0,
      vacationDays: absence.vacationDays,
      sickDays: absence.sickDays,
      holidayDays: absence.holidayDays,
      paidLeaveDays: absence.paidLeaveDays,
      svDays,
      taxDays: profile.flatTax ? null : svDays,
      contributionGroup: contributionGroup(profile),
      ...euros
    }
  };
}

/* ================= Termin-Korrekturen (Boss) =================
 * Sagt ein Kunde rechtzeitig ab (ohne neuen Termin), darf der Boss den Termin abziehen –
 * je Klick genau ±1, mit Zeitpunkt. Erscheint als eigene Zeile im Gehaltsnachweis.
 * Die Tabelle legt der Worker beim ersten Zugriff selbst an – kein SQL nötig.
 */
let adjustmentsReady = false;
async function ensureAdjustments(env) {
  if (adjustmentsReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS appointment_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clerk_user_id TEXT NOT NULL,
    payroll_month TEXT NOT NULL,
    delta INTEGER NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  adjustmentsReady = true;
}

async function adjustmentRows(env, userId, month) {
  await ensureAdjustments(env);
  return month
    ? all(env, `SELECT id, payroll_month, delta, note, created_at FROM appointment_adjustments
                WHERE clerk_user_id = ? AND payroll_month = ? ORDER BY id`, userId, month)
    : all(env, `SELECT id, payroll_month, delta, note, created_at FROM appointment_adjustments
                WHERE clerk_user_id = ? ORDER BY id`, userId);
}
const adjustmentSum = rows => rows.reduce((sum, r) => sum + Number(r.delta || 0), 0);

async function listAdjustments({ env, owner, url }) {
  const month = url.searchParams.get("month");
  return json(await adjustmentRows(env, owner, validMonth(month) ? month : null));
}

async function createAdjustment({ request, env, owner, userId }) {
  const body = (await readJson(request)) || {};
  const month = String(body.month || "");
  const delta = Number(body.delta);
  if (!validMonth(month)) return err("Ungültiger Monat.");
  if (delta !== 1 && delta !== -1) return err("Termine lassen sich nur einzeln korrigieren.");
  if (isBoss(env, owner)) return err("Bitte einen Mitarbeiter auswählen.");

  const closed = await first(env,
    "SELECT id FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?", owner, month);
  if (closed) return err("Der Monat ist bereits abgeschlossen – Termine lassen sich nicht mehr ändern.", 409);

  const perf = await first(env,
    `SELECT COALESCE(SUM(appointments), 0) AS appts FROM performance_entries
     WHERE clerk_user_id = ? AND substr(work_date, 1, 7) = ?`, owner, month);
  const current = adjustmentSum(await adjustmentRows(env, owner, month));
  if (delta < 0 && Number(perf?.appts || 0) + current + delta < 0) {
    return err("Weniger als 0 Termine geht nicht.");
  }
  if (delta > 0 && current + delta > 0) {
    return err("Mehr Termine, als erfasst wurden, lassen sich nicht hinzufügen – „+“ nimmt nur einen Abzug zurück.");
  }
  const note = String(body.note || "").trim().slice(0, 200) ||
    (delta < 0 ? "Kunde hat rechtzeitig abgesagt" : "Abzug zurückgenommen");
  return created(await run(env,
    `INSERT INTO appointment_adjustments (clerk_user_id, payroll_month, delta, note, created_by)
     VALUES (?, ?, ?, ?, ?)`, owner, month, delta, note, userId));
}

async function listOwnAdjustments({ env, userId, url }) {
  const month = url.searchParams.get("month");
  return json(await adjustmentRows(env, userId, validMonth(month) ? month : null));
}

// Brutto je Monat für die letzten 12 Monate (inkl. Abrechnungsmonat).
// Abgeschlossene Monate zählen mit ihrem abgerechneten Brutto, offene mit dem aktuellen Stand.
async function rollingYear(env, userId, month) {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 12, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

  await ensureAdjustments(env);
  const [work, perf, absence, closed, adjust] = await Promise.all([
    all(env,
      `SELECT substr(work_date, 1, 7) AS month, SUM(work_minutes) AS mins
       FROM work_entries WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ?
       GROUP BY month`, userId, from, to),
    all(env,
      `SELECT substr(work_date, 1, 7) AS month, SUM(appointments) AS appts
       FROM performance_entries WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ?
       GROUP BY month`, userId, from, to),
    all(env,
      `SELECT substr(absence_date, 1, 7) AS month, SUM(paid_amount_cents) AS paid
       FROM employee_absences WHERE clerk_user_id = ? AND absence_date >= ? AND absence_date < ?
       GROUP BY month`, userId, from, to),
    all(env,
      `SELECT payroll_month AS month, gross_cents FROM monthly_closings
       WHERE clerk_user_id = ? AND payroll_month >= ? AND payroll_month < ?`,
      userId, from.slice(0, 7), to.slice(0, 7)),
    all(env,
      `SELECT payroll_month AS month, SUM(delta) AS delta FROM appointment_adjustments
       WHERE clerk_user_id = ? AND payroll_month >= ? AND payroll_month < ?
       GROUP BY payroll_month`,
      userId, from.slice(0, 7), to.slice(0, 7))
  ]);

  const months = {};
  work.forEach(r => (months[r.month] = (months[r.month] || 0) + Math.round((Number(r.mins) * hourlyRateCents(r.month)) / 60)));
  perf.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.appts) * COMMISSION_RATE_CENTS));
  absence.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.paid || 0)));
  adjust.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.delta || 0) * COMMISSION_RATE_CENTS));
  closed.forEach(r => (months[r.month] = Number(r.gross_cents || 0)));

  const values = Object.values(months);
  return {
    from: from.slice(0, 7),
    to: month,
    gross: values.reduce((a, b) => a + b, 0) / 100,
    limit: (minijobLimitCents(month) * 12) / 100,
    monthsOver: Object.entries(months).filter(([m, v]) => v > minijobLimitCents(m)).length
  };
}

function previousMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

function monthClosingAllowed(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  const today = berlinToday();
  const current = today.slice(0, 7);
  if (month >= current) return false;
  // Vormonat erst ab dem 8. abschließbar (7-tägige Korrekturfrist)
  return month !== previousMonth(current) || Number(today.slice(8, 10)) >= 8;
}

// Monat vorbei (ab dem letzten Tag des Monats) – für den Abschluss auf Bestätigung der Mitarbeiterin
function monthOver(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return false;
  return berlinToday() >= monthEnd(month);
}

const CLOSING_MONEY_FIELDS = [
  "gross", "employee_deductions", "net", "employer_contributions", "employer_cost"
];

function safeParse(text) {
  try { return JSON.parse(text || "null"); } catch { return null; }
}

async function getMonthlyClosings({ env, owner }) {
  const rows = await all(env,
    `SELECT id, clerk_user_id, payroll_month, work_minutes, work_days, appointments,
            commissionable_appointments, gross_cents, employee_deductions_cents, net_cents,
            employer_contributions_cents, employer_cost_cents, snapshot_json, closed_by, closed_at
     FROM monthly_closings WHERE clerk_user_id = ? ORDER BY payroll_month DESC`,
    owner);

  return json(rows.map(row => ({
    ...row,
    ...Object.fromEntries(
      CLOSING_MONEY_FIELDS.map(k => [k, Number(row[`${k}_cents`] || 0) / 100])
    ),
    snapshot: safeParse(row.snapshot_json)
  })));
}

async function createMonthlyClosing({ request, env, userId, owner, exec, confirmedByEmployee = false }) {
  const body = (await readJson(request)) || {};
  const month = String(body.month || "").trim();

  if (confirmedByEmployee ? !monthOver(month) : !monthClosingAllowed(month)) {
    return err("Der Monat kann erst nach Ablauf der 7-tägigen Korrekturfrist abgeschlossen werden.");
  }

  const existing = await first(env,
    "SELECT id FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?",
    owner, month);
  if (existing) return ok({ already_exists: true, id: existing.id });

  const [work, perf, absences, settings, officeSettings, member, employee, employer, entries, yearWorkDates, yearAbsences, year] = await Promise.all([
    first(env,
      `SELECT COALESCE(SUM(work_minutes), 0) AS mins, COUNT(DISTINCT work_date) AS days, COUNT(*) AS n
       FROM work_entries WHERE clerk_user_id = ? AND substr(work_date, 1, 7) = ?`,
      owner, month),
    first(env,
      `SELECT COALESCE(SUM(appointments), 0) AS appts, COUNT(*) AS n
       FROM performance_entries WHERE clerk_user_id = ? AND substr(work_date, 1, 7) = ?`,
      owner, month),
    all(env,
      `SELECT ${ABSENCE_COLS.join(", ")} FROM employee_absences
       WHERE clerk_user_id = ? AND substr(absence_date, 1, 7) = ? ORDER BY absence_date`,
      owner, month),
    first(env, "SELECT * FROM payroll_settings WHERE clerk_user_id = ?", owner),
    first(env, "SELECT * FROM office_settings WHERE id = 1"),
    first(env, "SELECT display_name, email FROM office_members WHERE clerk_user_id = ?", owner),
    first(env, "SELECT * FROM employee_profiles WHERE clerk_user_id = ?", owner).catch(() => null),
    first(env, "SELECT * FROM office_employer WHERE id = 1").catch(() => null),
    all(env,
      `SELECT w.work_date, w.start_time, w.end_time, w.break_minutes, w.work_minutes,
              COALESCE(p.appointments, 0) AS appointments
       FROM work_entries w
       LEFT JOIN performance_entries p ON p.work_entry_id = w.id
       WHERE w.clerk_user_id = ? AND substr(w.work_date, 1, 7) = ?
       ORDER BY w.work_date, w.start_time`,
      owner, month),
    all(env,
      `SELECT DISTINCT work_date FROM work_entries
       WHERE clerk_user_id = ? AND substr(work_date, 1, 4) = ? AND work_date <= ?`,
      owner, month.slice(0, 4), monthEnd(month)),
    all(env,
      `SELECT ${ABSENCE_COLS.join(", ")} FROM employee_absences
       WHERE clerk_user_id = ? AND substr(absence_date, 1, 4) = ? AND absence_date <= ?`,
      owner, month.slice(0, 4), monthEnd(month)),
    rollingYear(env, owner, month)
  ]);

  if (!Number(work?.n || 0) && !Number(perf?.n || 0) && !absences.length) {
    return ok({ skipped: true, reason: "NO_DATA" });
  }

  const adjustments = await adjustmentRows(env, owner, month);
  const apptAdjust = adjustmentSum(adjustments);

  const profile = mapPayrollSettings(settings, owner);
  const { cents, payroll } = calculatePayroll({
    month,
    mins: Number(work?.mins || 0),
    days: Number(work?.days || 0),
    appts: Math.max(0, Number(perf?.appts || 0) + apptAdjust),
    profile,
    employment: employee || {},
    absences,
    goalHours: Number(officeSettings?.goal_hours || SETTINGS_DEFAULTS.goalHours)
  });

  const snapshot = {
    employeeName: member?.display_name || member?.email || owner,
    month,
    monthLabel: new Intl.DateTimeFormat("de-DE", {
      timeZone: "Europe/Berlin", month: "long", year: "numeric"
    }).format(new Date(`${month}-15T00:00:00Z`)),
    profile,
    payroll: { ...payroll, entryAppts: Number(perf?.appts || 0), apptAdjust },
    adjustments,
    note: String(body.note || "").trim().slice(0, 180),
    paymentDate: validDate(body.payment_date) ? body.payment_date : null,
    hourlyRate: hourlyRateCents(month) / 100,
    commissionRate: COMMISSION_RATE_CENTS / 100,
    created: berlinToday(),
    // eingefroren zum Abschlusszeitpunkt:
    employer: mapEmployer(employer),
    employee: mapEmployeeProfile(employee),
    entries,
    absences,
    vacation: calculateVacationStats({
      workDates: yearWorkDates.map(r => r.work_date),
      absences: yearAbsences,
      employment: employee || {},
      month
    }),
    contract: {
      weeklyHours: CONTRACT_WEEKLY_HOURS,
      maxWorkdaysPerWeek: CONTRACT_MAX_WORKDAYS_PER_WEEK,
      // Reiner Hinweis: Ein 4. Tag wird weder blockiert noch aus Berechnungen entfernt.
      workdayWarnings: weeklyWorkdayWarnings(yearWorkDates, month)
    },
    year
  };

  const result = await run(env,
    `INSERT INTO monthly_closings (
       clerk_user_id, payroll_month, work_minutes, work_days, appointments,
       commissionable_appointments, hourly_rate_cents, commission_rate_cents,
       gross_cents, employee_deductions_cents, net_cents,
       employer_contributions_cents, employer_cost_cents, snapshot_json, closed_by
     ) VALUES (${qs(15)})`,
    owner, month, payroll.mins, payroll.days, payroll.appts, payroll.eligible,
    hourlyRateCents(month), COMMISSION_RATE_CENTS,
    cents.gross, cents.employeeDeductions, cents.net,
    cents.employerContributions, cents.employerCost,
    JSON.stringify(snapshot), userId);

  // Falls für den Monat bereits ein Beitragsnachweis existiert, nach dem
  // Monatsabschluss automatisch Ist-Beitrag und Differenz nachziehen.
  await syncContributionReportActual(env, owner, month, cents.gross, profile, payroll.svDays);

  if (exec && !confirmedByEmployee) await runLater(exec, notifyUser(env, owner, {
    title: `Dein Gehaltsnachweis für ${snapshot.monthLabel} ist da`,
    body: "Bitte unter „Mehr“ → „Meine Unterlagen“ ansehen und mit deiner Unterschrift den Empfang und deine Arbeitszeiten bestätigen.",
    tag: `payslip-${month}`,
    url: hrUrl("vertrag")
  }));

  return ok({ id: result.meta?.last_row_id, snapshot }, 201);
}


/* ================= Beitragsnachweis Minijob-Zentrale ================= */

/*
 * SmartADM Office bereitet den monatlichen Beitragsnachweis vor.
 * Die eigentliche Übermittlung erfolgt weiterhin im SV-Meldeportal.
 *
 * Der Beitragsnachweis ist nicht personenbezogen; da Office aktuell je
 * Mitarbeiter rechnet, werden die Datensätze hier pro Mitarbeiter/Monat
 * gespeichert. Falls später mehrere Minijobber unter derselben Betriebsnummer
 * beschäftigt werden, kann die Oberfläche die Werte vor der Übertragung
 * zusätzlich summieren.
 */

const CONTRIBUTION_STATUSES = ["draft", "submitted", "paid"];

const CONTRIBUTION_DUE_DATES_2026 = {
  "2026-01": ["2026-01-25", "2026-01-28"],
  "2026-02": ["2026-02-22", "2026-02-25"],
  "2026-03": ["2026-03-24", "2026-03-27"],
  "2026-04": ["2026-04-23", "2026-04-28"],
  "2026-05": ["2026-05-21", "2026-05-27"],
  "2026-06": ["2026-06-23", "2026-06-26"],
  "2026-07": ["2026-07-26", "2026-07-29"],
  "2026-08": ["2026-08-24", "2026-08-27"],
  "2026-09": ["2026-09-23", "2026-09-28"],
  "2026-10": ["2026-10-25", "2026-10-28"],
  "2026-11": ["2026-11-23", "2026-11-26"],
  "2026-12": ["2026-12-21", "2026-12-28"]
};

const validMonth = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ""));

// Bundesweite Feiertage + 24./31.12. sind keine Bankarbeitstage
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}
function bankHolidays(y) {
  const iso = t => new Date(t).toISOString().slice(0, 10), e = easterSunday(y), d = 86400000;
  return new Set([`${y}-01-01`, iso(e - 2 * d), iso(e + d), `${y}-05-01`, iso(e + 39 * d), iso(e + 50 * d),
    `${y}-10-03`, `${y}-12-24`, `${y}-12-25`, `${y}-12-26`, `${y}-12-31`]);
}
// Beiträge fällig am drittletzten, Beitragsnachweis bis Beginn des fünftletzten Bankarbeitstags (§ 23 SGB IV)
function contributionDueDates(month) {
  const pair = CONTRIBUTION_DUE_DATES_2026[month];
  if (pair) return { submissionDueDate: pair[0], paymentDueDate: pair[1] };
  if (!validMonth(month)) return { submissionDueDate: null, paymentDueDate: null };
  const [y, m] = month.split("-").map(Number);
  const holidays = bankHolidays(y);
  const bankDays = [];
  for (let day = new Date(Date.UTC(y, m, 0)).getUTCDate(); day >= 1 && bankDays.length < 5; day--) {
    const t = new Date(Date.UTC(y, m - 1, day));
    const iso = t.toISOString().slice(0, 10);
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6 && !holidays.has(iso)) bankDays.push(iso);
  }
  const before = new Date(`${bankDays[4]}T12:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  return { submissionDueDate: before.toISOString().slice(0, 10), paymentDueDate: bankDays[2] };
}

function calculateMinijobContributions(grossCents, profile, svDays = 30) {
  const gross = nonNegInt(grossCents);
  const days = Math.max(0, Math.min(30, nonNegInt(svDays, 30) || 30));

  const kv = profile.employerKv ? Math.round(gross * 0.13) : 0;
  const rvEmployer = profile.employerRv ? Math.round(gross * RV_EMPLOYER_RATE) : 0;

  // Arbeitnehmer-RV nur bei bestehender Versicherungspflicht.
  // Bei Befreiung (employeeRv = false) bleibt sie 0; der AG-Anteil bleibt bestehen.
  let rvEmployee = 0;
  let rvMinBase = 0;
  if (profile.employeeRv && gross > 0) {
    const base = Math.round((RV_MIN_BASE_CENTS * days) / 30);
    if (profile.rvMinBaseApplies && gross < base) rvMinBase = base;
    rvEmployee = Math.max(0, Math.round((rvMinBase || gross) * RV_FULL_RATE) - Math.round(gross * RV_EMPLOYER_RATE));
  }

  const rv = rvEmployer + rvEmployee;
  const u1 = profile.u1 ? Math.round(gross * 0.008) : 0;
  const u2 = profile.u2 ? Math.round(gross * 0.0022) : 0;
  const insolvency = profile.insolvency ? Math.round(gross * 0.0015) : 0;

  // Die 2-%-Pauschsteuer wird an die Minijob-Zentrale abgeführt – unabhängig
  // davon, ob der Arbeitgeber sie wirtschaftlich trägt oder vom Lohn einbehält.
  const flatTax = profile.flatTax ? Math.round(gross * 0.02) : 0;

  // Unfallversicherung/BG gehört nicht in den Beitragsnachweis der Minijob-Zentrale.
  const total = kv + rv + u1 + u2 + insolvency + flatTax;

  return {
    gross_cents: gross,
    kv_cents: kv,
    rv_employer_cents: rvEmployer,
    rv_employee_cents: rvEmployee,
    rv_cents: rv,
    u1_cents: u1,
    u2_cents: u2,
    insolvency_cents: insolvency,
    flat_tax_cents: flatTax,
    total_cents: total,
    rv_min_base_cents: rvMinBase
  };
}

const CONTRIBUTION_SELECT = `
  SELECT
    id, clerk_user_id, payroll_month,
    estimated_gross_cents,
    kv_cents, rv_employer_cents, rv_employee_cents, rv_cents,
    u1_cents, u2_cents, insolvency_cents, flat_tax_cents,
    reported_total_cents, prior_correction_cents, amount_due_cents,
    actual_gross_cents, actual_total_cents, correction_cents,
    submission_due_date, payment_due_date,
    status, submitted_at, paid_at, note, snapshot_json,
    created_by, created_at, updated_at
  FROM minijob_contribution_reports`;

function mapContributionReport(row) {
  if (!row) return null;
  return {
    ...row,
    estimated_gross: Number(row.estimated_gross_cents || 0) / 100,
    kv: Number(row.kv_cents || 0) / 100,
    rv_employer: Number(row.rv_employer_cents || 0) / 100,
    rv_employee: Number(row.rv_employee_cents || 0) / 100,
    rv: Number(row.rv_cents || 0) / 100,
    u1: Number(row.u1_cents || 0) / 100,
    u2: Number(row.u2_cents || 0) / 100,
    insolvency: Number(row.insolvency_cents || 0) / 100,
    flat_tax: Number(row.flat_tax_cents || 0) / 100,
    reported_total: Number(row.reported_total_cents || 0) / 100,
    prior_correction: Number(row.prior_correction_cents || 0) / 100,
    amount_due: Number(row.amount_due_cents || 0) / 100,
    actual_gross: row.actual_gross_cents == null ? null : Number(row.actual_gross_cents) / 100,
    actual_total: row.actual_total_cents == null ? null : Number(row.actual_total_cents) / 100,
    correction: Number(row.correction_cents || 0) / 100,
    snapshot: safeParse(row.snapshot_json)
  };
}

let contributionReady = false;
async function ensureContributionReports(env) {
  if (contributionReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS minijob_contribution_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clerk_user_id TEXT NOT NULL,
    payroll_month TEXT NOT NULL,
    estimated_gross_cents INTEGER NOT NULL DEFAULT 0,
    kv_cents INTEGER NOT NULL DEFAULT 0,
    rv_employer_cents INTEGER NOT NULL DEFAULT 0,
    rv_employee_cents INTEGER NOT NULL DEFAULT 0,
    rv_cents INTEGER NOT NULL DEFAULT 0,
    u1_cents INTEGER NOT NULL DEFAULT 0,
    u2_cents INTEGER NOT NULL DEFAULT 0,
    insolvency_cents INTEGER NOT NULL DEFAULT 0,
    flat_tax_cents INTEGER NOT NULL DEFAULT 0,
    reported_total_cents INTEGER NOT NULL DEFAULT 0,
    prior_correction_cents INTEGER NOT NULL DEFAULT 0,
    amount_due_cents INTEGER NOT NULL DEFAULT 0,
    actual_gross_cents INTEGER,
    actual_total_cents INTEGER,
    correction_cents INTEGER NOT NULL DEFAULT 0,
    submission_due_date TEXT,
    payment_due_date TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    submitted_at TEXT,
    paid_at TEXT,
    note TEXT,
    snapshot_json TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (clerk_user_id, payroll_month))`);
  contributionReady = true;
}

async function getContributionReports({ env, owner }) {
  await ensureContributionReports(env);
  const rows = await all(env,
    `${CONTRIBUTION_SELECT}
     WHERE clerk_user_id = ?
     ORDER BY payroll_month DESC`,
    owner);
  return json(rows.map(mapContributionReport));
}

async function contributionProfile(env, owner) {
  const settings = await first(env,
    "SELECT * FROM payroll_settings WHERE clerk_user_id = ?", owner);
  return mapPayrollSettings(settings, owner);
}

// Portalbeträge werden in Cent je Beitragsgruppe eingefroren. Eine Restschuld
// gehört im Folgemonat in dieselbe Beitragsgruppe, nicht nur in die Zahlungssumme.
function contributionFields(c, profile) {
  return { "6000": c.kv_cents, "0100": profile.employeeRv ? c.rv_cents : 0,
    "0500": profile.employeeRv ? 0 : c.rv_cents, U1: c.u1_cents, U2: c.u2_cents,
    "0050": c.insolvency_cents, St: c.flat_tax_cents };
}
const fieldTotal = fields => Object.values(fields).reduce((sum, n) => sum + n, 0);
function closingContributionFields(closing) {
  const snap = safeParse(closing?.snapshot_json);
  if (!snap?.profile || !snap?.payroll) return null;
  // Der Abschluss hält die damals gültigen Einstellungen und SV-Tage fest.
  return contributionFields(calculateMinijobContributions(Number(closing.gross_cents),
    snap.profile, snap.payroll.svDays), snap.profile);
}
function submissionConfirmed(report) {
  return report?.status !== "draft" && !!safeParse(report?.snapshot_json)?.submissionConfirmation;
}
async function previousContributionFields(env, owner, month) {
  const prior = previousMonth(month);
  const [report, closing] = await Promise.all([
    first(env, "SELECT * FROM minijob_contribution_reports WHERE clerk_user_id = ? AND payroll_month = ?", owner, prior),
    first(env, "SELECT gross_cents, snapshot_json FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?", owner, prior)
  ]);
  const actual = closingContributionFields(closing);
  const snap = safeParse(report?.snapshot_json);
  if (submissionConfirmed(report) && !actual) return null;
  if (!submissionConfirmed(report) || !actual || !snap?.baseFields) return {};
  return Object.fromEntries(Object.keys(actual).map(key => [key, actual[key] - (snap.baseFields[key] || 0)]));
}

async function syncContributionReportActual(env, owner, month, grossCents, profile = null, svDays = 30) {
  await ensureContributionReports(env);
  const existing = await first(env,
    `SELECT id, reported_total_cents
     FROM minijob_contribution_reports
     WHERE clerk_user_id = ? AND payroll_month = ?`,
    owner, month);
  if (!existing) return;

  const p = profile || await contributionProfile(env, owner);
  const actual = calculateMinijobContributions(grossCents, p, svDays);
  const correction = actual.total_cents - Number(existing.reported_total_cents || 0);

  await run(env,
    `UPDATE minijob_contribution_reports
     SET actual_gross_cents = ?, actual_total_cents = ?, correction_cents = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    actual.gross_cents, actual.total_cents, correction, existing.id);
}

async function upsertContributionReport({ request, env, userId, owner }) {
  const body = (await readJson(request)) || {};
  const month = String(body.month || "").trim();
  if (!validMonth(month)) return err("Bitte einen gültigen Abrechnungsmonat im Format JJJJ-MM angeben.");

  let estimatedGrossCents;
  if (body.estimated_gross_cents != null) {
    estimatedGrossCents = Number(body.estimated_gross_cents);
    if (!Number.isSafeInteger(estimatedGrossCents) || estimatedGrossCents < 0 || estimatedGrossCents > 10000000) return err("Voraussichtliches Brutto ist ungültig.");
  } else if (body.estimated_gross != null) {
    const euros = Number(body.estimated_gross);
    if (!Number.isFinite(euros) || euros < 0 || euros > 100000) return err("Voraussichtliches Brutto ist ungültig.");
    estimatedGrossCents = Math.round(euros * 100);
  } else {
    return err("Voraussichtliches Brutto fehlt.");
  }

  await ensureContributionReports(env);
  const existing = await first(env,
    `SELECT *
     FROM minijob_contribution_reports
     WHERE clerk_user_id = ? AND payroll_month = ?`,
    owner, month);

  const status = CONTRIBUTION_STATUSES.includes(body.status) ? body.status : (existing?.status || "draft");
  const wasConfirmed = submissionConfirmed(existing);
  const needsConfirmation = status !== "draft" && !wasConfirmed;
  const submittedAt = status === "draft" ? null : body.submitted_date;
  const paidAt = status === "paid" ? body.paid_date : null;
  if (status !== "draft" && (!validDate(submittedAt) || submittedAt > berlinToday())) {
    return err("Bitte das tatsächliche Übermittlungsdatum im SV-Meldeportal angeben (nicht in der Zukunft).");
  }
  if (needsConfirmation && body.submission_confirmed !== true) {
    return err("Bitte bestätigen, dass diese Werte tatsächlich im SV-Meldeportal übermittelt wurden.");
  }
  if (status === "paid" && (!validDate(paidAt) || paidAt < submittedAt || paidAt > berlinToday())) {
    return err("Bitte das tatsächliche Zahlungsdatum ab Übermittlung bis heute angeben.");
  }
  if (wasConfirmed) {
    if (status === "draft" || estimatedGrossCents !== existing.estimated_gross_cents || submittedAt !== String(existing.submitted_at).slice(0, 10)) {
      return err("Bestätigte Meldungen sind eingefroren. Abweichungen werden nach Monatsabschluss im Folgemonat verrechnet.", 409);
    }
    await run(env, `UPDATE minijob_contribution_reports SET status = ?, paid_at = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      status, paidAt, cleanText(body.note, 500), existing.id);
    return json(mapContributionReport(await first(env, `${CONTRIBUTION_SELECT} WHERE id = ?`, existing.id)));
  }

  const [storedProfile, employee, closing, priorFields, member] = await Promise.all([
    contributionProfile(env, owner),
    first(env, "SELECT start_date, end_date FROM employee_profiles WHERE clerk_user_id = ?", owner),
    first(env,
      "SELECT gross_cents, snapshot_json FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?",
      owner, month),
    previousContributionFields(env, owner, month),
    first(env, "SELECT email FROM office_members WHERE clerk_user_id = ?", owner)
  ]);

  if (needsConfirmation && isTestEmail(member?.email)) return err("Testkonto – nicht an die Minijob-Zentrale melden.");
  if (needsConfirmation && priorFields == null) return err("Bitte zuerst den Vormonat abschließen, damit dessen Beitragsausgleich feststeht.", 409);
  const profile = safeParse(closing?.snapshot_json)?.profile || storedProfile;
  const priorCorrection = fieldTotal(priorFields || {});
  const svDays = insuredDays(month, employee?.start_date, employee?.end_date);
  const estimated = calculateMinijobContributions(estimatedGrossCents, profile, svDays || 30);
  const due = contributionDueDates(month);
  const amountDue = estimated.total_cents + priorCorrection;
  const note = cleanText(body.note, 500);

  let actualGross = null;
  let actualTotal = null;
  let correction = 0;
  if (closing) {
    const actual = calculateMinijobContributions(Number(closing.gross_cents || 0), safeParse(closing.snapshot_json)?.profile || profile, safeParse(closing.snapshot_json)?.payroll?.svDays ?? svDays);
    actualGross = actual.gross_cents;
    actualTotal = actual.total_cents;
    correction = actual.total_cents - estimated.total_cents;
  }

  const baseFields = contributionFields(estimated, profile);
  const portalFields = Object.fromEntries(Object.keys(baseFields).map(key => [key, baseFields[key] + (priorFields?.[key] || 0)]));
  if (needsConfirmation && JSON.stringify(body.portal_fields) !== JSON.stringify(portalFields)) {
    return err("Die Portalwerte haben sich geändert. Bitte neu laden und vor Bestätigung mit der tatsächlichen Meldung vergleichen.", 409);
  }
  const snapshot = {
    baseFields, priorFields: priorFields || {}, portalFields, manualGross: body.manual_gross === true,
    basis: closing && Number(closing.gross_cents) === estimatedGrossCents ? "final" : "estimate",
    submissionConfirmation: needsConfirmation ? { confirmedBy: userId, confirmedAt: new Date().toISOString(), submittedDate: submittedAt } : null,
    payrollMonth: month,
    calculatedAt: new Date().toISOString(),
    profile,
    svDays,
    rates: {
      kv: profile.employerKv ? 0.13 : 0,
      rvEmployer: profile.employerRv ? RV_EMPLOYER_RATE : 0,
      rvEmployee: profile.employeeRv ? RV_EMPLOYEE_RATE : 0,
      u1: profile.u1 ? 0.008 : 0,
      u2: profile.u2 ? 0.0022 : 0,
      insolvency: profile.insolvency ? 0.0015 : 0,
      flatTax: profile.flatTax ? 0.02 : 0
    },
    accidentInsuranceIncluded: false
  };

  const saveResult = await run(env,
    `INSERT INTO minijob_contribution_reports (
       clerk_user_id, payroll_month, estimated_gross_cents,
       kv_cents, rv_employer_cents, rv_employee_cents, rv_cents,
       u1_cents, u2_cents, insolvency_cents, flat_tax_cents,
       reported_total_cents, prior_correction_cents, amount_due_cents,
       actual_gross_cents, actual_total_cents, correction_cents,
       submission_due_date, payment_due_date, status, submitted_at, paid_at, note, snapshot_json, created_by,
       updated_at
     ) VALUES (${qs(25)}, CURRENT_TIMESTAMP)
     ON CONFLICT(clerk_user_id, payroll_month) DO UPDATE SET
       estimated_gross_cents = excluded.estimated_gross_cents,
       kv_cents = excluded.kv_cents,
       rv_employer_cents = excluded.rv_employer_cents,
       rv_employee_cents = excluded.rv_employee_cents,
       rv_cents = excluded.rv_cents,
       u1_cents = excluded.u1_cents,
       u2_cents = excluded.u2_cents,
       insolvency_cents = excluded.insolvency_cents,
       flat_tax_cents = excluded.flat_tax_cents,
       reported_total_cents = excluded.reported_total_cents,
       prior_correction_cents = excluded.prior_correction_cents,
       amount_due_cents = excluded.amount_due_cents,
       actual_gross_cents = excluded.actual_gross_cents,
       actual_total_cents = excluded.actual_total_cents,
       correction_cents = excluded.correction_cents,
       submission_due_date = excluded.submission_due_date,
       payment_due_date = excluded.payment_due_date,
       status = excluded.status,
       submitted_at = excluded.submitted_at,
       paid_at = excluded.paid_at,
       note = excluded.note,
       snapshot_json = excluded.snapshot_json,
       created_by = excluded.created_by,
       updated_at = CURRENT_TIMESTAMP
     WHERE minijob_contribution_reports.status = 'draft'
        OR json_extract(CASE WHEN json_valid(minijob_contribution_reports.snapshot_json)
          THEN minijob_contribution_reports.snapshot_json ELSE '{}' END, '$.submissionConfirmation') IS NULL`,
    owner, month, estimated.gross_cents,
    estimated.kv_cents, estimated.rv_employer_cents, estimated.rv_employee_cents, estimated.rv_cents,
    estimated.u1_cents, estimated.u2_cents, estimated.insolvency_cents, estimated.flat_tax_cents,
    estimated.total_cents, priorCorrection, amountDue,
    actualGross, actualTotal, correction,
    due.submissionDueDate, due.paymentDueDate, status, submittedAt, paidAt, note, JSON.stringify(snapshot), userId
  );

  if (!saveResult.meta?.changes) return err("Der Nachweis wurde inzwischen bestätigt. Bitte neu laden.", 409);
  const row = await first(env,
    `${CONTRIBUTION_SELECT}
     WHERE clerk_user_id = ? AND payroll_month = ?`,
    owner, month);
  return json(mapContributionReport(row), existing ? 200 : 201);
}

async function updateContributionReport({ request, env, id, userId }) {
  await ensureContributionReports(env);
  const existing = await first(env, `${CONTRIBUTION_SELECT} WHERE id = ?`, id);
  if (!existing) return err("Beitragsnachweis nicht gefunden.", 404);
  const body = (await readJson(request)) || {};
  return upsertContributionReport({ env, owner: existing.clerk_user_id, userId,
    request: new Request(request.url, { method: "PUT", body: JSON.stringify({ ...body,
      month: existing.payroll_month, estimated_gross_cents: existing.estimated_gross_cents,
      submitted_date: body.submitted_date || existing.submitted_at?.slice(0, 10) }) }) });
}


/* ================= Gehaltsnachweise unterschreiben =================
 * Nach dem Monatsabschluss bestätigt die Mitarbeiterin Empfang und Arbeitszeiten,
 * der Arbeitgeber zeichnet gegen. Die Unterschrift gilt für genau diesen Abschluss (Prüfsumme).
 */
let payslipReady = false;
async function ensurePayslips(env) {
  if (payslipReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS payslip_signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clerk_user_id TEXT NOT NULL,
    payroll_month TEXT NOT NULL,
    role TEXT NOT NULL,
    signer_id TEXT,
    signer_name TEXT,
    signature TEXT NOT NULL,
    doc_hash TEXT NOT NULL,
    user_agent TEXT,
    signed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (clerk_user_id, payroll_month, role))`);
  payslipReady = true;
}

async function payslipList(env, userId, month = null) {
  await ensurePayslips(env);
  const closings = month
    ? await all(env, `SELECT id, payroll_month, gross_cents, net_cents, work_minutes, snapshot_json, closed_at
                      FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?`, userId, month)
    : await all(env, `SELECT id, payroll_month, gross_cents, net_cents, work_minutes, snapshot_json, closed_at
                      FROM monthly_closings WHERE clerk_user_id = ? ORDER BY payroll_month DESC`, userId);
  const sigs = await all(env,
    "SELECT payroll_month, role, signer_name, signature, doc_hash, signed_at FROM payslip_signatures WHERE clerk_user_id = ?", userId);
  const out = [];
  for (const c of closings) {
    const hash = await sha256Hex(c.snapshot_json || "");
    const valid = role => {
      const sig = sigs.find(x => x.payroll_month === c.payroll_month && x.role === role && x.doc_hash === hash);
      return sig ? { signer_name: sig.signer_name, signed_at: sig.signed_at, signature: sig.signature } : null;
    };
    out.push({
      id: c.id, month: c.payroll_month, gross: Number(c.gross_cents || 0) / 100, net: Number(c.net_cents || 0) / 100,
      work_minutes: Number(c.work_minutes || 0), closed_at: c.closed_at, hash,
      snapshot: safeParse(c.snapshot_json),
      signatures: { employee: valid("employee"), employer: valid("employer") }
    });
  }
  return out;
}

function parsePayslipSignature(body) {
  const month = String(body?.month || "");
  const signature = String(body?.signature || "");
  if (!validMonth(month)) return { error: "Unbekannter Abrechnungsmonat." };
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > SIGNATURE_MAX) {
    return { error: "Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben." };
  }
  return { month, signature };
}

async function storePayslipSignature(env, request, userId, month, role, signerId, signerName, signature, hash) {
  await run(env,
    `INSERT INTO payslip_signatures (clerk_user_id, payroll_month, role, signer_id, signer_name, signature, doc_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(clerk_user_id, payroll_month, role) DO UPDATE SET
       signer_id = excluded.signer_id, signer_name = excluded.signer_name, signature = excluded.signature,
       doc_hash = excluded.doc_hash, signed_at = CURRENT_TIMESTAMP, user_agent = excluded.user_agent`,
    userId, month, role, signerId, signerName, signature, hash, String(request.headers.get("User-Agent") || "").slice(0, 200));
}

const slipName = (slip, role) => role === "employee"
  ? (slip.snapshot?.employee?.full_name || slip.snapshot?.employeeName || "Mitarbeiter")
  : (slip.snapshot?.employer?.name || "Arbeitgeber");

async function listOwnPayslips({ env, userId }) {
  if (isBoss(env, userId)) return json([]);
  return json(await payslipList(env, userId));
}

async function signOwnPayslip({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Als Boss zeichnest du im Monatsarchiv gegen.");
  const parsed = parsePayslipSignature(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [slip] = await payslipList(env, userId, parsed.month);
  if (!slip) return err("Für diesen Monat gibt es noch keinen Gehaltsnachweis.", 404);
  if (!slip.signatures.employee) {
    await storePayslipSignature(env, request, userId, parsed.month, "employee", userId, slipName(slip, "employee"), parsed.signature, slip.hash);
    await pushBoss(env, exec, {
      title: "Gehaltsnachweis bestätigt",
      body: `${slipName(slip, "employee")} hat den Gehaltsnachweis für ${slip.snapshot?.monthLabel || parsed.month} unterschrieben.${slip.signatures.employer ? "" : " Bitte im Monatsarchiv gegenzeichnen."}`,
      tag: `payslip-${userId}-${parsed.month}`,
      url: hrUrl("nachweise")
    });
  }
  return ok((await payslipList(env, userId, parsed.month))[0]);
}

async function listAdminPayslips({ env, owner }) {
  return json(await payslipList(env, owner));
}

async function signAdminPayslip({ request, env, owner, userId, exec }) {
  const parsed = parsePayslipSignature(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [slip] = await payslipList(env, owner, parsed.month);
  if (!slip) return err("Der Monat ist noch nicht abgeschlossen.", 404);
  if (!slip.signatures.employer) {
    await storePayslipSignature(env, request, owner, parsed.month, "employer", userId, slipName(slip, "employer"), parsed.signature, slip.hash);
    if (slip.signatures.employee) await runLater(exec, notifyUser(env, owner, {
      title: "Gehaltsnachweis gegengezeichnet",
      body: `Kim hat deinen Gehaltsnachweis für ${slip.snapshot?.monthLabel || parsed.month} gegengezeichnet. Du findest ihn unter „Meine Unterlagen“.`,
      tag: `payslip-${parsed.month}`,
      url: hrUrl("vertrag")
    }));
  }
  return ok((await payslipList(env, owner, parsed.month))[0]);
}


/* ================= Monatsabschluss auf Anfrage =================
 * Der Boss fragt: „Monat abschließen?“ – die Mitarbeiterin antwortet Ja (Abschluss + Unterschrift)
 * oder Nein (bleibt offen, mit kurzem Grund).
 */
let closeRequestsReady = false;
async function ensureCloseRequests(env) {
  if (closeRequestsReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS close_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    clerk_user_id TEXT NOT NULL,
    payroll_month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    requested_by TEXT,
    requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    answered_at TEXT,
    UNIQUE (clerk_user_id, payroll_month))`);
  closeRequestsReady = true;
}

const monthLabelOf = month => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", month: "long", year: "numeric" })
  .format(new Date(`${month}-15T00:00:00Z`));

async function closeRequestRows(env, userId) {
  await ensureCloseRequests(env);
  const rows = await all(env,
    `SELECT r.payroll_month AS month, r.status, r.note, r.requested_at, r.answered_at,
            (SELECT COUNT(*) FROM monthly_closings c WHERE c.clerk_user_id = r.clerk_user_id AND c.payroll_month = r.payroll_month) AS closed
     FROM close_requests r WHERE r.clerk_user_id = ? ORDER BY r.payroll_month DESC`, userId);
  return rows.map(r => ({ ...r, closed: Number(r.closed) > 0, label: monthLabelOf(r.month) }));
}

async function listAdminCloseRequests({ env, owner }) {
  return json(await closeRequestRows(env, owner));
}

async function createCloseRequest({ request, env, owner, userId, exec }) {
  await ensureCloseRequests(env);
  const body = (await readJson(request)) || {};
  const month = String(body.month || "").trim();
  if (!monthOver(month)) return err("Fragen kannst du ab dem letzten Tag des Monats.");
  const closed = await first(env, "SELECT id FROM monthly_closings WHERE clerk_user_id = ? AND payroll_month = ?", owner, month);
  if (closed) return err("Der Monat ist bereits abgeschlossen.", 409);
  await run(env,
    `INSERT INTO close_requests (clerk_user_id, payroll_month, status, note, requested_by)
     VALUES (?, ?, 'pending', NULL, ?)
     ON CONFLICT(clerk_user_id, payroll_month) DO UPDATE SET
       status = 'pending', note = NULL, requested_by = excluded.requested_by,
       requested_at = CURRENT_TIMESTAMP, answered_at = NULL`,
    owner, month, userId);
  await runLater(exec, notifyUser(env, owner, {
    title: `${monthLabelOf(month)} abschließen?`,
    body: "Kim möchte den Monat abschließen. Sind alle Arbeitszeiten und Termine eingetragen? Bitte in Office mit Ja oder Nein antworten.",
    tag: `close-${month}`,
    url: hrUrl("dashboard")
  }));
  return ok((await closeRequestRows(env, owner)).find(r => r.month === month));
}

async function listOwnCloseRequests({ env, userId }) {
  if (isBoss(env, userId)) return json([]);
  return json((await closeRequestRows(env, userId)).filter(r => r.status === "pending" && !r.closed));
}

async function answerCloseRequest({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Nur für Mitarbeiter.");
  await ensureCloseRequests(env);
  const body = (await readJson(request)) || {};
  const month = String(body.month || "").trim();
  const yes = body.answer === "yes";
  const note = cleanText(body.note, 300);
  const req = await first(env, "SELECT status FROM close_requests WHERE clerk_user_id = ? AND payroll_month = ?", userId, month);
  if (!req) return err("Keine offene Anfrage für diesen Monat.", 404);
  const name = (await first(env, "SELECT full_name FROM employee_profiles WHERE clerk_user_id = ?", userId).catch(() => null))?.full_name || "Deine Mitarbeiterin";

  if (!yes) {
    await run(env, "UPDATE close_requests SET status = 'declined', note = ?, answered_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ? AND payroll_month = ?",
      note, userId, month);
    await pushBoss(env, exec, {
      title: `${monthLabelOf(month)} bleibt offen`,
      body: `${name} möchte noch etwas nachtragen${note ? `: ${note}` : "."}`,
      tag: `close-${userId}-${month}`,
      url: hrUrl("lohn")
    });
    return ok({ status: "declined" });
  }

  const res = await createMonthlyClosing({
    request: new Request("https://office.local/close", { method: "POST", body: JSON.stringify({ month }) }),
    env, userId, owner: userId, exec, confirmedByEmployee: true
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) return err(result?.error || "Der Monat konnte nicht abgeschlossen werden.", res.status);
  if (result?.skipped) return err("Für diesen Monat gibt es keine Einträge – nichts abzuschließen.");
  await run(env, "UPDATE close_requests SET status = 'confirmed', note = NULL, answered_at = CURRENT_TIMESTAMP WHERE clerk_user_id = ? AND payroll_month = ?",
    userId, month);
  await pushBoss(env, exec, {
    title: `${monthLabelOf(month)} abgeschlossen`,
    body: `${name} hat bestätigt, dass alles eingetragen ist. Der Gehaltsnachweis liegt im Monatsarchiv.`,
    tag: `close-${userId}-${month}`,
    url: hrUrl("nachweise")
  });
  const [slip] = await payslipList(env, userId, month);
  return ok({ status: "confirmed", slip });
}

/* ================= Lohnnachweis an die Berufsgenossenschaft =================
 * Jahressummen aller Beschäftigten: Arbeitsentgelt, geleistete Arbeitsstunden, Zahl der Versicherten.
 * Abgeschlossene Monate mit ihrem abgerechneten Brutto, offene Monate mit dem aktuellen Stand.
 */
async function getUvLohnnachweis({ env, url }) {
  await ensureMasterColumns(env);
  await ensureAdjustments(env);
  const year = String(url.searchParams.get("year") || "").trim();
  if (!/^\d{4}$/.test(year)) return err("Bitte ein Jahr angeben.");
  const from = `${year}-01-01`, to = `${Number(year) + 1}-01-01`;
  const testIds = new Set((await all(env, "SELECT clerk_user_id, email FROM office_members")).filter(m => isTestEmail(m.email)).map(m => m.clerk_user_id));
  const people = (await all(env, "SELECT clerk_user_id, full_name, start_date, end_date, insurance_number FROM employee_profiles"))
    .filter(p => !testIds.has(p.clerk_user_id) && p.insurance_number && p.start_date && p.start_date < to && (!p.end_date || p.end_date >= from));
  const rows = [];
  for (const p of people) {
    const id = p.clerk_user_id;
    const [work, perf, absence, closed, adjust] = await Promise.all([
      all(env, `SELECT substr(work_date, 1, 7) AS month, SUM(work_minutes) AS mins FROM work_entries
                WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ? GROUP BY month`, id, from, to),
      all(env, `SELECT substr(work_date, 1, 7) AS month, SUM(appointments) AS appts FROM performance_entries
                WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ? GROUP BY month`, id, from, to),
      all(env, `SELECT substr(absence_date, 1, 7) AS month, SUM(paid_amount_cents) AS paid FROM employee_absences
                WHERE clerk_user_id = ? AND absence_date >= ? AND absence_date < ? GROUP BY month`, id, from, to),
      all(env, `SELECT payroll_month AS month, gross_cents FROM monthly_closings
                WHERE clerk_user_id = ? AND payroll_month >= ? AND payroll_month < ?`, id, `${year}-01`, `${Number(year) + 1}-01`),
      all(env, `SELECT payroll_month AS month, SUM(delta) AS delta FROM appointment_adjustments
                WHERE clerk_user_id = ? AND payroll_month >= ? AND payroll_month < ? GROUP BY payroll_month`, id, `${year}-01`, `${Number(year) + 1}-01`)
    ]);
    const months = {};
    work.forEach(r => (months[r.month] = (months[r.month] || 0) + Math.round((Number(r.mins) * hourlyRateCents(r.month)) / 60)));
    perf.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.appts) * COMMISSION_RATE_CENTS));
    absence.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.paid || 0)));
    adjust.forEach(r => (months[r.month] = (months[r.month] || 0) + Number(r.delta || 0) * COMMISSION_RATE_CENTS));
    closed.forEach(r => (months[r.month] = Number(r.gross_cents || 0)));
    const grossCents = Object.values(months).reduce((a, b) => a + b, 0);
    const minutes = work.reduce((a, r) => a + Number(r.mins || 0), 0);
    if (!grossCents && !minutes) continue;
    rows.push({
      clerk_user_id: id, name: p.full_name, start_date: p.start_date, end_date: p.end_date,
      gross: grossCents / 100, minutes,
      closed_months: closed.length, open_months: Object.keys(months).filter(m => !closed.some(c => c.month === m)).length
    });
  }
  const employer = mapEmployer(await first(env, "SELECT * FROM office_employer WHERE id = 1"));
  return json({
    year, employer,
    employees: rows,
    total_gross: Math.round(rows.reduce((a, r) => a + r.gross * 100, 0)) / 100,
    total_minutes: rows.reduce((a, r) => a + r.minutes, 0),
    insured: rows.length,
    complete: berlinToday() > `${year}-12-31` && rows.every(r => !r.open_months)
  });
}

/* ================= Filialen & Terminbuchung ================= */

const BRANCH_COLS = "id, name, note, booking_url, schedule, created_at, updated_at";

// Anwesenheit je Filiale (Mo–Fr): vm = vormittags, nm = nachmittags, gt = ganztags.
// Das Gesprächsskript formuliert daraus die Terminfrage.
const BRANCH_DAYS = ["mo", "di", "mi", "do", "fr"];
const BRANCH_TIMES = ["vm", "nm", "gt"];

function parseSchedule(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  BRANCH_DAYS.forEach(day => { if (BRANCH_TIMES.includes(src[day])) out[day] = src[day]; });
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Die Spalte „schedule“ legt der Worker beim ersten Zugriff selbst an – kein SQL nötig.
let branchScheduleReady = false;
async function ensureBranchSchedule(env) {
  if (branchScheduleReady) return;
  try {
    await run(env, "ALTER TABLE office_branches ADD COLUMN schedule TEXT");
  } catch {
    // Spalte gibt es schon
  }
  branchScheduleReady = true;
}

function parseBranchBody(body) {
  const name = String(body?.name || "").trim().slice(0, 120);
  const note = String(body?.note || "").trim().slice(0, 200);
  const bookingUrl = String(body?.booking_url || "").trim();

  if (!name) return { error: "Bitte einen Namen für die Filiale eingeben." };

  let valid = false;
  try {
    valid = new URL(bookingUrl).protocol === "https:" && bookingUrl.length <= 1000;
  } catch {}
  if (!valid) return { error: "Bitte einen gültigen Buchungslink eingeben (beginnt mit https://)." };

  return { values: [name, note || null, bookingUrl, parseSchedule(body?.schedule)] };
}

async function listBranches({ env }) {
  await ensureBranchSchedule(env);
  const rows = await all(env, `SELECT ${BRANCH_COLS} FROM office_branches ORDER BY name COLLATE NOCASE`);
  return json(rows.map(row => ({ ...row, schedule: safeParse(row.schedule) || {} })));
}

async function createBranch({ request, env }) {
  const { error, values } = parseBranchBody(await readJson(request));
  if (error) return err(error);
  await ensureBranchSchedule(env);
  return created(await run(env,
    "INSERT INTO office_branches (name, note, booking_url, schedule) VALUES (?, ?, ?, ?)",
    ...values));
}

async function updateBranch({ request, env, id }) {
  const { error, values } = parseBranchBody(await readJson(request));
  if (error) return err(error);
  await ensureBranchSchedule(env);
  return changed(await run(env,
    `UPDATE office_branches
     SET name = ?, note = ?, booking_url = ?, schedule = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    ...values, id), "Filiale nicht gefunden.");
}

const deleteBranch = async ({ env, id }) =>
  changed(await run(env, "DELETE FROM office_branches WHERE id = ?", id), "Filiale nicht gefunden.");

/* ================= Telefonliste ================= */

const CALL_MAX_ATTEMPTS = 5;
const CALL_RESULTS = ["R_TA_mT", "R_TA_oT"];
// R_TA_kK setzt der Worker nach 5 Versuchen, R_TA_fK wenn alle Nummern als falsch markiert sind.
// Rückgaben verlangen eine Notiz (protocol) – außer bei falschen Kontaktdaten.

// Themen steuern den Abschnitt „Worum es geht“ im Anruf-Skript der App.
const CALL_TOPICS = [
  "zuteilung", "mindestguthaben", "kinder", "sohn", "tochter",
  "besparung", "foerderung", "treuepraemie", "riester", "neuterminierung"
];

const CALL_SELECT = `
  SELECT c.id, c.assigned_to, c.customer_name, c.salutation, c.phones, c.branch_id, c.teams,
         c.topics, c.briefing,
         c.attempts, c.attempt_log, c.bad_phones, c.status, c.protocol, c.closed_at, c.archived_at,
         c.hold_note, c.held_at, c.kk_state, c.kk_archived_at, c.rounds, c.round_log, c.fk_task_id,
         c.created_at, c.updated_at,
         b.name AS branch_name, b.booking_url,
         m.display_name, m.email
  FROM office_calls c
  LEFT JOIN office_branches b ON b.id = c.branch_id
  LEFT JOIN office_members m ON m.clerk_user_id = c.assigned_to`;

const mapCall = row => ({
  ...row,
  teams: Boolean(row.teams),
  phones: safeParse(row.phones) || [],
  topics: safeParse(row.topics) || [],
  attempt_log: safeParse(row.attempt_log) || [],
  bad_phones: safeParse(row.bad_phones) || [],
  round_log: safeParse(row.round_log) || [],
  rounds: Number(row.rounds || 1)
});

const HELD_MSG = "Kontakt ist gehalten – bitte zuerst „Halten aufheben“.";
const cleanHoldNote = value => String(value ?? "").trim().slice(0, 500);

const MAX_PHONES = 2;
const MAX_PHONES_MSG = "Höchstens 2 Telefonnummern je Kontakt.";

function parsePhones(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[\n,;]+/);
  const phones = raw
    .map(p => String(p)
      .replace(/[^\d+\s/()-]/g, "")   // Beschriftungen wie „(mobil)“ entfernen
      .replace(/\(\s*\)/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s/()-]+|[\s/(-]+$/g, "")
      .trim())
    .filter(p => (p.match(/\d/g) || []).length >= 4)
    .map(p => p.slice(0, 40));
  return [...new Set(phones)].slice(0, 5);
}

const cleanProtocol = value => String(value ?? "").trim().slice(0, 2000) || null;

// Rückgaben mit/ohne Termin und „nicht erreicht“ brauchen eine Notiz (mindestens 1 Zeichen).
// Bei falschen Kontaktdaten nicht – der Status sagt schon alles.
const RETURN_NOTE_MIN = 1;
const RETURN_NOTE_MSG = "Bitte kurz notieren, warum der Kontakt zurückgeht.";
const hasReturnNote = protocol => (protocol || "").length >= RETURN_NOTE_MIN;

const parseTopics = input =>
  [...new Set((Array.isArray(input) ? input : []).map(String))]
    .filter(topic => CALL_TOPICS.includes(topic));

async function parseCallBody(env, body) {
  const assignedTo = String(body?.assigned_to || "").trim();
  const name = String(body?.customer_name || "").trim().slice(0, 120);
  const salutation = body?.salutation === "Frau" ? "Frau" : "Herr";
  const phones = parsePhones(body?.phones);
  const topics = parseTopics(body?.topics);
  const briefing = String(body?.briefing || "").trim().slice(0, 2000) || null;
  const place = String(body?.place ?? "").trim();

  if (!validUserId(assignedTo) || isBoss(env, assignedTo)) return { error: "Bitte einen Mitarbeiter auswählen." };
  if (!name) return { error: "Bitte den Kundennamen eingeben." };
  if (!phones.length) return { error: "Bitte mindestens eine gültige Telefonnummer eingeben." };
  if (phones.length > MAX_PHONES) return { error: MAX_PHONES_MSG };

  const member = await first(env, "SELECT 1 FROM office_members WHERE clerk_user_id = ?", assignedTo);
  if (!member) return { error: "Mitarbeiter wurde noch nicht in Office registriert." };

  let branchId = null;
  let teams = 0;
  if (place === "teams") {
    teams = 1;
  } else if (place) {
    branchId = nonNegInt(place, 0);
    const branch = branchId && await first(env, "SELECT 1 FROM office_branches WHERE id = ?", branchId);
    if (!branch) return { error: "Die gewählte Filiale existiert nicht mehr." };
  }

  return {
    values: [assignedTo, name, salutation, JSON.stringify(phones),
             branchId, teams, JSON.stringify(topics), briefing]
  };
}

// Position der Nummern in values – beim Update für bad_phones erneut gebraucht.
const CALL_PHONES_INDEX = 3;

// Push ohne Kundennamen – die Nachricht ist auf dem Sperrbildschirm sichtbar.
async function notifyCalls(env, exec, userId) {
  const job = (async () => {
    const row = await first(env,
      "SELECT COUNT(*) AS n FROM office_calls WHERE assigned_to = ? AND status = 'open' AND hold_note IS NULL", userId);
    const n = Number(row?.n || 0);
    return notifyUser(env, userId, {
      title: "Neuer Kontakt in der Telefonliste",
      body: n === 1 ? "Du hast 1 offenen Kontakt." : `Du hast ${n} offene Kontakte.`,
      tag: "calls",
      url: `${APP_PATH}?page=telefon`
    });
  })();
  if (exec?.waitUntil) exec.waitUntil(job); else await job;
}

/* --- Mitarbeiter --- */

const listOwnCalls = async ({ env, userId }) =>
  json((await all(env,
    `${CALL_SELECT} WHERE c.assigned_to = ? AND c.status = 'open'
     ORDER BY (c.hold_note IS NULL), c.held_at ASC, c.created_at ASC, c.id ASC`,
    userId)).map(mapCall));

async function registerCallAttempt({ request, env, userId, id }) {
  const body = (await readJson(request)) || {};

  const protocol = cleanProtocol(body.protocol);

  // Der letzte Versuch gibt den Kontakt zurück – das geht nur mit Notiz.
  if (!hasReturnNote(protocol)) {
    const current = await first(env,
      "SELECT attempts FROM office_calls WHERE id = ? AND assigned_to = ? AND status = 'open'", id, userId);
    if (current && Number(current.attempts) + 1 >= CALL_MAX_ATTEMPTS) return err(RETURN_NOTE_MSG);
  }

  // In SET beziehen sich alle Ausdrücke auf den alten Wert von attempts.
  // Beim letzten Versuch: R_TA_kK → direkt ins Kein-Kontakt-Archiv (nicht in den Rücklauf).
  // Ohne mitgeschickte Notiz bleibt die gespeicherte Notiz stehen.
  const row = await first(env,
    `UPDATE office_calls SET
       attempts = attempts + 1,
       attempt_log = json_insert(COALESCE(attempt_log, '[]'), '$[#]', CURRENT_TIMESTAMP),
       protocol = COALESCE(?, protocol),
       status = CASE WHEN attempts + 1 >= ? THEN 'R_TA_kK' ELSE 'open' END,
       closed_at = CASE WHEN attempts + 1 >= ? THEN CURRENT_TIMESTAMP ELSE NULL END,
       kk_state = CASE WHEN attempts + 1 >= ? THEN 'archived' ELSE kk_state END,
       kk_archived_at = CASE WHEN attempts + 1 >= ? THEN CURRENT_TIMESTAMP ELSE kk_archived_at END,
       round_log = CASE WHEN attempts + 1 >= ?
         THEN json_insert(COALESCE(round_log, '[]'), '$[#]', json_object(
           'round', COALESCE(rounds, 1), 'archived_at', CURRENT_TIMESTAMP,
           'attempts', attempts + 1, 'protocol', COALESCE(?, protocol)))
         ELSE round_log END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open' AND hold_note IS NULL
     RETURNING attempts, status`,
    protocol, CALL_MAX_ATTEMPTS, CALL_MAX_ATTEMPTS, CALL_MAX_ATTEMPTS, CALL_MAX_ATTEMPTS,
    CALL_MAX_ATTEMPTS, protocol, id, userId);

  if (!row) return err("Kontakt nicht gefunden, gehalten oder bereits abgeschlossen.", 404);
  return ok({ attempts: row.attempts, status: row.status });
}

/*
 * Falsche Kontaktdaten: EINE Aufgabe im Boss-Posteingang, solange mindestens ein Rückläufer
 * mit falschen Kontaktdaten offen ist. Sie wird angelegt, sobald der erste dazukommt, zeigt die
 * aktuelle Anzahl und erledigt sich selbst, wenn keiner mehr übrig ist.
 * Frühere Einzelaufgaben („Falsche Nummer: …“) werden dabei mit abgeschlossen.
 */
const FK_TASK_TITLE = "Falsche Nummern in den Rückläufern";
const FK_OPEN_WHERE = "status = 'R_TA_fK' AND archived_at IS NULL AND kk_state IS NULL";

async function syncFkTask(env, exec = null) {
  const [count, task] = await Promise.all([
    first(env, `SELECT COUNT(*) AS n FROM office_calls WHERE ${FK_OPEN_WHERE}`),
    first(env, "SELECT id FROM office_tasks WHERE assigned_to = ? AND status = 'open' AND title = ?", BOSS_INBOX, FK_TASK_TITLE)
  ]);
  const n = Number(count?.n || 0);
  const done = `status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`;

  await run(env, `UPDATE office_tasks SET ${done} WHERE assigned_to = ? AND status = 'open' AND title LIKE 'Falsche Nummer: %'`, BOSS_INBOX);

  if (!n) {
    if (task) await run(env, `UPDATE office_tasks SET ${done} WHERE id = ?`, task.id);
    return;
  }

  const description = `${n === 1 ? "1 Kontakt hat" : `${n} Kontakte haben`} falsche Kontaktdaten.\n` +
    "Unter „Kontakte“ → „Rückläufer“ die neue Nummer eintragen – die Aufgabe erledigt sich, sobald keiner mehr übrig ist.";
  if (task) {
    await run(env, "UPDATE office_tasks SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", description, task.id);
    return;
  }

  const result = await run(env,
    `INSERT INTO office_tasks (assigned_to, created_by, title, description, due_date, priority, status)
     VALUES (?, 'system', ?, ?, NULL, 'high', 'open')`,
    BOSS_INBOX, FK_TASK_TITLE, description);
  const message = taskPushMessage(result.meta?.last_row_id, FK_TASK_TITLE, null, "high", FK_TASK_TITLE);
  await runLater(exec, Promise.all(bossIds(env).map(bossId => notifyUser(env, bossId, message))));
}

async function flagCallPhone({ request, env, userId, id, exec }) {
  const body = (await readJson(request)) || {};
  const phone = String(body.phone || "");

  const row = await first(env,
    "SELECT phones, bad_phones, hold_note FROM office_calls WHERE id = ? AND assigned_to = ? AND status = 'open'",
    id, userId);
  if (!row) return err("Kontakt nicht gefunden oder bereits abgeschlossen.", 404);
  if (row.hold_note !== null) return err(HELD_MSG, 409);

  const phones = safeParse(row.phones) || [];
  if (!phones.includes(phone)) return err("Unbekannte Telefonnummer.");

  const bad = new Set(safeParse(row.bad_phones) || []);
  if (body.wrong) bad.add(phone); else bad.delete(phone);
  const badList = phones.filter(p => bad.has(p));
  const status = badList.length === phones.length ? "R_TA_fK" : "open";
  const protocol = cleanProtocol(body.protocol);

  // bad_phones = alter Wert → schützt vor gleichzeitigen Änderungen
  const result = await run(env,
    `UPDATE office_calls
     SET bad_phones = ?, protocol = COALESCE(?, protocol), status = ?,
         closed_at = CASE WHEN ? = 'open' THEN closed_at ELSE CURRENT_TIMESTAMP END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open' AND hold_note IS NULL AND bad_phones = ?`,
    JSON.stringify(badList), protocol, status, status,
    id, userId, row.bad_phones);

  if (!result.meta?.changes) return err("Der Kontakt wurde gerade geändert – bitte neu laden.", 409);
  if (status === "R_TA_fK") await syncFkTask(env, exec);
  return ok({ status, bad_phones: badList });
}

async function closeCall({ request, env, userId, id }) {
  const row=await first(env,"SELECT briefing FROM office_calls WHERE id = ? AND assigned_to = ? AND status = 'open'",id,userId);
  if(contactRequestName(row))return err("Bitte für diesen Auftrag die Kontaktdaten erfassen.");
  const body = (await readJson(request)) || {};
  const result = String(body.result || "");
  if (!CALL_RESULTS.includes(result)) return err("Ungültiges Ergebnis.");
  const protocol = cleanProtocol(body.protocol);
  if (!hasReturnNote(protocol)) return err(RETURN_NOTE_MSG);

  return changed(await run(env,
    `UPDATE office_calls
     SET status = ?, protocol = ?, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open' AND hold_note IS NULL`,
    result, protocol, id, userId),
    "Kontakt nicht gefunden, gehalten oder bereits abgeschlossen.");
}

function contactRequestName(call) {
  const prefix="[SmartADM-Skript v1]\n";
  if(!String(call?.briefing||"").startsWith(prefix))return "";
  try {const data=JSON.parse(call.briefing.slice(prefix.length));return data.version===1 ? String(data.contactRequest?.name||"").trim().slice(0,120) : "";}catch{return "";}
}
async function receiveContactDetails({request,env,userId,id,exec}) {
  const call=await first(env,"SELECT briefing,customer_name FROM office_calls WHERE id = ? AND assigned_to = ? AND status = 'open' AND hold_note IS NULL",id,userId);
  if(!call)return err("Kontakt nicht gefunden, gehalten oder bereits abgeschlossen.",404);
  const name=contactRequestName(call);if(!name)return err("Dieser Kontakt ist kein Auftrag zum Erfragen von Kontaktdaten.");
  const body=await readJson(request);
  const phone=String(body?.phone||"").trim(),email=String(body?.email||"").trim();
  if(!phone&&!email)return err("Bitte mindestens Telefonnummer oder E-Mail-Adresse eintragen.");
  if(phone && (phone.length>60 || !/^[+\d\s()/.-]+$/.test(phone) || (phone.match(/\d/g)||[]).length<4))return err("Bitte eine gültige Telefonnummer eintragen.");
  if(email && (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return err("Bitte eine gültige E-Mail-Adresse eintragen.");
  const protocol=[`Kontaktdaten von ${name} erhalten`,phone ? `Telefon: ${phone}` : "",email ? `E-Mail: ${email}` : ""].filter(Boolean).join("\n");
  const result=await run(env,`UPDATE office_calls SET status='R_TA_oT',protocol=?,closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND assigned_to=? AND status='open' AND hold_note IS NULL`,protocol,id,userId);
  if(!result.meta?.changes)return err("Der Kontakt wurde inzwischen abgeschlossen.",409);
  await pushBoss(env,exec,{title:`Kontaktdaten von ${name} erhalten`,body:[phone,email].filter(Boolean).join(" · "),tag:`contact-details-${id}`,url:hrUrl("telefon")});
  return ok();
}

// Notiz speichern, ohne dass ein Versuch gezählt oder der Kontakt abgeschlossen wird.
async function saveCallNote({ request, env, userId, id }) {
  const body = (await readJson(request)) || {};
  return changed(await run(env,
    `UPDATE office_calls SET protocol = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open'`,
    cleanProtocol(body.protocol), id, userId),
    "Kontakt nicht gefunden oder bereits abgeschlossen.");
}

// „Halten“: kein Versuch, kein Abschluss – der Kontakt bleibt offen, nur mit Notiz markiert.
// Dieselbe Route speichert auch Änderungen an der Notiz.
async function holdCall({ request, env, userId, id }) {
  const body = (await readJson(request)) || {};
  const note = cleanHoldNote(body.note);
  if (!note) return err("Bitte kurz notieren, was noch zu klären ist.");

  return changed(await run(env,
    `UPDATE office_calls
     SET hold_note = ?, held_at = COALESCE(held_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open'`,
    note, id, userId), "Kontakt nicht gefunden oder bereits abgeschlossen.");
}

const unholdCall = async ({ env, userId, id }) =>
  changed(await run(env,
    `UPDATE office_calls
     SET hold_note = NULL, held_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND assigned_to = ? AND status = 'open' AND hold_note IS NOT NULL`,
    id, userId), "Kontakt nicht gefunden oder nicht gehalten.");

/* --- Boss --- */

const CALL_SCOPES = {
  open: "c.status = 'open' ORDER BY c.created_at DESC, c.id DESC",
  // R_TA_kK läuft nicht mehr über den Rücklauf, sondern über das Kein-Kontakt-Archiv.
  returned: `c.status <> 'open' AND c.status <> 'R_TA_kK' AND c.kk_state IS NULL AND c.archived_at IS NULL
             ORDER BY c.closed_at DESC, c.id DESC`,
  archived: "c.archived_at IS NOT NULL ORDER BY c.archived_at DESC, c.id DESC LIMIT 1000",   // Kundenarchiv
  kk: "c.kk_state = 'archived' ORDER BY c.kk_archived_at ASC, c.id ASC LIMIT 500"
};

async function listAdminCalls({ env, url }) {
  const scope = url.searchParams.get("scope");
  const where = CALL_SCOPES[scope] || CALL_SCOPES.open;
  return json((await all(env, `${CALL_SELECT} WHERE ${where}`)).map(mapCall));
}

async function createCall({ request, env, userId, exec }) {
  const { error, values } = await parseCallBody(env, await readJson(request));
  if (error) return err(error);

  const result = await run(env,
    `INSERT INTO office_calls
       (assigned_to, customer_name, salutation, phones, branch_id, teams, topics, briefing, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ...values, userId);

  await notifyCalls(env, exec, values[0]);
  return created(result);
}

async function updateCall({ request, env, id }) {
  const { error, values } = await parseCallBody(env, await readJson(request));
  if (error) return err(error);

  return changed(await run(env,
    `UPDATE office_calls
     SET assigned_to = ?, customer_name = ?, salutation = ?, phones = ?, branch_id = ?, teams = ?,
         topics = ?, briefing = ?,
         -- Falsch-Markierungen nur für Nummern behalten, die es noch gibt
         bad_phones = (
           SELECT json_group_array(value) FROM json_each(office_calls.bad_phones)
           WHERE value IN (SELECT value FROM json_each(?))
         ),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    ...values, values[CALL_PHONES_INDEX], id), "Kontakt nicht gefunden.");
}

async function deleteCall({ env, id }) {
  const result = await run(env, "DELETE FROM office_calls WHERE id = ?", id);
  await syncFkTask(env);
  return changed(result, "Kontakt nicht gefunden.");
}

async function reopenCall({ env, id, exec }) {
  const row = await first(env,
    `UPDATE office_calls
     SET status = 'open', attempts = 0, attempt_log = '[]', bad_phones = '[]',
         closed_at = NULL, archived_at = NULL,
         hold_note = NULL, held_at = NULL, kk_state = NULL, kk_archived_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'open'
     RETURNING assigned_to`,
    id);
  if (!row) return err("Kontakt nicht gefunden oder bereits offen.", 404);

  await syncFkTask(env);
  await notifyCalls(env, exec, row.assigned_to);
  return ok();
}

async function archiveCall({ env, id }) {
  const result = await run(env,
    `UPDATE office_calls SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'open' AND archived_at IS NULL`,
    id);
  if (result.meta?.changes) await syncFkTask(env);
  return changed(result, "Kontakt nicht gefunden oder bereits erledigt.");
}

// Rückläufer: Nummer(n) direkt in der Karte ersetzen → Kontakt geht mit neuem Durchlauf zurück.
// Versuchs-Historie (attempt_log, round_log) und Protokoll bleiben erhalten.
async function replaceCallPhones({ request, env, id, exec }) {
  const body = (await readJson(request)) || {};
  const phones = parsePhones(body.phones);
  if (!phones.length) return err("Bitte mindestens eine gültige Telefonnummer eingeben.");
  if (phones.length > MAX_PHONES) return err(MAX_PHONES_MSG);

  const row = await first(env,
    `UPDATE office_calls
     SET phones = ?, bad_phones = '[]', status = 'open', attempts = 0,
         closed_at = NULL, archived_at = NULL,
         hold_note = NULL, held_at = NULL, kk_state = NULL, kk_archived_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status <> 'open'
     RETURNING assigned_to`,
    JSON.stringify(phones), id);
  if (!row) return err("Kontakt nicht gefunden oder bereits offen.", 404);

  await syncFkTask(env);
  await notifyCalls(env, exec, row.assigned_to);
  return ok();
}

/* --- Boss: Kein-Kontakt-Archiv --- */

// Neuer Telefonie-Durchlauf: Zähler auf 0, Durchlauf +1.
// attempt_log, round_log, Protokoll und falsche Nummern bleiben erhalten.
const KK_RELEASE_SET = `
  status = 'open', attempts = 0, rounds = COALESCE(rounds, 1) + 1,
  kk_state = NULL, kk_archived_at = NULL, closed_at = NULL,
  hold_note = NULL, held_at = NULL,
  updated_at = CURRENT_TIMESTAMP`;

async function notifyMany(env, exec, userIds) {
  for (const userId of new Set(userIds)) await notifyCalls(env, exec, userId);
}

async function releaseKkCall({ env, id, exec }) {
  const row = await first(env,
    `UPDATE office_calls SET ${KK_RELEASE_SET}
     WHERE id = ? AND kk_state = 'archived'
     RETURNING assigned_to`,
    id);
  if (!row) return err("Kontakt nicht im Kein-Kontakt-Archiv.", 404);
  await notifyCalls(env, exec, row.assigned_to);
  return ok();
}

async function releaseOldestKkCalls({ request, env, exec }) {
  const body = (await readJson(request)) || {};
  const count = Math.min(Math.max(nonNegInt(body.count, 5), 1), 50);
  const rows = await all(env,
    `UPDATE office_calls SET ${KK_RELEASE_SET}
     WHERE id IN (
       SELECT id FROM office_calls WHERE kk_state = 'archived'
       ORDER BY kk_archived_at ASC, id ASC LIMIT ?
     )
     RETURNING assigned_to`,
    count);
  await notifyMany(env, exec, rows.map(r => r.assigned_to));
  return ok({ released: rows.length });
}

// Endgültig erledigt → verschwindet aus Office (Weiterbearbeitung im BSH-System).
const finishKkCall = async ({ env, id }) =>
  changed(await run(env,
    "DELETE FROM office_calls WHERE id = ? AND kk_state = 'archived'", id),
    "Kontakt nicht im Kein-Kontakt-Archiv.");

/* ================= Kontakt-Pakete =================
 * Der Boss legt importierte Kontakte je Filiale in ein Paket (z. B. aus einer Excel-Liste) –
 * für alle Mitarbeiter oder für einen bestimmten (assigned_to). Mitarbeiter holen sich per Knopf
 * POOL_TAKE Kontakte daraus in die eigene Telefonliste – immer die, die laut Liste als Erste
 * zurückgeholt würden (frühestes Rückholdatum). So wird die Liste nie zu voll.
 * Eigene Tabelle, legt der Worker selbst an.
 */
const POOL_TAKE = 10;
const POOL_MAX_IMPORT = 100;      // Kontakte je Import-Aufruf (Rest schickt die App hinterher)

let poolReady = false;
async function ensurePool(env) {
  if (poolReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS office_call_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER,
    teams INTEGER NOT NULL DEFAULT 0,
    assigned_to TEXT,
    customer_name TEXT NOT NULL,
    salutation TEXT NOT NULL DEFAULT 'Herr',
    phones TEXT NOT NULL,
    topics TEXT,
    briefing TEXT,
    due_date TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // Tabelle aus der ersten Version (ohne Mitarbeiter-Zuordnung) nachrüsten
  const cols = new Set((await all(env, "PRAGMA table_info(office_call_pool)")).map(c => c.name));
  if (!cols.has("assigned_to")) {
    try { await run(env, "ALTER TABLE office_call_pool ADD COLUMN assigned_to TEXT"); } catch { /* gibt es schon */ }
  }
  poolReady = true;
}

// Paket = Filiale ("12"), Videocall ("teams") oder ohne Ort ("") – jeweils für alle ("") oder einen Mitarbeiter.
function poolWhere(place, owner) {
  place = String(place ?? "").trim();
  owner = String(owner ?? "").trim();
  const where = [];
  const args = [];
  if (place === "teams") where.push("teams = 1");
  else if (nonNegInt(place, 0)) { where.push("teams = 0 AND branch_id = ?"); args.push(nonNegInt(place, 0)); }
  else where.push("teams = 0 AND branch_id IS NULL");
  if (owner) { where.push("assigned_to = ?"); args.push(owner); }
  else where.push("assigned_to IS NULL");
  return [where.join(" AND "), args];
}

const POOL_ORDER = "ORDER BY (due_date IS NULL), due_date ASC, id ASC";

const poolPlace = row => row.teams ? "teams" : row.branch_id ? String(row.branch_id) : "";

// Terminort fürs Paket: Filial-ID, "teams" oder leer
async function poolTarget(env, value) {
  const place = String(value ?? "").trim();
  if (place === "teams") return { branchId: null, teams: 1 };
  if (!place) return { branchId: null, teams: 0 };
  const branchId = nonNegInt(place, 0);
  const branch = branchId && await first(env, "SELECT 1 FROM office_branches WHERE id = ?", branchId);
  if (!branch) return { error: "Die gewählte Filiale existiert nicht mehr." };
  return { branchId, teams: 0 };
}

async function poolLabel(env, place) {
  place = String(place ?? "").trim();
  if (place === "teams") return "Teams";
  const branchId = nonNegInt(place, 0);
  const row = branchId && await first(env, "SELECT name FROM office_branches WHERE id = ?", branchId);
  return row?.name || (branchId ? "Filiale gelöscht" : "ohne Filiale");
}

// Mitarbeiter fürs Paket prüfen: leer = alle, sonst ein registrierter Mitarbeiter (nicht der Boss).
async function poolOwner(env, value) {
  const owner = String(value ?? "").trim();
  if (!owner) return { owner: null };
  if (!validUserId(owner) || isBoss(env, owner)) return { error: "Bitte einen Mitarbeiter auswählen." };
  const member = await first(env, "SELECT 1 FROM office_members WHERE clerk_user_id = ?", owner);
  if (!member) return { error: "Mitarbeiter wurde noch nicht in Office registriert." };
  return { owner };
}

// Push an den Mitarbeiter, dem ein Paket gehört – ohne Kundennamen (Sperrbildschirm).
async function notifyPool(env, exec, owner, place) {
  if (!owner) return;
  const [where, args] = poolWhere(place, owner);
  const row = await first(env, `SELECT COUNT(*) AS n FROM office_call_pool WHERE ${where}`, ...args);
  const n = Number(row?.n || 0);
  if (!n) return;
  await runLater(exec, notifyUser(env, owner, {
    title: "Neues Paket",
    body: `Du hast ein Paket mit ${n === 1 ? "1 neuen Kontakt" : `${n} neuen Kontakten`} erhalten.`,
    tag: "pool",
    url: `${APP_PATH}?page=telefon`
  }));
}

function parsePoolContact(c) {
  const name = String(c?.customer_name || "").trim().slice(0, 120);
  const phones = parsePhones(c?.phones);
  if (!name) return { error: "Name fehlt." };
  if (!phones.length) return { error: "Keine gültige Telefonnummer." };
  if (phones.length > MAX_PHONES) return { error: MAX_PHONES_MSG };
  return {
    row: {
      customer_name: name,
      salutation: c?.salutation === "Frau" ? "Frau" : "Herr",
      phones: JSON.stringify(phones),
      topics: JSON.stringify(parseTopics(c?.topics)),
      briefing: String(c?.briefing || "").trim().slice(0, 2000) || null,
      due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(c?.due_date || "")) ? c.due_date : null
    }
  };
}

// Pakete mit Anzahl (ohne Kundennamen). Mitarbeiter sehen die für alle und die eigenen, der Boss alle.
async function listPool({ env, userId }) {
  await ensurePool(env);
  const boss = isBoss(env, userId);
  const rows = await all(env,
    `SELECT p.branch_id, p.teams, p.assigned_to, b.name AS branch_name, m.display_name,
            COUNT(*) AS count, MIN(p.due_date) AS next_due
     FROM office_call_pool p
     LEFT JOIN office_branches b ON b.id = p.branch_id
     LEFT JOIN office_members m ON m.clerk_user_id = p.assigned_to
     ${boss ? "" : "WHERE p.assigned_to IS NULL OR p.assigned_to = ?"}
     GROUP BY p.branch_id, p.teams, p.assigned_to
     ORDER BY p.teams, b.name COLLATE NOCASE, (p.assigned_to IS NOT NULL), m.display_name COLLATE NOCASE`,
    ...(boss ? [] : [userId]));
  return json(rows.map(r => ({
    place: poolPlace(r), branch_name: r.branch_name || null, teams: Boolean(r.teams),
    assigned_to: r.assigned_to || null, display_name: r.display_name || null,
    count: Number(r.count), next_due: r.next_due || null
  })));
}

// Mitarbeiter: bis zu POOL_TAKE Kontakte aus einem Paket in die eigene Liste holen –
// die mit dem frühesten Rückholdatum zuerst, ohne Datum zuletzt.
// Erst wenn weniger als POOL_TAKE Kontakte noch gar nicht angerufen wurden.
// body: { place, mine: true = eigenes Paket, sonst das für alle }
async function takeFromPool({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Pakete holen sich Mitarbeiter in ihre eigene Telefonliste.");
  const member = await first(env, "SELECT 1 FROM office_members WHERE clerk_user_id = ?", userId);
  if (!member) return err("Bitte zuerst in Office registrieren.", 403);
  await ensurePool(env);

  const fresh = await first(env,
    "SELECT COUNT(*) AS n FROM office_calls WHERE assigned_to = ? AND status = 'open' AND COALESCE(attempts, 0) = 0",
    userId);
  const untouched = Number(fresh?.n || 0);
  if (untouched >= POOL_TAKE) {
    return err(`Du hast noch ${untouched} Kontakte, die du noch nicht angerufen hast. Neue gibt es, sobald es weniger als ${POOL_TAKE} sind.`, 409);
  }

  const body = (await readJson(request)) || {};
  const [where, args] = poolWhere(body.place, body.mine ? userId : "");
  const ids = (await all(env,
    `SELECT id FROM office_call_pool WHERE ${where} ${POOL_ORDER} LIMIT ?`, ...args, POOL_TAKE))
    .map(r => r.id);
  if (!ids.length) return err("Dieses Paket ist leer.", 404);

  const list = JSON.stringify(ids);
  const [inserted] = await env.DB.batch([
    stmt(env,
      `INSERT INTO office_calls
         (assigned_to, customer_name, salutation, phones, branch_id, teams, topics, briefing, created_by)
       SELECT ?, customer_name, salutation, phones, branch_id, teams, topics, briefing, created_by
       FROM office_call_pool WHERE id IN (SELECT value FROM json_each(?))
       ${POOL_ORDER}`,
      [userId, list]),
    stmt(env, "DELETE FROM office_call_pool WHERE id IN (SELECT value FROM json_each(?))", [list])
  ]);
  const taken = Number(inserted?.meta?.changes ?? ids.length);
  // Kim bekommt jede Entnahme mit – und wenn das Paket dadurch geschlossen ist.
  const rest = Number((await first(env, `SELECT COUNT(*) AS n FROM office_call_pool WHERE ${where}`, ...args))?.n || 0);
  const [name, paket] = await Promise.all([memberName(env, userId), poolLabel(env, body.place)]);
  const message = {
    title: rest ? "Kontakte aus Paket geholt" : `Paket ${paket} ist leer`,
    body: `${name} hat ${taken === 1 ? "1 Kontakt" : `${taken} Kontakte`} aus „${paket}“ geholt – ` +
      (rest ? `noch ${rest} im Paket.` : "das Paket ist jetzt leer."),
    tag: "pool-boss",
    url: `${APP_PATH}?page=telefon`
  };
  await runLater(exec, Promise.all(bossIds(env).map(bossId => notifyUser(env, bossId, message))));
  return ok({ taken, rest });
}

/* --- Boss --- */

async function listAdminPool({ env }) {
  await ensurePool(env);
  const rows = await all(env,
    `SELECT p.id, p.branch_id, p.teams, p.assigned_to, p.customer_name, p.salutation, p.phones, p.topics, p.briefing,
            p.due_date, p.created_at, b.name AS branch_name, m.display_name
     FROM office_call_pool p
     LEFT JOIN office_branches b ON b.id = p.branch_id
     LEFT JOIN office_members m ON m.clerk_user_id = p.assigned_to
     ORDER BY (p.due_date IS NULL), p.due_date ASC, p.id ASC`);
  return json(rows.map(r => ({
    ...r, place: poolPlace(r), teams: Boolean(r.teams), assigned_to: r.assigned_to || null,
    phones: safeParse(r.phones) || [], topics: safeParse(r.topics) || []
  })));
}

// Import: { place, assigned_to: "" = alle, notify: true beim letzten Teil,
//          contacts: [{ customer_name, salutation, phones, topics, briefing, due_date }] }
async function importPool({ request, env, userId, exec }) {
  const body = (await readJson(request)) || {};
  const list = Array.isArray(body.contacts) ? body.contacts : [];
  if (!list.length) return err("Keine Kontakte übergeben.");
  if (list.length > POOL_MAX_IMPORT) return err(`Höchstens ${POOL_MAX_IMPORT} Kontakte je Schritt.`);

  const place = String(body.place ?? "").trim();
  const target = await poolTarget(env, place);
  if (target.error) return err(target.error);
  const { branchId, teams } = target;
  const who = await poolOwner(env, body.assigned_to);
  if (who.error) return err(who.error);

  await ensurePool(env);
  const rows = [];
  const skipped = [];
  list.forEach((contact, index) => {
    const parsed = parsePoolContact(contact);
    if (parsed.error) skipped.push({ index, error: parsed.error });
    else rows.push(parsed.row);
  });

  // Eine Abfrage für alle Zeilen – D1 zählt Abfragen je Aufruf.
  if (rows.length) {
    await run(env,
      `INSERT INTO office_call_pool
         (branch_id, teams, assigned_to, customer_name, salutation, phones, topics, briefing, due_date, created_by)
       SELECT ?, ?, ?, json_extract(value, '$.customer_name'), json_extract(value, '$.salutation'),
              json_extract(value, '$.phones'), json_extract(value, '$.topics'), json_extract(value, '$.briefing'),
              json_extract(value, '$.due_date'), ?
       FROM json_each(?)`,
      branchId, teams, who.owner, userId, JSON.stringify(rows));
  }
  if (body.notify) await notifyPool(env, exec, who.owner, place);
  return ok({ added: rows.length, skipped });
}

// Paket einem anderen Mitarbeiter (oder allen) geben: { place, from, to } – "" = alle
async function reassignPool({ request, env, exec }) {
  const body = (await readJson(request)) || {};
  await ensurePool(env);
  const who = await poolOwner(env, body.to);
  if (who.error) return err(who.error);
  const [where, args] = poolWhere(body.place, body.from);
  const result = await run(env, `UPDATE office_call_pool SET assigned_to = ? WHERE ${where}`, who.owner, ...args);
  const moved = Number(result.meta?.changes || 0);
  if (moved) await notifyPool(env, exec, who.owner, body.place);
  return ok({ moved });
}

// Einen Kontakt im Paket bearbeiten: { customer_name, salutation, phones, topics, briefing, place, due_date? }
// Die Zuordnung (für alle / Mitarbeiter) bleibt, ein anderer Terminort verschiebt ihn ins passende Paket.
async function updatePoolContact({ request, env, id }) {
  await ensurePool(env);
  const body = (await readJson(request)) || {};
  const parsed = parsePoolContact(body);
  if (parsed.error) return err(parsed.error);
  const target = await poolTarget(env, body.place);
  if (target.error) return err(target.error);
  const r = parsed.row;
  const sets = ["customer_name = ?", "salutation = ?", "phones = ?", "topics = ?", "briefing = ?", "branch_id = ?", "teams = ?"];
  const args = [r.customer_name, r.salutation, r.phones, r.topics, r.briefing, target.branchId, target.teams];
  if (body && Object.prototype.hasOwnProperty.call(body, "due_date")) { sets.push("due_date = ?"); args.push(r.due_date); }
  return changed(await run(env, `UPDATE office_call_pool SET ${sets.join(", ")} WHERE id = ?`, ...args, id),
    "Kontakt ist nicht (mehr) im Paket.");
}

async function deletePoolContact({ env, id }) {
  await ensurePool(env);
  return changed(await run(env, "DELETE FROM office_call_pool WHERE id = ?", id), "Kontakt ist nicht (mehr) im Paket.");
}

// Ganzes Paket leeren: DELETE /admin/pool?place=12&assigned_to=…
async function clearPool({ env, url }) {
  await ensurePool(env);
  const [where, args] = poolWhere(url.searchParams.get("place"), url.searchParams.get("assigned_to"));
  const result = await run(env, `DELETE FROM office_call_pool WHERE ${where}`, ...args);
  return ok({ deleted: Number(result.meta?.changes || 0) });
}

/* ================= Web Push (RFC 8291 / VAPID) ================= */

/*
 * Schlüssel-Quelle:
 *   1. Worker-Variablen VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (falls gesetzt)
 *   2. sonst D1-Tabelle push_config – fehlende Schlüssel erzeugt der Worker
 *      beim ersten Aufruf selbst und speichert sie dort.
 */

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF-SHA-256 mit Ausgabelänge ≤ 32 Byte (ein Block)
const hkdf = async (salt, ikm, info, length) =>
  (await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, length);

let pushConfigCache = null;

async function getPushConfig(env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) {
    return {
      publicKey: env.VAPID_PUBLIC_KEY.trim(),
      privateKey: env.VAPID_PRIVATE_KEY.trim(),
      subject: env.VAPID_SUBJECT.trim()
    };
  }
  if (pushConfigCache) return pushConfigCache;

  const load = () => first(env,
    "SELECT public_key, private_key, subject FROM push_config WHERE id = 1").catch(() => null);

  let row = await load();
  if (!row) return null; // Tabelle oder Zeile fehlt → Push aus

  if (!row.public_key || !row.private_key) {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
    const pub = b64urlEncode(await crypto.subtle.exportKey("raw", keys.publicKey));
    // Nur setzen, wenn noch leer – schützt vor gleichzeitigen ersten Aufrufen
    await run(env,
      `UPDATE push_config SET public_key = ?, private_key = ?
       WHERE id = 1 AND (public_key IS NULL OR private_key IS NULL)`,
      pub, jwk.d);
    row = await load();
  }

  if (!row?.public_key || !row?.private_key || !row?.subject) return null;

  pushConfigCache = {
    publicKey: row.public_key.trim(),
    privateKey: row.private_key.trim(),
    subject: row.subject.trim()
  };
  return pushConfigCache;
}

async function encryptPushPayload(subscription, text) {
  const uaPublic = b64url(subscription.p256dh);
  const authSecret = b64url(subscription.auth);

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))
  ));

  // Header: salt (16) | record size (4) | key length (1) | Server-Public-Key (65)
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;

  return concat(header, asPublic, cipher);
}

let vapidKeyCache = null;

async function vapidSigningKey(config) {
  if (vapidKeyCache) return vapidKeyCache;
  const pub = b64url(config.publicKey);
  vapidKeyCache = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      d: config.privateKey,
      x: b64urlEncode(pub.slice(1, 33)),
      y: b64urlEncode(pub.slice(33, 65))
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return vapidKeyCache;
}

async function vapidAuthorization(config, endpoint) {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: config.subject
  })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(config), enc.encode(`${header}.${claims}`)
  );
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${config.publicKey}`;
}

async function sendPush(env, config, subscription, message) {
  if (!validPushEndpoint(subscription.endpoint)) return { status: 0, service: "", detail: "Push-Dienst nicht erlaubt" };
  const res = await fetch(subscription.endpoint, {
    redirect: "error",
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(config, subscription.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high"
    },
    body: await encryptPushPayload(subscription, JSON.stringify(message))
  });

  const detail = res.ok ? "" : (await res.text()).slice(0, 300);
  if (res.status === 404 || res.status === 410) {
    // Gerät hat die Anmeldung aufgehoben → aufräumen
    await run(env, "DELETE FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint);
  } else if (!res.ok) {
    console.warn("Push fehlgeschlagen:", res.status, detail);
  }
  return {
    status: res.status,
    service: new URL(subscription.endpoint).host,
    detail
  };
}

async function notifyUser(env, userId, message) {
  const config = await getPushConfig(env);
  if (!config) return [];
  const subscriptions = await all(env,
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE clerk_user_id = ?", userId);
  return Promise.all(subscriptions.map(sub =>
    sendPush(env, config, sub, message).catch(error => {
      console.error("Push-Fehler:", error);
      return { status: 0, service: "", detail: String(error?.message || error) };
    })
  ));
}

function taskPushMessage(id, title, dueDate, priority, heading = "Neue Aufgabe in SmartADM Office") {
  const lines = [title];
  if (dueDate) {
    const [, month, day] = dueDate.split("-");
    lines.push(`Fällig: ${day}.${month}.`);
  }
  if (priority === "high") lines.push("Priorität: hoch");
  return {
    title: heading,
    body: lines.join("\n"),
    tag: `task-${id}`,
    url: `${APP_PATH}?page=organisation`
  };
}

async function savePushSubscription({ request, env, userId }) {
  const body = await readJson(request);
  const endpoint = String(body?.endpoint || "");
  const p256dh = String(body?.keys?.p256dh || "");
  const auth = String(body?.keys?.auth || "");

  let valid = false;
  try {
    valid = validPushEndpoint(endpoint) &&
      endpoint.length <= 1000 &&
      b64url(p256dh).length === 65 &&
      b64url(auth).length === 16;
  } catch {}
  if (!valid) return err("Ungültige Push-Anmeldung.");

  await run(env,
    `INSERT INTO push_subscriptions (clerk_user_id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       clerk_user_id = excluded.clerk_user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       updated_at = CURRENT_TIMESTAMP
     WHERE push_subscriptions.clerk_user_id = excluded.clerk_user_id`,
    userId, endpoint, p256dh, auth,
    String(request.headers.get("User-Agent") || "").slice(0, 200));

  return ok();
}

async function deletePushSubscription({ request, env, userId }) {
  const body = await readJson(request);
  await run(env, "DELETE FROM push_subscriptions WHERE endpoint = ? AND clerk_user_id = ?",
    String(body?.endpoint || ""), userId);
  return ok();
}

async function sendTestPush({ env, userId }) {
  if (!(await getPushConfig(env))) {
    return err("Push ist noch nicht eingerichtet (Tabelle push_config fehlt).", 503);
  }
  const results = await notifyUser(env, userId, {
    title: "SmartADM Office",
    body: "Benachrichtigungen funktionieren ✓",
    tag: "test",
    url: APP_PATH
  });
  if (!results.length) return err("Für dieses Gerät ist noch keine Push-Anmeldung gespeichert.", 404);
  return ok({
    sent: results.filter(r => r.status >= 200 && r.status < 300).length,
    total: results.length,
    results
  });
}

// Einmaliger Hinweis an alle Mitarbeiter: neue Version, „Was ist neu?“ ansehen.
// Optional mit eigenem Text: { title, body } – z. B. wenn neue Pflichten bestätigt werden müssen.
async function announceUpdate({ request, env }) {
  const custom = (await readJson(request)) || {};
  if (!(await getPushConfig(env))) {
    return err("Push ist noch nicht eingerichtet (Tabelle push_config fehlt).", 503);
  }
  const rows = await all(env, "SELECT DISTINCT clerk_user_id FROM push_subscriptions");
  const employees = rows.map(r => r.clerk_user_id).filter(id => id && !isBoss(env, id));
  const message = {
    title: cleanText(custom.title, 60) || "SmartADM Office",
    body: cleanText(custom.body, 180) || "Neue Version! Schaue dir jetzt an, was neu ist.",
    tag: "whatsnew",
    url: APP_PATH
  };
  let sent = 0, total = 0;
  for (const id of employees) {
    const results = await notifyUser(env, id, message);
    total += results.length;
    sent += results.filter(r => r.status >= 200 && r.status < 300).length;
  }
  return ok({ employees: employees.length, sent, total });
}

/* ================= SmartADM 5 – Cloudspeicher =================
 * Eigener Bereich neben Office: eigene Tabellen (s5_items, s5_meta), eigene Pfade (/s5/…).
 * Zugriff hat ausschließlich das unten eingetragene Clerk-Konto – Office-Mitarbeiter nicht.
 *
 * Gespeichert wird je Eintrag (Bereich + Schlüssel), nicht als ganze Datei. Jeder Eintrag
 * trägt eine Version; geschrieben wird nur, wenn das Gerät die aktuelle Version kennt.
 * So überschreiben sich Handy und PC nicht gegenseitig.
 */

const S5_USER_ID = "user_3JMu8X64anaxeyWQBKl9OQz6Q5G";   // kim.betcher@schwaebisch-hall.de
const S5_SECTIONS = [
  "profil", "einstellung", "banken", "bma", "termine",
  "abstimmung", "provisionen", "provArchiv", "auswertung"
];
const S5_MAX_OPS = 40;            // D1 erlaubt im Free-Tarif 50 Abfragen je Aufruf
const S5_MAX_KEY = 300;
const S5_MAX_DATA = 1500000;      // Zeichen je Eintrag (D1-Zeilengrenze: 2 MB)

const s5Allowed = (env, userId) => userId === (env.S5_USER_ID || S5_USER_ID);

// Rohes JSON aus der Datenbank wird unverändert durchgereicht – spart Rechenzeit.
const s5ItemJson = row =>
  `{"s":${JSON.stringify(row.section)},"k":${JSON.stringify(row.item_key)},` +
  `"o":${Number(row.ord) || 0},"v":${Number(row.version)},"x":${row.deleted ? 1 : 0},` +
  `"d":${row.deleted || row.data == null ? "null" : row.data}}`;

const s5Raw = body =>
  new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders }
  });

// Alles, was sich seit dem Stand „since“ geändert hat. since = 0 → kompletter Bestand.
async function s5Pull({ env, userId, url }) {
  const since = nonNegInt(url.searchParams.get("since"), 0);

  // Zähler und Einträge in einer Transaktion lesen, damit der Stand zusammenpasst.
  const [meta, items] = await env.DB.batch([
    stmt(env, "SELECT rev FROM s5_meta WHERE user_id = ?", [userId]),
    stmt(env,
      `SELECT section, item_key, data, ord, version, deleted
       FROM s5_items
       WHERE user_id = ? AND rev > ? ${since ? "" : "AND deleted = 0"}
       ORDER BY rev ASC, section ASC, ord ASC`,
      [userId, since])
  ]);

  const rev = Number(meta.results?.[0]?.rev || 0);
  return s5Raw(`{"rev":${rev},"items":[${(items.results || []).map(s5ItemJson).join(",")}]}`);
}

function s5ParseOp(op) {
  const section = String(op?.s ?? "");
  const key = String(op?.k ?? "");
  if (!S5_SECTIONS.includes(section)) return { error: `Unbekannter Bereich: ${section || "–"}` };
  if (!key || key.length > S5_MAX_KEY || key.includes("\u0000")) return { error: "Ungültiger Schlüssel." };

  const deleted = op.x ? 1 : 0;
  const data = deleted ? null : JSON.stringify(op.d);
  if (!deleted && (data === undefined || data === "null")) return { error: "Eintrag ohne Inhalt." };
  if (data && data.length > S5_MAX_DATA) return { error: `Eintrag zu groß: ${section}/${key.slice(0, 40)}` };

  const ord = Number(op.o);
  return { section, key, data, deleted, ord: Number.isFinite(ord) ? ord : 0, base: nonNegInt(op.b, 0) };
}

// Änderungen eines Geräts übernehmen. Je Eintrag gilt: nur schreiben, wenn „b“ (die Version,
// die das Gerät kennt) noch aktuell ist. Sonst kommt der Serverstand als Konflikt zurück.
async function s5Push({ request, env, userId }) {
  const body = await readJson(request);
  const raw = Array.isArray(body?.ops) ? body.ops : null;
  if (!raw || !raw.length) return err("Keine Änderungen übergeben.");
  if (raw.length > S5_MAX_OPS) return err(`Höchstens ${S5_MAX_OPS} Änderungen je Aufruf.`);

  const ops = raw.map(s5ParseOp);
  const invalid = ops.find(op => op.error);
  if (invalid) return err(invalid.error);

  const seen = new Set();
  for (const op of ops) {
    const id = `${op.section}\u0000${op.key}`;
    if (seen.has(id)) return err("Ein Eintrag kommt doppelt vor.");
    seen.add(id);
  }

  // Zähler erhöhen und alle Einträge schreiben – eine Transaktion.
  // Dadurch entspricht die Reihenfolge der Zählerstände der Reihenfolge der Speicherungen.
  const results = await env.DB.batch([
    stmt(env,
      `INSERT INTO s5_meta (user_id, rev) VALUES (?, 1)
       ON CONFLICT(user_id) DO UPDATE SET rev = rev + 1
       RETURNING rev`,
      [userId]),
    ...ops.map(op => stmt(env,
      `INSERT INTO s5_items (user_id, section, item_key, data, ord, version, rev, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, (SELECT rev FROM s5_meta WHERE user_id = ?), ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, section, item_key) DO UPDATE SET
         data = excluded.data, ord = excluded.ord, deleted = excluded.deleted,
         version = s5_items.version + 1, rev = excluded.rev, updated_at = CURRENT_TIMESTAMP
       WHERE s5_items.version = ?
       RETURNING version`,
      [userId, op.section, op.key, op.data, op.ord, userId, op.deleted, op.base]))
  ]);

  const rev = Number(results[0].results?.[0]?.rev || 0);
  const applied = [];
  const rejected = [];
  ops.forEach((op, i) => {
    const version = results[i + 1].results?.[0]?.version;
    if (version) applied.push({ s: op.section, k: op.key, v: Number(version) });
    else rejected.push(op);
  });

  let conflicts = [];
  if (rejected.length) {
    const rows = await all(env,
      `SELECT section, item_key, data, ord, version, deleted FROM s5_items
       WHERE user_id = ? AND (${rejected.map(() => "(section = ? AND item_key = ?)").join(" OR ")})`,
      userId, ...rejected.flatMap(op => [op.section, op.key]));
    conflicts = rows.map(s5ItemJson);
  }

  return s5Raw(`{"rev":${rev},"applied":${JSON.stringify(applied)},"conflicts":[${conflicts.join(",")}]}`);
}

const s5Routes = [
  ["GET", "/s5/pull", s5Pull],
  ["POST", "/s5/push", s5Push]
];

function handleS5(ctx) {
  if (!s5Allowed(ctx.env, ctx.userId)) return err("Kein Zugriff auf SmartADM 5 mit diesem Konto.", 403);
  const found = s5Routes.find(([method, path]) => method === ctx.request.method && path === ctx.url.pathname);
  return found ? found[2](ctx) : err("Endpunkt nicht gefunden.", 404);
}

/* ================= Einsatzplan, Wochenkonto, Vorfälle =================
 * Eigene Tabellen – Urlaub, Lohn und Abrechnung bleiben davon unberührt.
 *
 * Einsatzplan: Die Mitarbeiterin trägt ihre Telefontage mit Startzeit ein (höchstens 3 je
 * Kalenderwoche, Vertrag § 5). Sagt sie ab, bekommt der Boss sofort einen Push mit Grund.
 * Ist 30 Minuten nach dem geplanten Start nichts passiert, bekommt sie eine Erinnerung;
 * nach 90 Minuten ohne Aktivität und ohne Absage bekommt der Boss Aufgabe + Push.
 * Aktivität = Arbeitszeit für den Tag oder Bewegung in der Telefonliste (Versuch, Halten, Abschluss).
 *
 * Läuft über den Cron-Trigger (scheduled, alle 15 Minuten) und zusätzlich bei jedem Laden
 * der Boss-Aufgaben – fehlt der Cron, kommt der Hinweis spätestens, wenn der Boss Office öffnet.
 */

const PLAN_REMINDER_MIN = 30;
const PLAN_ALERT_MIN = 90;
// Jede Aktivität am geplanten Tag zählt – auch wenn sie früher als geplant anfängt (z. B. 08:00 statt 17:00).
const PLAN_MAX_AHEAD_DAYS = 60;
const PLAN_STATUSES = ["planned", "started", "missed", "late", "cancelled"];
const WEEK_RESULTS = ["unexcused", "excused", "employer"];
const INCIDENT_KINDS = ["no_cancel", "late_sick", "talk", "warning", "other"];
const INCIDENT_LABELS = {
  no_cancel: "Nicht erschienen ohne Absage",
  late_sick: "Krankmeldung verspätet",
  talk: "Gespräch geführt",
  warning: "Abmahnung",
  other: "Sonstiges"
};
const WEEKDAYS_DE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

let hrReady = false;
async function ensureHr(env) {
  if (hrReady) return;
  await env.DB.batch([
    `CREATE TABLE IF NOT EXISTS work_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clerk_user_id TEXT NOT NULL,
      plan_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      cancel_reason TEXT,
      cancelled_at TEXT,
      cancelled_in_time INTEGER,
      started_at TEXT,
      reminded_at TEXT,
      alerted_at TEXT,
      alert_task_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS work_plans_one_per_day
       ON work_plans (clerk_user_id, plan_date) WHERE status <> 'cancelled'`,
    `CREATE INDEX IF NOT EXISTS work_plans_date ON work_plans (plan_date, status)`,
    `CREATE TABLE IF NOT EXISTS week_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clerk_user_id TEXT NOT NULL,
      week_start TEXT NOT NULL,
      result TEXT NOT NULL,
      note TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (clerk_user_id, week_start))`,
    `CREATE TABLE IF NOT EXISTS hr_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clerk_user_id TEXT NOT NULL,
      incident_date TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      handed_over_on TEXT,
      plan_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS notice_acks (
      clerk_user_id TEXT NOT NULL,
      version TEXT NOT NULL,
      acknowledged_at TEXT DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT,
      PRIMARY KEY (clerk_user_id, version))`,
    `CREATE TABLE IF NOT EXISTS week_planning (
      clerk_user_id TEXT NOT NULL, week_start TEXT NOT NULL,
      reason TEXT, completed_at TEXT,
      PRIMARY KEY (clerk_user_id, week_start))`,
    `CREATE TABLE IF NOT EXISTS hr_flags (
      flag TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
  ].map(sql => env.DB.prepare(sql)));
  hrReady = true;
}

/* --- Zeit in Berlin --- */

function berlinParts(ms = Date.now()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(ms)).map(x => [x.type, x.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    utcLike: Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  };
}

const berlinOffsetMin = ms => Math.round((berlinParts(ms).utcLike - Math.floor(ms / 1000) * 1000) / 60000);

// Berliner Datum + Uhrzeit → Zeitpunkt (ms). Zwei Durchgänge, damit die Sommerzeit stimmt.
function berlinToMs(date, time = "00:00") {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const guess = naive - berlinOffsetMin(naive) * 60000;
  return naive - berlinOffsetMin(guess) * 60000;
}

const sqlTime = ms => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const sqlToMs = text => Date.parse(String(text || "").replace(" ", "T") + "Z");

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDe(date) {
  const d = new Date(`${date}T12:00:00Z`);
  const [, m, day] = date.split("-");
  return `${WEEKDAYS_DE[d.getUTCDay()]} ${day}.${m}.`;
}

const validClock = value => validTime(value) && Number(value.slice(0, 2)) < 24 && Number(value.slice(3)) < 60;
const planStartMs = plan => berlinToMs(plan.plan_date, plan.start_time);
const hrUrl = page => `${APP_PATH}?page=${page}`;

async function pushBoss(env, exec, message) {
  await runLater(exec, Promise.all(bossIds(env).map(id => notifyUser(env, id, message))));
}

/* --- Einsatzplan (Mitarbeiter) --- */

const PLAN_COLS = [
  "id", "clerk_user_id", "plan_date", "start_time", "note", "status", "cancel_reason",
  "cancelled_at", "cancelled_in_time", "started_at", "reminded_at", "alerted_at",
  "alert_task_id", "created_at", "updated_at"
];

async function listOwnPlans({ env, userId }) {
  await ensureHr(env);
  const today = berlinToday();
  return json(await all(env,
    `SELECT ${PLAN_COLS.join(", ")} FROM work_plans
     WHERE clerk_user_id = ? AND plan_date >= ?
     ORDER BY plan_date ASC, start_time ASC, id ASC`,
    userId, addDays(mondayOfWeek(today), -56)));
}

async function employmentOf(env, userId) {
  return (await first(env,
    "SELECT start_date, end_date FROM employee_profiles WHERE clerk_user_id = ?", userId).catch(() => null)) || {};
}

// Prüft Datum/Uhrzeit eines (neuen oder geänderten) Einsatztags.
async function checkPlanSlot(env, userId, date, time, ignoreId = null) {
  const today = berlinToday();
  if (!validDate(date)) return "Bitte ein gültiges Datum wählen.";
  if (!validClock(time)) return "Bitte eine gültige Startzeit wählen.";
  if (date < today) return "Vergangene Tage können nicht mehr geplant werden.";
  if (date > addDays(today, PLAN_MAX_AHEAD_DAYS)) return `Höchstens ${PLAN_MAX_AHEAD_DAYS} Tage im Voraus planen.`;
  if (berlinToMs(date, time) <= Date.now()) return "Die Startzeit liegt schon in der Vergangenheit.";

  const job = await employmentOf(env, userId);
  if (job.start_date && date < job.start_date) return "Vor deinem Arbeitsbeginn kann nicht geplant werden.";
  if (job.end_date && date > job.end_date) return "Nach dem Ende deines Arbeitsverhältnisses kann nicht geplant werden.";

  const ignore = ignoreId ? "AND id <> ?" : "";
  const extra = ignoreId ? [ignoreId] : [];
  const same = await first(env,
    `SELECT id FROM work_plans WHERE clerk_user_id = ? AND plan_date = ? AND status <> 'cancelled' ${ignore}`,
    userId, date, ...extra);
  if (same) return "Für diesen Tag ist schon ein Einsatz geplant.";

  const monday = mondayOfWeek(date);
  const count = await first(env,
    `SELECT COUNT(*) AS n FROM work_plans
     WHERE clerk_user_id = ? AND plan_date BETWEEN ? AND ? AND status <> 'cancelled' ${ignore}`,
    userId, monday, addDays(monday, 6), ...extra);
  if (Number(count?.n || 0) >= CONTRACT_MAX_WORKDAYS_PER_WEEK) {
    return `In der ${isoWeekLabel(monday)} sind schon ${CONTRACT_MAX_WORKDAYS_PER_WEEK} Tage geplant (Vertrag: höchstens ${CONTRACT_MAX_WORKDAYS_PER_WEEK} Tage pro Woche).`;
  }
  return null;
}

function parsePlanBody(body) {
  return {
    date: String(body?.plan_date || "").trim(),
    time: String(body?.start_time || "").trim(),
    note: cleanText(body?.note, 200)
  };
}

async function createPlan({ request, env, userId }) {
  if (isBoss(env, userId)) return err("Der Einsatzplan wird von den Mitarbeitern selbst gepflegt.");
  await ensureHr(env);
  const plan = parsePlanBody(await readJson(request));
  const problem = await checkPlanSlot(env, userId, plan.date, plan.time);
  if (problem) return err(problem);
  try {
    return created(await run(env,
      "INSERT INTO work_plans (clerk_user_id, plan_date, start_time, note) VALUES (?, ?, ?, ?)",
      userId, plan.date, plan.time, plan.note));
  } catch {
    return err("Für diesen Tag ist schon ein Einsatz geplant.");
  }
}

async function ownOpenPlan(env, userId, id) {
  return first(env,
    `SELECT ${PLAN_COLS.join(", ")} FROM work_plans WHERE id = ? AND clerk_user_id = ?`, id, userId);
}

async function updatePlan({ request, env, userId, id, exec }) {
  await ensureHr(env);
  const current = await ownOpenPlan(env, userId, id);
  if (!current) return err("Einsatz nicht gefunden.", 404);
  if (current.status !== "planned") return err("Dieser Einsatz kann nicht mehr geändert werden.");
  if (Date.now() >= planStartMs(current)) {
    return err("Der geplante Start ist schon vorbei – bitte stattdessen absagen.");
  }

  const plan = parsePlanBody(await readJson(request));
  const problem = await checkPlanSlot(env, userId, plan.date, plan.time, id);
  if (problem) return err(problem);

  const result = await run(env,
    `UPDATE work_plans SET plan_date = ?, start_time = ?, note = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND clerk_user_id = ? AND status = 'planned'`,
    plan.date, plan.time, plan.note, id, userId);

  // Kurzfristige Änderung (heute oder morgen) → Boss erfährt es sofort.
  const today = berlinToday();
  const dayName = date => (date === today ? "heute" : date === addDays(today, 1) ? "morgen" : fmtDe(date));
  if (current.plan_date <= addDays(today, 1) && (plan.date !== current.plan_date || plan.time !== current.start_time)) {
    const name = await memberName(env, userId);
    await pushBoss(env, exec, {
      title: `Einsatz verschoben: ${name}`,
      body: `${dayName(current.plan_date)} ${current.start_time} Uhr → ${dayName(plan.date)} ${plan.time} Uhr`,
      tag: `plan-${id}`,
      url: hrUrl("einsatz")
    });
  }
  return changed(result, "Einsatz nicht gefunden.");
}

async function deletePlan({ env, userId, id }) {
  await ensureHr(env);
  const current = await ownOpenPlan(env, userId, id);
  if (!current) return err("Einsatz nicht gefunden.", 404);
  // Ab dem Vortag verlässt sich der Boss auf den Termin → dann nur noch „Absagen“ mit Grund.
  if (current.status !== "planned" || current.plan_date <= addDays(berlinToday(), 1)) {
    return err("Ab dem Vortag bitte „Absagen“ mit Grund verwenden.");
  }
  return changed(await run(env,
    "DELETE FROM work_plans WHERE id = ? AND clerk_user_id = ? AND status = 'planned'", id, userId),
    "Einsatz nicht gefunden.");
}

async function cancelPlan({ request, env, userId, id, exec }) {
  await ensureHr(env);
  const body = (await readJson(request)) || {};
  const reason = String(body.reason || "").trim().slice(0, 300);
  if (reason.length < 3) return err("Bitte kurz den Grund für die Absage angeben.");

  const current = await ownOpenPlan(env, userId, id);
  if (!current) return err("Einsatz nicht gefunden.", 404);
  if (!["planned", "missed"].includes(current.status)) return err("Dieser Einsatz kann nicht mehr abgesagt werden.");
  if (current.plan_date < addDays(berlinToday(), -1)) return err("Dieser Einsatz liegt zu weit zurück.");

  const inTime = Date.now() < planStartMs(current) ? 1 : 0;
  const row = await first(env,
    `UPDATE work_plans SET status = 'cancelled', cancel_reason = ?, cancelled_at = CURRENT_TIMESTAMP,
       cancelled_in_time = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND clerk_user_id = ? AND status IN ('planned', 'missed')
     RETURNING alert_task_id`,
    reason, inTime, id, userId);
  if (!row) return err("Einsatz nicht gefunden.", 404);

  const nowText = berlinParts().time;
  if (row.alert_task_id) {
    await run(env,
      `UPDATE office_tasks SET description = COALESCE(description, '') || ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      `\n\nNachträglich abgesagt um ${nowText} Uhr. Grund: ${reason}`, row.alert_task_id);
  }

  const name = await memberName(env, userId);
  const when = current.plan_date === berlinToday() ? "heute" : fmtDe(current.plan_date);
  await pushBoss(env, exec, {
    title: inTime ? `Absage: ${name}` : `Späte Absage: ${name}`,
    body: `${when}, ${current.start_time} Uhr${inTime ? "" : ` (abgesagt um ${nowText} Uhr)`}\nGrund: ${reason}`,
    tag: `plan-${id}`,
    url: hrUrl("einsatz")
  });
  return ok({ cancelled_in_time: Boolean(inTime) });
}

/* --- Automatische Prüfung --- */

async function planHasActivity(env, plan) {
  const work = await first(env,
    "SELECT 1 AS hit FROM work_entries WHERE clerk_user_id = ? AND work_date = ? LIMIT 1",
    plan.clerk_user_id, plan.plan_date);
  if (work) return true;

  const from = sqlTime(berlinToMs(plan.plan_date, "00:00"));
  const to = sqlTime(berlinToMs(addDays(plan.plan_date, 1), "00:00"));
  const call = await first(env,
    `SELECT 1 AS hit FROM office_calls c
     WHERE c.assigned_to = ? AND (
       (c.held_at >= ? AND c.held_at < ?) OR
       (c.closed_at >= ? AND c.closed_at < ?) OR
       (json_valid(c.attempt_log) AND EXISTS (
         SELECT 1 FROM json_each(c.attempt_log) j WHERE j.value >= ? AND j.value < ?)))
     LIMIT 1`,
    plan.clerk_user_id, from, to, from, to, from, to);
  return Boolean(call);
}

async function checkPlans(env, exec = null) {
  await ensureHr(env);
  const today = berlinToday();
  const now = Date.now();
  const plans = await all(env,
    `SELECT ${PLAN_COLS.join(", ")} FROM work_plans
     WHERE status IN ('planned', 'missed') AND plan_date BETWEEN ? AND ?`,
    addDays(today, -14), today);

  for (const plan of plans) {
    const start = planStartMs(plan);
    const heute = plan.plan_date === today;
    // Vor der geplanten Startzeit nur prüfen, ob sie heute schon (früher) angefangen hat
    if (now < start && !heute) continue;

    if (await planHasActivity(env, plan)) {
      if (plan.status === "planned") {
        await run(env,
          `UPDATE work_plans SET status = 'started', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'planned'`, plan.id);
        continue;
      }
      const late = await first(env,
        `UPDATE work_plans SET status = 'late', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'missed' RETURNING alert_task_id`, plan.id);
      if (late?.alert_task_id) {
        await run(env,
          `UPDATE office_tasks SET description = COALESCE(description, '') || ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          `\n\nNachtrag: Um ${berlinParts(now).time} Uhr war doch Aktivität in Office zu sehen (verspäteter Start).`,
          late.alert_task_id);
      }
      continue;
    }

    if (plan.status !== "planned" || now < start) continue;
    const minutes = (now - start) / 60000;

    if (minutes >= PLAN_ALERT_MIN) {
      const claimed = await first(env,
        `UPDATE work_plans SET status = 'missed', alerted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'planned' RETURNING id`, plan.id);
      if (!claimed) continue;

      const name = await memberName(env, plan.clerk_user_id);
      const deadline = berlinParts(start + PLAN_ALERT_MIN * 60000).time;
      const title = `Einsatz ohne Absage: ${name}, ${fmtDe(plan.plan_date)}`;
      const description =
        `Geplanter Start: ${plan.start_time} Uhr. Bis ${deadline} Uhr keine Aktivität in Office und keine Absage.\n` +
        "Unter „Mitarbeiter“ → „Einsatzplan & Wochenkonto“ kannst du die Woche einordnen und unter „Vorfälle & Abmahnungen“ den Vorfall festhalten.";
      const task = await run(env,
        `INSERT INTO office_tasks (assigned_to, created_by, title, description, due_date, priority, status)
         VALUES (?, 'system', ?, ?, NULL, 'high', 'open')`,
        BOSS_INBOX, title, description);
      const taskId = task.meta?.last_row_id;
      await run(env, "UPDATE work_plans SET alert_task_id = ? WHERE id = ?", taskId, plan.id);
      await pushBoss(env, exec, {
        title: "Einsatz ohne Absage",
        body: `${name}: ${plan.plan_date === today ? "heute" : fmtDe(plan.plan_date)} ${plan.start_time} Uhr geplant – keine Aktivität, keine Absage.`,
        tag: `plan-${plan.id}`,
        url: hrUrl("organisation")
      });
      continue;
    }

    if (minutes >= PLAN_REMINDER_MIN && !plan.reminded_at) {
      const claimed = await first(env,
        `UPDATE work_plans SET reminded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'planned' AND reminded_at IS NULL RETURNING id`, plan.id);
      if (!claimed) continue;
      await runLater(exec, notifyUser(env, plan.clerk_user_id, {
        title: "Dein Einsatz heute",
        body: `Geplant war ${plan.start_time} Uhr. Falls du heute nicht kannst, sag bitte jetzt in Office ab – mit kurzem Grund.`,
        tag: `plan-${plan.id}`,
        url: hrUrl("dashboard")
      }));
    }
  }
}

// Dauer bleibt im vorhandenen Notizformat gespeichert; alte Einsätze entsprechen zwei Stunden.
function plannedMinutes(plan) {
  const m = /^Geplante Dauer: (\d{1,2}):([0-5]\d) h(?:\r?\n|$)/.exec(String(plan.note || ""));
  const n = m ? Number(m[1])*60 + Number(m[2]) : 120;
  return n > 0 && n <= 1440 ? n : 120;
}
function planningWeek(date) {
  const weekday = new Date(date+"T12:00:00Z").getUTCDay() || 7;
  const week = weekday >= 5 ? addDays(mondayOfWeek(date),7) : mondayOfWeek(date);
  return addDays(week,-3) >= "2026-10-21" ? week : null;
}
function sundayReminderSlot(now) {
  if(new Date(now.date+"T12:00:00Z").getUTCDay() !== 0) return null;
  // Nur das aktuelle Zeitfenster nachholen: Ein verspäteter Cron verschickt keine Serie alter Pushes.
  return ["17:00","13:00","09:00"].find(time => now.time >= time) || null;
}
async function weekPlanComplete(env,userId,week) {
  const saved = await first(env,"SELECT completed_at FROM week_planning WHERE clerk_user_id = ? AND week_start = ?",userId,week);
  if(saved?.completed_at) return true;
  const plans=await all(env,"SELECT note FROM work_plans WHERE clerk_user_id = ? AND plan_date BETWEEN ? AND ? AND status <> 'cancelled'",userId,week,addDays(week,6));
  // Bereits vollständig geplante Alt-Wochen benötigen keine erneute Bestätigung.
  return plans.length > 0 && plans.length <= 3 && plans.reduce((sum,p)=>sum+plannedMinutes(p),0) === 360;
}
async function ensureWeekPlanningTask(env,userId,week=planningWeek(berlinToday())) {
  if(!week || isBoss(env,userId))return;
  await ensureHr(env);
  if(await weekPlanComplete(env,userId,week)) {
    await run(env,"UPDATE office_tasks SET status = 'completed', completed_at = COALESCE(completed_at,CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE assigned_to = ? AND created_by = ? AND status = 'open'",userId,"week-plan:"+week);
    return;
  }
  const job=await employmentOf(env,userId);
  if(!job.start_date || job.start_date > addDays(week,6) || job.end_date && job.end_date < week)return;
  await run(env,`INSERT INTO office_tasks (assigned_to,created_by,title,description,due_date,priority,status)
    SELECT ?,?,'Bitte Folgewoche planen',?,?,'high','open'
    WHERE NOT EXISTS (SELECT 1 FROM office_tasks WHERE assigned_to = ? AND created_by = ?)`,
    userId,"week-plan:"+week,
    `Plane deine Arbeitstage für die ${isoWeekLabel(week)}. Mehr oder weniger als sechs Stunden sind mit kurzer Begründung möglich. Freitag und Samstag kannst du jeweils auf morgen verschieben; Sonntag ist die Planung verbindlich.`,
    addDays(week,-1),userId,"week-plan:"+week);
}
async function confirmWeekPlanning({request,env,userId}) {
  if(isBoss(env,userId))return err("Nur für Mitarbeiter.",403);
  await ensureHr(env);
  const body=await readJson(request),week=String(body?.week_start || "");
  if(!validDate(week) || mondayOfWeek(week)!==week)return err("Bitte eine gültige Woche wählen.");
  const plans=await all(env,"SELECT note FROM work_plans WHERE clerk_user_id = ? AND plan_date BETWEEN ? AND ? AND status <> 'cancelled'",userId,week,addDays(week,6));
  if(!plans.length || plans.length > 3)return err("Bitte plane ein bis drei Arbeitstage.");
  const total=plans.reduce((sum,p)=>sum+plannedMinutes(p),0);
  const reason=total===360 ? "" : String(body?.reason || "").trim().replace(/\s+/g," ");
  if(total!==360 && !reason)return err("Bei mehr oder weniger als sechs Stunden ist eine Begründung nötig.");
  if(reason.length>120)return err("Bitte die Begründung auf 120 Zeichen kürzen.");
  await env.DB.batch([
    stmt(env,`INSERT INTO week_planning (clerk_user_id,week_start,reason,completed_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(clerk_user_id,week_start) DO UPDATE SET reason=excluded.reason,completed_at=excluded.completed_at`,[userId,week,reason||null]),
    stmt(env,"UPDATE office_tasks SET status='completed', completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE assigned_to=? AND created_by=?",[userId,"week-plan:"+week])
  ]);
  return ok({week_start:week,minutes:total});
}
async function remindWeekPlanning(env, exec = null) {
  await ensureHr(env);
  const now=berlinParts(),week=planningWeek(now.date);
  if(!week)return;
  const people=await all(env,`SELECT clerk_user_id FROM employee_profiles
    WHERE start_date IS NOT NULL AND start_date <= ? AND (end_date IS NULL OR end_date='' OR end_date >= ?)`,addDays(week,6),week);
  const slot=sundayReminderSlot(now);
  for(const {clerk_user_id:id} of people){
    if(!id || isBoss(env,id))continue;
    await ensureWeekPlanningTask(env,id,week);
    if(!slot || await weekPlanComplete(env,id,week))continue;
    const flag=`week-plan:${id}:${week}:${slot}`;
    const claimed=await run(env,"INSERT OR IGNORE INTO hr_flags (flag) VALUES (?)",flag);
    if(!claimed.meta?.changes)continue;
    try {
      // Hier abwarten, damit fehlgeschlagene Zustellung beim nächsten Cron erneut versucht werden kann.
      const results=await notifyUser(env,id,{
        title:"Bitte Folgewoche planen",
        body:`Deine Planung für die ${isoWeekLabel(week)} fehlt noch. Bitte lege jetzt deine Arbeitstage fest. Bei mehr oder weniger als sechs Stunden trage eine kurze Begründung ein.`,
        tag:`week-plan-${week}-${slot.replace(":","")}`,url:hrUrl("dashboard")
      });
      if(!results.length || !results.some(r=>r.status>=200 && r.status<300))await run(env,"DELETE FROM hr_flags WHERE flag = ?",flag);
    }catch(error){await run(env,"DELETE FROM hr_flags WHERE flag = ?",flag);throw error;}
  }
}

/* --- Einsatzplan (Boss) --- */

async function listAdminPlans({ env, url, exec }) {
  await ensureHr(env);
  await checkPlans(env, exec).catch(e => console.error("checkPlans:", e.message));
  const filter = String(url.searchParams.get("user_id") || "").trim();
  const from = validDate(url.searchParams.get("from")) ? url.searchParams.get("from") : addDays(berlinToday(), -120);
  const to = validDate(url.searchParams.get("to")) ? url.searchParams.get("to") : addDays(berlinToday(), PLAN_MAX_AHEAD_DAYS);
  const byUser = validUserId(filter);
  return json(await all(env,
    `SELECT ${PLAN_COLS.map(c => `p.${c}`).join(", ")}, m.display_name, m.email
     FROM work_plans p LEFT JOIN office_members m ON m.clerk_user_id = p.clerk_user_id
     WHERE p.plan_date BETWEEN ? AND ? ${byUser ? "AND p.clerk_user_id = ?" : ""}
     ORDER BY p.plan_date DESC, p.start_time DESC, p.id DESC`,
    from, to, ...(byUser ? [filter] : [])));
}

async function deleteAdminPlan({ env, id }) {
  await ensureHr(env);
  return changed(await run(env, "DELETE FROM work_plans WHERE id = ?", id), "Einsatz nicht gefunden.");
}

/* --- Wochenkonto --- */

async function getWeekAccount({ env, userId }) {
  await ensureHr(env);
  const [reviews, job, absences] = await Promise.all([
    all(env, "SELECT id, week_start, result FROM week_reviews WHERE clerk_user_id = ? ORDER BY week_start", userId),
    employmentOf(env, userId),
    all(env,
      `SELECT absence_date, absence_type, paid_minutes FROM employee_absences
       WHERE clerk_user_id = ? ORDER BY absence_date`, userId).catch(() => [])
  ]);
  return json({
    reviews,
    absences,
    start_date: job.start_date || null,
    end_date: job.end_date || null,
    weekly_minutes: CONTRACT_WEEKLY_HOURS * 60,
    max_days: CONTRACT_MAX_WORKDAYS_PER_WEEK
  });
}

async function listWeekReviews({ env, owner }) {
  await ensureHr(env);
  return json(await all(env,
    `SELECT id, week_start, result, note, created_at, updated_at FROM week_reviews
     WHERE clerk_user_id = ? ORDER BY week_start DESC`, owner));
}

async function saveWeekReview({ request, env, owner, userId }) {
  await ensureHr(env);
  const body = (await readJson(request)) || {};
  const weekStart = String(body.week_start || "").trim();
  const result = String(body.result || "").trim();
  const note = cleanText(body.note, 500);

  if (!validDate(weekStart) || mondayOfWeek(weekStart) !== weekStart) return err("Ungültige Woche.");
  if (addDays(weekStart, 6) >= berlinToday()) return err("Eine Woche kann erst eingeordnet werden, wenn sie vorbei ist.");
  if (!WEEK_RESULTS.includes(result)) return err("Bitte eine Einordnung wählen.");

  await run(env,
    `INSERT INTO week_reviews (clerk_user_id, week_start, result, note, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(clerk_user_id, week_start) DO UPDATE SET
       result = excluded.result, note = excluded.note, created_by = excluded.created_by,
       updated_at = CURRENT_TIMESTAMP`,
    owner, weekStart, result, note, userId);
  return ok();
}

async function deleteWeekReview({ env, owner, id }) {
  await ensureHr(env);
  return changed(await run(env, "DELETE FROM week_reviews WHERE id = ? AND clerk_user_id = ?", id, owner),
    "Einordnung nicht gefunden.");
}

/* --- Vorfälle & Abmahnungen (nur Boss) --- */

const INCIDENT_COLS = [
  "id", "clerk_user_id", "incident_date", "kind", "description", "handed_over_on",
  "plan_id", "created_at", "updated_at"
];

function parseIncidentBody(body) {
  const date = String(body?.incident_date || "").trim();
  const kind = String(body?.kind || "").trim();
  const description = String(body?.description || "").trim().slice(0, 4000);
  const handedOver = String(body?.handed_over_on || "").trim() || null;
  const planId = body?.plan_id ? nonNegInt(body.plan_id, 0) || null : null;

  if (!validDate(date)) return { error: "Bitte ein gültiges Datum eingeben." };
  if (date > berlinToday()) return { error: "Vorfälle können nicht in der Zukunft liegen." };
  if (!INCIDENT_KINDS.includes(kind)) return { error: "Bitte eine Art auswählen." };
  if (!description) return { error: "Bitte beschreiben, was passiert ist." };
  if (handedOver) {
    if (kind !== "warning") return { error: "Ein Übergabedatum gibt es nur bei Abmahnungen." };
    if (!validDate(handedOver)) return { error: "Ungültiges Übergabedatum." };
    if (handedOver < date) return { error: "Die Übergabe kann nicht vor dem Vorfall liegen." };
  }
  return { values: [date, kind, description, handedOver, planId] };
}

async function listIncidents({ env, owner }) {
  await ensureHr(env);
  return json(await all(env,
    `SELECT ${INCIDENT_COLS.join(", ")} FROM hr_incidents
     WHERE clerk_user_id = ? ORDER BY incident_date DESC, id DESC`, owner));
}

async function createIncident({ request, env, owner }) {
  await ensureHr(env);
  const parsed = parseIncidentBody(await readJson(request));
  if (parsed.error) return err(parsed.error);
  return created(await run(env,
    `INSERT INTO hr_incidents (clerk_user_id, incident_date, kind, description, handed_over_on, plan_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    owner, ...parsed.values));
}

async function updateIncident({ request, env, owner, id }) {
  await ensureHr(env);
  const parsed = parseIncidentBody(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [date, kind, description, handedOver, planId] = parsed.values;
  return changed(await run(env,
    `UPDATE hr_incidents SET incident_date = ?, kind = ?, description = ?, handed_over_on = ?,
       plan_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND clerk_user_id = ?`,
    date, kind, description, handedOver, planId, id, owner), "Vorfall nicht gefunden.");
}

async function deleteIncident({ env, owner, id }) {
  await ensureHr(env);
  return changed(await run(env, "DELETE FROM hr_incidents WHERE id = ? AND clerk_user_id = ?", id, owner),
    "Vorfall nicht gefunden.");
}

/* --- Bestätigung neuer Regeln („Was ist neu?“) --- */

const validNoticeVersion = v => /^[\w.-]{1,40}$/.test(String(v || ""));

async function listOwnAcks({ env, userId }) {
  await ensureHr(env);
  return json(await all(env,
    "SELECT version, acknowledged_at FROM notice_acks WHERE clerk_user_id = ? ORDER BY acknowledged_at DESC",
    userId));
}

async function acknowledgeNotice({ request, env, userId, exec }) {
  await ensureHr(env);
  const body = (await readJson(request)) || {};
  const version = String(body.version || "").trim();
  if (!validNoticeVersion(version)) return err("Ungültige Version.");

  const result = await run(env,
    "INSERT OR IGNORE INTO notice_acks (clerk_user_id, version, user_agent) VALUES (?, ?, ?)",
    userId, version, String(request.headers.get("User-Agent") || "").slice(0, 200));

  if (result.meta?.changes && !isBoss(env, userId)) {
    const name = await memberName(env, userId);
    await pushBoss(env, exec, {
      title: "Neue Regeln bestätigt",
      body: `${name} hat „Was ist neu?“ (${version}) gelesen und bestätigt.`,
      tag: `ack-${version}`,
      url: hrUrl("mitarbeiter")
    });
  }
  const row = await first(env,
    "SELECT version, acknowledged_at FROM notice_acks WHERE clerk_user_id = ? AND version = ?", userId, version);
  return ok(row || { version });
}

async function listAdminAcks({ env, owner }) {
  await ensureHr(env);
  return json(await all(env,
    "SELECT version, acknowledged_at, user_agent FROM notice_acks WHERE clerk_user_id = ? ORDER BY acknowledged_at DESC",
    owner));
}

/* ================= Arbeitsvertrag: Dokumente & Nachtrag mit Unterschrift =================
 * Dokumente (z. B. der eingescannte Arbeitsvertrag) lädt der Boss hoch. Gespeichert in
 * Stücken, weil eine D1-Zeile höchstens 2 MB fassen darf. Der Mitarbeiter sieht nur seine eigenen.
 *
 * Nachtrag: Der Text liegt hier im Worker (nicht in der öffentlichen Seite), die Personendaten
 * kommen aus den Stammdaten. Beide Seiten unterschreiben mit dem Finger. Jede Unterschrift
 * speichert den Text, wie er unterschrieben wurde, samt Prüfsumme. Ändern sich die Daten,
 * bevor beide unterschrieben haben, gilt eine ältere Unterschrift nicht mehr und muss neu geleistet werden.
 */

const DOC_MAX_BYTES = 8 * 1024 * 1024;
const DOC_CHUNK = 900000;                       // Zeichen Base64 je Zeile
const DOC_MIMES = ["application/pdf", "image/jpeg", "image/png"];
const SIGNATURE_MAX = 300000;
// Der Nachtrag gilt ausschließlich für diese Mitarbeiterin. Beim ersten Aufruf wird ihr Konto
// über die E-Mail gefunden und danach fest über die Clerk-ID zugeordnet.
const ADDENDUM_EMAIL = "schreitersaskia@gmail.com";

const ADDENDUM = {
  version: "nachtrag-2026-10",
  title: "Nachtrag zum Arbeitsvertrag",
  sections: [
    {
      heading: "§ 1 Einsatzplanung",
      items: [
        "Die Arbeitnehmerin legt ihre Arbeitstage weiterhin selbst fest (§ 5 des Arbeitsvertrags). Sie trägt jeden Arbeitstag vorab mit Datum und Startzeit in den Einsatzplan der Anwendung „SmartADM 5 Office“ ein.",
        "Je Kalenderwoche werden höchstens drei Arbeitstage geplant.",
        "Die Arbeitstage einer Kalenderwoche sind spätestens am Sonntag der Vorwoche bis 20:00 Uhr eingetragen.",
        "Ein eingetragener Arbeitstag ist verbindlich. Änderungen sind bis zur geplanten Startzeit in der Anwendung möglich; ab dem Vortag nur noch über eine Absage nach § 2."
      ]
    },
    {
      heading: "§ 2 Absage und Arbeitsverhinderung",
      items: [
        "Kann die Arbeitnehmerin einen eingetragenen Arbeitstag nicht wahrnehmen, sagt sie ihn vor der geplanten Startzeit über die Funktion „Absagen“ in der Anwendung ab und gibt kurz den Grund an.",
        "Ist die Anwendung nicht erreichbar, erfolgt die Absage vor der Startzeit per Anruf oder Textnachricht an den Arbeitgeber.",
        "Bei Arbeitsunfähigkeit infolge Krankheit teilt die Arbeitnehmerin dies und die voraussichtliche Dauer unverzüglich mit, sobald sie davon weiß (§ 5 Abs. 1 Entgeltfortzahlungsgesetz, § 17 des Arbeitsvertrags). Die Mitteilung erfolgt nach Absatz 1 oder 2.",
        "Der Arbeitgeber kann verlangen, dass die Arbeitsunfähigkeit bereits ab dem ersten Tag ärztlich festgestellt wird.",
        "Ein eingetragener Arbeitstag, der weder wahrgenommen noch rechtzeitig abgesagt wird, gilt als Verstoß gegen die Pflichten aus diesem Nachtrag. Wiederholte Verstöße können arbeitsrechtliche Maßnahmen bis zur Abmahnung nach sich ziehen."
      ]
    },
    {
      heading: "§ 3 Wochenarbeitszeit und Nacharbeit",
      items: [
        "Die vereinbarte Arbeitszeit beträgt weiterhin 6 Stunden je Kalenderwoche (§ 5 des Arbeitsvertrags). In Wochen mit Beginn oder Ende des Arbeitsverhältnisses und in Zeiten der Freistellung nach § 6 des Arbeitsvertrags gilt sie anteilig.",
        {
          text: "Bleibt die Arbeitszeit einer Woche darunter, wird die Differenz wie folgt behandelt:",
          sub: [
            "Von der Arbeitnehmerin zu vertreten (z. B. Arbeitstag ohne rechtzeitige Absage nicht wahrgenommen): Die fehlenden Stunden werden in den folgenden Wochen nachgearbeitet.",
            "Von keiner Seite zu vertreten (z. B. rechtzeitige Absage, Arbeitsunfähigkeit ohne Anspruch auf Entgeltfortzahlung): Die Stunden werden nicht vergütet und nicht nachgearbeitet. Gesetzliche Ansprüche auf Entgeltfortzahlung bleiben unberührt.",
            "Vom Arbeitgeber zu vertreten (z. B. fehlende Kontakte, Absage durch den Arbeitgeber): Die Stunden werden als bezahlte Freistellung vergütet."
          ]
        },
        "Die Einordnung nimmt der Arbeitgeber vor; sie ist für die Arbeitnehmerin in der Anwendung einsehbar. Mehrarbeit über die vereinbarte Arbeitszeit hinaus bedarf weiterhin der Zustimmung des Arbeitgebers; nachgearbeitete Stunden gelten nicht als Mehrarbeit."
      ]
    },
    {
      heading: "§ 4 Erfassung und Benachrichtigungen",
      items: [
        "Die Anwendung speichert zu jedem Arbeitstag Datum, Startzeit, Status, Absagen mit Grund und Zeitpunkt sowie den Beginn der Aktivität (erfasste Arbeitszeit, Anrufversuche in der Telefonliste). Die Daten dienen ausschließlich der Durchführung des Arbeitsverhältnisses und sind nur dem Arbeitgeber und der Arbeitnehmerin zugänglich.",
        "Die Arbeitnehmerin erhält eine Erinnerung, wenn 30 Minuten nach der geplanten Startzeit keine Aktivität vorliegt. Der Arbeitgeber wird über Absagen, kurzfristige Änderungen und Arbeitstage ohne Aktivität und ohne Absage automatisch benachrichtigt.",
        "Die Arbeitnehmerin hält die Benachrichtigungen der Anwendung auf ihrem Gerät aktiviert."
      ]
    },
    {
      heading: "§ 5 Schlussbestimmungen",
      items: [
        "Dieser Nachtrag wird wirksam, sobald beide Parteien unterschrieben haben, und ist Bestandteil des Arbeitsvertrags. Alle übrigen Regelungen des Arbeitsvertrags gelten unverändert weiter.",
        "Änderungen und Ergänzungen bedürfen der Textform (§ 22 des Arbeitsvertrags).",
        "Sollte eine Bestimmung dieses Nachtrags unwirksam sein, bleiben die übrigen Bestimmungen wirksam. An die Stelle der unwirksamen Bestimmung tritt die gesetzliche Regelung.",
        "Beide Parteien unterschreiben elektronisch in der Anwendung „SmartADM 5 Office“. Jede Partei kann den unterschriebenen Nachtrag dort jederzeit ansehen und als PDF herunterladen."
      ]
    }
  ]
};

let contractsReady = false;
async function ensureContracts(env) {
  if (contractsReady) return;
  await env.DB.batch([
    `CREATE TABLE IF NOT EXISTS employee_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clerk_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      chunks INTEGER NOT NULL,
      uploaded_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS employee_document_chunks (
      document_id INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (document_id, idx))`,
    `CREATE TABLE IF NOT EXISTS addendum_signatures (
      clerk_user_id TEXT NOT NULL,
      version TEXT NOT NULL,
      role TEXT NOT NULL,
      signer_id TEXT NOT NULL,
      signer_name TEXT,
      signature TEXT NOT NULL,
      doc_json TEXT NOT NULL,
      doc_hash TEXT NOT NULL,
      signed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      user_agent TEXT,
      PRIMARY KEY (clerk_user_id, version, role))`,
    `CREATE TABLE IF NOT EXISTS addendum_targets (
      clerk_user_id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
  ].map(sql => env.DB.prepare(sql)));
  contractsReady = true;
}

// Für wen gibt es den Nachtrag? Nur für das fest zugeordnete Konto.
async function addendumTarget(env) {
  await ensureContracts(env);
  const pinned = await first(env, "SELECT clerk_user_id FROM addendum_targets LIMIT 1");
  if (pinned) return pinned.clerk_user_id;
  const hits = await all(env, "SELECT clerk_user_id FROM office_members WHERE lower(email) = ?", ADDENDUM_EMAIL);
  if (hits.length !== 1 || isBoss(env, hits[0].clerk_user_id)) return null;
  await run(env, "INSERT OR IGNORE INTO addendum_targets (clerk_user_id) VALUES (?)", hits[0].clerk_user_id);
  return hits[0].clerk_user_id;
}
const addendumFor = async (env, userId) => (await addendumTarget(env)) === userId;
const NO_ADDENDUM = { available: false };

const deDate = iso => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const cityOf = zipCity => String(zipCity || "").replace(/^\s*\d{4,5}\s+/, "").trim();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Nachtrag mit den aktuellen Stammdaten zusammensetzen.
async function renderAddendum(env, userId) {
  const [employer, employee] = await Promise.all([
    first(env, "SELECT name, street, zip_city FROM office_employer WHERE id = 1").catch(() => null),
    first(env, "SELECT full_name, street, zip_city, birth_date, start_date FROM employee_profiles WHERE clerk_user_id = ?", userId).catch(() => null)
  ]);
  const e = employer || {}, a = employee || {};
  const missing = [
    [e.name, "Arbeitgeber: Name"], [e.street, "Arbeitgeber: Straße"], [e.zip_city, "Arbeitgeber: PLZ und Ort"],
    [a.full_name, "Mitarbeiter: vollständiger Name"], [a.street, "Mitarbeiter: Straße"],
    [a.zip_city, "Mitarbeiter: PLZ und Ort"], [a.birth_date, "Mitarbeiter: Geburtsdatum"], [a.start_date, "Mitarbeiter: Eintritt"]
  ].filter(([v]) => !v).map(([, label]) => label);

  const doc = {
    version: ADDENDUM.version,
    title: ADDENDUM.title,
    employer: { name: e.name || "", street: e.street || "", zip_city: e.zip_city || "" },
    employee: { name: a.full_name || "", street: a.street || "", zip_city: a.zip_city || "", birth_date: a.birth_date || "" },
    intro: [
      `Zwischen ${e.name || "[Arbeitgeber]"}, ${e.street || "[Straße]"}, ${e.zip_city || "[PLZ Ort]"} – nachfolgend „Arbeitgeber“ –`,
      `und ${a.full_name || "[Name]"}, ${a.street || "[Straße]"}, ${a.zip_city || "[PLZ Ort]"}, geboren am ${deDate(a.birth_date) || "[Geburtsdatum]"} – nachfolgend „Arbeitnehmerin“ –`,
      `wird zum Arbeitsvertrag mit Beginn am ${deDate(a.start_date) || "[Eintritt]"} folgender Nachtrag vereinbart. Er konkretisiert die Regelungen zur Arbeitszeit (§ 5) und zur Arbeitsverhinderung (§ 17) des Arbeitsvertrags.`
    ],
    sections: ADDENDUM.sections,
    place: cityOf(e.zip_city),
    place_employee: cityOf(a.zip_city)
  };
  return { doc, missing, hash: await sha256Hex(JSON.stringify(doc)) };
}

// Stand für einen Mitarbeiter: Text, gültige Unterschriften, fertig ja/nein.
async function addendumState(env, userId) {
  await ensureContracts(env);
  const [current, rows] = await Promise.all([
    renderAddendum(env, userId),
    all(env, `SELECT role, signer_name, signature, doc_json, doc_hash, signed_at FROM addendum_signatures
              WHERE clerk_user_id = ? AND version = ?`, userId, ADDENDUM.version)
  ]);
  const by = Object.fromEntries(rows.map(r => [r.role, r]));
  const complete = Boolean(by.employee && by.employer && by.employee.doc_hash === by.employer.doc_hash);
  const hash = complete ? by.employee.doc_hash : current.hash;
  const valid = role => (by[role] && by[role].doc_hash === hash
    ? { signer_name: by[role].signer_name, signed_at: by[role].signed_at, signature: by[role].signature } : null);
  return {
    version: ADDENDUM.version,
    ready: complete || current.missing.length === 0,
    missing: complete ? [] : current.missing,
    complete,
    hash,
    doc: complete ? safeParse(by.employee.doc_json) : current.doc,
    signatures: { employee: valid("employee"), employer: valid("employer") }
  };
}

function parseSignature(body) {
  const signature = String(body?.signature || "");
  if (String(body?.version || "") !== ADDENDUM.version) return { error: "Der Nachtrag wurde inzwischen geändert. Bitte die Seite neu laden." };
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > SIGNATURE_MAX) {
    return { error: "Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben." };
  }
  return { signature };
}

async function storeSignature(env, request, userId, role, signerId, signerName, signature, state) {
  await run(env,
    `INSERT INTO addendum_signatures (clerk_user_id, version, role, signer_id, signer_name, signature, doc_json, doc_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(clerk_user_id, version, role) DO UPDATE SET
       signer_id = excluded.signer_id, signer_name = excluded.signer_name, signature = excluded.signature,
       doc_json = excluded.doc_json, doc_hash = excluded.doc_hash, signed_at = CURRENT_TIMESTAMP,
       user_agent = excluded.user_agent`,
    userId, ADDENDUM.version, role, signerId, signerName, signature,
    JSON.stringify(state.doc), state.hash, String(request.headers.get("User-Agent") || "").slice(0, 200));
}

/* --- Mitarbeiter --- */

async function getOwnAddendum({ env, userId }) {
  if (!(await addendumFor(env, userId))) return json(NO_ADDENDUM);
  return json(await addendumState(env, userId));
}

async function signOwnAddendum({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Als Boss unterschreibst du über die Mitarbeiter-Ansicht.");
  if (!(await addendumFor(env, userId))) return err("Für dich gibt es keinen Nachtrag.", 404);
  const body = (await readJson(request)) || {};
  const parsed = parseSignature(body);
  if (parsed.error) return err(parsed.error);

  const state = await addendumState(env, userId);
  if (!state.ready) return err("Der Nachtrag ist noch nicht vollständig vorbereitet. Kim ist informiert.");
  if (state.signatures.employee) return ok(await addendumState(env, userId));

  await storeSignature(env, request, userId, "employee", userId, state.doc.employee.name, parsed.signature, state);

  // Die Unterschrift gilt zugleich als Bestätigung von „Was ist neu?“.
  if (validNoticeVersion(body.notice_version)) {
    await ensureHr(env);
    await run(env, "INSERT OR IGNORE INTO notice_acks (clerk_user_id, version, user_agent) VALUES (?, ?, ?)",
      userId, String(body.notice_version), String(request.headers.get("User-Agent") || "").slice(0, 200));
  }

  const after = await addendumState(env, userId);
  await pushBoss(env, exec, {
    title: "Nachtrag unterschrieben",
    body: after.complete
      ? `${state.doc.employee.name} hat unterschrieben – der Nachtrag ist damit vollständig.`
      : `${state.doc.employee.name} hat den Nachtrag unterschrieben. Bitte gegenzeichnen.`,
    tag: `addendum-${userId}`,
    url: hrUrl("mitarbeiter")
  });
  return ok(after);
}

/* --- Boss --- */

async function listAdminAddenda({ env }) {
  const target = await addendumTarget(env);
  if (!target) return json([]);
  const people = await all(env, "SELECT clerk_user_id, full_name FROM employee_profiles WHERE clerk_user_id = ?", target).catch(() => []);
  const out = [];
  for (const p of people) {
    const s = await addendumState(env, p.clerk_user_id);
    out.push({
      clerk_user_id: p.clerk_user_id, name: p.full_name, ready: s.ready, missing: s.missing, complete: s.complete,
      employee_signed: Boolean(s.signatures.employee), employer_signed: Boolean(s.signatures.employer)
    });
  }
  return json(out);
}

const getAdminAddendum = async ({ env, owner }) =>
  json((await addendumFor(env, owner)) ? await addendumState(env, owner) : NO_ADDENDUM);

async function signAdminAddendum({ request, env, owner, userId, exec }) {
  const body = (await readJson(request)) || {};
  const parsed = parseSignature(body);
  if (parsed.error) return err(parsed.error);
  if (!(await addendumFor(env, owner))) return err("Für diesen Mitarbeiter gibt es keinen Nachtrag.", 404);
  const state = await addendumState(env, owner);
  if (!state.ready) return err(`Es fehlen noch Stammdaten: ${state.missing.join(", ")}.`);
  if (state.signatures.employer) return ok(state);

  await storeSignature(env, request, owner, "employer", userId, state.doc.employer.name, parsed.signature, state);
  const after = await addendumState(env, owner);
  if (after.complete) {
    await runLater(exec, notifyUser(env, owner, {
      title: "Nachtrag vollständig unterschrieben",
      body: "Kim hat gegengezeichnet. Du findest den Nachtrag unter „Mehr“ → „Meine Unterlagen“ zum Herunterladen.",
      tag: "addendum",
      url: hrUrl("vertrag")
    }));
  }
  return ok(after);
}

async function resetAdminAddendum({ env, owner }) {
  await ensureContracts(env);
  await run(env, "DELETE FROM addendum_signatures WHERE clerk_user_id = ? AND version = ?", owner, ADDENDUM.version);
  return ok();
}

/* --- Dokumente --- */

const DOC_COLS = "id, title, file_name, mime, size, created_at";

async function listDocuments(env, userId) {
  await ensureContracts(env);
  return all(env, `SELECT ${DOC_COLS} FROM employee_documents WHERE clerk_user_id = ? ORDER BY created_at DESC, id DESC`, userId);
}

const listOwnDocuments = async ({ env, userId }) => json(await listDocuments(env, userId));
const listAdminDocuments = async ({ env, owner }) => json(await listDocuments(env, owner));

async function documentResponse(env, userId, id) {
  await ensureContracts(env);
  const doc = await first(env, `SELECT ${DOC_COLS}, chunks FROM employee_documents WHERE id = ? AND clerk_user_id = ?`, id, userId);
  if (!doc) return err("Dokument nicht gefunden.", 404);
  const parts = await all(env, "SELECT data FROM employee_document_chunks WHERE document_id = ? ORDER BY idx", id);
  const b64 = parts.map(p => p.data).join("");
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ascii = doc.file_name.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
  return new Response(bytes, {
    headers: {
      ...corsHeaders,
      "Content-Type": doc.mime,
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.file_name)}`,
      "Cache-Control": "private, no-store"
    }
  });
}

const getOwnDocument = ({ env, userId, id }) => documentResponse(env, userId, id);
const getAdminDocument = ({ env, owner, id }) => documentResponse(env, owner, id);

async function uploadAdminDocument({ request, env, owner, userId }) {
  await ensureContracts(env);
  const body = (await readJson(request)) || {};
  const title = cleanText(body.title, 120) || "Dokument";
  const fileName = cleanText(String(body.file_name || "").replace(/[\\/]/g, "_"), 160) || "dokument.pdf";
  const mime = String(body.mime || "");
  const data = String(body.data || "").replace(/\s/g, "");
  if (!DOC_MIMES.includes(mime)) return err("Bitte eine PDF-Datei oder ein Bild (JPG/PNG) hochladen.");
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return err("Die Datei konnte nicht gelesen werden.");
  const size = Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > DOC_MAX_BYTES) return err("Die Datei ist größer als 8 MB.");

  const chunks = [];
  for (let i = 0; i < data.length; i += DOC_CHUNK) chunks.push(data.slice(i, i + DOC_CHUNK));
  const result = await run(env,
    `INSERT INTO employee_documents (clerk_user_id, title, file_name, mime, size, chunks, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, owner, title, fileName, mime, size, chunks.length, userId);
  const id = result.meta?.last_row_id;
  try {
    for (let i = 0; i < chunks.length; i++) {
      await run(env, "INSERT INTO employee_document_chunks (document_id, idx, data) VALUES (?, ?, ?)", id, i, chunks[i]);
    }
  } catch (e) {
    await env.DB.batch([
      stmt(env, "DELETE FROM employee_document_chunks WHERE document_id = ?", [id]),
      stmt(env, "DELETE FROM employee_documents WHERE id = ?", [id])
    ]);
    console.error("Upload fehlgeschlagen:", e.message);
    return err("Die Datei konnte nicht gespeichert werden.", 500);
  }
  return created(result);
}

async function deleteAdminDocument({ env, owner, id }) {
  await ensureContracts(env);
  const doc = await first(env, "SELECT id FROM employee_documents WHERE id = ? AND clerk_user_id = ?", id, owner);
  if (!doc) return err("Dokument nicht gefunden.", 404);
  await env.DB.batch([
    stmt(env, "DELETE FROM employee_document_chunks WHERE document_id = ?", [id]),
    stmt(env, "DELETE FROM employee_documents WHERE id = ?", [id])
  ]);
  return ok();
}

/* ================= Persönliche Einstellungen (Startseite der Mitarbeiter) ================= */

const PREFS_MAX = 20000;
let prefsReady = false;
async function ensurePrefs(env) {
  if (prefsReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS user_prefs (
    clerk_user_id TEXT PRIMARY KEY,
    prefs TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  prefsReady = true;
}

async function getOwnPrefs({ env, userId }) {
  await ensurePrefs(env);
  const row = await first(env, "SELECT prefs, updated_at FROM user_prefs WHERE clerk_user_id = ?", userId);
  return json({ prefs: row ? safeParse(row.prefs) : null, updated_at: row?.updated_at || null });
}

async function saveOwnPrefs({ request, env, userId }) {
  await ensurePrefs(env);
  const body = await readJson(request);
  const prefs = body?.prefs;
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return err("Ungültige Einstellungen.");
  const text = JSON.stringify(prefs);
  if (text.length > PREFS_MAX) return err("Die Einstellungen sind zu groß.");
  await run(env,
    `INSERT INTO user_prefs (clerk_user_id, prefs, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(clerk_user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = CURRENT_TIMESTAMP`,
    userId, text);
  return ok();
}

/* ================= Routing ================= */

const route = (method, path, handler, opts = {}) => ({
  method,
  pattern: new RegExp(`^${path.replace(/:id/g, "(\\d+)")}$`),
  handler,
  ...opts
});

// target: true → Admin-Route, die ?user_id= benötigt (wird zu ctx.owner)
const routes = [
  route("GET", "/me", ({ env, userId }) =>
    json({ authenticated: true, userId, role: roleOf(env, userId) })),
  route("PUT", "/me/profile", upsertOfficeMember),
  route("POST", "/plans/week/confirm", confirmWeekPlanning),
  route("POST", "/calls/:id/contact-details", receiveContactDetails),
  route("GET", "/me/prefs", getOwnPrefs),
  route("PUT", "/me/prefs", saveOwnPrefs),

  route("GET", "/tasks", getOwnTasks),
  route("PUT", "/tasks/:id/complete", completeOwnTask),
  route("POST", "/tasks", createTaskForBoss),
  route("DELETE", "/tasks/:id", withdrawTaskForBoss),

  route("GET", "/entries", listEntries),
  route("POST", "/entries", createEntry),
  route("PUT", "/entries/:id", updateEntry),
  route("DELETE", "/entries/:id", deleteEntry),

  route("GET", "/settings", getSettings),
  route("GET", "/branches", listBranches),

  route("GET", "/appointment-adjustments", listOwnAdjustments),
  route("GET", "/calls", listOwnCalls),
  route("POST", "/calls/:id/attempt", registerCallAttempt),
  route("POST", "/calls/:id/close", closeCall),
  route("PUT", "/calls/:id/note", saveCallNote),
  route("POST", "/calls/:id/phone", flagCallPhone),
  route("POST", "/calls/:id/hold", holdCall),
  route("POST", "/calls/:id/unhold", unholdCall),
  route("GET", "/pool", listPool),
  route("POST", "/pool/take", takeFromPool),

  route("PUT", "/push/subscription", savePushSubscription),
  route("DELETE", "/push/subscription", deletePushSubscription),
  route("POST", "/push/test", sendTestPush),

  route("GET", "/plans", listOwnPlans),
  route("POST", "/plans", createPlan),
  route("PUT", "/plans/:id", updatePlan),
  route("DELETE", "/plans/:id", deletePlan),
  route("POST", "/plans/:id/cancel", cancelPlan),
  route("GET", "/week-account", getWeekAccount),
  route("GET", "/notices/acks", listOwnAcks),
  route("POST", "/notices/ack", acknowledgeNotice),
  route("GET", "/addendum", getOwnAddendum),
  route("GET", "/payslips", listOwnPayslips),
  route("GET", "/close-requests", listOwnCloseRequests),
  route("POST", "/close-requests/answer", answerCloseRequest),
  route("POST", "/payslips/sign", signOwnPayslip),
  route("POST", "/addendum/sign", signOwnAddendum),
  route("GET", "/documents", listOwnDocuments),
  route("GET", "/documents/:id", getOwnDocument),

  route("GET", "/admin/security-monitor", getSecurityMonitor),
  route("GET", "/admin/users", getAdminUsers),
  route("GET", "/admin/entries", listEntries, { target: true }),
  route("PUT", "/admin/settings", updateSettings),
  route("POST", "/admin/branches", createBranch),
  route("PUT", "/admin/branches/:id", updateBranch),
  route("DELETE", "/admin/branches/:id", deleteBranch),
  route("GET", "/admin/calls", listAdminCalls),
  route("POST", "/admin/calls", createCall),
  route("PUT", "/admin/calls/:id", updateCall),
  route("DELETE", "/admin/calls/:id", deleteCall),
  route("PUT", "/admin/calls/:id/reopen", reopenCall),
  route("PUT", "/admin/calls/:id/archive", archiveCall),
  route("PUT", "/admin/calls/:id/phones", replaceCallPhones),
  route("POST", "/admin/calls/kk/release-oldest", releaseOldestKkCalls),
  route("PUT", "/admin/calls/:id/kk-release", releaseKkCall),
  route("PUT", "/admin/calls/:id/kk-done", finishKkCall),
  route("GET", "/admin/pool", listAdminPool),
  route("POST", "/admin/pool", importPool),
  route("PUT", "/admin/pool/:id", updatePoolContact),
  route("DELETE", "/admin/pool/:id", deletePoolContact),
  route("DELETE", "/admin/pool", clearPool),
  route("PUT", "/admin/pool/assign", reassignPool),
  route("GET", "/admin/tasks", getAdminTasks),
  route("POST", "/admin/tasks", createAdminTask),
  route("POST", "/admin/push/announce", announceUpdate),
  route("DELETE", "/admin/tasks/:id", deleteAdminTask),
  route("PUT", "/admin/tasks/:id/reopen", reopenAdminTask),
  route("PUT", "/admin/tasks/:id/complete", completeInboxTask),
  route("GET", "/admin/payroll-settings", getPayrollSettings, { target: true }),
  route("PUT", "/admin/payroll-settings", updatePayrollSettings, { target: true }),
  route("GET", "/admin/monthly-closings", getMonthlyClosings, { target: true }),
  route("GET", "/admin/employee-profile", getEmployeeProfile, { target: true }),
  route("PUT", "/admin/employee-profile", updateEmployeeProfile, { target: true }),
  route("GET", "/admin/absences", listAbsences, { target: true }),
  route("GET", "/admin/appointment-adjustments", listAdjustments, { target: true }),
  route("POST", "/admin/appointment-adjustments", createAdjustment, { target: true }),
  route("POST", "/admin/absences", createAbsence, { target: true }),
  route("PUT", "/admin/absences/:id", updateAbsence, { target: true }),
  route("DELETE", "/admin/absences/:id", deleteAbsence, { target: true }),
  route("GET", "/admin/employer", getEmployer),
  route("PUT", "/admin/employer", updateEmployer),
  route("GET", "/admin/contribution-reports", getContributionReports, { target: true }),
  route("PUT", "/admin/contribution-reports", upsertContributionReport, { target: true }),
  route("PUT", "/admin/contribution-reports/:id", updateContributionReport),
  route("POST", "/admin/monthly-closings", createMonthlyClosing, { target: true }),
  route("GET", "/admin/plans", listAdminPlans),
  route("DELETE", "/admin/plans/:id", deleteAdminPlan),
  route("GET", "/admin/week-reviews", listWeekReviews, { target: true }),
  route("PUT", "/admin/week-reviews", saveWeekReview, { target: true }),
  route("DELETE", "/admin/week-reviews/:id", deleteWeekReview, { target: true }),
  route("GET", "/admin/incidents", listIncidents, { target: true }),
  route("POST", "/admin/incidents", createIncident, { target: true }),
  route("PUT", "/admin/incidents/:id", updateIncident, { target: true }),
  route("DELETE", "/admin/incidents/:id", deleteIncident, { target: true }),
  route("GET", "/admin/notice-acks", listAdminAcks, { target: true }),
  route("GET", "/admin/addenda", listAdminAddenda),
  route("GET", "/admin/payslips", listAdminPayslips, { target: true }),
  route("GET", "/admin/close-requests", listAdminCloseRequests, { target: true }),
  route("POST", "/admin/close-requests", createCloseRequest, { target: true }),
  route("POST", "/admin/payslips/sign", signAdminPayslip, { target: true }),
  route("GET", "/admin/uv-lohnnachweis", getUvLohnnachweis),
  route("GET", "/admin/addendum", getAdminAddendum, { target: true }),
  route("POST", "/admin/addendum/sign", signAdminAddendum, { target: true }),
  route("DELETE", "/admin/addendum", resetAdminAddendum, { target: true }),
  route("GET", "/admin/documents", listAdminDocuments, { target: true }),
  route("POST", "/admin/documents", uploadAdminDocument, { target: true }),
  route("GET", "/admin/documents/:id", getAdminDocument, { target: true }),
  route("DELETE", "/admin/documents/:id", deleteAdminDocument, { target: true })
];

/* ================= Sicherheitsprüfung und dauerhafte Überwachung ================= */

async function officeAllowed(env, userId) {
  return isBoss(env, userId) || !!await first(env,
    "SELECT 1 FROM employee_profiles WHERE clerk_user_id = ?", userId);
}
function validPushEndpoint(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      (u.hostname === "fcm.googleapis.com" || u.hostname === "web.push.apple.com" ||
       u.hostname === "updates.push.services.mozilla.com" ||
       /^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname));
  } catch { return false; }
}
let securityReady = false;
async function ensureSecurity(env) {
  if (securityReady) return;
  await run(env, `CREATE TABLE IF NOT EXISTS security_metrics (
    hour TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(hour, kind))`);
  await run(env, `CREATE TABLE IF NOT EXISTS security_monitor_state (
    check_key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0, task_id INTEGER, notified INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT, last_ok TEXT, detail TEXT)`);
  securityReady = true;
}
async function recordSecurityMetric(env, kind) {
  await ensureSecurity(env);
  const hour = new Date().toISOString().slice(0, 13);
  await run(env, `INSERT INTO security_metrics(hour, kind, count) VALUES (?, ?, 1)
    ON CONFLICT(hour, kind) DO UPDATE SET count = count + 1`, hour, kind);
}
async function securityCheckResult(env, key, healthy, detail) {
  await ensureSecurity(env);
  const old = await first(env, "SELECT * FROM security_monitor_state WHERE check_key = ?", key);
  const failures = healthy ? 0 : Number(old?.failures || 0) + 1;
  const active = !healthy && failures >= 2;
  let taskId = old?.task_id || null;
  let notified = old?.notified || 0;
  if (active && !old?.active) {
    const task = await run(env, `INSERT INTO office_tasks
      (assigned_to, created_by, title, description, priority, status)
      VALUES (?, 'security-monitor', ?, ?, 'high', 'open')`, BOSS_INBOX,
      `Sicherheitsmonitor: ${key}`, `${detail}\nZwei aufeinanderfolgende Prüfungen auffällig. Dies ist kein Nachweis eines erfolgreichen Angriffs.`);
    taskId = task.meta?.last_row_id || null;
    notified = 0;
  }
  if (healthy && old?.active) {
    if (taskId) await run(env, "UPDATE office_tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ? AND created_by = 'security-monitor'", taskId);
    await Promise.all(bossIds(env).map(id => notifyUser(env, id, {
      title: "Sicherheitsmonitor: wieder unauffällig", body: key,
      tag: `security-${key}`, url: `${APP_PATH}?page=organisation`
    })));
    notified = 0;
  }
  if (active && !notified) {
    const results = await Promise.all(bossIds(env).map(id => notifyUser(env, id, {
      title: "Sicherheitsmonitor: Prüfung erforderlich", body: `${key}: ${detail}`,
      tag: `security-${key}`, url: `${APP_PATH}?page=organisation`
    })));
    notified = results.flat().some(r => r.status >= 200 && r.status < 300) ? 1 : 0;
  }
  await run(env, `INSERT INTO security_monitor_state
    (check_key, failures, active, task_id, notified, checked_at, last_ok, detail)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CASE WHEN ? THEN CURRENT_TIMESTAMP END, ?)
    ON CONFLICT(check_key) DO UPDATE SET failures = excluded.failures, active = excluded.active,
      task_id = excluded.task_id, notified = excluded.notified, checked_at = excluded.checked_at,
      last_ok = COALESCE(excluded.last_ok, security_monitor_state.last_ok), detail = excluded.detail`,
    key, failures, active ? 1 : 0, taskId, notified, healthy ? 1 : 0, detail);
  if (active) console.warn(JSON.stringify({ event: "security.monitor_alert", check: key, detail }));
}
// BEGIN MONITORED_ASSETS (generated by scripts/update-security-baseline.py)
const MONITORED_ASSETS = {
  "/index.html": "7e60f96e09362a6b200917a62fb449180dcf9a63236aef24122b4b8c3adece9a",
  "/kb.css": "94fc9d3b5382f0604a2772cc4d8573ea6a4b25b9c77cd8dc8d949e6fd790c432",
  "/smartadm/sales/index.html": "b82b016eb1c57e53b2af504b754caa802bc04eb1d2a50722bd785355374f9719",
  "/smartadm/sales/cloud.js": "b62ef1f8fa93b3c9b8e6007c622c8e2771dda3220e979c77eb1c55084b5e0e26",
  "/smartadm/office/": "5658a7757890285cfd6c42ac4a52db30c00cf777982bd085e325d86c34919d4f",
  "/smartadm/office/sw.js": "6511d6967746e83342953639c96d37884644f31be01ad81f833f52b0d8cee660",
  "/smartadm/office/week-planner.js": "1ff59ff97053f6702be28c7f57a78cf6b3b869271f15d0cb5344be7c61119bf2",
  "/smartadm/office/vendor/xlsx-0.20.3.min.js": "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41",
  "/smartadm/office/vendor/html2pdf.min.js": "f3e5733ad8b0547c6ad7ee6c7766277fc13d1cb584197aaacbed930ce5ce0f8f"
};
// END MONITORED_ASSETS
async function monitorSecurity(env) {
  await ensureSecurity(env);
  for (const [path, expected] of Object.entries(MONITORED_ASSETS)) {
    let healthy = false, detail = "Abruf fehlgeschlagen oder Zeitüberschreitung";
    try {
      const response = await fetch(`${APP_ORIGIN}${path}`, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
        healthy = digest === expected;
        detail = healthy ? "HTTPS und SHA-256 stimmen mit dem freigegebenen Repository-Stand überein" : "Inhalt weicht vom freigegebenen Repository-Stand ab; Veröffentlichung oder unerwartete Änderung prüfen";
      } else detail = `HTTP ${response.status}`;
    } catch {}
    await securityCheckResult(env, path, healthy, detail);
  }
  let apiHealthy = false, apiDetail = "API nicht erreichbar";
  try {
    const health = await fetch("https://smartadm-office-api.betcherkimg.workers.dev/health", { signal: AbortSignal.timeout(10000), redirect: "error" });
    const body = await health.json();
    const denied = await fetch("https://smartadm-office-api.betcherkimg.workers.dev/admin/users", { signal: AbortSignal.timeout(10000), redirect: "error" });
    apiHealthy = health.ok && body.database === true && denied.status === 401 && denied.headers.get("Cache-Control")?.includes("no-store");
    apiDetail = apiHealthy ? "API/Datenbank erreichbar; anonymer Adminzugriff abgewiesen" : `API-Health ${health.status}, anonymer Adminzugriff ${denied.status}`;
  } catch {}
  await securityCheckResult(env, "API-Verfügbarkeit und Zugriffsschutz", apiHealthy, apiDetail);
  const hour = new Date().toISOString().slice(0, 13);
  const rows = await all(env, "SELECT kind, count FROM security_metrics WHERE hour = ?", hour);
  const counts = Object.fromEntries(rows.map(r => [r.kind, Number(r.count)]));
  const denied = (counts.auth_denied || 0) + (counts.admin_denied || 0);
  await securityCheckResult(env, "Abgewiesene Zugriffe", denied < 100 && !counts.unapproved_account,
    `${denied} abgewiesene Authentifizierungen/Adminzugriffe, ${counts.unapproved_account || 0} Zugriffe nicht freigegebener Konten in dieser UTC-Stunde`);
  await securityCheckResult(env, "API-Fehler", (counts.handler_error || 0) < 5,
    `${counts.handler_error || 0} interne API-Fehler in dieser UTC-Stunde`);
  await run(env, "DELETE FROM security_metrics WHERE hour < ?", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 13));
}
async function getSecurityMonitor({ env }) {
  await ensureSecurity(env);
  return json({ checks: await all(env, "SELECT * FROM security_monitor_state ORDER BY check_key"),
    metrics: await all(env, "SELECT * FROM security_metrics ORDER BY hour DESC, kind LIMIT 100"),
    intervalMinutes: 15, note: "Auffälligkeiten sind Verdachtsmomente, keine Bestätigung eines erfolgreichen Angriffs." });
}

/* ================= Worker ================= */

export default {
  // Cron-Trigger (Cloudflare → Worker → Einstellungen → Trigger): */15 * * * *
  async scheduled(event, env, exec) {
    exec.waitUntil((async () => {
      if (env.SECURITY_MONITOR_ONLY === "true") { await monitorSecurity(env); return; }
      await checkPlans(env, exec).catch(e => console.error("checkPlans:", e.message));
      await remindWeekPlanning(env, exec).catch(e => console.error("remindWeekPlanning:", e.message));
    })());
  },

  async fetch(request, env, exec) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (env.SECURITY_MONITOR_ONLY === "true") return err("Endpunkt nicht gefunden.", 404);

    if (url.pathname === "/push/public-key") {
      const config = await getPushConfig(env);
      return json({ publicKey: config?.publicKey || null });
    }

    if (url.pathname === "/health") {
      const db = await env.DB.prepare("SELECT 1 AS ok").first().catch(() => null);
      return json({ status: db?.ok === 1 ? "ok" : "degraded", database: db?.ok === 1 }, db?.ok === 1 ? 200 : 503);
    }

    let userId;
    try {
      ({ userId } = await verifyClerkToken(request));
    } catch (e) {
      console.warn(JSON.stringify({ event: "security.auth_denied", reason: "invalid_or_missing_token" }));
      exec.waitUntil(recordSecurityMetric(env, "auth_denied").catch(() => {}));
      return err("Nicht autorisiert.", 401);
    }

    // SmartADM 5 läuft getrennt von Office und prüft den Zugriff selbst.
    if (url.pathname.startsWith("/s5/")) {
      try {
        return await handleS5({ request, env, exec, url, userId });
      } catch (e) {
        console.error("SmartADM5 error:", e.message);
        return err("Speichern in der Cloud fehlgeschlagen.", 500);
      }
    }

    if (!await officeAllowed(env, userId)) {
      await recordSecurityMetric(env, "unapproved_account");
      return err("Dieses Konto ist für Office nicht freigegeben.", 403);
    }

    const isAdminPath = url.pathname.startsWith("/admin/");
    if (isAdminPath && !isBoss(env, userId)) {
      exec.waitUntil(recordSecurityMetric(env, "admin_denied").catch(() => {}));
      return err("Keine Boss-Berechtigung.", 403);
    }

    for (const r of routes) {
      const match = r.method === request.method && r.pattern.exec(url.pathname);
      if (!match) continue;

      const ctx = {
        request, env, exec, url, userId,
        owner: userId,
        id: match[1] ? Number(match[1]) : null
      };

      if (r.target) {
        const target = String(url.searchParams.get("user_id") || "").trim();
        if (!validUserId(target)) return err("Ungültige Mitarbeiter-ID.");
        ctx.owner = target;
      }

      try { return await r.handler(ctx); }
      catch (error) {
        console.error(JSON.stringify({ event: "office.handler_error", route: r.pattern.source }));
        exec.waitUntil(recordSecurityMetric(env, "handler_error").catch(() => {}));
        return err("Die Anfrage konnte nicht verarbeitet werden.", 500);
      }
    }

    return err(isAdminPath ? "Admin-Endpunkt nicht gefunden." : "Endpunkt nicht gefunden.", 404);
  }
};