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
const officePayRates = new Map([[2026,1390],[2027,1460]]);
const hourlyRateCents = month => [...officePayRates].filter(([year])=>year<=Number(String(month||"2026").slice(0,4))).sort((a,b)=>b[0]-a[0])[0]?.[1] || HOURLY_RATE_CENTS;
const DEFAULT_YEAR_RULES={kv:.13,rvEmployer:.15,rvFull:.186,rvMinBase:17500,u1:.008,u2:.0022,insolvency:.0015,flatTax:.02};
const officeYearRules=new Map([[2026,{...DEFAULT_YEAR_RULES,year:2026,limit:60300,confirmed:true}],[2027,{...DEFAULT_YEAR_RULES,year:2027,limit:63300,confirmed:false}]]);
const yearRules=month=>officeYearRules.get(Number(String(month).slice(0,4)))||{...DEFAULT_YEAR_RULES,year:Number(String(month).slice(0,4)),limit:0,confirmed:false};
const COMMISSION_RATE_CENTS = 500;
const targetGrossFor=(owner,month)=>['user_3JNFepxrEB8HUQ0ADo9FHDNFC5u','user_3JNA7KXodzRQQ7I2egc5wdCfLVv'].includes(owner)&&month>='2026-10'&&month<='2026-12'?60000:0;
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

function parseWorkBody(body,allowCorrection=false) {
  if (!body || !(allowedWorkDate(body.work_date)||allowCorrection&&validDate(body.work_date)&&body.work_date<=berlinToday()) ||
      !validTime(body.start_time) || !validTime(body.end_time)) {
    return { error: "Arbeitszeitdaten ungültig. Das Datum darf nur heute oder innerhalb der letzten 7 Tage liegen." };
  }
  if(body.end_time<=body.start_time)return {error:"Das tatsächliche Ende muss am selben Tag nach dem Beginn liegen."};
  const breakMinutes = nonNegInt(body.break_minutes);
  const calculated=minutesFromTimes(body.start_time,body.end_time,breakMinutes);
  const workMinutes=body.work_minutes===undefined?calculated:Number(body.work_minutes);
  if(!Number.isInteger(workMinutes)||Math.abs(workMinutes-calculated)>1)return {error:"Die eingetragene Dauer und der tatsächliche Arbeitsnachweis passen nicht zusammen."};
  if (workMinutes <= 0) {
    return { error: "Arbeitsdauer muss nach Abzug der Pause größer als 0 sein." };
  }
  return { values: [body.work_date, body.start_time, body.end_time, breakMinutes, workMinutes] };
}

function parsePerformanceBody(body,allowCorrection=false) {
  if (!body || !(allowedWorkDate(body.work_date)||allowCorrection&&validDate(body.work_date)&&body.work_date<=berlinToday())) {
    return { error: "Datum ungültig. Erlaubt sind heute und die letzten 7 Tage." };
  }
  // Jeder gesetzte Termin wird vergütet. Die Spalte commissionable_appointments bleibt
  // bestehen und trägt denselben Wert – gerechnet wird überall mit appointments.
  const appointments = nonNegInt(body.appointments);
  return { values: [body.work_date, appointments, appointments] };
}

function parseEntryBody(body,allowCorrection=false) {
  const work = parseWorkBody(body,allowCorrection);
  if (work.error) return work;
  const perf = parsePerformanceBody(body,allowCorrection);
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
    w.regular_slot,w.record_kind,w.entry_note,CASE WHEN w.record_kind='actual' THEN w.work_date END actual_work_date,w.entry_state,w.submission_id, w.created_at, w.updated_at
  FROM work_entries w
  LEFT JOIN performance_entries p ON p.work_entry_id = w.id
  WHERE w.clerk_user_id = ?
  ORDER BY w.work_date DESC, w.start_time DESC`;

const listEntries = async ({ env, owner }) => {await ensureRegular(env);return json(await all(env, ENTRY_SELECT, owner));};

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
  const body=await readJson(request);
  await ensureRegular(env);
  const {error,work,perf}=parseEntryBody(body,await regularCorrectionOpen(env,owner,body?.work_date));
  if (error) return err(error);
  const regularError=await regularEntryError(env,owner,body);if(regularError)return regularError;
  if(await first(env,"SELECT 1 FROM employee_absences WHERE clerk_user_id=? AND absence_date=?",owner,work[0]))return err("Für diesen Tag ist bereits eine Abwesenheit erfasst.",409);
  const closed = await closedMonthError(env, owner, work[0]);
  if (closed) return closed;

  const [workResult] = await env.DB.batch([
    stmt(env,
      `INSERT INTO work_entries
         (clerk_user_id, work_date, start_time, end_time, break_minutes, work_minutes,regular_slot,entry_state)
       VALUES (?, ?, ?, ?, ?, ?,?,?)`,
      [owner, ...work,body.regular_slot||null,await regularActive(env,owner,work[0])?"draft":"final"]),
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
  await ensureRegular(env);
  const row = await first(env,
    "SELECT work_date,entry_state,submission_id FROM work_entries WHERE id = ? AND clerk_user_id = ?", id, owner);
  if (!row) return err("Eintrag nicht gefunden.", 404);
  if(row.submission_id&&row.entry_state==='final')return err("Diese Woche wurde bereits abgesendet. Bitte Kim um eine nachvollziehbare Korrekturfreigabe bitten.",409);
  if (!allowedWorkDate(row.work_date)&&!await regularCorrectionOpen(env,owner,row.work_date)) {
    return err("Einträge, die älter als 7 Tage sind, können nicht mehr geändert werden.", 403);
  }
  return null;
}

async function updateEntry({ request, env, owner, id }) {
  const body=await readJson(request);
  await ensureRegular(env);
  if(await first(env,"SELECT 1 FROM work_entries WHERE id=? AND clerk_user_id=? AND record_kind='weekly_allocation'",id,owner))return err('Bitte diese Wochenzuordnung direkt in der Wochenliste ändern.',409);
  const {error,work,perf}=parseEntryBody(body,await regularCorrectionOpen(env,owner,body?.work_date));
  if (error) return err(error);

  const regularError=await regularEntryError(env,owner,body,id);if(regularError)return regularError;
  const denied = await checkEditable(env, id, owner);
  if (denied) return denied;
  const old = await first(env, "SELECT work_date FROM work_entries WHERE id = ? AND clerk_user_id = ?", id, owner);
  const closed = await closedMonthError(env, owner, work[0], old?.work_date);
  if (closed) return closed;

  await env.DB.batch([
    stmt(env,
      `UPDATE work_entries
       SET work_date = ?, start_time = ?, end_time = ?, break_minutes = ?, work_minutes = ?,regular_slot=?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND clerk_user_id = ?`,
      [...work,body.regular_slot||null,id,owner]),
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
  if (!row) return json({...SETTINGS_DEFAULTS,payrollYears:[...officeYearRules.values()],payRates:[...officePayRates].map(([year,rate])=>({year,rate}))});
  return json({
    ...Object.fromEntries(
      Object.entries(SETTINGS_COLUMNS).map(([key, col]) => [key, Number(row[col])])
    ),
    updated_at: row.updated_at,payrollYears:[...officeYearRules.values()],payRates:[...officePayRates].map(([year,rate])=>({year,rate}))
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
  await ensureHr(env);
  // Advance weekly planning is retired; keep existing tasks as historical records.
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
  "paid_minutes", "paid_amount_cents", "note", "created_at", "updated_at","leave_request_id","regular_holiday_id"
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
  await ensureRegular(env);
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
  await ensureRegular(env);
  if(['vacation','holiday'].includes(type)&&await regularActive(env,owner,date))return err('Urlaub wird im Kalender beantragt und genehmigt. Feiertage folgen automatisch den Regeltagen; ihre Vergütung wird in der Abrechnung geprüft.',409);
  const closed=await closedMonthError(env,owner,date);if(closed)return closed;
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
  await ensureRegular(env);
  const parsed = parseAbsenceBody(await readJson(request));
  if (parsed.error) return err(parsed.error);
  const [date, type, paidMinutes, paidAmountCents, note] = parsed.values;
  const exists = await first(env,
    "SELECT id,absence_date,leave_request_id,regular_holiday_id FROM employee_absences WHERE id = ? AND clerk_user_id = ?", id, owner);
  if (!exists) return err("Abwesenheit nicht gefunden.", 404);
  if(exists.leave_request_id||exists.regular_holiday_id)return err("Diese Abwesenheit gehört zu einem Antrag. Bitte im Kalender korrigieren.",409);
  const closed=await closedMonthError(env,owner,exists.absence_date,date);if(closed)return closed;
  const conflict = await ensureNoWorkOnAbsenceDate(env, owner, date, id);
  if (conflict) return err(conflict);

  return changed(await run(env,
    `UPDATE employee_absences
     SET absence_date = ?, absence_type = ?, paid_minutes = ?, paid_amount_cents = ?, note = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND clerk_user_id = ?`,
    date, type, paidMinutes, paidAmountCents, note, id, owner), "Abwesenheit nicht gefunden.");
}

async function deleteAbsence({env,owner,id}) {
  await ensureRegular(env);
  const row=await first(env,"SELECT absence_date,leave_request_id,regular_holiday_id FROM employee_absences WHERE id=? AND clerk_user_id=?",id,owner);
  if(!row)return err("Abwesenheit nicht gefunden.",404);
  if(row.leave_request_id||row.regular_holiday_id)return err("Diese Abwesenheit gehört zu einem Antrag. Bitte im Kalender korrigieren.",409);
  const closed=await closedMonthError(env,owner,row.absence_date);if(closed)return closed;
  return changed(await run(env,"DELETE FROM employee_absences WHERE id=? AND clerk_user_id=?",id,owner),"Abwesenheit nicht gefunden.");
}

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
const minijobLimitCents=month=>yearRules(month).limit;
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
function calculatePayroll({ month, mins, days, appts, profile, employment = {}, absences = [], goalHours = 24,targetAppointments=50,targetGrossCents=0 }) {
  const yr=yearRules(month);
  const timePay = Math.round((mins * hourlyRateCents(month)) / 60);
  const commission = appts * COMMISSION_RATE_CENTS;
  const absence = absenceTotals(absences);
  const absencePay = absence.vacationPay + absence.sickPay + absence.holidayPay + absence.paidLeavePay;
  const targetBonus=targetGrossCents>0&&appts>=targetAppointments?Math.max(0,targetGrossCents-timePay-commission-absencePay):0;
  const gross = timePay + commission + targetBonus + absencePay;
  const svDays = insuredDays(month, employment.start_date, employment.end_date);

  // RV-Eigenanteil – unter 175 € (anteilig bei Teilmonat) gilt der Mindestbeitrag:
  // 18,6 % der Mindestbemessung abzüglich 15 % Arbeitgeberanteil vom tatsächlichen Entgelt.
  let employeeRv = 0;
  let rvMinBase = 0;
  if (profile.employeeRv && gross > 0) {
    const base = Math.round((yr.rvMinBase * svDays) / 30);
    if (profile.rvMinBaseApplies && gross < base) rvMinBase = base;
    employeeRv = Math.max(0, Math.round((rvMinBase || gross) * yr.rvFull) - Math.round(gross * yr.rvEmployer));
  }
  const employee = {
    employeeRv,
    employeeFlatTax: profile.flatTax && profile.flatTaxEmployee ? Math.round(gross * yr.flatTax) : 0
  };

  const employer = Object.fromEntries(
    Object.entries(EMPLOYER_RATES).map(([k,rate])=>{const rates={employerKv:profile.employerKv?yr.kv:0,employerRv:profile.employerRv?yr.rvEmployer:0,u1:profile.u1?yr.u1:0,u2:profile.u2?yr.u2:0,insolvency:profile.insolvency?yr.insolvency:0,employerFlatTax:profile.flatTax&&!profile.flatTaxEmployee?yr.flatTax:0};return [k,Math.round(gross*(k==='accident'?rate(profile):rates[k]))]})
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
       FROM payroll_work_entries WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ?
       GROUP BY month`, userId, from, to),
    all(env,
      `SELECT substr(work_date, 1, 7) AS month, SUM(appointments) AS appts
       FROM payroll_performance_entries WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ?
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
  await ensureRegular(env);
  if(await regularActive(env,owner,monthEnd(month))){
    const prepared=await prepareCalendarPayroll(env,owner,month);
    if(prepared.blockers.length)return err(prepared.blockers.join(' '),409);
    if(!prepared.checked)return err('Bitte in der Lohnabrechnung die automatisch berechneten Monatswerte prüfen und bestätigen.',409);
  }
  const regularBlock=await regularClosingError(env,owner,month);if(regularBlock)return regularBlock;


  const [work, perf, absences, settings, officeSettings, member, employee, employer, entries, yearWorkDates, yearAbsences, year] = await Promise.all([
    first(env,
      `SELECT COALESCE(SUM(work_minutes), 0) AS mins, COUNT(DISTINCT work_date) AS days, COUNT(*) AS n
       FROM payroll_work_entries WHERE clerk_user_id = ? AND substr(work_date, 1, 7) = ?`,
      owner, month),
    first(env,
      `SELECT COALESCE(SUM(appointments), 0) AS appts, COUNT(*) AS n
       FROM payroll_performance_entries WHERE clerk_user_id = ? AND substr(work_date, 1, 7) = ?`,
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
      `SELECT w.work_date, w.start_time, w.end_time, w.break_minutes, w.work_minutes,w.record_kind,w.entry_note,
              COALESCE(p.appointments, 0) AS appointments
       FROM payroll_work_entries w
       LEFT JOIN payroll_performance_entries p ON p.work_entry_id = w.id
       WHERE w.clerk_user_id = ? AND substr(w.work_date, 1, 7) = ?
       ORDER BY w.work_date, w.start_time`,
      owner, month),
    all(env,
      `SELECT DISTINCT work_date FROM payroll_work_entries
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
    targetAppointments:(await regularMonthInfo(env,owner,month)).cutAppointments,targetGrossCents:targetGrossFor(owner,month),
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
    calendarCalculation:await regularActive(env,owner,monthEnd(month))?await prepareCalendarPayroll(env,owner,month):null,
    note: String(body.note || "").trim().slice(0, 180),
    paymentDate: validDate(body.payment_date) ? body.payment_date : null,
    payrollYearRules:yearRules(month),
    hourlyRate: hourlyRateCents(month) / 100,
    commissionRate: COMMISSION_RATE_CENTS / 100,
    created: berlinToday(),
    // eingefroren zum Abschlusszeitpunkt:
    employer: mapEmployer(employer),
    employee: mapEmployeeProfile(employee),
    entries,
    absences,
    vacation: leaveAccount(await leaveContext(env,owner),Number(month.slice(0,4)),monthEnd(month)),
    contract: {
      weeklyHours: CONTRACT_WEEKLY_HOURS,
      maxWorkdaysPerWeek: CONTRACT_MAX_WORKDAYS_PER_WEEK,
      // Reiner Hinweis: Ein 4. Tag wird weder blockiert noch aus Berechnungen entfernt.
      workdayWarnings: weeklyWorkdayWarnings(yearWorkDates, month)
    },
    year
  };

  const calendarCheck=snapshot.calendarCalculation;
  const result = await run(env,
    `INSERT INTO monthly_closings (
       clerk_user_id, payroll_month, work_minutes, work_days, appointments,
       commissionable_appointments, hourly_rate_cents, commission_rate_cents,
       gross_cents, employee_deductions_cents, net_cents,
       employer_contributions_cents, employer_cost_cents, snapshot_json, closed_by
     ) SELECT ${qs(15)} WHERE ? IS NULL OR EXISTS(SELECT 1 FROM payroll_checks WHERE clerk_user_id=? AND payroll_month=? AND source_hash=?)`,
    owner, month, payroll.mins, payroll.days, payroll.appts, payroll.eligible,
    hourlyRateCents(month), COMMISSION_RATE_CENTS,
    cents.gross, cents.employeeDeductions, cents.net,
    cents.employerContributions, cents.employerCost,
    JSON.stringify(snapshot), userId,calendarCheck?.hash||null,owner,month,calendarCheck?.hash||null);
  if(!result.meta?.changes)return err("Die Abrechnung wurde während des Abschlusses geändert. Bitte erneut prüfen.",409);

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

function calculateMinijobContributions(grossCents, profile, svDays = 30,month=berlinToday().slice(0,7)) {
  const yr=yearRules(month);
  const gross = nonNegInt(grossCents);
  const days = Math.max(0, Math.min(30, nonNegInt(svDays, 30) || 30));

  const kv = profile.employerKv ? Math.round(gross * yr.kv) : 0;
  const rvEmployer = profile.employerRv ? Math.round(gross * yr.rvEmployer) : 0;

  // Arbeitnehmer-RV nur bei bestehender Versicherungspflicht.
  // Bei Befreiung (employeeRv = false) bleibt sie 0; der AG-Anteil bleibt bestehen.
  let rvEmployee = 0;
  let rvMinBase = 0;
  if (profile.employeeRv && gross > 0) {
    const base = Math.round((yr.rvMinBase * days) / 30);
    if (profile.rvMinBaseApplies && gross < base) rvMinBase = base;
    rvEmployee = Math.max(0, Math.round((rvMinBase || gross) * yr.rvFull) - Math.round(gross * yr.rvEmployer));
  }

  const rv = rvEmployer + rvEmployee;
  const u1 = profile.u1 ? Math.round(gross * yr.u1) : 0;
  const u2 = profile.u2 ? Math.round(gross * yr.u2) : 0;
  const insolvency = profile.insolvency ? Math.round(gross * yr.insolvency) : 0;

  // Die 2-%-Pauschsteuer wird an die Minijob-Zentrale abgeführt – unabhängig
  // davon, ob der Arbeitgeber sie wirtschaftlich trägt oder vom Lohn einbehält.
  const flatTax = profile.flatTax ? Math.round(gross * yr.flatTax) : 0;

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
  // Use the frozen amounts; later yearly parameters must never change prior-month portal fields.
  const p=snap.payroll,cent=k=>Math.round(Number(p[k]||0)*100);
  if(['employerKv','employerRv','employeeRv','u1','u2','insolvency','employerFlatTax','employeeFlatTax'].every(k=>typeof p[k]==='number'))return {"6000":cent('employerKv'),"0100":snap.profile.employeeRv?cent('employerRv')+cent('employeeRv'):0,"0500":snap.profile.employeeRv?0:cent('employerRv'),U1:cent('u1'),U2:cent('u2'),"0050":cent('insolvency'),St:cent('employerFlatTax')+cent('employeeFlatTax')};
  return contributionFields(calculateMinijobContributions(Number(closing.gross_cents),
    snap.profile, snap.payroll.svDays,closing.payroll_month||snap.month), snap.profile);
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
  const actual = calculateMinijobContributions(grossCents, p, svDays,month);
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
  const estimated = calculateMinijobContributions(estimatedGrossCents, profile, svDays || 30,month);
  const due = contributionDueDates(month);
  const amountDue = estimated.total_cents + priorCorrection;
  const note = cleanText(body.note, 500);

  let actualGross = null;
  let actualTotal = null;
  let correction = 0;
  if (closing) {
    const actual = calculateMinijobContributions(Number(closing.gross_cents || 0), safeParse(closing.snapshot_json)?.profile || profile, safeParse(closing.snapshot_json)?.payroll?.svDays ?? svDays,month);
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
      all(env, `SELECT substr(work_date, 1, 7) AS month, SUM(work_minutes) AS mins FROM payroll_work_entries
                WHERE clerk_user_id = ? AND work_date >= ? AND work_date < ? GROUP BY month`, id, from, to),
      all(env, `SELECT substr(work_date, 1, 7) AS month, SUM(appointments) AS appts FROM payroll_performance_entries
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
  archived: "c.archived_at IS NOT NULL ORDER BY c.archived_at DESC, c.id DESC",   // Kundenarchiv
  kk: "c.kk_state = 'archived' AND c.archived_at IS NULL ORDER BY c.kk_archived_at ASC, c.id ASC"
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
  const result = await run(env, `UPDATE office_calls SET status = CASE WHEN status = 'open' THEN 'archived' ELSE status END,
    archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP), closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP),
    kk_state = NULL, hold_note = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, id);
  await syncFkTask(env);
  return changed(result, "Kontakt nicht gefunden.");
}

async function reopenCall({ env, id, exec }) {
  const row = await first(env,
    `UPDATE office_calls
     SET status = 'open', attempts = 0, rounds = COALESCE(rounds, 1) + 1, bad_phones = '[]',
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

// Erledigt bleibt im Kundenarchiv einschließlich Protokoll und Versuchen.
const finishKkCall = async ({ env, id }) =>
  changed(await run(env,
    "UPDATE office_calls SET archived_at = CURRENT_TIMESTAMP, kk_state = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND kk_state = 'archived' AND archived_at IS NULL", id),
    "Kontakt nicht im Kein-Kontakt-Archiv.");

/* Kontaktverlauf: Datenbank-Trigger sichern jede gespeicherte Fassung atomar.
 * Kein Ablaufdatum; keine Personen-Zusammenführung über gemeinsam genutzte Nummern.
 * Initialbestand wird einmal übernommen. Bereits früher gelöschte Daten sind nicht rekonstruierbar.
 */
const contactHistoryReady = new WeakMap();
async function ensureContactHistory(env) {
  if (contactHistoryReady.has(env.DB)) return contactHistoryReady.get(env.DB);
  const setup = (async () => {
    await ensurePool(env);
    const poolColumns = await all(env, "PRAGMA table_info(office_call_pool)");
    if (!poolColumns.some(c => c.name === "archived_at")) {
      try { await run(env, "ALTER TABLE office_call_pool ADD COLUMN archived_at TEXT"); }
      catch (error) {
        if (!(await all(env, "PRAGMA table_info(office_call_pool)")).some(c => c.name === "archived_at")) throw error;
      }
    }
    await run(env, `CREATE TABLE IF NOT EXISTS office_contact_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_id INTEGER NOT NULL,
      event TEXT NOT NULL, snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(env, "CREATE INDEX IF NOT EXISTS office_contact_history_source ON office_contact_history(source, source_id, id)");
    const statements = [];
    for (const [source, table] of [["call", "office_calls"], ["pool", "office_call_pool"]]) {
      const columns = (await all(env, `PRAGMA table_info(${table})`)).map(c => c.name).filter(c => /^[a-z_]+$/.test(c));
      const snapshot = prefix => `json_object(${columns.map(c => `'${c}', ${prefix}.${c}`).join(", ")})`;
      for (const [event, timing, prefix] of [["created", "AFTER INSERT", "NEW"], ["updated", "AFTER UPDATE", "NEW"], ["removed", "BEFORE DELETE", "OLD"]]) {
        statements.push(stmt(env, `CREATE TRIGGER IF NOT EXISTS contact_history_${source}_${event} ${timing} ON ${table}
          BEGIN INSERT INTO office_contact_history(source, source_id, event, snapshot)
          VALUES ('${source}', ${prefix}.id, '${event}', ${snapshot(prefix)}); END`));
      }
      statements.push(stmt(env, `INSERT INTO office_contact_history(source, source_id, event, snapshot)
        SELECT '${source}', c.id, 'existing', ${snapshot("c")} FROM ${table} c
        WHERE NOT EXISTS (SELECT 1 FROM office_contact_history h WHERE h.source = '${source}' AND h.source_id = c.id)`));
    }
    // Auch alte App-Versionen und direkte DELETE-Aufrufe dürfen das Kundenarchiv nicht leeren.
    statements.push(stmt(env, `CREATE TRIGGER IF NOT EXISTS office_calls_preserve BEFORE DELETE ON office_calls
      BEGIN SELECT RAISE(ABORT, 'Kontakte bleiben im Archiv erhalten.'); END`));
    await env.DB.batch(statements);
  })();
  contactHistoryReady.set(env.DB, setup);
  try { await setup; } catch (error) { contactHistoryReady.delete(env.DB); throw error; }
}

async function listContactHistory({env, url}) {
  await ensureContactHistory(env);
  const after = nonNegInt(url.searchParams.get("after"), 0);
  const source = url.searchParams.get("source"), sourceId = nonNegInt(url.searchParams.get("source_id"), 0);
  const rows = await all(env, `SELECT * FROM office_contact_history WHERE id > ?
    ${source && sourceId ? "AND source = ? AND source_id = ?" : ""} ORDER BY id LIMIT 250`,
    after, ...(source && sourceId ? [source, sourceId] : []));
  return json({items: rows.map(r => ({...r, contact: mapCall(safeParse(r.snapshot) || {}), snapshot: undefined})),
    next: rows.length === 250 ? rows.at(-1).id : null});
}

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
  const where = ["archived_at IS NULL"];
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
     ${boss ? "WHERE p.archived_at IS NULL" : "WHERE p.archived_at IS NULL AND (p.assigned_to IS NULL OR p.assigned_to = ?)"}
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
     WHERE p.archived_at IS NULL
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
  return changed(await run(env, `UPDATE office_call_pool SET ${sets.join(", ")} WHERE id = ? AND archived_at IS NULL`, ...args, id),
    "Kontakt ist nicht (mehr) im Paket.");
}

async function deletePoolContact({ env, id }) {
  await ensurePool(env);
  return changed(await run(env, "UPDATE office_call_pool SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND archived_at IS NULL", id), "Kontakt ist nicht (mehr) im Paket.");
}

// Ganzes Paket leeren: DELETE /admin/pool?place=12&assigned_to=…
async function clearPool({ env, url }) {
  await ensurePool(env);
  const [where, args] = poolWhere(url.searchParams.get("place"), url.searchParams.get("assigned_to"));
  const result = await run(env, `UPDATE office_call_pool SET archived_at = CURRENT_TIMESTAMP WHERE ${where}`, ...args);
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
    redirect: "manual",
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
  if(await first(env,"SELECT 1 FROM employee_absences WHERE clerk_user_id=? AND absence_date=?",userId,date))return "Für diesen Tag ist bereits eine bezahlte Abwesenheit genehmigt. Bitte im Kalender prüfen.";
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
    if(await regularActive(env,plan.clerk_user_id,plan.plan_date))continue;
    if(await first(env,"SELECT 1 FROM employee_absences WHERE clerk_user_id=? AND absence_date=?",plan.clerk_user_id,plan.plan_date))continue;
    const region=(await first(env,"SELECT region FROM leave_settings WHERE clerk_user_id=?",plan.clerk_user_id).catch(()=>null))?.region||'BW';
    if(leaveHolidays(Number(plan.plan_date.slice(0,4)),region)[plan.plan_date])continue;
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
  if(await regularActive(env,userId,addDays(week,6)))return true;
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
  const patterns=await regularPatterns(env,userId);
  const start=patterns.filter(p=>p.valid_from&&p.valid_from<=berlinToday()).map(p=>p.valid_from).sort()[0];
  const credits=start?await regularHolidayRows(env,userId,[start,addDays(berlinToday(),-370)].sort().at(-1),berlinToday(),patterns):[];
  for(const h of credits)if(!absences.some(a=>a.absence_date===h.date))absences.push({absence_date:h.date,absence_type:'holiday',paid_minutes:h.minutes});
  const info=await regularMonthInfo(env,userId,berlinToday().slice(0,7),patterns,await leaveContext(env,userId));for(const d of info.releaseDays)if(!absences.some(a=>a.absence_date===d.date))absences.push(d);
  return json({
    patterns,reviews,
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

const CALENDAR_ADDENDUM = {
  version: "nachtrag-2026-11-regeltage",
  title: "Nachtrag 2 zum Arbeitsvertrag",
  sections: [
    {heading:"§ 1 Arbeitszeit, Regeltage und freie Verteilung",items:[
      "Die regelmäßige Arbeitszeit beträgt sechs Stunden je Kalenderwoche. Als Regelverteilung legt die Arbeitnehmerin in Office drei verschiedene Wochentage von Montag bis Freitag mit jeweils zwei Stunden fest. Diese erste Festlegung erfolgt nach ihrer Unterschrift zu diesem Nachtrag in einer gesonderten, für beide Parteien dauerhaft einsehbaren Erklärung in Textform und wird Bestandteil der Vereinbarung. Sie gilt frühestens ab dem Wirksamwerden dieses Nachtrags und niemals rückwirkend.",
      "Die Arbeitnehmerin wählt die Regeltage nach ihren persönlichen Verhältnissen unabhängig von einzelnen Feiertagen. Sie kann eine neue Regelverteilung jederzeit in Office erklären. Eine Änderung gilt ab dem ersten Tag des übernächsten Kalendermonats nach Zugang beim Arbeitgeber. Frühere Erklärungen, Zeitpunkte und Geltungszeiträume bleiben erhalten; eine rückwirkende Änderung ist ausgeschlossen.",
      "Die tatsächlichen Arbeitstage und Uhrzeiten kann die Arbeitnehmerin innerhalb der Kalenderwoche weiterhin selbst wählen und auch kurzfristig von den Regeltagen abweichen. Die Regelverteilung gilt, soweit keine Abweichung vereinbart oder dokumentiert ist. Regelmäßig wird an höchstens drei Tagen gearbeitet; zusätzliche Tage und Mehrarbeit bedürfen der Zustimmung des Arbeitgebers. An Samstagen, Sonntagen und gesetzlichen Feiertagen wird nicht gearbeitet.",
      "Die bisherige Pflicht zur vorherigen Eingabe konkreter Uhrzeiten bis Sonntag 20:00 Uhr entfällt ab Geltung der neuen Regelverteilung. Es gibt keine laufende Aktivitätsüberwachung. Tatsächlich geleistete Arbeit wird mit dem tatsächlichen Datum, Beginn, Ende, Pausen und Terminen spätestens innerhalb von sieben Kalendertagen dokumentiert. Die Einträge bleiben bis zum Absenden der Woche als veränderbarer Entwurf sichtbar und werden zuvor nicht für die Lohnabrechnung verwendet. Die Arbeitnehmerin sendet ihre vollständige Woche ab Freitag bis spätestens Sonntag ab. Nach dem Absenden sind Änderungen nur nach dokumentierter Freigabe des Arbeitgebers möglich und erfordern erneutes Absenden. Office erinnert am Freitag in der Anwendung, am Samstag ab 12:00 Uhr per Push sowie am Sonntag um 09:00, 13:00 und 17:00 Uhr; eine fehlende Pushzustellung entbindet nicht von der Dokumentation. Die drei Regeltag-Zeilen dienen zusätzlich der Wochenübersicht; eine Zuordnung zu einer solchen Zeile ändert das tatsächliche Arbeitsdatum nicht. Geplante zukünftige Arbeit gilt nicht als geleistet. Dauerhafte Abweichungen sollen Anlass sein, die Regelverteilung mit dem vereinbarten Vorlauf anzupassen."
    ]},
    {heading:"§ 2 Feiertage und Wochenkonto",items:[
      "Fällt ein gesetzlicher Feiertag auf einen am betreffenden Datum gültigen Regeltag, werden zwei Stunden Feiertagsausfall auf das Wochenkonto gutgeschrieben. Die noch zu leistende Wochenarbeitszeit sinkt je betroffenem Regeltag um zwei Stunden, mindestens auf null. Ein Feiertag auf einem anderen Tag begründet nach dieser Regelverteilung keine Gutschrift. Es gibt keine Höchstzahl bezahlter Feiertage im Jahr. Zwingende gesetzliche Ansprüche, insbesondere bei einer abweichenden tatsächlichen Vereinbarung, bleiben unberührt.",
      "Die Feiertagsgutschrift wird nicht durch eine abweichende Wahl tatsächlicher Arbeitstage vermindert. Die ausgefallenen Stunden sind weder vor- noch nachzuarbeiten. Vier Stunden Arbeit und zwei Stunden Feiertagsausfall erfüllen beispielsweise das regelmäßige Sechsstundensoll. Mehrarbeit über das durch Feiertage und andere anrechenbare Abwesenheiten verminderte Arbeitssoll bedarf vorheriger Zustimmung und wird gesondert dokumentiert; tatsächlich geleistete Arbeit wird vollständig erfasst.",
      "Maßgeblich sind die gesetzlichen Feiertage am tatsächlichen Arbeitsort. Die Parteien gehen derzeit von Baden-Württemberg aus. Änderungen des Arbeitsorts werden vorab mitgeteilt und mit ihrem Geltungsbeginn dokumentiert. Heiligabend und Silvester sind keine gesetzlichen Feiertage.",
      "Feiertage haben bei der Buchung Vorrang vor Urlaub und Krankheit; derselbe Ausfall wird nicht doppelt gutgeschrieben. Ein gesetzlicher Feiertag verbraucht keinen Urlaubstag. Bei Krankheit gelten die gesetzlichen Vorschriften einschließlich § 4 Absatz 2 EFZG. Ein Entgeltausfall nach § 2 Absatz 3 EFZG wird nur nach dokumentierter Prüfung des unentschuldigten Fehlens unmittelbar vor oder nach dem Feiertag festgestellt; er wird nicht allein aus einer Lücke in Office abgeleitet."
    ]},
    {heading:"§ 3 Vergütung ausgefallener Arbeit",items:[
      "Für gesetzliche Feiertagsausfälle wird das Arbeitsentgelt nach § 2 EFZG fortgezahlt, das ohne den Feiertag angefallen wäre. Dazu gehören der geltende Stundenlohn und der zu schätzende Provisionsausfall. Als überprüfbare Schätzgrundlage dient die tatsächlich verdiente Terminprovision je tatsächlich geleisteter Arbeitsstunde im Feiertagsmonat und den beiden vorangegangenen Kalendermonaten, bei kürzerer Beschäftigung seit Beschäftigungsbeginn. Ist dieser Zeitraum nicht repräsentativ oder fehlen Daten, wird eine geeignete Schätzung gesondert dokumentiert. Der gesetzlich geschuldete Betrag darf dadurch nicht unterschritten werden.",
      "Terminziele, von denen ein Zielbonus oder eine zielabhängige Freistellung abhängen, vermindern sich im Verhältnis der Feiertagsausfallstunden zur Sollarbeitszeit des Zielzeitraums, kaufmännisch auf ganze Termine gerundet. Der vereinbarte Bonusbetrag bleibt erhalten. Gesetzliche Vergütungsansprüche werden durch Zielbedingungen oder die Geringfügigkeitsgrenze nicht ausgeschlossen. Fiktive Kundentermine werden nicht angelegt.",
      "Urlaubsentgelt wird gemäß § 11 BUrlG nach dem maßgeblichen Durchschnittsverdienst der letzten dreizehn Wochen vor Urlaubsbeginn ermittelt. Regelmäßige arbeitsbezogene variable Vergütungsbestandteile sind einzubeziehen; unverschuldete Verdienstkürzungen, dauerhafte Entgelterhöhungen und Überstundenvergütung werden nach den gesetzlichen Vorgaben behandelt. Die gesetzlichen Ansprüche bei Krankheit bleiben bestehen. Office dokumentiert Berechnung und Prüfung; die Freigabe ist kein Verzicht auf gesetzliche Ansprüche."
    ]},
    {heading:"§ 4 Urlaub und Anträge",items:[
      "Bei einer regelmäßigen Dreitagewoche beträgt der gesetzliche Mindesturlaub zwölf Arbeitstage für ein volles Kalenderjahr. Eintritt, Austritt, Wartezeit, Änderungen der Arbeitszeitverteilung, Teilurlaub und Übertragung richten sich nach dem Bundesurlaubsgesetz. Frühere Vertragszeiträume werden anhand der damals geltenden Verteilung geprüft und nicht rückwirkend umgeschrieben.",
      "Urlaub wird in Office mit den betroffenen Soll-Arbeitstagen beantragt und vom Arbeitgeber unter Beachtung des Bundesurlaubsgesetzes genehmigt. Der Antrag allein ist noch keine Genehmigung. Ein voller Urlaubstag ersetzt den Soll-Arbeitstag, regelmäßig zwei Stunden. Genehmigte Ausfallstunden müssen nicht nachgearbeitet werden. Ärztlich nachgewiesene Arbeitsunfähigkeit während des Urlaubs wird nach § 9 BUrlG berücksichtigt.",
      "Urlaubsstände, Anträge, Entscheidungen und Korrekturen bleiben nachvollziehbar. Ein Jahreswechsel löscht keinen offenen Bestand. Übertragung und Verfall werden unter Beachtung der gesetzlichen Voraussetzungen einschließlich der erforderlichen individuellen Hinweise geprüft. Bei Ausfall von Office stimmen die Parteien sich unmittelbar ab."
    ]},
    {heading:"§ 5 Geltung und Unterlagen",items:[
      "Dieser Nachtrag wird mit Zustimmung beider Parteien wirksam, frühestens am 01.11.2026. Die erste Regelverteilung gilt ab dem späteren Datum von Wirksamwerden und Erklärung der Arbeitnehmerin. Die Erklärung der Regeltage wird unverändert mit Zeitstempel dokumentiert. Bis dahin gelten die bisherigen Vereinbarungen.",
      "Der Arbeitsvertrag und der Nachtrag vom 14.10.2026 gelten im Übrigen weiter. Soweit dieser Nachtrag Arbeitszeitverteilung, Zeiterfassung, Planung oder Feiertage abweichend regelt, geht er ab seinem Geltungsbeginn vor. Gesetzliche Mindestansprüche bleiben unberührt.",
      "Beide Parteien unterschreiben dasselbe unveränderliche Dokument elektronisch in Office. Der Nachtrag bleibt mit beiden Unterschriften, Zeitpunkten und Prüfsumme einzeln als PDF abrufbar. Der erste Nachtrag und die Erklärungen zu den Regeltagen bleiben gesondert erhalten."
    ]}
  ]
};
const ADDENDUM_VERSIONS = new Map([ADDENDUM, CALENDAR_ADDENDUM].map(doc => [doc.version, doc]));
const activeAddendumVersion = CALENDAR_ADDENDUM.version;

let contractsReady = false;
async function ensureContracts(env) {
  if (contractsReady) return;
  await env.DB.batch([
    `CREATE TABLE IF NOT EXISTS addendum_documents(clerk_user_id TEXT NOT NULL,version TEXT NOT NULL,doc_json TEXT NOT NULL,doc_hash TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(clerk_user_id,version))`,
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
const addendumFor = async (env, userId) => userId===TEST_LEAVE_USER_ID || (await addendumTarget(env)) === userId;
const NO_ADDENDUM = { available: false };

const deDate = iso => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : "");
const cityOf = zipCity => String(zipCity || "").replace(/^\s*\d{4,5}\s+/, "").trim();

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Nachtrag mit den aktuellen Stammdaten zusammensetzen.
async function renderAddendum(env, userId, version = activeAddendumVersion) {
  const definition = ADDENDUM_VERSIONS.get(version);
  if (!definition) throw new Error("Unbekannte Nachtragsversion.");
  const [employer, employee] = await Promise.all([
    first(env, "SELECT name, street, zip_city FROM office_employer WHERE id = 1").catch(() => null),
    first(env, "SELECT full_name, street, zip_city, birth_date, start_date FROM employee_profiles WHERE clerk_user_id = ?", userId).catch(() => null)
  ]);
  const e = employer || {}, a = userId===TEST_LEAVE_USER_ID?{full_name:"Testkonto",street:"Teststraße 1",zip_city:"00000 Testort",birth_date:"2000-01-01",start_date:"2026-10-01",...Object.fromEntries(Object.entries(employee||{}).filter(([,v])=>v))}:employee||{};
  const missing = [
    [e.name, "Arbeitgeber: Name"], [e.street, "Arbeitgeber: Straße"], [e.zip_city, "Arbeitgeber: PLZ und Ort"],
    [a.full_name, "Mitarbeiter: vollständiger Name"], [a.street, "Mitarbeiter: Straße"],
    [a.zip_city, "Mitarbeiter: PLZ und Ort"], [a.birth_date, "Mitarbeiter: Geburtsdatum"], [a.start_date, "Mitarbeiter: Eintritt"]
  ].filter(([v]) => !v).map(([, label]) => label);

  const doc = {
    version: definition.version,
    title: definition.title,
    employer: { name: e.name || "", street: e.street || "", zip_city: e.zip_city || "" },
    employee: { name: a.full_name || "", street: a.street || "", zip_city: a.zip_city || "", birth_date: a.birth_date || "" },
    intro: [
      `Zwischen ${e.name || "[Arbeitgeber]"}, ${e.street || "[Straße]"}, ${e.zip_city || "[PLZ Ort]"} – nachfolgend „Arbeitgeber“ –`,
      `und ${a.full_name || "[Name]"}, ${a.street || "[Straße]"}, ${a.zip_city || "[PLZ Ort]"}, geboren am ${deDate(a.birth_date) || "[Geburtsdatum]"} – nachfolgend „Arbeitnehmerin“ –`,
      `wird zum Arbeitsvertrag mit Beginn am ${deDate(a.start_date) || "[Eintritt]"} folgender Nachtrag vereinbart. Er konkretisiert die Regelungen zur Arbeitszeit (§ 5) und zur Arbeitsverhinderung (§ 17) des Arbeitsvertrags.`
    ],
    sections: userId===TEST_LEAVE_USER_ID ? [{heading:"TESTDOKUMENT",items:["Dieses Dokument dient ausschließlich dem Funktionstest im freigegebenen Testkonto und ändert kein Arbeitsverhältnis."]},...definition.sections] : definition.sections,
    place: cityOf(e.zip_city),
    place_employee: cityOf(a.zip_city)
  };
  return { doc, missing, hash: await sha256Hex(JSON.stringify(doc)) };
}

// Stand für einen Mitarbeiter: Text, gültige Unterschriften, fertig ja/nein.
async function addendumState(env, userId, version = activeAddendumVersion) {
  await ensureContracts(env);
  const [current, rows] = await Promise.all([
    renderAddendum(env, userId, version),
    all(env, `SELECT role, signer_name, signature, doc_json, doc_hash, signed_at FROM addendum_signatures
              WHERE clerk_user_id = ? AND version = ?`, userId, version)
  ]);
  const by = Object.fromEntries(rows.map(r => [r.role, r]));
  const complete = Boolean(by.employee && by.employer && by.employee.doc_hash === by.employer.doc_hash);
  // The first signature freezes the text; the other party must consent to that exact snapshot.
  const canonical=await first(env,"SELECT doc_json,doc_hash FROM addendum_documents WHERE clerk_user_id=? AND version=?",userId,version);
  const frozen = canonical || by.employee || by.employer;
  const hash = frozen?.doc_hash || current.hash;
  const valid = role => (by[role] && by[role].doc_hash === hash
    ? { signer_name: by[role].signer_name, signed_at: by[role].signed_at, signature: by[role].signature } : null);
  return {
    version, canDefer: false, testAccount: userId===TEST_LEAVE_USER_ID,
    ready: Boolean(frozen) || current.missing.length === 0,
    missing: complete ? [] : current.missing,
    complete,
    hash,
    doc: frozen ? safeParse(frozen.doc_json) : current.doc,
    signatures: { employee: valid("employee"), employer: valid("employer") }
  };
}

function parseSignature(body) {
  const signature = String(body?.signature || "");
  if (!ADDENDUM_VERSIONS.has(String(body?.version || ""))) return { error: "Der Nachtrag wurde inzwischen geändert. Bitte die Seite neu laden." };
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signature) || signature.length > SIGNATURE_MAX) {
    return { error: "Die Unterschrift konnte nicht gelesen werden. Bitte erneut unterschreiben." };
  }
  return { signature };
}

async function storeSignature(env, request, userId, role, signerId, signerName, signature, state) {
  await run(env,"INSERT OR IGNORE INTO addendum_documents(clerk_user_id,version,doc_json,doc_hash) VALUES(?,?,?,?)",userId,state.version,JSON.stringify(state.doc),state.hash);
  const frozen=await first(env,"SELECT doc_hash FROM addendum_documents WHERE clerk_user_id=? AND version=?",userId,state.version);
  if(frozen.doc_hash!==state.hash)throw new Error("Dokument wurde inzwischen eingefroren. Bitte erneut öffnen.");
  await run(env,
    `INSERT OR IGNORE INTO addendum_signatures(clerk_user_id,version,role,signer_id,signer_name,signature,doc_json,doc_hash,user_agent) VALUES(?,?,?,?,?,?,?,?,?)`,
    userId,state.version,role,signerId,signerName,signature,JSON.stringify(state.doc),state.hash,String(request.headers.get("User-Agent")||"").slice(0,200));
}

/* --- Mitarbeiter --- */

async function addendumBundle(env, userId) {
  const current = await addendumState(env, userId);
  current.archive = [];
  for (const version of ADDENDUM_VERSIONS.keys()) {
    if (version === activeAddendumVersion) continue;
    const signed = await first(env, "SELECT 1 FROM addendum_signatures WHERE clerk_user_id = ? AND version = ?", userId, version);
    if (signed) current.archive.push(await addendumState(env, userId, version));
  }
  return current;
}
async function getOwnAddendum({ env, userId }) {
  if (!(await addendumFor(env, userId))) return json(NO_ADDENDUM);
  return json(await addendumBundle(env, userId));
}

async function signOwnAddendum({ request, env, userId, exec }) {
  if (isBoss(env, userId)) return err("Als Boss unterschreibst du über die Mitarbeiter-Ansicht.");
  if (!(await addendumFor(env, userId))) return err("Für dich gibt es keinen Nachtrag.", 404);
  const body = (await readJson(request)) || {};
  const parsed = parseSignature(body);
  if (parsed.error) return err(parsed.error);

  const state = await addendumState(env, userId, body.version);
  if (body.version === CALENDAR_ADDENDUM.version && body.doc_hash !== state.hash) return err("Bitte den aktuellen Nachtrag vollständig öffnen und erneut bestätigen.", 409);
  if (!state.ready) return err("Der Nachtrag ist noch nicht vollständig vorbereitet. Kim ist informiert.");
  if (state.signatures.employee) return ok(await addendumState(env, userId));

  await storeSignature(env, request, userId, "employee", userId, state.doc.employee.name, parsed.signature, state);

  // Die Unterschrift gilt zugleich als Bestätigung von „Was ist neu?“.
  if (validNoticeVersion(body.notice_version)) {
    await ensureHr(env);
    await run(env, "INSERT OR IGNORE INTO notice_acks (clerk_user_id, version, user_agent) VALUES (?, ?, ?)",
      userId, String(body.notice_version), String(request.headers.get("User-Agent") || "").slice(0, 200));
  }

  const after = await addendumState(env, userId, body.version);
  if (after.complete && after.version === CALENDAR_ADDENDUM.version) await activateLeaveTerms(env, userId, after);
  await pushBoss(env, exec, {
    title: "Nachtrag unterschrieben",
    body: after.complete
      ? `${state.doc.employee.name} hat unterschrieben – der Nachtrag ist damit vollständig.`
      : `${state.doc.employee.name} hat den Nachtrag unterschrieben. Bitte gegenzeichnen.`,
    tag: `addendum-${userId}`,
    url: hrUrl("mitarbeiter")
  });
  return ok(await addendumBundle(env, userId));
}

/* --- Boss --- */

async function listAdminAddenda({ env }) {
  const target = await addendumTarget(env);
  if (!target) return json([]);
  const people = await all(env, "SELECT clerk_user_id, full_name FROM employee_profiles WHERE clerk_user_id IN (?,?)", target,TEST_LEAVE_USER_ID).catch(() => []);
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
  json((await addendumFor(env, owner)) ? await addendumBundle(env, owner) : NO_ADDENDUM);

async function signAdminAddendum({ request, env, owner, userId, exec }) {
  const body = (await readJson(request)) || {};
  const parsed = parseSignature(body);
  if (parsed.error) return err(parsed.error);
  if (!(await addendumFor(env, owner))) return err("Für diesen Mitarbeiter gibt es keinen Nachtrag.", 404);
  const state = await addendumState(env, owner, body.version);
  if (body.version === CALENDAR_ADDENDUM.version && body.doc_hash !== state.hash) return err("Bitte den aktuellen Nachtrag vollständig öffnen und erneut bestätigen.", 409);
  if (!state.ready) return err(`Es fehlen noch Stammdaten: ${state.missing.join(", ")}.`);
  if (state.signatures.employer) return ok(state);

  await storeSignature(env, request, owner, "employer", userId, state.doc.employer.name, parsed.signature, state);
  const after = await addendumState(env, owner, body.version);
  if (after.complete && after.version === CALENDAR_ADDENDUM.version) await activateLeaveTerms(env, owner, after);
  if (after.complete) {
    await runLater(exec, notifyUser(env, owner, {
      title: "Nachtrag vollständig unterschrieben",
      body: "Kim hat gegengezeichnet. Du findest den Nachtrag unter „Mehr“ → „Meine Unterlagen“ zum Herunterladen.",
      tag: "addendum",
      url: hrUrl("vertrag")
    }));
  }
  return ok(await addendumBundle(env, owner));
}

async function resetAdminAddendum({ env, owner }) {
  await ensureContracts(env);
  return err("Unterschriebene Nachträge bleiben erhalten. Änderungen benötigen eine neue Dokumentversion.", 409);
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

/* ================= Kalender, Anträge und Urlaubskonto ================= */
const leaveSchemaReady = new WeakMap();
const officeSchemaKnown=new WeakMap();
async function officeSchemaCurrent(env){if(officeSchemaKnown.get(env.DB))return true;const r=await first(env,"SELECT version FROM office_schema_versions WHERE name='calendar' AND version=3").catch(()=>null);if(r)officeSchemaKnown.set(env.DB,true);return !!r;}
async function ensureLeave(env) {
  if (leaveSchemaReady.has(env.DB)) return leaveSchemaReady.get(env.DB);
  const promise = (async () => {
    if(await officeSchemaCurrent(env)){await ensurePayRates(env);return;}
    await ensureHr(env);
    await ensureContracts(env);
    await ensurePayRates(env);
    await env.DB.batch([
      `CREATE TABLE IF NOT EXISTS leave_terms (clerk_user_id TEXT NOT NULL,effective_from TEXT NOT NULL,weekly_minutes INTEGER NOT NULL,workdays INTEGER NOT NULL,day_minutes INTEGER NOT NULL,region TEXT NOT NULL DEFAULT 'BW',source_version TEXT NOT NULL,source_hash TEXT NOT NULL,PRIMARY KEY(clerk_user_id,effective_from))`,
      `CREATE TABLE IF NOT EXISTS leave_requests (id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,kind TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,dates_json TEXT NOT NULL,note TEXT,status TEXT NOT NULL DEFAULT 'requested',revision INTEGER NOT NULL DEFAULT 1,decision_note TEXT,decided_by TEXT,decided_at TEXT,decision_token TEXT,snapshot_json TEXT,paid_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS leave_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,request_id INTEGER,event TEXT NOT NULL,actor TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS leave_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,leave_year INTEGER NOT NULL,days_hundredths INTEGER NOT NULL,note TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS leave_transfers (clerk_user_id TEXT NOT NULL,leave_year INTEGER NOT NULL,requested_by TEXT NOT NULL,requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(clerk_user_id,leave_year))`,
      `CREATE TABLE IF NOT EXISTS leave_regions(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,effective_from TEXT NOT NULL,region TEXT NOT NULL,note TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS leave_settings (clerk_user_id TEXT PRIMARY KEY,region TEXT NOT NULL DEFAULT 'BW')`,
      `CREATE TABLE IF NOT EXISTS leave_plan_history (id INTEGER PRIMARY KEY AUTOINCREMENT,plan_id INTEGER NOT NULL,clerk_user_id TEXT NOT NULL,event TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS leave_requests_owner ON leave_requests(clerk_user_id,from_date,id)`,
      `CREATE INDEX IF NOT EXISTS leave_audit_owner ON leave_audit(clerk_user_id,id)`
    ].map(sql => stmt(env,sql)));
    const cols = new Set((await all(env,"PRAGMA table_info(employee_absences)")).map(c=>c.name));
    if (!cols.has("leave_request_id")) {
      try { await run(env,"ALTER TABLE employee_absences ADD COLUMN leave_request_id INTEGER"); }
      catch(error) { if (!(await all(env,"PRAGMA table_info(employee_absences)")).some(c=>c.name==="leave_request_id")) throw error; }
    }
    const planCols=(await all(env,"PRAGMA table_info(work_plans)")).map(c=>c.name).filter(c=>/^[a-z_]+$/.test(c));
    const obj=p=>`json_object(${planCols.map(c=>`'${c}',${p}.${c}`).join(',')})`;
    const triggers=[];
    for(const [name,when,p] of [["created","AFTER INSERT","NEW"],["changed","AFTER UPDATE","NEW"],["removed","BEFORE DELETE","OLD"]])triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_plan_${name} ${when} ON work_plans BEGIN INSERT INTO leave_plan_history(plan_id,clerk_user_id,event,snapshot_json) VALUES(${p}.id,${p}.clerk_user_id,'${name}',${obj(p)}); END`));
    triggers.push(stmt(env,`INSERT INTO leave_plan_history(plan_id,clerk_user_id,event,snapshot_json) SELECT p.id,p.clerk_user_id,'existing',${obj('p')} FROM work_plans p WHERE NOT EXISTS(SELECT 1 FROM leave_plan_history h WHERE h.plan_id=p.id)`));

    triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_absence_no_work BEFORE INSERT ON employee_absences WHEN EXISTS(SELECT 1 FROM work_entries w WHERE w.clerk_user_id=NEW.clerk_user_id AND w.work_date=NEW.absence_date) BEGIN SELECT RAISE(ABORT,'Arbeitszeit und volle Abwesenheit dürfen sich nicht überschneiden.'); END`));
    triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_work_no_absence BEFORE INSERT ON work_entries WHEN EXISTS(SELECT 1 FROM employee_absences a WHERE a.clerk_user_id=NEW.clerk_user_id AND a.absence_date=NEW.work_date) BEGIN SELECT RAISE(ABORT,'Für diesen Tag besteht bereits eine Abwesenheit.'); END`));
    triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_work_no_absence_update BEFORE UPDATE OF work_date,clerk_user_id ON work_entries WHEN EXISTS(SELECT 1 FROM employee_absences a WHERE a.clerk_user_id=NEW.clerk_user_id AND a.absence_date=NEW.work_date) BEGIN SELECT RAISE(ABORT,'Für diesen Tag besteht bereits eine Abwesenheit.'); END`));
    for(const table of ['work_entries','employee_absences']){
      const col=table==='work_entries'?'work_date':'absence_date';
      for(const [event,row] of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']])triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_closed_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN EXISTS(SELECT 1 FROM monthly_closings c WHERE c.clerk_user_id=${row}.clerk_user_id AND c.payroll_month=substr(${row}.${col},1,7)) BEGIN SELECT RAISE(ABORT,'Dieser Monat ist bereits abgeschlossen.'); END`));
    }
    for(const table of ['work_entries','employee_absences']){const col=table==='work_entries'?'work_date':'absence_date';triggers.push(stmt(env,`CREATE TRIGGER IF NOT EXISTS leave_closed_${table}_update_old BEFORE UPDATE ON ${table} WHEN EXISTS(SELECT 1 FROM monthly_closings c WHERE c.clerk_user_id=OLD.clerk_user_id AND c.payroll_month=substr(OLD.${col},1,7)) BEGIN SELECT RAISE(ABORT,'Dieser Monat ist bereits abgeschlossen.'); END`));}
    await env.DB.batch(triggers);
    // Repair activation after a network failure between saving the last signature and activation.
    const signed=await all(env,`SELECT clerk_user_id,MAX(signed_at) signed_at,MIN(doc_hash) doc_hash FROM addendum_signatures WHERE version=? GROUP BY clerk_user_id HAVING COUNT(DISTINCT role)=2 AND COUNT(DISTINCT doc_hash)=1`,CALENDAR_ADDENDUM.version);
    for(const row of signed)await insertLeaveTerms(env,row.clerk_user_id,row.signed_at,row.doc_hash);
  })();
  leaveSchemaReady.set(env.DB,promise);
  try {await promise;}catch(error){leaveSchemaReady.delete(env.DB);throw error;}
}
function leaveSignedDate(stamp) {return berlinParts(Date.parse(String(stamp).replace(' ','T')+'Z')).date;}
async function insertLeaveTerms(env,owner,signedAt,hash) {
  const available=await first(env,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='regular_patterns'");if(!available)return;
  const pattern=await first(env,"SELECT declared_date FROM regular_patterns WHERE clerk_user_id=? AND kind='initial' ORDER BY id LIMIT 1",owner);if(!pattern)return;
  const from=["2026-11-01",leaveSignedDate(signedAt),pattern.declared_date].sort().at(-1);
  await run(env,`INSERT OR IGNORE INTO leave_terms(clerk_user_id,effective_from,weekly_minutes,workdays,day_minutes,region,source_version,source_hash) VALUES(?,?,360,3,120,'BW',?,?)`,owner,from,CALENDAR_ADDENDUM.version,hash);
}
async function activateLeaveTerms(env,owner,add) {
  await ensureLeave(env);
  const latest=[add.signatures.employee.signed_at,add.signatures.employer.signed_at].sort().at(-1);
  await insertLeaveTerms(env,owner,latest,add.hash);
}
function leaveEaster(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}
const TEST_LEAVE_USER_ID = "user_3JNA7KXodzRQQ7I2egc5wdCfLVv";
const CALENDAR_NOTICE_VERSION = "2026-10-27-regeltage-v2";
const LEAVE_REGIONS=["BW","BY","BE","BB","HB","HH","HE","MV","NI","NW","RP","SL","SN","ST","SH","TH"];
function leaveHolidays(year,region="BW") {
  const out={};const add=(date,name)=>out[date]=name;
  for(const [d,n] of [["01-01","Neujahr"],["05-01","Tag der Arbeit"],["10-03","Tag der Deutschen Einheit"],["12-25","1. Weihnachtstag"],["12-26","2. Weihnachtstag"]])add(`${year}-${d}`,n);
  const easter=leaveEaster(year);
  for(const [offset,name] of [[-2,"Karfreitag"],[1,"Ostermontag"],[39,"Christi Himmelfahrt"],[50,"Pfingstmontag"]])add(addDays(easter,offset),name);
  if(["BW","BY","ST"].includes(region))add(`${year}-01-06`,"Heilige Drei Könige");
  if(["BW","BY","HE","NW","RP","SL"].includes(region))add(addDays(easter,60),"Fronleichnam");
  if(["BW","BY","NW","RP","SL"].includes(region))add(`${year}-11-01`,"Allerheiligen");
  if(["BB","HB","HH","MV","NI","SN","ST","SH","TH"].includes(region))add(`${year}-10-31`,"Reformationstag");
  if(["BE","MV"].includes(region))add(`${year}-03-08`,"Internationaler Frauentag");
  if(region==="SL")add(`${year}-08-15`,"Mariä Himmelfahrt");
  if(region==="TH")add(`${year}-09-20`,"Weltkindertag");
  if(region==="SN") {let day=`${year}-11-22`;while(new Date(day+'T12:00Z').getUTCDay()!==3)day=addDays(day,-1);add(day,"Buß- und Bettag");}
  return out;
}
const leaveDays=(from,to)=>{
  if(!validDate(from)||!validDate(to)||from>to)return [];
  const out=[];for(let d=from;d<=to&&out.length<=366;d=addDays(d,1))out.push(d);return out;
};
function leaveWaitingEnd(start) {
  const [y,m,d]=String(start||'').split('-').map(Number);if(!y)return '9999-12-31';
  const last=new Date(Date.UTC(y,m+5,0)).getUTCDate();
  const target=new Date(Date.UTC(y,m+5,Math.min(d,last))).toISOString().slice(0,10);return d>last?target:addDays(target,-1);
}
const leaveRoundPartial=n=>{const whole=Math.floor(n+1e-9);return n-whole>=.5-1e-9?whole+1:Math.round(n*100)/100;};
function leaveYearValue({year,asOf,job,terms=[],dutyDates=[]}) {
  const ys=`${year}-01-01`,ye=`${year}-12-31`,start=[ys,job.start_date||ys].sort().at(-1),end=[ye,job.end_date||ye].sort()[0];
  if(start>end||asOf<start)return {entitlement:0,provisional:false,annual:0,waitingEnd:leaveWaitingEnd(job.start_date)};
  const finish=[end,asOf].sort()[0],eligible=finish>leaveWaitingEnd(job.start_date);
  const periods=[];let legacy=false;
  const monthWeight=(a,b)=>{let n=0;for(const d of leaveDays(a,b)){const [y,m]=d.split('-').map(Number);n+=1/new Date(Date.UTC(y,m,0)).getUTCDate();}return n;};
  const duration=monthWeight(start,end);
  let weighted=0;
  const firstTerm=terms.filter(t=>t.effective_from<=end).sort((a,b)=>a.effective_from.localeCompare(b.effective_from));
  const legacyEnd=firstTerm[0] ? addDays(firstTerm[0].effective_from,-1) : end;
  if(start<=legacyEnd) {
    // The agreed three-day week is the entitlement basis, not the number of logged workdays.
    const annual=12,count=monthWeight(start,[legacyEnd,end].sort()[0]);
    if(count>0){weighted+=annual*count;periods.push({from:start,to:[legacyEnd,end].sort()[0],annual,source:'contract_three_days'});}
  }
  for(let i=0;i<firstTerm.length;i++){
    const t=firstTerm[i],a=[start,t.effective_from].sort().at(-1),b=[end,firstTerm[i+1]?addDays(firstTerm[i+1].effective_from,-1):end].sort()[0];
    if(a>b)continue;const count=monthWeight(a,b);weighted+=t.workdays*4*count;periods.push({from:a,to:b,annual:t.workdays*4,source:t.source_version});
  }
  const annual=duration>0?weighted/duration:0;
  let factor=1;
  const entryYear=String(job.start_date||'').slice(0,4)===String(year);
  if(!eligible)factor=entryYear?Math.min(1,fullMonthsBetween(job.start_date,finish)/12):0;
  else if(job.end_date&&job.end_date<=`${year}-06-30`)factor=Math.min(1,fullMonthsBetween(start,end)/12);
  const partial=factor<1;
  const raw=annual*factor;
  return {entitlement:partial?leaveRoundPartial(raw):Math.round(raw*100)/100,annual:Math.round(annual*100)/100,provisional:legacy,waitingEnd:leaveWaitingEnd(job.start_date),periods,asOf:finish,partial};
}
async function leaveContext(env,owner) {
  await ensureLeave(env);
  const [job,terms,settings,work,absences,plans,requests,adjustments,transfers,closings]=await Promise.all([
    employmentOf(env,owner),all(env,"SELECT * FROM leave_terms WHERE clerk_user_id=? ORDER BY effective_from",owner),first(env,"SELECT region FROM leave_settings WHERE clerk_user_id=?",owner),
    all(env,"SELECT work_date,SUM(work_minutes) minutes FROM work_entries WHERE clerk_user_id=? GROUP BY work_date",owner),
    all(env,"SELECT * FROM employee_absences WHERE clerk_user_id=? ORDER BY absence_date",owner),
    all(env,"SELECT * FROM work_plans WHERE clerk_user_id=? ORDER BY plan_date",owner),
    all(env,"SELECT * FROM leave_requests WHERE clerk_user_id=? ORDER BY id DESC",owner),
    all(env,"SELECT * FROM leave_adjustments WHERE clerk_user_id=? ORDER BY id",owner),
    all(env,"SELECT * FROM leave_transfers WHERE clerk_user_id=?",owner),
    all(env,"SELECT payroll_month FROM monthly_closings WHERE clerk_user_id=?",owner)
  ]);
  const regions=await all(env,'SELECT * FROM leave_regions WHERE clerk_user_id=? ORDER BY effective_from,id',owner);
  const regionAt=date=>regions.filter(r=>r.effective_from<=date).at(-1)?.region||settings?.region||terms.at(-1)?.region||'BW';
  const region=regionAt(berlinToday());
  const dutyDates=[...new Set([...work.map(w=>w.work_date),...absences.map(a=>a.absence_date),...plans.filter(p=>p.status!=='cancelled').map(p=>p.plan_date)])];
  return {owner,job,terms,region,regions,regionAt,work,absences,plans,requests,adjustments,transfers,closings,dutyDates};
}
function leaveAllocatedDays(context){return context.requests.filter(r=>['approved','cancellation_requested'].includes(r.status)).flatMap(r=>(safeParse(r.snapshot_json)?.days||[]).flatMap(d=>d.leave_allocations?.length?d.leave_allocations.map(a=>({...d,leave_year:a.year,units:d.units>0?a.units:0})):d));}
function leaveYearBucket(context,year,asOf=berlinToday()) {
  const value=leaveYearValue({year,asOf,job:context.job,terms:context.terms,dutyDates:context.dutyDates});
  const projection=leaveYearValue({year,asOf:`${year}-12-31`,job:context.job,terms:context.terms,dutyDates:context.dutyDates});
  const adjustment=context.adjustments.filter(a=>a.leave_year===year).reduce((n,a)=>n+a.days_hundredths/100,0);
  const allocations=leaveAllocatedDays(context);
  const used=allocations.filter(d=>d.leave_year===year).reduce((n,d)=>n+Number(d.units||0),0)+context.absences.filter(a=>a.absence_type==='vacation'&&!a.leave_request_id&&Number(a.absence_date.slice(0,4))===year).length;
  const reserved=context.requests.filter(r=>r.status==='requested'&&r.kind==='vacation').flatMap(r=>safeParse(r.dates_json)||[]).filter(d=>Number(d.slice(0,4))===year&&!leaveHolidays(year,context.region)[d]).length;
  const taken=allocations.filter(d=>d.leave_year===year&&d.date<=asOf).reduce((n,d)=>n+Number(d.units||0),0)+context.absences.filter(a=>a.absence_type==='vacation'&&!a.leave_request_id&&a.absence_date<=asOf&&Number(a.absence_date.slice(0,4))===year).length;
  return {...value,year,adjustment,entitlement:Math.round((value.entitlement+adjustment)*100)/100,projected:Math.round((projection.entitlement+adjustment)*100)/100,approved:used,taken,reserved,remaining:Math.round((value.entitlement+adjustment-used)*100)/100,planningRemaining:Math.round((projection.entitlement+adjustment-used-reserved)*100)/100,transferRequested:context.transfers.some(t=>t.leave_year===year),adjustments:context.adjustments.filter(a=>a.leave_year===year)};
}
// Origin-year buckets remain unchanged; carryover is a derived balance, never a duplicated grant.
function leaveAccount(context,year,asOf=berlinToday()) {
  const own=leaveYearBucket(context,year,asOf),start=Number((context.job.start_date||String(year)).slice(0,4)),boundary=`${year}-01-01`,carryover=[];
  const allocations=leaveAllocatedDays(context);
  for(let origin=start;origin<year;origin++){
    const bucket=leaveYearBucket(context,origin,`${origin}-12-31`);
    const committed=allocations.filter(d=>d.leave_year===origin&&d.date>=boundary).reduce((n,d)=>n+Number(d.units||0),0);
    const grant=Math.max(0,Math.round((bucket.remaining+committed)*100)/100),approved=Math.min(grant,committed);
    if(grant||bucket.provisional)carryover.push({year:origin,days:grant,approved,remaining:Math.max(0,Math.round((grant-approved)*100)/100),provisional:bucket.provisional});
  }
  const carried=carryover.reduce((n,c)=>n+c.days,0),committed=carryover.reduce((n,c)=>n+c.approved,0),round=n=>Math.round(n*100)/100;
  const priorPending=context.requests.filter(r=>r.status==='requested'&&r.kind==='vacation').flatMap(r=>safeParse(r.dates_json)||[]).filter(d=>d<boundary).length,priorReserved=Math.min(Math.max(0,carried-committed),priorPending);
  const carriedTaken=allocations.filter(d=>d.leave_year<year&&d.date>=boundary&&d.date<=asOf&&d.date<=`${year}-12-31`).reduce((n,d)=>n+Number(d.units||0),0);
  return {...own,reserved:round(own.reserved+priorReserved),taken:round(own.taken+carriedTaken),annualEntitlement:own.entitlement,annualProjected:own.projected,carried:round(carried),carryover,automaticCarryover:true,
    entitlement:round(own.entitlement+carried),projected:round(own.projected+carried),approved:round(own.approved+committed),
    remaining:round(own.remaining+carried-committed),planningRemaining:round(own.planningRemaining+carried-committed-priorReserved),
    provisional:own.provisional||carryover.some(c=>c.provisional)};
}
function leaveRequestView(r) {return {...r,dates:safeParse(r.dates_json)||[],snapshot:safeParse(r.snapshot_json),dates_json:undefined,snapshot_json:undefined,decision_token:undefined};}
async function getLeaveCalendar({env,userId,owner,url}) {
  owner=owner||userId;const context=await leaveContext(env,owner);
  const month=String(url.searchParams.get('month')||berlinToday().slice(0,7));if(!/^\d{4}-\d{2}$/.test(month)||!validDate(month+'-01'))return err('Ungültiger Monat.');
  const year=Number(month.slice(0,4));if(year<2020||year>2100)return err('Ungültiges Jahr.');
  const from=addDays(month+'-01',-7),to=addDays(monthEnd(month),7),within=d=>d>=from&&d<=to;
  const holidayMap={};for(let y=year-1;y<=year+1;y++)for(const r of LEAVE_REGIONS)for(const [date,name] of Object.entries(leaveHolidays(y,r)))if(context.regionAt(date)===r)holidayMap[date]=name;
  const patterns=await regularPatterns(env,owner),regularHolidays=await regularHolidayRows(env,owner,from,to,patterns,context);
  const history=await all(env,"SELECT plan_id,event,snapshot_json,created_at FROM leave_plan_history WHERE clerk_user_id=? AND json_extract(snapshot_json,'$.plan_date') BETWEEN ? AND ? ORDER BY id DESC LIMIT 500",owner,from,to);
  return json({patterns,regularHolidays,month,region:context.region,job:context.job,terms:context.terms,accounts:[year-1,year,year+1].filter(y=>y>=Number((context.job.start_date||'2020').slice(0,4))).map(y=>leaveAccount(context,y)),
    holidays:Object.entries(holidayMap).map(([date,name])=>({date,name})),
    plans:context.plans.filter(p=>within(p.plan_date)).map(p=>({...p,minutes:plannedMinutes(p)})),work:context.work.filter(w=>within(w.work_date)),absences:context.absences.filter(a=>within(a.absence_date)),requests:context.requests.map(leaveRequestView),
    history:history.map(h=>({...h,snapshot:safeParse(h.snapshot_json),snapshot_json:undefined})),audit:await all(env,"SELECT id,request_id,event,actor,detail_json,created_at FROM leave_audit WHERE clerk_user_id=? ORDER BY id DESC LIMIT 200",owner),closedMonths:context.closings.map(c=>c.payroll_month),
    payrollYears:[...officeYearRules.values()],rates:[...officePayRates].map(([year,rate])=>({year,rate})),testAccount:owner===TEST_LEAVE_USER_ID,rateReview:!officePayRates.has(year)?'Stundensatz und Rechtsstand für dieses Jahr vor der Abrechnung prüfen.':null,regionalNote:context.region==='BY'?'Zusätzliche örtliche Feiertage in Bayern müssen gesondert geprüft werden.':null});
}
async function addLeaveRequest({request,env,userId,exec}) {
  if(isBoss(env,userId))return err('Bitte den Antrag als Mitarbeiter stellen.',403);
  const context=await leaveContext(env,userId),body=await readJson(request),kind=String(body?.kind||'vacation');
  const dates=[...new Set(Array.isArray(body?.dates)?body.dates.map(String):[])].sort();
  if(!['vacation','holiday'].includes(kind)||!dates.length||dates.length>60||dates.some(d=>!validDate(d)))return err('Bitte gültige Soll-Arbeitstage auswählen (höchstens 60).');
  if(dates.some(d=>d<berlinToday())&&kind==='vacation')return err('Urlaub bitte für zukünftige Arbeitstage beantragen.');
  if(dates.some(d=>d<context.job.start_date||context.job.end_date&&d>context.job.end_date))return err('Ein Tag liegt außerhalb des Arbeitsverhältnisses.');
  const note=cleanText(body?.note,500)||'';
  for(const date of dates){
    const regular=await regularActive(env,userId,date);
    if(regular&&kind==='holiday')return err('Die Feiertagsgutschrift folgt automatisch den Regeltagen. Dafür ist kein Antrag nötig.');
    if(regular&&kind==='vacation'&&!regular.weekdays.includes(regularWeekday(date)))return err('Bitte die gültigen Soll-Arbeitstage als Urlaub auswählen. Abweichende Einsätze vorher mit Kim klären.');
    const holiday=leaveHolidays(Number(date.slice(0,4)),context.regionAt(date))[date];
    if(kind==='holiday'&&!holiday)return err(`${date} ist im hinterlegten Bundesland kein gesetzlicher Feiertag.`);
    if(kind==='vacation'&&holiday)return err('Gesetzliche Feiertage bitte nicht als Urlaub beantragen; den Feiertagsausfall getrennt prüfen lassen.');
    if(![1,2,3,4,5].includes(regularWeekday(date)))return err('Bitte nur Montag bis Freitag als Arbeitstage auswählen.');
    if(context.work.some(w=>w.work_date===date)||context.absences.some(a=>a.absence_date===date))return err('Für einen ausgewählten Tag ist schon Arbeitszeit oder eine Abwesenheit erfasst.');
    if(context.requests.some(r=>['requested','approved','cancellation_requested'].includes(r.status)&&(safeParse(r.dates_json)||[]).includes(date)))return err('Für einen ausgewählten Tag besteht bereits ein Antrag.');
  }
  if(kind==='holiday'&&!note)return err('Bitte beschreiben, warum ohne Feiertag an diesem Tag gearbeitet worden wäre.');
  const token=crypto.randomUUID();
  await env.DB.batch([
    stmt(env,`INSERT INTO leave_requests(clerk_user_id,kind,from_date,to_date,dates_json,note,decision_token) VALUES(?,?,?,?,?,?,?)`,[userId,kind,dates[0],dates.at(-1),JSON.stringify(dates),note,token]),
    stmt(env,`INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,'requested',?,json_object('dates',dates_json,'kind',kind,'note',note) FROM leave_requests WHERE decision_token=?`,[userId,token])
  ]);
  await pushBoss(env,exec,{title:kind==='vacation'?'Neuer Urlaubsantrag':'Feiertagsausfall prüfen',body:`${dates.length} Soll-Arbeitstag(e) zur Prüfung.`,tag:'leave-request',url:hrUrl('kalender')});
  return ok();
}
async function leavePayQuote(env,owner,date,minutes,kind,context,referenceDate=date) {
  await ensureRegular(env);
  if(!officePayRates.has(Number(date.slice(0,4))))throw new Error('Für dieses Jahr bitte zuerst den dann geltenden Stundensatz und Rechtsstand in den Kalendereinstellungen bestätigen. Eine automatische Vergütung wird noch nicht festgeschrieben.');
  const from=[addDays(referenceDate,-91),context.job.start_date||referenceDate].sort().at(-1);
  const work=await first(env,"SELECT SUM(work_minutes) minutes FROM payroll_work_entries WHERE clerk_user_id=? AND work_date>=? AND work_date<?",owner,from,referenceDate);
  const perf=await first(env,"SELECT SUM(commissionable_appointments) appointments FROM payroll_performance_entries WHERE clerk_user_id=? AND work_date>=? AND work_date<?",owner,from,referenceDate);
  await ensureAdjustments(env);
  const changes=await all(env,"SELECT delta FROM appointment_adjustments WHERE clerk_user_id=? AND payroll_month>=? AND payroll_month<=?",owner,from.slice(0,7),addDays(referenceDate,-1).slice(0,7));
  const paid=await all(env,"SELECT absence_date,paid_minutes,paid_amount_cents FROM employee_absences WHERE clerk_user_id=? AND absence_date>=? AND absence_date<? AND paid_amount_cents>0",owner,from,referenceDate);
  for(const a of context.payrollPaidReference||[]){if(a.absence_date<from||a.absence_date>=referenceDate)continue;const i=paid.findIndex(p=>p.absence_date===a.absence_date);if(i<0)paid.push(a);else paid[i]=a;}
  const refMinutes=Number(work?.minutes||0)+paid.reduce((n,a)=>n+a.paid_minutes,0),appointments=Math.max(0,Number(perf?.appointments||0)+adjustmentSum(changes));
  const absenceVariable=paid.reduce((n,a)=>n+Math.max(0,a.paid_amount_cents-Math.round(a.paid_minutes*hourlyRateCents(a.absence_date.slice(0,7))/60)),0);
  const hourly=hourlyRateCents(date.slice(0,7));
  const base=Math.round(minutes*hourly/60),variable=refMinutes>0?Math.round(minutes*(appointments*COMMISSION_RATE_CENTS+absenceVariable)/refMinutes):0;
  return {date,minutes,kind,base_cents:base,variable_estimate_cents:variable,suggested_cents:base+variable,reference:{from,to:addDays(referenceDate,-1),minutes:refMinutes,commissionable_appointments:appointments,paid_absence_variable_cents:absenceVariable},requiresReview:true,
    note:kind==='holiday'?'Vorschlag: Grundlohn plus geschätzter variabler Ausfall. Tatsächlichen Lohnausfall bestätigen.':'Vorschlag: Grundlohn plus geschätzte Terminprovision. Unverschuldete Ausfälle, Überstunden, Provisionskorrekturen und Zielbonus vor Freigabe prüfen.'};
}
async function previewLeaveDecision({env,owner,id}) {
  const context=await leaveContext(env,owner),r=context.requests.find(r=>String(r.id)===String(id));if(!r)return err('Antrag nicht gefunden.',404);
  const days=[];
  for(const date of safeParse(r.dates_json)||[]){
    const plan=context.plans.find(p=>p.plan_date===date&&p.status!=='cancelled'),term=context.terms.filter(t=>t.effective_from<=date).at(-1);
    const minutes=plan?plannedMinutes(plan):term?.day_minutes||120;
    if(!officePayRates.has(Number(date.slice(0,4))))return err('Bitte zuerst den Jahresstundensatz in den Kalendereinstellungen bestätigen.');
    const quote=await leavePayQuote(env,owner,date,minutes,r.kind,context,r.from_date);
    days.push({...quote,plan_id:plan?.id||null,plan_status:plan?.status||null,legacy:!term,holiday:leaveHolidays(Number(date.slice(0,4)),context.region)[date]||null,closed:context.closings.some(c=>c.payroll_month===date.slice(0,7))});
  }
  return json({request:leaveRequestView(r),revision:r.revision,days,accounts:[...new Set(days.map(d=>Number(d.date.slice(0,4))))].map(year=>leaveAccount(context,year)),warning:'Vorschlag zur Prüfung, keine bereits ausgeführte Zahlung. Tatsächliche Solltage und vollständige Vergütung bestätigen.'});
}
async function decideLeaveRequest({request,env,owner,userId,id,exec}) {
  const context=await leaveContext(env,owner),r=context.requests.find(x=>String(x.id)===String(id));if(!r)return err('Antrag nicht gefunden.',404);
  const body=await readJson(request),action=String(body?.action||''),note=cleanText(body?.note,1000)||'';
  if(Number(body?.revision)!==r.revision)return err('Antrag wurde inzwischen geändert. Bitte neu öffnen.',409);
  if(!['approve','reject','cancel','paid','sick'].includes(action))return err('Unbekannte Entscheidung.');
  if(action==='paid'){
    if(r.status!=='approved'||!validDate(body?.paid_at)||body.paid_at>berlinToday())return err('Bitte das tatsächliche, nicht zukünftige Zahlungsdatum eintragen.');
    const token=crypto.randomUUID();
    const result=await env.DB.batch([stmt(env,"UPDATE leave_requests SET paid_at=?,decision_token=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND revision=?",[body.paid_at,token,id,owner,r.revision]),stmt(env,"INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,'paid',?,? FROM leave_requests WHERE id=? AND decision_token=?",[userId,JSON.stringify({paid_at:body.paid_at}),id,token])]);
    if(!result[0].meta?.changes)return err('Antrag wurde gleichzeitig geändert.',409);return ok();
  }
  if(action==='approve'){
    if(r.status!=='requested')return err('Dieser Antrag ist nicht mehr offen.',409);
    if(body?.confirmed!==true||!note)return err('Bitte Solltage, Vergütung und Entscheidungsgrund ausdrücklich bestätigen.');
    const supplied=Array.isArray(body.days)?body.days:[],days=[],usedByYear=new Map();
    for(const date of safeParse(r.dates_json)||[]){
      const input=supplied.find(x=>x.date===date);if(!input)return err('Die geprüften Tageswerte fehlen.');
      const minutes=Number(input.minutes),amount=Number(input.amount_cents),year=Number(date.slice(0,4));
      if(!Number.isInteger(minutes)||minutes<1||minutes>1440||!Number.isInteger(amount)||amount<Math.round(minutes*hourlyRateCents(date.slice(0,7))/60)||amount>10000000)return err('Bitte gültige Ausfallstunden und mindestens die Grundvergütung bestätigen.');
      if(!officePayRates.has(year))return err('Stundensatz und Rechtsstand für dieses Jahr zuerst in den Kalendereinstellungen bestätigen.');
      if(context.closings.some(c=>c.payroll_month===date.slice(0,7)))return err('Dieser Monat ist bereits abgeschlossen. Eine Korrektur darf die gespeicherte Abrechnung nicht überschreiben.');
      if(context.work.some(w=>w.work_date===date)||context.absences.some(a=>a.absence_date===date))return err('Für diesen Tag sind inzwischen Arbeitszeit oder Abwesenheiten vorhanden.',409);
      const holiday=leaveHolidays(year,context.regionAt(date))[date];if(r.kind==='vacation'&&holiday||r.kind==='holiday'&&!holiday)return err('Feiertagszuordnung hat sich geändert. Bitte Antrag prüfen.',409);
      const pattern=await regularActive(env,owner,date);if(r.kind==='vacation'&&pattern&&!pattern.weekdays.includes(regularWeekday(date)))return err('Dieser beantragte Tag ist nach der gültigen Regelverteilung arbeitsfrei. Bitte Antrag anpassen.',409);
      const selectedPlan=context.plans.find(p=>p.plan_date===date&&p.status!=='cancelled');
      const week=mondayOfWeek(date),otherDates=new Set([...context.plans.filter(p=>p.status!=='cancelled'&&p.plan_date>=week&&p.plan_date<=addDays(week,6)).map(p=>p.plan_date),...context.absences.filter(a=>a.absence_date>=week&&a.absence_date<=addDays(week,6)).map(a=>a.absence_date),...(safeParse(r.dates_json)||[]).filter(d=>d>=week&&d<=addDays(week,6))]);
      if(otherDates.size>3&&body?.extra_days_confirmed!==true)return err('Mehr als drei Soll-Arbeitstage in einer Woche: bitte die abweichende Planung ausdrücklich bestätigen.');
      let leaveYear=year,leaveAllocations=[];
      if(r.kind==='vacation'){
        let left=1;
        for(let origin=Number((context.job.start_date||date).slice(0,4));origin<year&&left>0;origin++){
          const previous=leaveYearBucket(context,origin,`${origin}-12-31`),available=Math.max(0,previous.remaining-(usedByYear.get(origin)||0)),units=Math.round(Math.min(left,available)*100)/100;
          if(units){leaveAllocations.push({year:origin,units});usedByYear.set(origin,Math.round(((usedByYear.get(origin)||0)+units)*100)/100);left=Math.round((left-units)*100)/100;}
        }
        if(left){leaveAllocations.push({year,units:left});usedByYear.set(year,Math.round(((usedByYear.get(year)||0)+left)*100)/100);}
        leaveYear=leaveAllocations[0].year;
      }
      const quote=await leavePayQuote(env,owner,date,minutes,r.kind,context,r.from_date);
      days.push({date,minutes,amount_cents:amount,manual_amount:amount!==quote.suggested_cents,reference_reviewed:true,kind:r.kind,units:r.kind==='vacation'?1:0,leave_year:leaveYear,leave_allocations:leaveAllocations,plan_id:selectedPlan?.id||null,quote});
    }
    for(const [year,n] of usedByYear){const account=leaveYearBucket(context,year,year<Number(r.from_date.slice(0,4))?`${year}-12-31`:r.from_date);if(account.remaining<n&&body?.advance_confirmed!==true)return err('Der verfügbare Anspruch reicht am Urlaubsbeginn noch nicht aus. Einen freiwilligen Vorgriff bitte ausdrücklich bestätigen.');}
    const token=crypto.randomUUID(),snapshot={version:1,region:context.region,days,terms:context.terms,approved_by:userId,approved_note:note,advance:body?.advance_confirmed===true};
    const result=await env.DB.batch([
      stmt(env,"UPDATE leave_requests SET status='approved',revision=revision+1,decision_note=?,decided_by=?,decided_at=CURRENT_TIMESTAMP,decision_token=?,snapshot_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND status='requested' AND revision=?",[note,userId,token,JSON.stringify(snapshot),id,owner,r.revision]),
      stmt(env,`INSERT INTO employee_absences(clerk_user_id,absence_date,absence_type,paid_minutes,paid_amount_cents,note,leave_request_id)
        SELECT r.clerk_user_id,json_extract(j.value,'$.date'),r.kind,json_extract(j.value,'$.minutes'),json_extract(j.value,'$.amount_cents'),?,r.id FROM leave_requests r,json_each(r.snapshot_json,'$.days') j WHERE r.id=? AND r.decision_token=? AND r.status='approved'`,[note,id,token]),
      stmt(env,"INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,'approved',?,snapshot_json FROM leave_requests WHERE id=? AND decision_token=?",[userId,id,token])
    ]);
    if(!result[0].meta?.changes)return err('Antrag wurde gleichzeitig geändert.',409);
  }else if(action==='sick'){
    if(r.status!=='approved'||r.kind!=='vacation'||body?.medical_proof!==true||!note)return err('Korrektur benötigt einen genehmigten Urlaub, den bestätigten AU-Nachweis und einen Grund.');
    const snap=safeParse(r.snapshot_json),date=String(body.date||''),day=snap?.days.find(d=>d.date===date&&d.units>0);if(!day)return err('Urlaubstag nicht gefunden.');
    if(date>berlinToday()||context.closings.some(c=>c.payroll_month===date.slice(0,7)))return err('Nur vergangene Tage in noch offenen Abrechnungsmonaten können hier korrigiert werden.');
    const amount=Number(body.amount_cents);if(!Number.isInteger(amount)||amount<0)return err('Bitte die geprüfte Krankheitsvergütung eintragen.');
    day.units=0;day.kind='sick';day.amount_cents=amount;day.correction_note=note;
    const token=crypto.randomUUID();
    const result=await env.DB.batch([
      stmt(env,"UPDATE leave_requests SET snapshot_json=?,decision_token=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND revision=?",[JSON.stringify(snap),token,id,owner,r.revision]),
      stmt(env,"UPDATE employee_absences SET absence_type='sick',paid_amount_cents=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE clerk_user_id=? AND leave_request_id=? AND absence_date=? AND EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND decision_token=?)",[amount,note,owner,id,date,id,token]),
      stmt(env,"INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,'illness_correction',?,? FROM leave_requests WHERE id=? AND decision_token=?",[userId,JSON.stringify({date,before:safeParse(r.snapshot_json),after:snap,note,medical_proof:true}),id,token])
    ]);if(!result[0].meta?.changes)return err('Antrag wurde gleichzeitig geändert.',409);
  }else{
    if(!note)return err('Bitte einen Entscheidungsgrund eintragen.');
    if(action==='reject'&&r.status!=='requested'||action==='cancel'&&!['approved','cancellation_requested'].includes(r.status))return err('Diese Entscheidung passt nicht mehr zum Antrag.',409);
    if(action==='cancel'&&(safeParse(r.dates_json)||[]).some(d=>d<berlinToday()||context.closings.some(c=>c.payroll_month===d.slice(0,7))))return err('Vergangene oder abgerechnete Abwesenheiten benötigen eine gesonderte Korrektur.');
    const token=crypto.randomUUID(),status=action==='reject'?'rejected':'cancelled';
    const result=await env.DB.batch([stmt(env,"UPDATE leave_requests SET status=?,revision=revision+1,decision_token=?,decision_note=?,decided_by=?,decided_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?",[status,token,note,userId,id,r.revision]),stmt(env,"DELETE FROM employee_absences WHERE leave_request_id=? AND EXISTS(SELECT 1 FROM leave_requests WHERE id=? AND decision_token=?)",[id,id,token]),stmt(env,"INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,?, ?,? FROM leave_requests WHERE id=? AND decision_token=?",[status,userId,JSON.stringify({before:leaveRequestView(r),note}),id,token])]);if(!result[0].meta?.changes)return err('Antrag wurde gleichzeitig geändert.',409);
  }
  await runLater(exec,notifyUser(env,owner,{title:'Entscheidung zu deiner Abwesenheit',body:'Die Entscheidung und die berechneten Tage stehen in deinem Kalender.',tag:`leave-${id}`,url:hrUrl('kalender')}));
  return ok();
}
async function withdrawLeaveRequest({request,env,userId,id,exec}) {
  await ensureLeave(env);const r=await first(env,"SELECT * FROM leave_requests WHERE id=? AND clerk_user_id=?",id,userId);if(!r)return err('Antrag nicht gefunden.',404);
  if(!['requested','approved'].includes(r.status))return err('Antrag kann nicht mehr zurückgezogen werden.',409);
  const status=r.status==='requested'?'withdrawn':'cancellation_requested';
  const token=crypto.randomUUID();
  const results=await env.DB.batch([stmt(env,"UPDATE leave_requests SET status=?,revision=revision+1,decision_token=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND revision=?",[status,token,id,userId,r.revision]),stmt(env,"INSERT INTO leave_audit(clerk_user_id,request_id,event,actor,detail_json) SELECT clerk_user_id,id,?, ?,? FROM leave_requests WHERE id=? AND decision_token=?",[status,userId,JSON.stringify({before:leaveRequestView(r)}),id,token])]);if(!results[0].meta?.changes)return err('Antrag wurde gleichzeitig geändert.',409);
  await pushBoss(env,exec,{title:'Abwesenheitsantrag geändert',body:status==='withdrawn'?'Ein offener Antrag wurde zurückgezogen.':'Bitte die gewünschte Urlaubsstornierung prüfen.',tag:'leave-request',url:hrUrl('kalender')});return ok();
}
async function transferLeave({request,env,userId}) {
  const context=await leaveContext(env,userId),body=await readJson(request),year=Number(body?.year),today=berlinToday();
  if(year!==Number(today.slice(0,4))||String(context.job.start_date||'').slice(0,4)!==String(year)||leaveWaitingEnd(context.job.start_date)<`${year}-12-31`)return err('Diese Übertragung auf Verlangen betrifft den Teilurlaub im Eintrittsjahr bei noch nicht erfüllter Wartezeit. Andere Übertragungsgründe bitte mit Kim klären.');
  await run(env,"INSERT OR IGNORE INTO leave_transfers(clerk_user_id,leave_year,requested_by) VALUES(?,?,?)",userId,year,userId);return ok();
}
async function adjustLeave({request,env,owner,userId}) {
  await ensureLeave(env);const body=await readJson(request),year=Number(body?.year),days=Number(body?.days),note=cleanText(body?.note,1000)||'';
  if(!Number.isInteger(year)||year<2020||year>2100||!Number.isFinite(days)||Math.abs(days)>100||!note)return err('Bitte Jahr, Korrekturtage und einen nachvollziehbaren Grund angeben.');
  await run(env,"INSERT INTO leave_adjustments(clerk_user_id,leave_year,days_hundredths,note,created_by) VALUES(?,?,?,?,?)",owner,year,Math.round(days*100),note,userId);return ok();
}
async function setLeaveRegion({request,env,owner,userId}) {
  await ensureLeave(env);const body=await readJson(request),region=String(body?.region||''),from=String(body?.effective_from||berlinToday()),note=cleanText(body?.note,500)||'';
  if(!LEAVE_REGIONS.includes(region)||!validDate(from)||from<berlinToday()||!note)return err('Bitte Bundesland, Grund und einen heutigen oder zukünftigen Geltungsbeginn angeben.');
  await env.DB.batch([stmt(env,'INSERT INTO leave_regions(clerk_user_id,effective_from,region,note,created_by) VALUES(?,?,?,?,?)',[owner,from,region,note,userId]),stmt(env,"INSERT INTO leave_audit(clerk_user_id,event,actor,detail_json) VALUES(?,'region_changed',?,?)",[owner,userId,JSON.stringify({region,effective_from:from,note})])]);return ok();
}
async function leaveDateBlocked(env,owner,date) {
  await ensureLeave(env);return !!await first(env,"SELECT 1 FROM employee_absences WHERE clerk_user_id=? AND absence_date=?",owner,date);
}


async function ensurePayRates(env) {
  await run(env,"CREATE TABLE IF NOT EXISTS office_payroll_years(pay_year INTEGER PRIMARY KEY,rules_json TEXT NOT NULL,confirmed_by TEXT NOT NULL,note TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  for(const r of await all(env,'SELECT pay_year,rules_json FROM office_payroll_years'))officeYearRules.set(r.pay_year,{...safeParse(r.rules_json),year:r.pay_year,confirmed:true});
  await run(env,"CREATE TABLE IF NOT EXISTS office_pay_rates(pay_year INTEGER PRIMARY KEY,rate_cents INTEGER NOT NULL,confirmed_by TEXT NOT NULL,note TEXT NOT NULL,updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const rates=await all(env,"SELECT pay_year,rate_cents FROM office_pay_rates ORDER BY pay_year");
  for(const r of rates)officePayRates.set(r.pay_year,r.rate_cents);
}
async function setLeaveRate({request,env,owner,userId}) {
  await ensureLeave(env);const body=await readJson(request),year=Number(body?.year),rate=Number(body?.rate_cents),note=cleanText(body?.note,500)||'';
  if(!Number.isInteger(year)||year<2026||year>2100||!Number.isInteger(rate)||rate<100||rate>100000||!note)return err("Bitte Jahr, geprüften Bruttostundensatz und Quelle/Grund eintragen.");
  const minimum=year===2026?1390:year===2027?1460:0;if(rate<minimum)return err("Der Stundensatz unterschreitet den bekannten gesetzlichen Mindestlohn.");
  const closed=await first(env,"SELECT 1 FROM monthly_closings WHERE substr(payroll_month,1,4)=? LIMIT 1",String(year));
  if(closed)return err("Für dieses Jahr liegen bereits Abschlüsse vor. Stundensätze dürfen nicht rückwirkend überschrieben werden.",409);
  const rules=body?.year_rules;
  if(!rules||!Number.isInteger(rules.limit)||rules.limit<10000||rules.limit>1000000||!Number.isInteger(rules.rvMinBase)||rules.rvMinBase<0||rules.rvMinBase>1000000||['kv','rvEmployer','rvFull','u1','u2','insolvency','flatTax'].some(k=>!Number.isFinite(rules[k])||rules[k]<0||rules[k]>.5))return err('Bitte die Jahreswerte für Minijobgrenze und Abgabensätze vollständig bestätigen.');
  await env.DB.batch([
    stmt(env,"INSERT INTO office_pay_rates(pay_year,rate_cents,confirmed_by,note) VALUES(?,?,?,?) ON CONFLICT(pay_year) DO UPDATE SET rate_cents=excluded.rate_cents,confirmed_by=excluded.confirmed_by,note=excluded.note,updated_at=CURRENT_TIMESTAMP",[year,rate,userId,note]),
    stmt(env,'INSERT INTO office_payroll_years(pay_year,rules_json,confirmed_by,note) VALUES(?,?,?,?) ON CONFLICT(pay_year) DO UPDATE SET rules_json=excluded.rules_json,confirmed_by=excluded.confirmed_by,note=excluded.note,updated_at=CURRENT_TIMESTAMP',[year,JSON.stringify(rules),userId,note])
  ]);officeYearRules.set(year,{...rules,year,confirmed:true});
  officePayRates.set(year,rate);return ok();
}
async function replayCalendarIntro({env,userId}) {
  if(userId!==TEST_LEAVE_USER_ID)return err("Nur im freigegebenen Testkonto verfügbar.",403);
  await ensureHr(env);
  await run(env,"DELETE FROM notice_acks WHERE clerk_user_id=? AND version=?",userId,CALENDAR_NOTICE_VERSION);
  return ok();
}
async function seedCalendarTest({env,userId}) {
  if(userId!==TEST_LEAVE_USER_ID)return err("Nur im freigegebenen Testkonto verfügbar.",403);
  const today=berlinToday(),year=Number(today.slice(0,4)),date=`${today.slice(5)>='12-26'?year+1:year}-12-25`;
  return ok({date,week:mondayOfWeek(date),month:date.slice(0,7),message:"Weihnachtswoche zur Ansicht geöffnet. Es wurden keine Arbeitszeiten, Pläne oder Unterschriften erzeugt."});
}

/* ================= Regeltage und einfache Wochenansicht ================= */
const regularSchemaReady = new WeakMap();
async function ensureRegular(env) {
  if(regularSchemaReady.has(env.DB))return regularSchemaReady.get(env.DB);
  const pending=(async()=>{
    if(await officeSchemaCurrent(env)){await ensurePayRates(env);return;}
    await ensureLeave(env);
    await env.DB.batch([
      `CREATE TABLE IF NOT EXISTS payroll_checks(clerk_user_id TEXT NOT NULL,payroll_month TEXT NOT NULL,source_hash TEXT NOT NULL,checked_by TEXT NOT NULL,checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(clerk_user_id,payroll_month))`,
      `CREATE TABLE IF NOT EXISTS regular_patterns(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,weekdays_json TEXT NOT NULL,kind TEXT NOT NULL,declared_date TEXT NOT NULL,effective_from TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS regular_activations(pattern_id INTEGER PRIMARY KEY,clerk_user_id TEXT NOT NULL,effective_from TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS regular_holidays(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,holiday_date TEXT NOT NULL,pattern_id INTEGER NOT NULL,minutes INTEGER NOT NULL DEFAULT 120,revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'calculated',amount_cents INTEGER NOT NULL DEFAULT 0,snapshot_json TEXT,note TEXT,decided_by TEXT,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(clerk_user_id,holiday_date))`,
      `CREATE TABLE IF NOT EXISTS regular_week_confirmations(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,week_start TEXT NOT NULL,state_hash TEXT NOT NULL,note TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS regular_submission_events(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,week_start TEXT NOT NULL,event TEXT NOT NULL,actor TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TABLE IF NOT EXISTS regular_work_history(id INTEGER PRIMARY KEY AUTOINCREMENT,clerk_user_id TEXT NOT NULL,entry_id INTEGER,event TEXT NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE TRIGGER IF NOT EXISTS regular_patterns_no_update BEFORE UPDATE ON regular_patterns BEGIN SELECT RAISE(ABORT,'Regeltage bleiben in der Historie erhalten.'); END`,
      `CREATE TRIGGER IF NOT EXISTS regular_patterns_no_delete BEFORE DELETE ON regular_patterns BEGIN SELECT RAISE(ABORT,'Regeltage bleiben in der Historie erhalten.'); END`,
      `CREATE TRIGGER IF NOT EXISTS regular_activations_no_update BEFORE UPDATE ON regular_activations BEGIN SELECT RAISE(ABORT,'Geltungsbeginn bleibt erhalten.'); END`,
      `CREATE TRIGGER IF NOT EXISTS regular_activations_no_delete BEFORE DELETE ON regular_activations BEGIN SELECT RAISE(ABORT,'Geltungsbeginn bleibt erhalten.'); END`,
      `CREATE UNIQUE INDEX IF NOT EXISTS regular_initial_once ON regular_patterns(clerk_user_id) WHERE kind='initial'`,
      `CREATE INDEX IF NOT EXISTS regular_patterns_owner ON regular_patterns(clerk_user_id,id)`
    ].map(sql=>stmt(env,sql)));
    for(const [table,col,type] of [['work_entries','record_kind',"TEXT NOT NULL DEFAULT 'actual'"],['work_entries','entry_note',"TEXT NOT NULL DEFAULT ''"],['work_entries','regular_slot','TEXT'],['work_entries','entry_state',"TEXT NOT NULL DEFAULT 'final'"],['work_entries','submission_id','INTEGER'],['employee_absences','regular_holiday_id','INTEGER'],['regular_week_confirmations','submission_token','TEXT']]){
      if(!(await all(env,`PRAGMA table_info(${table})`)).some(c=>c.name===col)){
        try{await run(env,`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)}catch(error){if(!(await all(env,`PRAGMA table_info(${table})`)).some(c=>c.name===col))throw error;}
      }
    }
    await env.DB.batch([
      stmt(env,"CREATE VIEW IF NOT EXISTS payroll_work_entries AS SELECT * FROM work_entries WHERE entry_state='final'"),
      stmt(env,"CREATE VIEW IF NOT EXISTS payroll_performance_entries AS SELECT p.* FROM performance_entries p WHERE p.work_entry_id IS NULL OR EXISTS(SELECT 1 FROM work_entries w WHERE w.id=p.work_entry_id AND w.entry_state='final')")
    ]);
    await run(env,"CREATE UNIQUE INDEX IF NOT EXISTS regular_one_allocation ON work_entries(clerk_user_id,regular_slot) WHERE record_kind='weekly_allocation'");
    await run(env,`CREATE TRIGGER IF NOT EXISTS regular_allocation_final_guard BEFORE UPDATE ON work_entries WHEN OLD.submission_id IS NOT NULL AND OLD.entry_state='final' AND NEW.entry_state='final' AND (NEW.record_kind<>OLD.record_kind OR NEW.entry_note<>OLD.entry_note) BEGIN SELECT RAISE(ABORT,'Abgesendete Wochenzuordnung ist festgeschrieben.'); END`);
    await ensureAdjustments(env);
    for(const table of ['work_entries','performance_entries','employee_absences','appointment_adjustments','week_reviews','regular_patterns','leave_regions','employee_profiles','payroll_settings','regular_week_confirmations','regular_submission_events','leave_requests']){
      for(const [event,p] of [['INSERT','NEW'],['UPDATE','NEW'],['DELETE','OLD']])await run(env,`CREATE TRIGGER IF NOT EXISTS payroll_check_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN DELETE FROM payroll_checks WHERE clerk_user_id=${p}.clerk_user_id; END`);
    }
    for(const table of ['office_pay_rates','office_payroll_years','office_settings'])for(const event of ['INSERT','UPDATE','DELETE'])await run(env,`CREATE TRIGGER IF NOT EXISTS payroll_check_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN DELETE FROM payroll_checks; END`);
    await run(env,"CREATE UNIQUE INDEX IF NOT EXISTS regular_submission_once ON regular_week_confirmations(clerk_user_id,week_start,state_hash)");
    for(const table of ['office_pay_rates','office_payroll_years'])for(const event of ['INSERT','UPDATE'])await run(env,`CREATE TRIGGER IF NOT EXISTS calendar_year_frozen_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} WHEN EXISTS(SELECT 1 FROM monthly_closings WHERE substr(payroll_month,1,4)=CAST(NEW.pay_year AS TEXT)) BEGIN SELECT RAISE(ABORT,'Jahreswerte mit bestehenden Abschlüssen bleiben erhalten.'); END`);
    await run(env,`CREATE TRIGGER IF NOT EXISTS regular_no_late_draft BEFORE INSERT ON work_entries WHEN NEW.entry_state='draft' AND EXISTS(SELECT 1 FROM regular_week_confirmations s WHERE s.clerk_user_id=NEW.clerk_user_id AND s.week_start=date(NEW.work_date,'-'||((CAST(strftime('%w',NEW.work_date) AS INTEGER)+6)%7)||' days') AND s.id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE clerk_user_id=NEW.clerk_user_id AND event='reopened')) BEGIN SELECT RAISE(ABORT,'Diese Woche wurde bereits abgesendet.'); END`);
    await run(env,`CREATE TRIGGER IF NOT EXISTS regular_final_no_change BEFORE UPDATE ON work_entries WHEN OLD.submission_id IS NOT NULL AND OLD.entry_state='final' AND NEW.entry_state='final' AND (NEW.work_date<>OLD.work_date OR NEW.work_minutes<>OLD.work_minutes OR NEW.start_time<>OLD.start_time OR NEW.end_time<>OLD.end_time OR NEW.break_minutes<>OLD.break_minutes OR COALESCE(NEW.regular_slot,'')<>COALESCE(OLD.regular_slot,'')) BEGIN SELECT RAISE(ABORT,'Abgesendete Arbeitswoche ist festgeschrieben.'); END`);
    await run(env,`CREATE TRIGGER IF NOT EXISTS regular_final_no_delete BEFORE DELETE ON work_entries WHEN OLD.submission_id IS NOT NULL AND OLD.entry_state='final' BEGIN SELECT RAISE(ABORT,'Abgesendete Arbeitswoche ist festgeschrieben.'); END`);
    await run(env,`CREATE TRIGGER IF NOT EXISTS regular_final_no_performance_change BEFORE UPDATE ON performance_entries WHEN EXISTS(SELECT 1 FROM work_entries w WHERE w.id=OLD.work_entry_id AND w.submission_id IS NOT NULL AND w.entry_state='final') AND NEW.appointments<>OLD.appointments BEGIN SELECT RAISE(ABORT,'Abgesendete Termine sind festgeschrieben.'); END`);
    const cols=(await all(env,'PRAGMA table_info(work_entries)')).map(c=>c.name).filter(c=>/^[a-z_]+$/.test(c));
    for(const [event,when,p] of [['created','AFTER INSERT','NEW'],['changed','AFTER UPDATE','NEW'],['removed','BEFORE DELETE','OLD']]){
      await run(env,`DROP TRIGGER IF EXISTS regular_work_${event}`);
      await run(env,`CREATE TRIGGER IF NOT EXISTS regular_work_${event} ${when} ON work_entries BEGIN INSERT INTO regular_work_history(clerk_user_id,entry_id,event,snapshot_json) VALUES(${p}.clerk_user_id,${p}.id,'${event}',json_object(${cols.map(c=>`'${c}',${p}.${c}`).join(',')})); END`);
    }
    await run(env,"CREATE TABLE IF NOT EXISTS office_schema_versions(name TEXT PRIMARY KEY,version INTEGER NOT NULL,installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    await run(env,"INSERT OR REPLACE INTO office_schema_versions(name,version) VALUES('calendar',3)");officeSchemaKnown.set(env.DB,true);
  })();regularSchemaReady.set(env.DB,pending);
  try{await pending}catch(error){regularSchemaReady.delete(env.DB);throw error;}
}
function regularWeekday(date){return new Date(date+'T12:00Z').getUTCDay();}
function regularChangeDate(date){const [y,m]=date.split('-').map(Number);return new Date(Date.UTC(y,m+1,1)).toISOString().slice(0,10);}
async function regularPatterns(env,owner){
  await ensureRegular(env);
  // Activation is append-only and can be retried after either party signs.
  const signed=await first(env,`SELECT MAX(signed_at) signed_at FROM addendum_signatures WHERE clerk_user_id=? AND version=? HAVING COUNT(DISTINCT role)=2 AND COUNT(DISTINCT doc_hash)=1`,owner,CALENDAR_ADDENDUM.version);
  if(signed?.signed_at){
    const initial=await first(env,"SELECT * FROM regular_patterns WHERE clerk_user_id=? AND kind='initial' ORDER BY id LIMIT 1",owner);
    if(initial){await insertLeaveTerms(env,owner,signed.signed_at,(await first(env,'SELECT doc_hash FROM addendum_signatures WHERE clerk_user_id=? AND version=? LIMIT 1',owner,CALENDAR_ADDENDUM.version)).doc_hash);await run(env,"INSERT OR IGNORE INTO regular_activations(pattern_id,clerk_user_id,effective_from) VALUES(?,?,?)",initial.id,owner,['2026-11-01',initial.declared_date,leaveSignedDate(signed.signed_at)].sort().at(-1));}
  }
  return (await all(env,`SELECT p.*,COALESCE(a.effective_from,p.effective_from) valid_from FROM regular_patterns p LEFT JOIN regular_activations a ON a.pattern_id=p.id WHERE p.clerk_user_id=? ORDER BY p.id`,owner)).map(p=>({...p,weekdays:safeParse(p.weekdays_json)||[],weekdays_json:undefined}));
}
function regularAt(patterns,date){return patterns.filter(p=>p.valid_from&&p.valid_from<=date).sort((a,b)=>a.valid_from.localeCompare(b.valid_from)||a.id-b.id).at(-1)||null;}
async function regularActive(env,owner,date=berlinToday()){
  await ensureContracts(env);
  const signed=await first(env,`SELECT COUNT(*) n FROM addendum_signatures WHERE clerk_user_id=? AND version=? HAVING COUNT(DISTINCT role)=2 AND COUNT(DISTINCT doc_hash)=1`,owner,CALENDAR_ADDENDUM.version);
  if(!signed)return null;return regularAt(await regularPatterns(env,owner),date);
}
async function getRegularPattern({env,owner,userId}){
  owner=owner||userId;const patterns=await regularPatterns(env,owner),current=regularAt(patterns,berlinToday());
  const signed=await first(env,'SELECT 1 FROM addendum_signatures WHERE clerk_user_id=? AND version=? AND role=\'employee\'',owner,CALENDAR_ADDENDUM.version);
  return json({patterns,current,needsInitial:!!signed&&!patterns.length,employeeSigned:!!signed,nextChangeDate:regularChangeDate(berlinToday()),today:berlinToday()});
}
async function chooseRegularPattern({request,env,userId,exec}){
  if(isBoss(env,userId)||!await addendumFor(env,userId))return err('Bitte die eigenen Regeltage als Mitarbeiter festlegen.',403);
  const body=await readJson(request),days=Array.isArray(body?.weekdays)?body.weekdays:[];
  if(days.length!==3||new Set(days).size!==3||days.some(d=>!Number.isInteger(d)||d<1||d>5)||body?.confirmed!==true)return err('Bitte genau drei verschiedene Tage von Montag bis Freitag wählen und bestätigen.');
  const state=await addendumState(env,userId);if(!state.signatures.employee)return err('Bitte zuerst den Nachtrag lesen und unterschreiben.',409);
  const patterns=await regularPatterns(env,userId),initial=patterns.length===0,today=berlinToday(),effective=initial?null:regularChangeDate(today);
  if(!initial&&!patterns[0].valid_from)return err('Kim muss den Nachtrag erst gegenzeichnen, bevor du eine Änderung erklärst.',409);
  if(!initial){const approved=await all(env,"SELECT absence_date FROM employee_absences WHERE clerk_user_id=? AND absence_type IN ('vacation','holiday') AND absence_date>=?",userId,effective);if(approved.some(a=>!days.includes(regularWeekday(a.absence_date))))return err('Die neuen Regeltage würden bereits genehmigten Urlaub verändern. Bitte zuerst mit Kim die betroffenen Urlaubstage anpassen.',409);}
  await env.DB.batch([
    stmt(env,'INSERT INTO regular_patterns(clerk_user_id,weekdays_json,kind,declared_date,effective_from) VALUES(?,?,?,?,?)',[userId,JSON.stringify([...days].sort()),initial?'initial':'change',today,effective]),
    stmt(env,`INSERT INTO leave_audit(clerk_user_id,event,actor,detail_json) VALUES(?,'regular_days_chosen',?,?)`,[userId,userId,JSON.stringify({weekdays:days,effective_from:effective,initial})])
  ]);
  await regularPatterns(env,userId);
  await pushBoss(env,exec,{title:initial?'Regeltage festgelegt':'Regeltage ändern sich',body:initial?'Die drei Regeltage stehen in Office. Bitte den Nachtrag gegenzeichnen, falls noch offen.':`Neue Regelverteilung gilt ab ${fmtDe(effective)}.`,tag:'regular-days-'+userId,url:hrUrl('kalender')});
  return getRegularPattern({env,userId});
}
async function regularHolidayRows(env,owner,from,to,patterns=null,knownContext=null){
  patterns=patterns||await regularPatterns(env,owner);
  const context=knownContext||await leaveContext(env,owner),result=[];
  const maps=new Map();
  for(const date of leaveDays(from,to)){
    const p=regularAt(patterns,date),weekday=regularWeekday(date);if(!p||!p.weekdays.includes(weekday))continue;
    const y=Number(date.slice(0,4));if(!maps.has(y))maps.set(y,leaveHolidays(y,context.regionAt(date)));const name=leaveHolidays(y,context.regionAt(date))[date];if(!name)continue;
    await run(env,'INSERT OR IGNORE INTO regular_holidays(clerk_user_id,holiday_date,pattern_id) VALUES(?,?,?)',owner,date,p.id);
    const row=await first(env,'SELECT * FROM regular_holidays WHERE clerk_user_id=? AND holiday_date=?',owner,date);
    result.push({...row,date,name,snapshot:safeParse(row.snapshot_json),snapshot_json:undefined});
  }
  return result;
}
async function regularHolidayQuote(env,owner,date){
  await ensureRegular(env);
  await ensureAdjustments(env);
  const [y,m]=date.split('-').map(Number),from=new Date(Date.UTC(y,m-3,1)).toISOString().slice(0,10),to=monthEnd(date.slice(0,7));
  const work=await first(env,'SELECT COALESCE(SUM(work_minutes),0) minutes FROM payroll_work_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?',owner,from,to);
  const perf=await first(env,'SELECT COALESCE(SUM(appointments),0) appointments FROM payroll_performance_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?',owner,from,to);
  const adjustments=await all(env,'SELECT delta FROM appointment_adjustments WHERE clerk_user_id=? AND payroll_month BETWEEN ? AND ?',owner,from.slice(0,7),date.slice(0,7));
  const appointments=Math.max(0,Number(perf?.appointments||0)+adjustmentSum(adjustments)),minutes=Number(work?.minutes||0),base=Math.round(120*hourlyRateCents(date.slice(0,7))/60),variable=minutes?Math.round(120*appointments*COMMISSION_RATE_CENTS/minutes):0;
  return {from,to,reference_minutes:minutes,reference_appointments:appointments,hourly_rate_cents:hourlyRateCents(date.slice(0,7)),base_cents:base,variable_cents:variable,suggested_cents:base+variable,provisional:berlinToday()<=to,emptyReference:minutes===0};
}
async function regularMonthInfo(env,owner,month,patterns=null,context=null){
  patterns=patterns||await regularPatterns(env,owner);context=context||await leaveContext(env,owner);
  const settings=await first(env,'SELECT * FROM office_settings WHERE id=1'),holidays={};
  for(const date of leaveDays(month+'-01',monthEnd(month))){const name=leaveHolidays(Number(date.slice(0,4)),context.regionAt(date))[date];if(name)holidays[date]=name;}
  const dates=leaveDays(month+'-01',monthEnd(month)).filter(date=>regularAt(patterns,date)?.weekdays.includes(regularWeekday(date))&&date>=(context.job.start_date||date)&&(!context.job.end_date||date<=context.job.end_date));
  const baseMinutes=dates.length*120,holidayMinutes=dates.filter(d=>holidays[d]).length*120,factor=baseMinutes?(baseMinutes-holidayMinutes)/baseMinutes:1;
  const appointments=Math.round((settings?.goal_appointments||40)*factor),cutAppointments=Math.round((settings?.cut_appointments||50)*factor);
  const performance=await all(env,'SELECT work_date,SUM(appointments) appointments FROM performance_entries WHERE clerk_user_id=? AND substr(work_date,1,7)=? GROUP BY work_date ORDER BY work_date',owner,month);
  let n=0,cutDate=null;for(const p of performance){n+=p.appointments;if(!cutDate&&n>=cutAppointments)cutDate=p.work_date;}
  const prefix='Automatische Freistellung: Monatsziel '+month;
  const releaseDays=cutDate?dates.filter(date=>date>cutDate&&!holidays[date]&&!context.work.some(w=>w.work_date===date)&&!context.absences.some(a=>a.absence_date===date&&!String(a.note||'').startsWith(prefix))).map(date=>({date,absence_date:date,absence_type:'paid_leave',paid_minutes:120,paid_amount_cents:2*hourlyRateCents(date.slice(0,7)),note:prefix,source_cut_date:cutDate})):[];
  return {month,baseMinutes,holidayMinutes,appointments,cutAppointments,cutDate,releaseDays};
}
async function groupLegacyRegularWeek(env,owner,patterns,week){
  const pattern=patterns[0];if(!pattern||!pattern.weekdays?.length)return;
  const requested=await first(env,"SELECT 1 FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='group_pending'",owner,week);
  if(!requested||await first(env,"SELECT 1 FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='legacy_grouped'",owner,week))return;
  const entries=await all(env,"SELECT * FROM work_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ? AND record_kind='actual' AND submission_id IS NULL",owner,week,addDays(week,6));
  if(entries.some(e=>e.submission_id)||!entries.length)return;
  for(const e of entries)if(await closedMonthError(env,owner,e.work_date))return;
  const slot=addDays(week,Math.min(...pattern.weekdays)-1);
  await env.DB.batch([
    stmt(env,"INSERT INTO regular_submission_events(clerk_user_id,week_start,event,actor,detail_json) SELECT ?,?,'legacy_grouped','system',? WHERE NOT EXISTS(SELECT 1 FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='legacy_grouped')",[owner,week,JSON.stringify({slot,entries,reason:'Bestehende Zeiten auf ausdrücklichen Wunsch der ersten Wochenzeile zugeordnet; tatsächliche Daten bleiben erhalten.'}),owner,week]),
    stmt(env,"UPDATE work_entries SET regular_slot=?,updated_at=CURRENT_TIMESTAMP WHERE clerk_user_id=? AND work_date BETWEEN ? AND ? AND record_kind='actual' AND submission_id IS NULL",[slot,owner,week,addDays(week,6)])
  ]);
}
async function getRegularWeek({env,owner,userId,url}){
  owner=owner||userId;const week=String(url.searchParams.get('week')||mondayOfWeek(berlinToday()));
  if(!validDate(week)||mondayOfWeek(week)!==week)return err('Ungültige Kalenderwoche.');
  const patterns=await regularPatterns(env,owner),end=addDays(week,6),current=regularAt(patterns,end),context=await leaveContext(env,owner);
  await groupLegacyRegularWeek(env,owner,patterns,week);
  const entries=await all(env,`SELECT w.*,COALESCE(p.appointments,0) appointments FROM work_entries w LEFT JOIN performance_entries p ON p.work_entry_id=w.id WHERE w.clerk_user_id=? AND w.work_date BETWEEN ? AND ? ORDER BY w.work_date,w.start_time`,owner,week,end);
  const holidays=await regularHolidayRows(env,owner,week,end,patterns,context);
  const monthInfos=await Promise.all([...new Set([week.slice(0,7),end.slice(0,7)])].map(m=>regularMonthInfo(env,owner,m,patterns,context)));
  const absences=context.absences.filter(a=>a.absence_date>=week&&a.absence_date<=end);
  for(const day of monthInfos.flatMap(m=>m.releaseDays).filter(d=>d.date>=week&&d.date<=end))if(!absences.some(a=>a.absence_date===day.date))absences.push(day);
  const declared=patterns.find(p=>p.kind==='initial'&&p.declared_date<=end&&(!p.valid_from||week<=mondayOfWeek(p.valid_from)))||null;
  const transition=!!declared&&!leaveDays(week,addDays(week,4)).some(d=>regularAt(patterns,d)?.weekdays.includes(regularWeekday(d)));
  const legacyPlans=transition?context.plans.filter(p=>p.plan_date>=week&&p.plan_date<=end&&p.status!=='cancelled'):[];
  const dateFor=d=>addDays(week,d-1),weekdaySet=new Set((current||declared)?.weekdays||[]);
  for(const date of leaveDays(week,addDays(week,4))){const p=regularAt(patterns,date);if(p?.weekdays.includes(regularWeekday(date)))weekdaySet.add(regularWeekday(date));}
  const slotDates=transition&&legacyPlans.length?[...new Set([...legacyPlans.map(p=>p.plan_date),...entries.map(e=>e.regular_slot||e.work_date)])].filter(d=>regularWeekday(d)>=1&&regularWeekday(d)<=5).sort():[...weekdaySet].sort().map(dateFor);
  const slots=slotDates.map(date=>{
    const day=regularWeekday(date),p=regularAt(patterns,date)||declared,holiday=holidays.find(h=>h.date===date),absence=absences.find(a=>a.absence_date===date);
    return {date,weekday:day,pattern_id:p?.id||null,legacy:transition,holiday:holiday||null,absence:absence||null,entries:entries.filter(e=>e.regular_slot===date||!e.regular_slot&&e.work_date===date)};
  });
  const assigned=new Set(slots.flatMap(s=>s.entries.map(e=>e.id))),unassigned=entries.filter(e=>!assigned.has(e.id));
  const mins=entries.reduce((n,e)=>n+e.work_minutes,0),credit=holidays.reduce((n,h)=>n+h.minutes,0),other=absences.filter(a=>a.absence_type!=='holiday').reduce((n,a)=>n+a.paid_minutes,0);
  const activeDates=leaveDays(week,addDays(week,4)).filter(date=>{const p=regularAt(patterns,date);return p?.weekdays.includes(regularWeekday(date))&&(!context.job.end_date||date<=context.job.end_date)&&date>=(context.job.start_date||date)});
  const baseline=activeDates.length?activeDates.length*120:declared?360:current?0:360,target=Math.max(0,baseline-credit-other),fulfilled=mins+credit+other;
  const correction=(await first(env,"SELECT MAX(id) id FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event IN ('reopened','correction_allowed')",owner,week))?.id||0;
  const stateHash=await sha256Hex(JSON.stringify({week,correction,entries:entries.map(e=>e.record_kind==='weekly_allocation'?[e.id,e.work_date,e.regular_slot,e.work_minutes,e.appointments,e.record_kind,e.entry_note]:[e.id,e.work_date,e.regular_slot,e.work_minutes,e.appointments])}));
  const confirmation=await first(env,"SELECT * FROM regular_week_confirmations WHERE clerk_user_id=? AND week_start=? AND state_hash=? AND id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='reopened') ORDER BY id DESC LIMIT 1",owner,week,stateHash,owner,week);
  if(confirmation){const event=await first(env,"SELECT actor,detail_json FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='submitted' AND json_extract(detail_json,'$.submission_id')=? ORDER BY id DESC LIMIT 1",owner,week,confirmation.id);confirmation.automatic=event?.actor==='system'&&safeParse(event?.detail_json)?.automatic===true;}
  const review=await first(env,'SELECT * FROM week_reviews WHERE clerk_user_id=? AND week_start=?',owner,week).catch(()=>null);
  const pastWeeks=[];
  const submittedWeeks=new Set((await all(env,"SELECT week_start FROM regular_week_confirmations WHERE clerk_user_id=? AND id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE clerk_user_id=? AND event='reopened')",owner,owner)).map(r=>r.week_start));
  const initial=patterns.filter(p=>p.valid_from).map(p=>p.valid_from).sort()[0];
  if(initial){for(let w=mondayOfWeek(initial),i=0;w<=mondayOfWeek(berlinToday())&&i<110;i++,w=addDays(w,7)){
    if(addDays(w,6)>berlinToday())continue;
    const confirmed=submittedWeeks.has(w);
    if((!confirmed||w===week&&!confirmation)&&!context.closings.some(c=>c.payroll_month===addDays(w,4).slice(0,7)))pastWeeks.push(w);
  }}
  const recent=entries.map(e=>regularWeekday(e.work_date));
  const latestWeeks=[];
  for(let i=0;i<6;i++){
    const w=addDays(mondayOfWeek(berlinToday()),-7*(i+1)),ds=context.work.filter(e=>e.work_date>=w&&e.work_date<=addDays(w,6));
    if(ds.length)latestWeeks.push(ds.some(e=>e.record_kind!=='weekly_allocation'&&!regularAt(patterns,e.work_date)?.weekdays.includes(regularWeekday(e.work_date))));
  }
  return json({transition,regularStart:declared?.valid_from||null,correctionOpen:await regularCorrectionOpen(env,owner,week),monthGoals:monthInfos.map(m=>({month:m.month,appointments:m.appointments,cutAppointments:m.cutAppointments,baseMinutes:m.baseMinutes,holidayMinutes:m.holidayMinutes})),week,end,active:activeDates.length>0||!!declared,current,patterns,slots:slots.filter(s=>s.pattern_id),unassigned,entries,holidays,absences,workMinutes:mins,holidayMinutes:credit,absenceMinutes:other,baseMinutes:baseline,targetMinutes:target,fulfilledMinutes:fulfilled,missingMinutes:Math.max(0,target-mins),overtimeMinutes:Math.max(0,mins-target),actualWorkdays:new Set(entries.filter(e=>e.record_kind!=='weekly_allocation').map(e=>e.work_date)).size,review,stateHash,confirmed:!!confirmation,confirmation,overdue:pastWeeks,patternReview:latestWeeks.filter(Boolean).length>=4,today:berlinToday()});
}
// A weekly allocation is explicitly a reference row, never an invented actual workday or clock interval.
async function saveRegularSlot({env,userId,request}){
  if(isBoss(env,userId))return err('Bitte im Mitarbeiterkonto eintragen.',403);
  await ensureRegular(env);const body=await readJson(request),date=String(body?.slot||''),minutes=Number(body?.minutes),appointments=Number(body?.appointments),note=cleanText(body?.note,500)||'';
  if(!validDate(date)||!Number.isInteger(minutes)||minutes<0||minutes>1440||!Number.isInteger(appointments)||appointments<0||appointments>1000)return err('Bitte gültige Stunden und eine ganze Terminanzahl eintragen.');
  const week=mondayOfWeek(date),today=berlinToday();
  if(week>mondayOfWeek(today)||week<mondayOfWeek(today)&&!await regularCorrectionOpen(env,userId,week))return err('Bitte die aktuelle Woche bearbeiten. Vergangene Wochen muss Kim zur Korrektur öffnen.',409);
  const response=await getRegularWeek({env,userId,url:new URL('https://local/regular-week?week='+week)}),data=await response.json();
  const slot=data.slots?.find(s=>s.date===date);if(!data.active||!slot)return err('Bitte einen gültigen Regeltag auswählen.');
  if(slot.holiday||slot.absence)return err('Feiertage und genehmigte Abwesenheiten sind gesperrt.',409);
  if(data.confirmed)return err('Diese Woche wurde bereits abgesendet. Kim kann sie zur Korrektur öffnen.',409);
  const closed=await closedMonthError(env,userId,date);if(closed)return closed;
  const legacy=slot.entries.filter(e=>e.record_kind!=='weekly_allocation'),baseMinutes=legacy.reduce((n,e)=>n+e.work_minutes,0),baseAppointments=legacy.reduce((n,e)=>n+e.appointments,0);
  if(minutes<baseMinutes||appointments<baseAppointments)return err('Die bereits dokumentierten Zeiten und Termine bleiben erhalten. Bitte Kim um eine Korrektur dieser ursprünglichen Nachweise bitten.',409);
  const saved=await env.DB.batch([
    stmt(env,`INSERT INTO work_entries(clerk_user_id,work_date,start_time,end_time,break_minutes,work_minutes,regular_slot,record_kind,entry_note,entry_state)
      VALUES(?,?,'','',0,?,?,'weekly_allocation',?,'draft')
      ON CONFLICT(clerk_user_id,regular_slot) WHERE record_kind='weekly_allocation' DO UPDATE SET work_minutes=excluded.work_minutes,entry_note=excluded.entry_note,updated_at=CURRENT_TIMESTAMP WHERE work_entries.entry_state='draft' AND work_entries.submission_id IS NULL`,[userId,date,minutes-baseMinutes,date,note]),
    stmt(env,`INSERT INTO performance_entries(clerk_user_id,work_date,appointments,commissionable_appointments,work_entry_id)
      SELECT ?,?,?,?,id FROM work_entries WHERE clerk_user_id=? AND regular_slot=? AND record_kind='weekly_allocation' AND entry_state='draft' AND submission_id IS NULL
      ON CONFLICT(work_entry_id) DO UPDATE SET appointments=excluded.appointments,commissionable_appointments=excluded.commissionable_appointments,updated_at=CURRENT_TIMESTAMP`,[userId,date,appointments-baseAppointments,appointments-baseAppointments,userId,date])
  ]);
  if(!saved[0].meta?.changes)return err('Die Woche wurde inzwischen abgesendet. Bitte neu laden.',409);
  return ok({saved:true,slot:date});
}
async function completeRegularWeek(ctx){
  const {env,userId,request,exec}=ctx,automatic=ctx.automatic===true,body=await readJson(request),week=String(body?.week||'');
  if(!validDate(week)||mondayOfWeek(week)!==week||addDays(week,4)>berlinToday())return err('Die Arbeitswoche kann ab Freitag abgesendet werden.');
  const response=await getRegularWeek({...ctx,url:new URL('https://local/regular-week?week='+week)});if(response.status!==200)return response;const data=await response.json();
  if(!data.active)return err('Für diese Woche ist noch keine neue Regelverteilung aktiv.');
  if(data.confirmed)return ok({already_submitted:true,week});
  if(body.state_hash!==data.stateHash)return err('Die Woche wurde inzwischen geändert. Bitte neu laden.',409);
  const note=cleanText(body?.note,500)||'';
  if(data.missingMinutes>0&&!note&&!automatic)return err('Bitte die fehlenden Stunden kurz erläutern. Kim entscheidet wie bisher über die Einordnung.');
  if(data.entries.some(e=>e.record_kind!=='weekly_allocation'&&e.work_date>berlinToday()))return err('Zukünftige Arbeit kann nicht als geleistet abgesendet werden.');
  for(const e of data.entries){const closed=await closedMonthError(env,userId,e.work_date);if(closed)return closed;}
  const token=crypto.randomUUID(),detail={token,week,automatic,entries:data.entries,missingMinutes:data.missingMinutes,overtimeMinutes:data.overtimeMinutes,actualWorkdays:data.actualWorkdays,note,source_hash:data.stateHash};
  const sent=await env.DB.batch([
    stmt(env,`INSERT OR IGNORE INTO regular_week_confirmations(clerk_user_id,week_start,state_hash,note,submission_token)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM work_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?)=?
      AND NOT EXISTS(SELECT 1 FROM work_entries w LEFT JOIN performance_entries p ON p.work_entry_id=w.id LEFT JOIN json_each(?) j ON json_extract(j.value,'$.id')=w.id WHERE w.clerk_user_id=? AND w.work_date BETWEEN ? AND ? AND (j.value IS NULL OR w.work_minutes<>json_extract(j.value,'$.work_minutes') OR w.work_date<>json_extract(j.value,'$.work_date') OR w.start_time<>json_extract(j.value,'$.start_time') OR w.end_time<>json_extract(j.value,'$.end_time') OR w.break_minutes<>json_extract(j.value,'$.break_minutes') OR COALESCE(w.regular_slot,'')<>COALESCE(json_extract(j.value,'$.regular_slot'),'') OR COALESCE(p.appointments,0)<>json_extract(j.value,'$.appointments') OR COALESCE(w.entry_note,'')<>COALESCE(json_extract(j.value,'$.entry_note'),'') OR w.record_kind<>COALESCE(json_extract(j.value,'$.record_kind'),'actual')))`,[userId,week,data.stateHash,note,token,userId,week,addDays(week,6),data.entries.length,JSON.stringify(data.entries),userId,week,addDays(week,6)]),
    stmt(env,`INSERT INTO regular_submission_events(clerk_user_id,week_start,event,actor,detail_json) SELECT clerk_user_id,week_start,'submitted',?,json_set(?,'$.submission_id',id) FROM regular_week_confirmations WHERE submission_token=?`,[automatic?'system':userId,JSON.stringify(detail),token]),
    stmt(env,`UPDATE work_entries SET entry_state='final',submission_id=(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE json_extract(detail_json,'$.token')=?),updated_at=CURRENT_TIMESTAMP WHERE clerk_user_id=? AND work_date BETWEEN ? AND ? AND submission_id IS NULL`,[token,userId,week,addDays(week,6)])
  ]);
  if(!sent[0].meta?.changes)return err('Die Einträge wurden gleichzeitig geändert. Bitte die aktuellen Werte erneut prüfen und absenden.',409);
  // A concurrent draft change never receives a valid source hash silently.
  const verify=await getRegularWeek({...ctx,url:new URL('https://local/regular-week?week='+week)}),after=await verify.json();
  if(after.stateHash!==data.stateHash)return err('Die Woche wurde gleichzeitig geändert. Bitte Kim um Prüfung der übermittelten Version bitten.',409);
  await pushBoss(env,exec,{title:automatic?'Arbeitswoche automatisch übernommen':'Arbeitswoche abgesendet',body:`${isoWeekLabel(week)}: ${data.workMinutes} Minuten Arbeit, ${data.holidayMinutes+data.absenceMinutes} Minuten Gutschrift.${data.missingMinutes?' '+data.missingMinutes+' Minuten fehlen – bitte einordnen.':''}`,tag:'week-submitted-'+userId+'-'+week,url:hrUrl('einsatz')});
  await run(env,"UPDATE office_tasks SET status='completed',completed_at=CURRENT_TIMESTAMP WHERE assigned_to=? AND created_by=?",userId,'regular-submit:'+week);
  return ok({submitted:true,automatic,week});
}
async function regularCorrectionOpen(env,owner,date){
  if(!validDate(date))return false;
  return !!await first(env,"SELECT 1 FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event IN ('reopened','correction_allowed') LIMIT 1",owner,mondayOfWeek(date));
}
async function reopenRegularWeek({request,env,owner,userId,exec}){
  await ensureRegular(env);const body=await readJson(request),week=String(body?.week||''),note=cleanText(body?.note,500)||'';
  if(!validDate(week)||mondayOfWeek(week)!==week||!note)return err('Bitte Woche und Korrekturgrund angeben.');
  const closed=await closedMonthError(env,owner,week,addDays(week,4));if(closed)return closed;
  const entries=await all(env,'SELECT * FROM work_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?',owner,week,addDays(week,6));
  for(const e of entries){const closed=await closedMonthError(env,owner,e.work_date);if(closed)return closed;}
  const submissions=await all(env,"SELECT id FROM regular_week_confirmations WHERE clerk_user_id=? AND week_start=? AND id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='reopened')",owner,week,owner,week);
  if(!submissions.length)await run(env,"INSERT INTO regular_submission_events(clerk_user_id,week_start,event,actor,detail_json)VALUES(?,?,'correction_allowed',?,?)",owner,week,userId,JSON.stringify({note,entries}));
  await env.DB.batch([
    ...submissions.map(r=>stmt(env,"INSERT INTO regular_submission_events(clerk_user_id,week_start,event,actor,detail_json) VALUES(?,?,'reopened',?,?)",[owner,week,userId,JSON.stringify({submission_id:r.id,note,entries})])),
    stmt(env,"UPDATE work_entries SET entry_state='draft',submission_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?",[owner,week,addDays(week,6)])
  ]);
  await runLater(exec,notifyUser(env,owner,{title:'Arbeitswoche zur Korrektur geöffnet',body:`${isoWeekLabel(week)}: ${note} Bitte korrigieren und erneut absenden.`,tag:'week-correction-'+week,url:hrUrl('zeiten')}));return ok();
}
async function autoCompleteRegularWeeks(env,exec){
  await ensureRegular(env);const today=berlinToday(),current=mondayOfWeek(today);
  const people=await all(env,'SELECT DISTINCT clerk_user_id FROM regular_activations WHERE effective_from<?',current);
  for(const {clerk_user_id:userId} of people){
    for(let i=2;i>=1;i--){
      const week=addDays(current,-7*i);
      if(await regularCorrectionOpen(env,userId,week))continue;
      const response=await getRegularWeek({env,userId,url:new URL('https://local/regular-week?week='+week)});if(response.status!==200)continue;
      const data=await response.json();if(!data.active||data.confirmed)continue;
      const result=await completeRegularWeek({env,userId,exec,automatic:true,request:new Request('https://local/regular-week/complete',{method:'POST',body:JSON.stringify({week,state_hash:data.stateHash,note:'Automatisch nach Ablauf des Sonntags übernommen. Keine persönliche Bestätigung; fehlende Angaben bleiben offen.'})})});
      if(result.status!==200)console.warn('Automatic weekly submission deferred:',result.status);
    }
  }
}
function regularReminderSlot(date,time){
  const day=regularWeekday(date);if(day===6)return time>='12:00'?'sat-12':null;
  if(day===0)return ['17:00','13:00','09:00'].find(t=>time>=t)||null;
  return null;
}
async function remindRegularSubmissions(env,exec){
  await ensureRegular(env);const now=berlinParts(),week=mondayOfWeek(now.date),slot=regularReminderSlot(now.date,now.time);if(!slot)return;
  const people=await all(env,'SELECT DISTINCT clerk_user_id FROM regular_activations WHERE effective_from<=?',now.date);
  for(const {clerk_user_id:owner} of people){
    if(owner===TEST_LEAVE_USER_ID)continue;
    const response=await getRegularWeek({env,owner,userId:owner,url:new URL('https://local/regular-week?week='+week)}),w=await response.json();if(!w.active||w.confirmed)continue;
    const flag='regular-submit:'+owner+':'+week+':'+slot,claimed=await run(env,'INSERT OR IGNORE INTO hr_flags(flag) VALUES(?)',flag);if(!claimed.meta?.changes)continue;
    try{const result=await notifyUser(env,owner,{title:'Bitte Arbeitszeiten absenden',body:'Deine Arbeitswoche ist noch ein Entwurf. Bitte Stunden und Termine prüfen und spätestens Sonntag auf „Absenden“ klicken.',tag:'regular-submit-'+week+'-'+slot,url:hrUrl('zeiten')});if(!result.some(r=>r.status>=200&&r.status<300))await run(env,'DELETE FROM hr_flags WHERE flag=?',flag);}catch(error){await run(env,'DELETE FROM hr_flags WHERE flag=?',flag);throw error;}
  }
}
async function regularEntryError(env,owner,body,ignoreId=null){
  const active=await regularActive(env,owner,body.work_date);if(!active)return body.regular_slot?err('Für dieses Datum gibt es noch keine aktive Regelverteilung.'):null;
  if(body.work_date===berlinToday()&&body.end_time>berlinParts().time)return err('Die angegebene Arbeitszeit liegt noch in der Zukunft. Bitte erst nach geleisteter Arbeit speichern.');
  if(![1,2,3,4,5].includes(regularWeekday(body.work_date)))return err('Arbeitszeit kann nur für Montag bis Freitag erfasst werden.');
  const context=await leaveContext(env,owner);if(leaveHolidays(Number(body.work_date.slice(0,4)),context.region)[body.work_date])return err('An gesetzlichen Feiertagen wird keine Arbeitszeit gebucht. Die Gutschrift folgt den Regeltagen.');
  const sent=await first(env,"SELECT 1 FROM regular_week_confirmations WHERE clerk_user_id=? AND week_start=? AND id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE event='reopened' AND clerk_user_id=? AND week_start=?)",owner,mondayOfWeek(body.work_date),owner,mondayOfWeek(body.work_date));
  if(sent)return err('Diese Woche wurde bereits abgesendet. Kim kann sie zur Korrektur wieder öffnen.',409);
  const slot=String(body.regular_slot||body.work_date);
  if(!validDate(slot)||mondayOfWeek(slot)!==mondayOfWeek(body.work_date))return err('Regelplatz und tatsächlicher Arbeitstag müssen in derselben Kalenderwoche liegen.');
  const slotPattern=await regularActive(env,owner,slot);
  if(!slotPattern?.weekdays.includes(regularWeekday(slot)))return err('Bitte einen der gültigen Regelplätze dieser Woche auswählen.');
  if(leaveHolidays(Number(slot.slice(0,4)),context.region)[slot]||context.absences.some(a=>a.absence_date===slot))return err('Dieser Regelplatz ist durch Feiertag oder Abwesenheit gutgeschrieben. Bitte einen anderen Regelplatz wählen.');
  const overlap=await first(env,'SELECT 1 FROM work_entries WHERE clerk_user_id=? AND work_date=? AND start_time<? AND end_time>? AND id<>?',owner,body.work_date,body.end_time,body.start_time,ignoreId||-1);if(overlap)return err('Diese Arbeitszeit überschneidet sich mit einem bestehenden Eintrag.');
  return null;
}
async function getRegularHolidays({env,owner,url}){
  const month=String(url.searchParams.get('month')||berlinToday().slice(0,7));if(!validMonth(month))return err('Ungültiger Monat.');
  await ensureAdjustments(env);
  const rows=await regularHolidayRows(env,owner,month+'-01',monthEnd(month)),out=[];
  for(const row of rows)out.push({...row,quote:await regularHolidayQuote(env,owner,row.date),closed:!!await first(env,'SELECT 1 FROM monthly_closings WHERE clerk_user_id=? AND payroll_month=?',owner,month)});
  return json(out);
}
async function decideRegularHoliday({request,env,owner,userId,id}){
  await ensureRegular(env);await ensureAdjustments(env);
  const row=await first(env,'SELECT * FROM regular_holidays WHERE id=? AND clerk_user_id=?',id,owner);if(!row)return err('Feiertag nicht gefunden.',404);
  const body=await readJson(request),note=cleanText(body?.note,1000)||'',amount=Number(body?.amount_cents),quote=await regularHolidayQuote(env,owner,row.holiday_date);
  if(body?.confirmed!==true||Number(body.revision)!==row.revision||!note)return err('Bitte den aktuellen Feiertag, die Vergütung und die Begründung bestätigen.');
  const closed=await closedMonthError(env,owner,row.holiday_date);if(closed)return closed;
  const existing=await first(env,'SELECT regular_holiday_id FROM employee_absences WHERE clerk_user_id=? AND absence_date=?',owner,row.holiday_date);
  if(existing&&existing.regular_holiday_id!==row.id)return err('Für diesen Tag gibt es bereits eine gesonderte Abwesenheit. Bitte zuerst die Überschneidung klären.',409);
  if(row.holiday_date>berlinToday())return err('Die Feiertagsvergütung kann nach dem Feiertag geprüft werden. Die Stundengutschrift ist vorher schon sichtbar.');
  const unpaid=body.unpaid===true;
  if(unpaid&&body.adjacent_unexcused_confirmed!==true)return err('Ein Entgeltausfall nach § 2 Abs. 3 EFZG benötigt die ausdrücklich geprüfte unentschuldigte Abwesenheit unmittelbar vor oder nach dem Feiertag.');
  if(!unpaid&&(!Number.isInteger(amount)||amount<quote.base_cents||amount>1000000))return err('Bitte die volle geprüfte Vergütung einschließlich des Provisionsausfalls eintragen.');
  const token=crypto.randomUUID();
  const snapshot={token,manual:!unpaid&&amount!==quote.suggested_cents,quote,pattern_id:row.pattern_id,minutes:120,amount_cents:unpaid?0:amount,unpaid,adjacent_unexcused_confirmed:unpaid,note,approved_by:userId};
  const result=await env.DB.batch([
    stmt(env,"UPDATE regular_holidays SET status=?,amount_cents=?,snapshot_json=?,note=?,decided_by=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND revision=?",[unpaid?'unpaid':'approved',snapshot.amount_cents,JSON.stringify(snapshot),note,userId,id,owner,row.revision]),
    stmt(env,`INSERT INTO employee_absences(clerk_user_id,absence_date,absence_type,paid_minutes,paid_amount_cents,note,regular_holiday_id) SELECT clerk_user_id,holiday_date,'holiday',minutes,amount_cents,note,id FROM regular_holidays WHERE id=? AND json_extract(snapshot_json,'$.token')=? ON CONFLICT(clerk_user_id,absence_date) DO UPDATE SET paid_minutes=excluded.paid_minutes,paid_amount_cents=excluded.paid_amount_cents,note=excluded.note,updated_at=CURRENT_TIMESTAMP WHERE employee_absences.regular_holiday_id=excluded.regular_holiday_id`,[id,token]),
    stmt(env,`INSERT INTO leave_audit(clerk_user_id,event,actor,detail_json) SELECT clerk_user_id,'holiday_decided',?,snapshot_json FROM regular_holidays WHERE id=? AND json_extract(snapshot_json,'$.token')=?`,[userId,id,token])
  ]);
  if(!result[0].meta?.changes)return err('Feiertag wurde inzwischen geändert.',409);return ok();
}
async function regularClosingError(env,owner,month){
  if(!await regularActive(env,owner,monthEnd(month)))return null;
  await ensureAdjustments(env);
  const rows=await regularHolidayRows(env,owner,month+'-01',monthEnd(month));
  for(const r of rows){
    if(r.status==='calculated')return err('Bitte zuerst die Feiertagsvergütung im Kalender prüfen und freigeben.',409);
    const q=await regularHolidayQuote(env,owner,r.date),s=r.snapshot?.quote;
    if(r.status!=='unpaid'&&(!s||JSON.stringify(q)!==JSON.stringify(s)))return err('Die Berechnungsgrundlage der Feiertagsvergütung hat sich geändert. Bitte im Kalender erneut bestätigen.',409);
  }
  return null;
}
async function getLeaveSummary({env,owner,url}){
  const month=String(url.searchParams.get('month')||berlinToday().slice(0,7));if(!validMonth(month))return err('Ungültiger Monat.');
  const context=await leaveContext(env,owner),a=leaveAccount(context,Number(month.slice(0,4)),monthEnd(month));
  const patterns=await regularPatterns(env,owner),start=patterns.filter(p=>p.valid_from&&p.valid_from<=berlinToday()).map(p=>p.valid_from).sort()[0];
  const holidayCredits=start?(await regularHolidayRows(env,owner,[start,addDays(berlinToday(),-370)].sort().at(-1),berlinToday(),patterns)).map(h=>({absence_date:h.date,absence_type:'holiday',paid_minutes:h.minutes})):[];
  const info=await regularMonthInfo(env,owner,month,patterns,context);for(const d of info.releaseDays)holidayCredits.push(d);
  return json({...a,regularPatterns:patterns,holidayCredits,goals:info,workedDays:context.work.filter(w=>w.work_date.slice(0,4)===month.slice(0,4)&&w.work_date<=monthEnd(month)).length,equivalentDays:context.dutyDates.filter(d=>d.slice(0,4)===month.slice(0,4)&&d<=monthEnd(month)).length,averageWorkdaysPerWeek:a.annual/4});
}

/* Payroll checks use the same server calculator and frozen sources as the final PDF. */
async function prepareCalendarPayroll(env,owner,month){
  await ensureRegular(env);await ensureAdjustments(env);
  const context=await leaveContext(env,owner),patterns=await regularPatterns(env,owner);
  const holidayRows=await regularHolidayRows(env,owner,month+'-01',monthEnd(month),patterns,context),items=[],blockers=[];
  const [work,perf,settings,office,adjustments]=await Promise.all([
    all(env,'SELECT id,work_date,start_time,end_time,break_minutes,work_minutes,regular_slot,record_kind,entry_note FROM payroll_work_entries WHERE clerk_user_id=? AND substr(work_date,1,7)=? ORDER BY id',owner,month),
    all(env,'SELECT id,work_date,appointments FROM payroll_performance_entries WHERE clerk_user_id=? AND substr(work_date,1,7)=? ORDER BY id',owner,month),
    first(env,'SELECT * FROM payroll_settings WHERE clerk_user_id=?',owner),first(env,'SELECT * FROM office_settings WHERE id=1'),adjustmentRows(env,owner,month)
  ]);
  const draft=await first(env,"SELECT COUNT(*) n FROM work_entries WHERE clerk_user_id=? AND substr(work_date,1,7)=? AND entry_state='draft'",owner,month);
  if(draft.n)blockers.push(`${draft.n} Arbeitszeiteintrag/-einträge sind noch Entwürfe. Saskia muss die betroffenen Wochen absenden.`);
  for(let w=mondayOfWeek(month+'-01');w<=monthEnd(month);w=addDays(w,7)){
    const hasRegularDay=leaveDays(w,addDays(w,4)).some(d=>d.slice(0,7)===month&&regularAt(patterns,d)?.weekdays.includes(regularWeekday(d)));
    if(!hasRegularDay)continue;
    const submitted=await first(env,"SELECT 1 FROM regular_week_confirmations WHERE clerk_user_id=? AND week_start=? AND id NOT IN(SELECT CAST(json_extract(detail_json,'$.submission_id') AS INTEGER) FROM regular_submission_events WHERE clerk_user_id=? AND week_start=? AND event='reopened') LIMIT 1",owner,w,owner,w);
    if(!submitted)blockers.push(`${isoWeekLabel(w)} ist noch nicht abgesendet. Vorher kann der Monat nicht endgültig abgerechnet werden.`);
  }
  const knownYear=yearRules(month).confirmed&&officePayRates.has(Number(month.slice(0,4)));
  if(!knownYear)blockers.push('Jahreswerte für Mindestlohn, Minijobgrenze und Abgabensätze vor der Abrechnung bestätigen. Kalender und Urlaub bleiben nutzbar.');
  const pending=context.requests.filter(r=>['requested','cancellation_requested'].includes(r.status)&&(safeParse(r.dates_json)||[]).some(d=>d.slice(0,7)===month));
  if(pending.length)blockers.push(`${pending.length} offener Urlaubs-/Abwesenheitsantrag im Monat: bitte im Kalender entscheiden.`);
  context.payrollPaidReference=[];
  for(const h of holidayRows){const q=await regularHolidayQuote(env,owner,h.date);context.payrollPaidReference.push({absence_date:h.date,paid_minutes:120,paid_amount_cents:h.status==='unpaid'?0:h.snapshot?.manual?h.amount_cents:q.suggested_cents});}
  const info=await regularMonthInfo(env,owner,month,patterns,context),autoPrefix='Automatische Freistellung: Monatsziel '+month;
  const absences=context.absences.filter(a=>a.absence_date.slice(0,7)===month&&!a.regular_holiday_id&&!String(a.note||'').startsWith(autoPrefix));
  for(const d of info.releaseDays){items.push({key:'release:'+d.date,date:d.date,kind:'paid_leave',minutes:120,amount_cents:d.paid_amount_cents,quote:{source_cut_date:d.source_cut_date},manual:false});absences.push(d);}
  for(const a of absences){
    if(a.absence_type!=='vacation'||!a.leave_request_id)continue;
    const r=context.requests.find(r=>r.id===a.leave_request_id),d=safeParse(r?.snapshot_json)?.days?.find(d=>d.date===a.absence_date);
    if(!r||!d) {blockers.push('Ein Urlaubstag hat keine vollständige Genehmigungsgrundlage. Bitte im Kalender prüfen.');continue;}
    const q=await leavePayQuote(env,owner,a.absence_date,a.paid_minutes,'vacation',context,r.from_date);
    const manual=d.manual_amount===true,amount=manual?a.paid_amount_cents:q.suggested_cents;
    items.push({key:'vacation:'+a.id,id:a.id,request_id:r.id,date:a.absence_date,kind:'vacation',minutes:a.paid_minutes,amount_cents:amount,quote:q,manual});
    if(q.reference.minutes===0&&!manual&&!d.reference_reviewed)blockers.push(`Urlaubsentgelt ${fmtDe(a.absence_date)}: keine Referenzstunden. Vergütung im Kalender gesondert prüfen.`);
    a.paid_amount_cents=amount;context.payrollPaidReference.push({absence_date:a.absence_date,paid_minutes:a.paid_minutes,paid_amount_cents:amount});
  }
  for(const h of holidayRows){
    const q=await regularHolidayQuote(env,owner,h.date),unpaid=h.status==='unpaid',manual=!!h.snapshot?.manual;
    const amount=unpaid?0:manual?h.amount_cents:q.suggested_cents;
    const existing=context.absences.find(a=>a.absence_date===h.date);
    if(existing&&!existing.regular_holiday_id)blockers.push(`Feiertag ${fmtDe(h.date)} überschneidet sich mit einer gesonderten Abwesenheit. Bitte im Kalender klären.`);
    if(q.emptyReference&&h.status==='calculated')blockers.push(`Feiertag ${fmtDe(h.date)}: keine Referenzstunden. Den Provisionsausfall einmal im Kalender prüfen.`);
    const record={key:'holiday:'+h.id,id:h.id,date:h.date,name:h.name,kind:'holiday',minutes:h.minutes,pattern_id:h.pattern_id,amount_cents:amount,quote:q,unpaid,manual};items.push(record);
    absences.push({absence_date:h.date,absence_type:'holiday',paid_minutes:h.minutes,paid_amount_cents:amount,note:unpaid?'Entgeltausfall nach dokumentierter Prüfung § 2 Abs. 3 EFZG':'Regeltag: Feiertagsentgelt automatisch berechnet'});
  }
  const mins=work.reduce((n,w)=>n+w.work_minutes,0),appts=Math.max(0,perf.reduce((n,p)=>n+p.appointments,0)+adjustmentSum(adjustments));
  const result=calculatePayroll({month,mins,days:new Set(work.map(w=>w.work_date)).size,appts,profile:mapPayrollSettings(settings,owner),employment:context.job,absences,goalHours:office?.goal_hours||24,targetAppointments:info.cutAppointments,targetGrossCents:targetGrossFor(owner,month)});
  // A missing record is never itself an unexcused absence.
  const reviews=await all(env,'SELECT week_start,result,note FROM week_reviews WHERE clerk_user_id=?',owner);
  for(let w=mondayOfWeek(month+'-01');w<=monthEnd(month);w=addDays(w,7)){
    if(addDays(w,6)>=berlinToday()||!regularAt(patterns,w))continue;
    const weekEntries=await all(env,'SELECT work_date,work_minutes FROM work_entries WHERE clerk_user_id=? AND work_date BETWEEN ? AND ?',owner,w,addDays(w,6));
    const hs=await regularHolidayRows(env,owner,w,addDays(w,6),patterns,context),as=context.absences.filter(a=>a.absence_date>=w&&a.absence_date<=addDays(w,6)&&a.absence_type!=='holiday');
    const expected=leaveDays(w,addDays(w,4)).filter(date=>{const p=regularAt(patterns,date);return p?.weekdays.includes(regularWeekday(date))&&(!context.job.end_date||date<=context.job.end_date)}).length*120;
    const virtual=info.releaseDays.filter(d=>d.date>=w&&d.date<=addDays(w,6)&&!as.some(a=>a.absence_date===d.date));
    const covered=weekEntries.reduce((n,e)=>n+e.work_minutes,0)+hs.reduce((n,h)=>n+h.minutes,0)+as.reduce((n,a)=>n+a.paid_minutes,0)+virtual.reduce((n,a)=>n+a.paid_minutes,0);
    if(covered<expected&&!reviews.some(r=>r.week_start===w))blockers.push(`${isoWeekLabel(w)}: ${expected-covered} Minuten fehlen. Unter „Einsatz & Zeiten“ einordnen.`);
  }
  const holidayMinutes=holidayRows.reduce((n,h)=>n+h.minutes,0),baseMinutes=leaveDays(month+'-01',monthEnd(month)).filter(date=>{const p=regularAt(patterns,date);return p?.weekdays.includes(regularWeekday(date))&&date>=(context.job.start_date||date)&&(!context.job.end_date||date<=context.job.end_date)}).length*120;
  const factor=baseMinutes>0?Math.max(0,(baseMinutes-holidayMinutes)/baseMinutes):1;
  const goals={baseMinutes,holidayMinutes,appointments:info.appointments,cutAppointments:info.cutAppointments};
  const sources={month,targetGrossCents:targetGrossFor(owner,month),yearRules:yearRules(month),work,perf,adjustments:adjustments.map(a=>[a.id,a.delta]),items:items.map(i=>({...i,quote:i.quote})),absences:absences.map(a=>[a.absence_date,a.absence_type,a.paid_minutes,a.paid_amount_cents]),profile:mapPayrollSettings(settings,owner),goals,requests:context.requests.filter(r=>(safeParse(r.dates_json)||[]).some(d=>d.slice(0,7)===month)).map(r=>[r.id,r.status]),reviews};
  const hash=await sha256Hex(JSON.stringify(sources));
  await run(env,'CREATE TABLE IF NOT EXISTS payroll_checks(clerk_user_id TEXT NOT NULL,payroll_month TEXT NOT NULL,source_hash TEXT NOT NULL,checked_by TEXT NOT NULL,checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(clerk_user_id,payroll_month))');
  const checked=await first(env,'SELECT * FROM payroll_checks WHERE clerk_user_id=? AND payroll_month=? AND source_hash=?',owner,month,hash);
  return {month,hash,blockers,items,absences,profile:mapPayrollSettings(settings,owner),payroll:result.payroll,cents:result.cents,goals,checked:!!checked,check:checked||null,provisional:berlinToday()<=monthEnd(month),active:!!regularAt(patterns,monthEnd(month))};
}
async function getPayrollPreparation({env,owner,url}){
  const month=String(url.searchParams.get('month')||'');if(!validMonth(month))return err('Ungültiger Monat.');return json(await prepareCalendarPayroll(env,owner,month));
}
async function confirmPayrollPreparation({env,owner,userId,request}){
  const body=await readJson(request),month=String(body?.month||'');if(!validMonth(month)||body?.confirmed!==true)return err('Bitte Monat und Berechnungsprüfung bestätigen.');
  const closed=await closedMonthError(env,owner,month+'-01');if(closed)return closed;
  const p=await prepareCalendarPayroll(env,owner,month);if(p.active&&berlinToday()<=monthEnd(month))return err('Die endgültige Monatsberechnung kann nach Monatsende bestätigt werden. Der aktuelle Stand ist eine Vorschau.');if(body.hash!==p.hash)return err('Die Abrechnungsdaten wurden inzwischen geändert. Bitte neu laden.',409);
  if(p.blockers.length)return err(p.blockers.join(' '),409);
  const statements=[],token=crypto.randomUUID(),requestUpdates=new Map();
  for(const item of p.items){
    if(item.kind==='holiday'){
      const snapshot={token,quote:item.quote,pattern_id:item.pattern_id,minutes:item.minutes,amount_cents:item.amount_cents,manual:item.manual,unpaid:item.unpaid,approved_by:userId};
      statements.push(stmt(env,"UPDATE regular_holidays SET status=?,amount_cents=?,snapshot_json=?,note='Monatsberechnung geprüft',decided_by=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=?",[item.unpaid?'unpaid':'approved',item.amount_cents,JSON.stringify(snapshot),userId,item.id,owner]));
      statements.push(stmt(env,`INSERT INTO employee_absences(clerk_user_id,absence_date,absence_type,paid_minutes,paid_amount_cents,note,regular_holiday_id) VALUES(?,?,'holiday',?,?,'Monatsberechnung geprüft',?) ON CONFLICT(clerk_user_id,absence_date) DO UPDATE SET paid_amount_cents=excluded.paid_amount_cents,note=excluded.note,updated_at=CURRENT_TIMESTAMP WHERE employee_absences.regular_holiday_id=excluded.regular_holiday_id`,[owner,item.date,item.minutes,item.amount_cents,item.id]));
    }else if(item.kind==='paid_leave'){
      statements.push(stmt(env,"INSERT INTO employee_absences(clerk_user_id,absence_date,absence_type,paid_minutes,paid_amount_cents,note) VALUES(?,?,'paid_leave',120,?,?) ON CONFLICT(clerk_user_id,absence_date) DO UPDATE SET paid_amount_cents=excluded.paid_amount_cents WHERE employee_absences.note=excluded.note",[owner,item.date,item.amount_cents,'Automatische Freistellung: Monatsziel '+month]));
    }else{
      statements.push(stmt(env,'UPDATE employee_absences SET paid_amount_cents=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=?',[item.amount_cents,item.id,owner]));
      let r=requestUpdates.get(item.request_id);if(!r){r=await first(env,'SELECT * FROM leave_requests WHERE id=? AND clerk_user_id=?',item.request_id,owner);requestUpdates.set(item.request_id,r);r.snapshot=safeParse(r.snapshot_json);}
      const d=r.snapshot.days.find(d=>d.date===item.date);d.amount_cents=item.amount_cents;d.quote=item.quote;
    }
  }
  for(const [id,r] of requestUpdates)statements.push(stmt(env,'UPDATE leave_requests SET snapshot_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND clerk_user_id=? AND revision=?',[JSON.stringify(r.snapshot),id,owner,r.revision]));
  statements.push(stmt(env,"INSERT INTO leave_audit(clerk_user_id,event,actor,detail_json) VALUES(?,'payroll_calculation_confirmed',?,?)",[owner,userId,JSON.stringify({month,hash:p.hash,items:p.items,payroll:p.payroll})]));
  if(statements.length)await env.DB.batch(statements);
  const after=await prepareCalendarPayroll(env,owner,month);
  if(after.hash!==p.hash)return err('Die Berechnungsgrundlagen haben sich während der Prüfung geändert. Bitte die aktuellen Werte erneut prüfen.',409);
  await run(env,'INSERT INTO payroll_checks(clerk_user_id,payroll_month,source_hash,checked_by) VALUES(?,?,?,?) ON CONFLICT(clerk_user_id,payroll_month) DO UPDATE SET source_hash=excluded.source_hash,checked_by=excluded.checked_by,checked_at=CURRENT_TIMESTAMP',owner,month,after.hash,userId);
  return json({...after,checked:true});
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
  route("GET","/admin/payroll-preparation",getPayrollPreparation,{target:true}),
  route("POST","/admin/payroll-preparation",confirmPayrollPreparation,{target:true}),
  route("GET","/regular-pattern",getRegularPattern),
  route("POST","/regular-pattern",chooseRegularPattern),
  route("GET","/regular-week",getRegularWeek),
  route("PUT","/regular-week/slot",saveRegularSlot),
  route("POST","/regular-week/complete",completeRegularWeek),
  route("POST","/admin/regular-week/reopen",reopenRegularWeek,{target:true}),
  route("GET","/admin/regular-pattern",getRegularPattern,{target:true}),
  route("GET","/admin/regular-week",getRegularWeek,{target:true}),
  route("GET","/admin/regular-holidays",getRegularHolidays,{target:true}),
  route("PUT","/admin/regular-holidays/:id",decideRegularHoliday,{target:true}),
  route("GET","/admin/leave-summary",getLeaveSummary,{target:true}),
  route("GET", "/calendar", getLeaveCalendar),
  route("POST", "/leave-requests", addLeaveRequest),
  route("POST", "/leave-requests/:id/withdraw", withdrawLeaveRequest),
  route("POST", "/leave-transfer", transferLeave),
  route("POST", "/calendar/test/replay", replayCalendarIntro),
  route("POST", "/calendar/test/examples", seedCalendarTest),
  route("GET", "/admin/calendar", getLeaveCalendar,{target:true}),
  route("GET", "/admin/leave-requests/:id/preview", previewLeaveDecision,{target:true}),
  route("PUT", "/admin/leave-requests/:id", decideLeaveRequest,{target:true}),
  route("POST", "/admin/leave-adjustments", adjustLeave,{target:true}),
  route("PUT", "/admin/leave-region", setLeaveRegion,{target:true}),
  route("PUT", "/admin/leave-pay-rate", setLeaveRate,{target:true}),
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
  route("GET", "/admin/contact-history", listContactHistory),
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
  "/smartadm/sales/index.html": "713465527ce4735ca6271c668e821a18deba69e359fe8524f8d8bd3031c4af41",
  "/smartadm/sales/cloud.js": "b62ef1f8fa93b3c9b8e6007c622c8e2771dda3220e979c77eb1c55084b5e0e26",
  "/smartadm/office/": "060b8050584ba27cf331d90b82df95585645fb22015f6f6b6652b9c9ffec2deb",
  "/smartadm/office/sw.js": "f0a8b8de6aed345ed5ebf40455d5cbbe125f6ca1c40bac0a4cc31525d24d70ab",
  "/smartadm/office/week-planner.js": "1ff59ff97053f6702be28c7f57a78cf6b3b869271f15d0cb5344be7c61119bf2",
  "/smartadm/office/absence-calendar.js": "787a9a9b5f94c38183216681fa3f989731f2d97d4ef4983371972abb07aedbcc",
  "/smartadm/office/regular-week.js": "7c22ab1650f0fe110c9320dcafa24bc27f06125205b5a85230624866270220cd",
  "/smartadm/office/guided-intro.js": "f6486a67d097f46fca9cefcaeef85e8cdcffaf34233a93d75a078be95532facb",
  "/smartadm/office/vendor/xlsx-0.20.3.min.js": "cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41",
  "/smartadm/office/vendor/html2pdf.min.js": "f3e5733ad8b0547c6ad7ee6c7766277fc13d1cb584197aaacbed930ce5ce0f8f",
  "/datenschutz.html": "0db7d3ba0c2c10e4d0a6c5856b46f62aa4b025093963abfc6794d333190d9df4",
  "/404.html": "55c733b10173a25f32c248a5cf69ebe35428f959061f8639ba20f330d6c1d91b",
  "/unterschriften/": "47f30ce1d4116d1da32c8045f33b26a49fe5fdc3454827778b662885a884f220",
  "/unterschriften/signatures.js": "9913bbfac46853fb44389f583e59cf4d2c8644678c9e14fbf74cbc33e2a62ba3",
  "/unterschriften/signatures.css": "7605fb9b99de40023d212bb76b3d46e0d44391ad985ab673b631faf6784c691d",
  "/unterschriften/schwaebisch-hall.svg": "c1ab3ed0934866e2fcfeb7cde413268a458f82f973bf3b40df947418560b53f0",
  "/unterschriften/admin/": "427d886ac91a77562c4cd68ddad21f81b5c7769122cad47b09a7471a1a73dc3e",
  "/unterschriften/admin/admin.js": "c6ad83780f85c005165a2bed01ab3699c6da18e675d48a2cdc2505e19228f9c8"
};
// END MONITORED_ASSETS
async function monitorSecurity(env) {
  await ensureSecurity(env);
  for (const [path, expected] of Object.entries(MONITORED_ASSETS)) {
    let healthy = false, detail = "Abruf fehlgeschlagen oder Zeitüberschreitung";
    try {
      const response = await fetch(`${APP_ORIGIN}${path}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
        healthy = digest === expected;
        detail = healthy ? "HTTPS und SHA-256 stimmen mit dem freigegebenen Repository-Stand überein" : "Inhalt weicht vom freigegebenen Repository-Stand ab; Veröffentlichung oder unerwartete Änderung prüfen";
      } else detail = `HTTP ${response.status}${response.status >= 300 && response.status < 400 ? " – unerwartete Weiterleitung" : ""}`;
    } catch (error) {
      detail = `Abruf fehlgeschlagen: ${String(error?.message || "Unbekannter Fehler").slice(0, 200)}`;
    }
    await securityCheckResult(env, path, healthy, detail);
  }
  let apiHealthy = false, apiDetail = "API nicht erreichbar";
  try {
    const health = await fetch("https://smartadm-office-api.betcherkimg.workers.dev/health", { signal: AbortSignal.timeout(10000), redirect: "manual" });
    const body = await health.json();
    const denied = await fetch("https://smartadm-office-api.betcherkimg.workers.dev/admin/users", { signal: AbortSignal.timeout(10000), redirect: "manual" });
    apiHealthy = health.ok && body.database === true && denied.status === 401 && denied.headers.get("Cache-Control")?.includes("no-store");
    apiDetail = apiHealthy ? "API/Datenbank erreichbar; anonymer Adminzugriff abgewiesen" : `API-Health ${health.status}, anonymer Adminzugriff ${denied.status}`;
  } catch (error) {
    apiDetail = `API-Prüfung fehlgeschlagen: ${String(error?.message || "Unbekannter Fehler").slice(0, 200)}`;
  }
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
      await autoCompleteRegularWeeks(env,exec).catch(e=>console.error("autoCompleteRegularWeeks:",e.message));
      await remindRegularSubmissions(env,exec).catch(e=>console.error("remindRegularSubmissions:",e.message));
      // Only the submitted-week workflow sends employee week reminders.
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

      try {
        if (/^\/(?:admin\/)?(?:calendar|leave-|plans|absences|addendum|addenda)(?:\/|$|-)/.test(url.pathname)) await ensureLeave(env);
        if (/^\/(?:admin\/)?(?:settings|monthly-closings|contribution-reports|uv-lohnnachweis|absences)/.test(url.pathname)) await ensureRegular(env);
        if (/^\/(?:admin\/)?(?:calls|pool|contact-history)(?:\/|$)/.test(url.pathname)) await ensureContactHistory(env);
        return await r.handler(ctx);
      }
      catch (error) {
        console.error(JSON.stringify({ event: "office.handler_error", route: r.pattern.source }));
        exec.waitUntil(recordSecurityMetric(env, "handler_error").catch(() => {}));
        return err("Die Anfrage konnte nicht verarbeitet werden.", 500);
      }
    }

    return err(isAdminPath ? "Admin-Endpunkt nicht gefunden." : "Endpunkt nicht gefunden.", 404);
  }
};