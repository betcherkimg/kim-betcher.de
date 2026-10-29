/* =====================================================================
   TAKT Nr. 30 – Ticket- und Einlass-API (Cloudflare Worker + D1)
   Eigenständig: eigene Datenbank, berührt SmartADM/Office nicht.
   ===================================================================== */

const APP_ORIGIN = "https://kim-betcher.de";
const APP_URL = `${APP_ORIGIN}/taktnr30/tickets/`;
const CLERK_ISSUER = "https://clerk.kim-betcher.de";
const CLERK_JWKS_URL = `${CLERK_ISSUER}/.well-known/jwks.json`;

const REGULAR_CAP = 70;          // reguläres Kontingent
const FREE_CAP = 30;             // 2TAKT-Freitickets
const HELPER_CAP = 20;           // Helfer-Tickets (eigenes Kontingent)
const MAX_PER_INVITE = 2;        // nie mehr als 2 Tickets je Einladung
const PRICE_CENTS = { 1: 2000, 2: 3500 };   // 1 Ticket 20 €, 2 Tickets 35 €
const RESERVATION_MS = 15 * 60 * 1000;      // Bezahlfenster
const CAPTURE_HOLD_MS = 10 * 60 * 1000;     // Halten während der Zahlungsbestätigung
const CLOCK_TOLERANCE_S = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;

const ROLE_RANK = { scanner: 1, tickets: 2, main: 3 };
const ROLE_LABEL = { main: "Hauptadministrator", tickets: "Ticketverwaltung", scanner: "Einlass" };

const DEFAULT_SETTINGS = {
  event_date: "2027-03-06",
  doors_time: "19:00",
  start_time: "20:00",
  place_public: "Heidenheim · Halle Kai Betcher – Bau & Holz",
  venue_name: "Halle Kai Betcher – Bau & Holz",
  venue_address: "In den Seewiesen 84, 89520 Heidenheim",
  intro_title: "30 Jahre. 100 Gäste. 1 Halle.",
  intro_text: "Geschlossene Gesellschaft. Kein Gästelistenplatz, kein Einlass.\nEinlass ab 19:00. Der Takt beginnt um 20:00.",
  lineup: "[]",
  lineup_note: "Line-up folgt",
  contact_name: "Kim Betcher",
  contact_phone: "0152 22686361",
  contact_email: "betcherkimg@gmail.com",
  sale_mode: "closed",            // closed | test | live
  show_countdown: "1",
  helper_signup: "1",
  helper_jobs: JSON.stringify([{ name: "Bar", slots: 0 }, { name: "Ticketscanner", slots: 0 }])
};
const SETTING_LIMITS = {
  event_date: 10, doors_time: 5, start_time: 5, place_public: 120, venue_name: 120, venue_address: 160,
  intro_title: 120, intro_text: 600, lineup: 4000, lineup_note: 80, contact_name: 80, contact_phone: 40,
  contact_email: 120, sale_mode: 6, show_countdown: 1, helper_signup: 1, helper_jobs: 2000
};

/* ================= Antworten ================= */

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Access-Control-Allow-Origin": APP_ORIGIN,
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Scanner-Key",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...baseHeaders, ...extra } });
const fail = (message, status = 400, code) => json({ error: message, code: code || undefined }, status);
const readJson = request => request.json().catch(() => null);

const stmt = (env, sql, args = []) => (args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql));
const all = async (env, sql, ...args) => (await stmt(env, sql, args).all()).results || [];
const first = (env, sql, ...args) => stmt(env, sql, args).first();
const run = (env, sql, ...args) => stmt(env, sql, args).run();
const changes = r => Number(r?.meta?.changes || 0);
const nowMs = () => Date.now();
const iso = (ms = nowMs()) => new Date(ms).toISOString();

/* ================= Zufall & Hashes ================= */

const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // ohne I, O, 0, 1
function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += B32[b & 31];
  return out;
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const cleanCode = (v, max = 40) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, max);

/* ================= Schema (legt sich selbst an) ================= */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, regular_cap INTEGER NOT NULL, free_cap INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS event_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS admin_users (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('main','tickets','scanner')), name TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS scanner_access (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, created_by TEXT, revoked_at TEXT, last_used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS invitations (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, note TEXT, referred_by INTEGER REFERENCES invitations(id), max_tickets INTEGER NOT NULL DEFAULT 2 CHECK (max_tickets BETWEEN 1 AND 2), status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT NOT NULL UNIQUE, access_key TEXT NOT NULL UNIQUE, invitation_id INTEGER NOT NULL REFERENCES invitations(id), email TEXT NOT NULL, buyer_first TEXT NOT NULL, buyer_last TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 2), amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', provider TEXT NOT NULL CHECK (provider IN ('paypal','test')), is_test INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','failed','refund_required','refunded')), paypal_order_id TEXT UNIQUE, consent_at TEXT NOT NULL, mail_status TEXT NOT NULL DEFAULT 'none', mail_error TEXT, mail_sent_at TEXT, created_at TEXT NOT NULL, paid_at TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS orders_invitation ON orders(invitation_id)`,
  `CREATE TABLE IF NOT EXISTS guests (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), position INTEGER NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, UNIQUE (order_id, position))`,
  `CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id), invitation_id INTEGER NOT NULL, quantity INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','converted','released')), created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS reservations_active ON reservations(state, expires_at)`,
  `CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('capture','refund')), provider_ref TEXT NOT NULL UNIQUE, status TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT, result TEXT)`,
  `CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, category TEXT NOT NULL CHECK (category IN ('regular','free','helper')), code TEXT NOT NULL UNIQUE, view_key TEXT NOT NULL UNIQUE, order_id INTEGER REFERENCES orders(id), invitation_id INTEGER REFERENCES invitations(id), helper_job TEXT, guest_position INTEGER, first_name TEXT, last_name TEXT, email TEXT, status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','blocked','cancelled')), is_test INTEGER NOT NULL DEFAULT 0, checked_in_at TEXT, checked_in_by TEXT, version INTEGER NOT NULL DEFAULT 1, mail_status TEXT NOT NULL DEFAULT 'none', note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (order_id, guest_position))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_helper ON tickets(invitation_id) WHERE helper_job IS NOT NULL AND status != 'cancelled'`,
  `CREATE INDEX IF NOT EXISTS tickets_category ON tickets(category, status)`,
  `CREATE TABLE IF NOT EXISTS retired_codes (code TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL, retired_at TEXT NOT NULL, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, actor_name TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`
];

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql)));
  await run(env, `INSERT OR IGNORE INTO events (id, name, regular_cap, free_cap, created_at) VALUES (1, 'TAKT Nr. 30', ?, ?, ?)`, REGULAR_CAP, FREE_CAP, iso());
  const rows = Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
    env.DB.prepare(`INSERT OR IGNORE INTO event_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')`).bind(k, v, iso()));
  await env.DB.batch(rows);
  schemaReady = true;
}

async function getSettings(env) {
  const rows = await all(env, `SELECT key, value FROM event_settings`);
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value;
  return s;
}

/* ================= Kontingent ================= */

const SQL_REGULAR_TAKEN = (alias = "") => `(
  (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND status != 'cancelled')
  + (SELECT COALESCE(SUM(quantity), 0) FROM reservations r${alias} WHERE r${alias}.state = 'active' AND r${alias}.expires_at > ?))`;

async function counts(env) {
  const t = nowMs();
  const row = await first(env, `SELECT
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND status != 'cancelled') AS regular_issued,
      (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ?) AS reserved,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') AS free_issued,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled' AND first_name IS NOT NULL) AS free_assigned,
      (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND status != 'cancelled') AS helper_issued,
      (SELECT COUNT(*) FROM tickets WHERE checked_in_at IS NOT NULL AND status != 'cancelled') AS checked_in,
      (SELECT COUNT(*) FROM tickets WHERE status = 'valid') AS expected,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE status = 'paid' AND is_test = 0) AS revenue_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE status = 'paid' AND is_test = 1) AS test_revenue_cents,
      (SELECT COUNT(*) FROM tickets WHERE is_test = 1) AS test_tickets,
      (SELECT COUNT(*) FROM orders WHERE status = 'refund_required') AS refund_required,
      (SELECT COUNT(*) FROM orders WHERE status = 'refunded') AS refunded`, t);
  const available = Math.max(0, REGULAR_CAP - row.regular_issued - row.reserved);
  return { ...row, regular_cap: REGULAR_CAP, free_cap: FREE_CAP, helper_cap: HELPER_CAP, helper_available: Math.max(0, HELPER_CAP - row.helper_issued), available };
}

/* ================= Rate Limiting & Turnstile ================= */

async function clientKey(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  return (await sha256Hex(`${env.IP_SALT || "takt30"}|${ip}`)).slice(0, 24);
}
async function limited(env, bucket, max, windowMs) {
  const t = nowMs();
  await run(env, `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END,
    reset_at = CASE WHEN reset_at < ? THEN ? ELSE reset_at END`, bucket, t + windowMs, t, t, t + windowMs);
  const row = await first(env, `SELECT count FROM rate_limits WHERE bucket = ?`, bucket);
  if (Math.random() < 0.02) await run(env, `DELETE FROM rate_limits WHERE reset_at < ?`, t).catch(() => {});
  return (row?.count || 0) > max;
}
async function turnstileOk(env, token, request) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", String(token).slice(0, 2048));
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

/* ================= Auth: Clerk + Scanner-Zugang ================= */

function b64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
const decodePart = part => JSON.parse(new TextDecoder().decode(b64url(part)));
let jwksCache = null, jwksAt = 0;
async function getJwks(force = false) {
  if (!force && jwksCache && nowMs() - jwksAt < JWKS_TTL_MS) return jwksCache;
  const res = await fetch(CLERK_JWKS_URL);
  if (!res.ok) throw new Error("JWKS");
  jwksCache = await res.json(); jwksAt = nowMs();
  return jwksCache;
}
async function verifyClerk(request) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("NO_TOKEN");
  const parts = auth.slice(7).trim().split(".");
  if (parts.length !== 3) throw new Error("INVALID_TOKEN");
  const [h, p, s] = parts;
  const header = decodePart(h), payload = decodePart(p);
  if (header.alg !== "RS256") throw new Error("INVALID_ALGORITHM");
  const pick = jwks => jwks.keys.find(k => k.kid === header.kid);
  const jwk = pick(await getJwks()) || pick(await getJwks(true));
  if (!jwk) throw new Error("KEY_NOT_FOUND");
  const algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algo, false, ["verify"]);
  if (!(await crypto.subtle.verify(algo.name, key, b64url(s), new TextEncoder().encode(`${h}.${p}`)))) throw new Error("INVALID_SIGNATURE");
  const now = Math.floor(nowMs() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp < now - CLOCK_TOLERANCE_S) throw new Error("TOKEN_EXPIRED");
  if (payload.nbf != null && payload.nbf > now + CLOCK_TOLERANCE_S) throw new Error("TOKEN_NOT_ACTIVE");
  if (payload.iss !== CLERK_ISSUER) throw new Error("INVALID_ISSUER");
  if (payload.azp && payload.azp !== APP_ORIGIN) throw new Error("INVALID_AUTHORIZED_PARTY");
  if (typeof payload.sub !== "string" || !/^user_[A-Za-z0-9]+$/.test(payload.sub)) throw new Error("NO_USER");
  return payload.sub;
}

// Liefert { actor, name, role } oder null. Rollen werden ausschließlich hier geprüft.
async function identify(request, env) {
  const scannerKey = request.headers.get("X-Scanner-Key");
  if (scannerKey) {
    const hash = await sha256Hex(`scanner|${String(scannerKey).slice(0, 80)}`);
    const row = await first(env, `SELECT id, name FROM scanner_access WHERE token_hash = ? AND revoked_at IS NULL`, hash);
    if (!row) return null;
    await run(env, `UPDATE scanner_access SET last_used_at = ? WHERE id = ?`, iso(), row.id).catch(() => {});
    return { actor: `scanner:${row.id}`, name: `Einlass: ${row.name}`, role: "scanner" };
  }
  if (!request.headers.get("Authorization")) return null;
  let userId;
  try { userId = await verifyClerk(request); } catch { return null; }
  const mains = String(env.MAIN_ADMIN_ID || "").split(",").map(v => v.trim()).filter(Boolean);
  if (mains.includes(userId)) return { actor: userId, name: "Hauptadministrator", role: "main" };
  const row = await first(env, `SELECT role, name FROM admin_users WHERE user_id = ? AND active = 1`, userId);
  if (!row) return { actor: userId, name: "", role: null };
  return { actor: userId, name: row.name || ROLE_LABEL[row.role], role: row.role };
}
const can = (who, role) => !!(who && who.role && ROLE_RANK[who.role] >= ROLE_RANK[role]);

async function audit(env, who, action, target, detail) {
  await run(env, `INSERT INTO audit_logs (actor, actor_name, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)`,
    who?.actor || "system", who?.name || "System", action, target == null ? null : String(target),
    detail == null ? null : JSON.stringify(detail).slice(0, 2000), iso());
}

/* ================= Validierung ================= */

const nameOk = v => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 60 && !/[<>{}\u0000-\u001f]/.test(v);
const cleanName = v => String(v || "").trim().replace(/\s+/g, " ");
const emailOk = v => typeof v === "string" && v.length <= 160 && /^[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}$/.test(v.trim());
const euro = cents => (cents / 100).toFixed(2);

/* ================= Öffentliche Endpunkte ================= */

function helperJobs(s) {
  try { return JSON.parse(s.helper_jobs).filter(j => j && j.name).map(j => ({ name: String(j.name), slots: Number(j.slots) || 0, info: String(j.info || "") })); } catch { return []; }
}

function publicEvent(s, c, env, jobCounts = {}) {
  let lineup = [];
  try { lineup = JSON.parse(s.lineup).filter(x => x && x.name); } catch {}
  const paypalReady = paypalConfigured(env);
  const mode = s.sale_mode === "test" && env.ALLOW_TEST_PAYMENTS !== "true" ? "closed"
    : s.sale_mode === "live" && !paypalReady ? "closed" : s.sale_mode;
  return {
    name: "TAKT Nr. 30",
    event_date: s.event_date, doors_time: s.doors_time, start_time: s.start_time, place_public: s.place_public,
    intro_title: s.intro_title, intro_text: s.intro_text, lineup, lineup_note: s.lineup_note,
    contact: { name: s.contact_name, phone: s.contact_phone, email: s.contact_email },
    show_countdown: s.show_countdown === "1",
    sale: { mode, sandbox: mode === "live" && env.PAYPAL_ENV !== "live", open: mode !== "closed", sold_out: c.available <= 0, available: c.available, cap: REGULAR_CAP, sold: c.regular_issued, prices: { one: PRICE_CENTS[1], two: PRICE_CENTS[2] } },
    helpers: {
      open: s.helper_signup === "1" && (c.helper_available ?? 1) > 0,
      available: c.helper_available,
      jobs: helperJobs(s).map(j => ({ ...j, taken: jobCounts[j.name] || 0, full: j.slots > 0 && (jobCounts[j.name] || 0) >= j.slots }))
    },
    paypal: mode === "live" ? { client_id: env.PAYPAL_CLIENT_ID, env: env.PAYPAL_ENV === "live" ? "live" : "sandbox" } : null,
    turnstile_site_key: env.TURNSTILE_SITE_KEY || null
  };
}

async function jobCounts(env) {
  const rows = await all(env, `SELECT helper_job, COUNT(*) AS n FROM tickets WHERE category = 'helper' AND status != 'cancelled' GROUP BY helper_job`);
  return Object.fromEntries(rows.map(r => [r.helper_job, r.n]));
}

async function getEvent(env) {
  const [s, c, jc] = await Promise.all([getSettings(env), counts(env), jobCounts(env)]);
  return json(publicEvent(s, c, env, jc));
}

// Helfer-Anmeldung über den persönlichen Einladungslink → kostenloses Helfer-Ticket
async function helperSignup(env, request, ctx) {
  if (await limited(env, `hp:${await clientKey(request, env)}`, 8, 10 * 60_000)) return fail("Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.", 429);
  const b = await readJson(request);
  if (!b) return fail("Ungültige Anfrage.");
  const s = await getSettings(env);
  if (s.helper_signup !== "1") return fail("Die Helfer-Anmeldung ist gerade geschlossen.", 409, "HELPER_CLOSED");
  if (!(await turnstileOk(env, b.turnstile, request))) return fail("Die Sicherheitsprüfung ist fehlgeschlagen. Bitte erneut versuchen.", 400, "TURNSTILE");
  if (b.accept !== true) return fail("Bitte bestätige Datenschutzhinweise und Teilnahmebedingungen.");
  const inv = await inviteState(env, cleanCode(b.invite));
  if (!inv) return fail("Diese Einladung kennen wir nicht.", 404, "INVITE_UNKNOWN");
  if (inv.status !== "active") return fail("Diese Einladung ist nicht mehr gültig.", 409, "INVITE_DISABLED");
  if (inv.helper_job) return fail("Mit dieser Einladung ist schon jemand als Helfer eingetragen.", 409, "HELPER_EXISTS");
  if (inv.remaining < 1) return fail("Mit dieser Einladung sind bereits alle Plätze vergeben.", 409, "INVITE_EXHAUSTED");
  if (!nameOk(b.first_name) || !nameOk(b.last_name)) return fail("Bitte Vor- und Nachnamen angeben.");
  if (!emailOk(b.email)) return fail("Bitte eine gültige E-Mail-Adresse angeben.");
  const job = helperJobs(s).find(j => j.name === b.job);
  if (!job) return fail("Bitte eine Aufgabe auswählen.");
  const t = nowMs();
  const code = randomCode(26), view = randomCode(26);
  // Atomar: Helferkontingent, Aufgaben-Plätze und Einladungskontingent in einem Schritt prüfen
  const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, invitation_id, helper_job, first_name, last_name, email, status, is_test, created_at, updated_at)
    SELECT printf('H-%02d', COALESCE((SELECT MAX(CAST(substr(number, 3) AS INTEGER)) FROM tickets WHERE category = 'helper'), 0) + 1), 'helper', ?, ?, ?, ?, ?, ?, ?, 'valid', 0, ?, ?
    WHERE (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND status != 'cancelled') < ?
      AND (? = 0 OR (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND helper_job = ? AND status != 'cancelled') < ?)
      AND (SELECT COUNT(*) FROM tickets tk LEFT JOIN orders o ON o.id = tk.order_id WHERE COALESCE(o.invitation_id, tk.invitation_id) = ? AND tk.status != 'cancelled')
        + (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE invitation_id = ? AND state = 'active' AND expires_at > ?) + 1
        <= (SELECT max_tickets FROM invitations WHERE id = ? AND status = 'active')
      AND NOT EXISTS (SELECT 1 FROM tickets WHERE invitation_id = ? AND helper_job IS NOT NULL AND status != 'cancelled')`,
    code, view, inv.id, job.name, cleanName(b.first_name), cleanName(b.last_name), String(b.email).trim().toLowerCase(), iso(t), iso(t),
    HELPER_CAP, job.slots, job.name, job.slots, inv.id, inv.id, t, inv.id, inv.id).catch(() => null);
  if (!r || !changes(r)) {
    const c = await counts(env);
    if (c.helper_available <= 0) return fail("Alle Helferplätze sind schon vergeben – danke trotzdem!", 409, "HELPER_FULL");
    const jc = await jobCounts(env);
    if (job.slots && (jc[job.name] || 0) >= job.slots) return fail(`Für „${job.name}“ sind schon genug Helfer eingetragen. Bitte eine andere Aufgabe wählen.`, 409, "JOB_FULL");
    return fail("Die Anmeldung war gerade nicht möglich. Bitte erneut versuchen.", 409);
  }
  const ticket = await first(env, `SELECT * FROM tickets WHERE id = ?`, r.meta.last_row_id);
  await audit(env, { actor: `invite:${inv.id}`, name: inv.name }, "helper.signup", ticket.number, { job: job.name });
  const mail = sendTicketMail(env, ticket).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(mail); else await mail;
  return json({ number: ticket.number, view_key: ticket.view_key, job: job.name }, 201);
}

async function inviteState(env, code) {
  const inv = await first(env, `SELECT id, name, max_tickets, status FROM invitations WHERE code = ?`, code);
  if (!inv) return null;
  const t = nowMs();
  const used = await first(env, `SELECT
     (SELECT COUNT(*) FROM tickets tk LEFT JOIN orders o ON o.id = tk.order_id WHERE COALESCE(o.invitation_id, tk.invitation_id) = ? AND tk.status != 'cancelled') AS issued,
     (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE invitation_id = ? AND state = 'active' AND expires_at > ?) AS reserved`, inv.id, inv.id, t);
  const remaining = Math.max(0, inv.max_tickets - used.issued - used.reserved);
  const helper = await first(env, `SELECT helper_job FROM tickets WHERE invitation_id = ? AND helper_job IS NOT NULL AND status != 'cancelled'`, inv.id);
  return { ...inv, issued: used.issued, reserved: used.reserved, remaining, helper_job: helper?.helper_job || null };
}

async function getInvite(env, request, code) {
  if (await limited(env, `inv:${await clientKey(request, env)}`, 40, 60_000)) return fail("Zu viele Anfragen. Bitte kurz warten.", 429);
  const st = await inviteState(env, cleanCode(code));
  if (!st) return fail("Diese Einladung kennen wir nicht. Bitte prüfe den Link.", 404, "INVITE_UNKNOWN");
  const first_name = st.name.split(" ")[0];
  return json({ valid: st.status === "active", status: st.status, first_name, max: st.max_tickets, issued: st.issued, reserved: st.reserved, remaining: st.remaining, helper_job: st.helper_job });
}

async function checkout(env, request, ctx) {
  const key = await clientKey(request, env);
  if (await limited(env, `co:${key}`, 8, 10 * 60_000)) return fail("Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.", 429);
  const body = await readJson(request);
  if (!body) return fail("Ungültige Anfrage.");
  const settings = await getSettings(env);
  const mode = publicEvent(settings, { available: 1 }, env).sale.mode;
  if (mode === "closed") return fail("Der Ticketverkauf ist gerade geschlossen.", 409, "SALE_CLOSED");
  if (!(await turnstileOk(env, body.turnstile, request))) return fail("Die Sicherheitsprüfung ist fehlgeschlagen. Bitte erneut versuchen.", 400, "TURNSTILE");
  if (body.accept !== true) return fail("Bitte bestätige Datenschutzhinweise und Teilnahmebedingungen.");

  const inv = await inviteState(env, cleanCode(body.invite));
  if (!inv) return fail("Diese Einladung kennen wir nicht.", 404, "INVITE_UNKNOWN");
  if (inv.status !== "active") return fail("Diese Einladung ist nicht mehr gültig.", 409, "INVITE_DISABLED");

  const guests = Array.isArray(body.guests) ? body.guests.slice(0, 3) : [];
  const quantity = guests.length;
  if (quantity < 1 || quantity > MAX_PER_INVITE) return fail("Pro Einladung sind 1 oder 2 Tickets möglich.");
  for (const g of guests) if (!nameOk(g?.first_name) || !nameOk(g?.last_name)) return fail("Bitte für jedes Ticket Vor- und Nachnamen angeben.");
  if (!emailOk(body.email)) return fail("Bitte eine gültige E-Mail-Adresse angeben.");
  if (quantity > inv.max_tickets - inv.issued) {
    inv.remaining = inv.max_tickets - inv.issued;
    return fail(inv.remaining ? `Mit dieser Einladung ist noch ${inv.remaining} Ticket möglich.` : "Mit dieser Einladung wurden bereits alle Tickets gekauft.", 409, "INVITE_EXHAUSTED");
  }

  // Gleiche Einladung startet neu → alten, unbezahlten Versuch sofort freigeben (z. B. Abbruch am Handy, neuer Versuch am PC)
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE invitation_id = ? AND status = 'pending'`).bind(iso(), inv.id),
    env.DB.prepare(`UPDATE reservations SET state = 'released' WHERE invitation_id = ? AND state = 'active'`).bind(inv.id)
  ]);
  inv.remaining = inv.max_tickets - inv.issued;
  if (quantity > inv.remaining) return fail("Mit dieser Einladung wurden bereits alle Tickets gekauft.", 409, "INVITE_EXHAUSTED");

  const t = nowMs();
  const orderNo = `T30-${new Date(t).toISOString().slice(2, 10).replace(/-/g, "")}-${randomCode(5)}`;
  const accessKey = randomCode(26);
  const amount = PRICE_CENTS[quantity];
  const provider = mode === "test" ? "test" : "paypal";
  const isTest = provider === "test" || env.PAYPAL_ENV !== "live";   // Sandbox = Spielgeld = Testticket
  const email = String(body.email).trim().toLowerCase();

  const ins = await run(env, `INSERT INTO orders (order_no, access_key, invitation_id, email, buyer_first, buyer_last, quantity, amount_cents, provider, is_test, status, consent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    orderNo, accessKey, inv.id, email, cleanName(guests[0].first_name), cleanName(guests[0].last_name), quantity, amount, provider, isTest ? 1 : 0, iso(t), iso(t), iso(t));
  const orderId = ins.meta.last_row_id;
  await env.DB.batch(guests.map((g, i) => env.DB.prepare(`INSERT INTO guests (order_id, position, first_name, last_name) VALUES (?, ?, ?, ?)`)
    .bind(orderId, i + 1, cleanName(g.first_name), cleanName(g.last_name))));

  // Atomar: nur reservieren, wenn Gesamtkontingent UND Einladungskontingent reichen.
  const res = await run(env, `INSERT INTO reservations (order_id, invitation_id, quantity, expires_at, state, created_at)
    SELECT ?, ?, ?, ?, 'active', ?
    WHERE ${SQL_REGULAR_TAKEN()} + ? <= ?
      AND (SELECT COUNT(*) FROM tickets tk LEFT JOIN orders o ON o.id = tk.order_id WHERE COALESCE(o.invitation_id, tk.invitation_id) = ? AND tk.status != 'cancelled')
        + (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE invitation_id = ? AND state = 'active' AND expires_at > ?) + ?
        <= (SELECT max_tickets FROM invitations WHERE id = ? AND status = 'active')`,
    orderId, inv.id, quantity, t + RESERVATION_MS, iso(t), t, quantity, REGULAR_CAP, inv.id, inv.id, t, quantity, inv.id);
  if (!changes(res)) {
    await run(env, `UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`, iso(), orderId);
    const c = await counts(env);
    return c.available < quantity
      ? fail(c.available ? `Es ist nur noch ${c.available} Ticket verfügbar.` : "Ausverkauft – es sind keine Tickets mehr verfügbar.", 409, "SOLD_OUT")
      : fail("Mit dieser Einladung ist gerade ein Kauf in Bearbeitung oder sie ist ausgeschöpft.", 409, "INVITE_EXHAUSTED");
  }

  const out = { order_no: orderNo, access_key: accessKey, amount_cents: amount, quantity, provider, expires_at: t + RESERVATION_MS };
  if (provider === "paypal") {
    try {
      const pp = await paypalCreateOrder(env, { orderNo, amount, quantity });
      await run(env, `UPDATE orders SET paypal_order_id = ?, updated_at = ? WHERE id = ?`, pp.id, iso(), orderId);
      out.paypal_order_id = pp.id;
    } catch (e) {
      await releaseOrder(env, orderId, "failed");
      return fail("PayPal ist gerade nicht erreichbar. Es wurde nichts abgebucht – bitte gleich noch einmal versuchen.", 502, "PAYPAL_CREATE");
    }
  }
  return json(out, 201);
}

async function releaseOrder(env, orderId, status = "cancelled") {
  await env.DB.batch([
    env.DB.prepare(`UPDATE reservations SET state = 'released' WHERE order_id = ? AND state = 'active'`).bind(orderId),
    env.DB.prepare(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(status, iso(), orderId)
  ]);
}

async function orderByKey(env, key) {
  return first(env, `SELECT * FROM orders WHERE access_key = ?`, cleanCode(key, 40));
}

async function cancelPending(env, request) {
  const body = await readJson(request);
  const order = body && await orderByKey(env, body.access_key);
  if (!order) return fail("Bestellung nicht gefunden.", 404);
  if (order.status === "pending") await releaseOrder(env, order.id, "cancelled");
  return json({ status: order.status === "pending" ? "cancelled" : order.status });
}

// Testzahlung – nur im Testmodus, nur wenn der Worker es ausdrücklich erlaubt.
async function testPay(env, request, ctx) {
  if (env.ALLOW_TEST_PAYMENTS !== "true") return fail("Testzahlungen sind deaktiviert.", 403);
  const body = await readJson(request);
  const order = body && await orderByKey(env, body.access_key);
  if (!order || order.provider !== "test") return fail("Bestellung nicht gefunden.", 404);
  const result = await settleOrder(env, order, { ref: `TEST-${order.order_no}`, amount: order.amount_cents, currency: "EUR" }, ctx);
  return json(result, result.ok ? 200 : 409);
}

// Zahlung bestätigt → Plätze sichern → Tickets erzeugen (idempotent).
async function settleOrder(env, order, payment, ctx) {
  if (order.status === "paid") return { ok: true, status: "paid", already: true };
  if (["refunded", "refund_required"].includes(order.status)) return { ok: false, status: order.status };
  if (payment.amount !== order.amount_cents || payment.currency !== "EUR") {
    await run(env, `UPDATE orders SET status = 'refund_required', updated_at = ? WHERE id = ?`, iso(), order.id);
    await audit(env, null, "payment.amount_mismatch", order.order_no, payment);
    return { ok: false, status: "refund_required" };
  }
  await run(env, `INSERT OR IGNORE INTO payments (order_id, provider, kind, provider_ref, status, amount_cents, currency, created_at) VALUES (?, ?, 'capture', ?, 'completed', ?, ?, ?)`,
    order.id, order.provider, payment.ref, payment.amount, payment.currency, iso());

  const t = nowMs();
  // Platz sichern: laufende Reservierung verlängern oder – falls abgelaufen – neu belegen, wenn noch Platz ist.
  let held = changes(await run(env, `UPDATE reservations SET expires_at = ? WHERE order_id = ? AND state = 'active' AND expires_at > ?`, t + CAPTURE_HOLD_MS, order.id, t));
  if (!held) {
    const st = await first(env, `SELECT state FROM reservations WHERE order_id = ?`, order.id);
    if (st?.state === "converted") held = 1;
    else held = changes(await run(env, `UPDATE reservations SET state = 'active', expires_at = ?
        WHERE order_id = ? AND state != 'converted'
          AND ((SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND status != 'cancelled')
             + (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ? AND order_id != ?)
             + quantity) <= ?
          AND ((SELECT COUNT(*) FROM tickets tk LEFT JOIN orders o ON o.id = tk.order_id WHERE COALESCE(o.invitation_id, tk.invitation_id) = reservations.invitation_id AND tk.status != 'cancelled')
             + (SELECT COALESCE(SUM(quantity), 0) FROM reservations r2 WHERE r2.invitation_id = reservations.invitation_id AND r2.state = 'active' AND r2.expires_at > ? AND r2.order_id != reservations.order_id)
             + quantity) <= (SELECT max_tickets FROM invitations WHERE id = reservations.invitation_id)`, t + CAPTURE_HOLD_MS, order.id, t, order.id, REGULAR_CAP, t));
  }
  if (!held) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET status = 'refund_required', updated_at = ? WHERE id = ? AND status IN ('pending','cancelled','failed')`).bind(iso(), order.id),
      env.DB.prepare(`UPDATE reservations SET state = 'released' WHERE order_id = ?`).bind(order.id)
    ]);
    await audit(env, null, "order.overbooked_refund", order.order_no, { amount: order.amount_cents });
    if (order.provider === "paypal" && payment.capture_id) {
      try { await paypalRefund(env, payment.capture_id, order); await markRefunded(env, order.id, payment.capture_id, order.amount_cents); }
      catch { /* bleibt refund_required – erscheint im Admin */ }
    }
    return { ok: false, status: "refund_required" };
  }

  const guests = await all(env, `SELECT position, first_name, last_name FROM guests WHERE order_id = ? ORDER BY position`, order.id);
  const ins = guests.map(g => env.DB.prepare(`INSERT INTO tickets (number, category, code, view_key, order_id, guest_position, first_name, last_name, email, status, is_test, created_at, updated_at)
      SELECT printf('T30-%03d', COALESCE((SELECT MAX(CAST(substr(number, 5) AS INTEGER)) FROM tickets WHERE category = 'regular'), 0) + 1), 'regular', ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE order_id = ? AND guest_position = ?)`)
    .bind(randomCode(26), randomCode(26), order.id, g.position, g.first_name, g.last_name, order.email, order.is_test, iso(), iso(), order.id, g.position));
  await env.DB.batch([
    ...ins,
    env.DB.prepare(`UPDATE reservations SET state = 'converted' WHERE order_id = ?`).bind(order.id),
    env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?`).bind(iso(), iso(), order.id)
  ]);
  await audit(env, null, "order.paid", order.order_no, { quantity: order.quantity, amount: order.amount_cents, test: !!order.is_test });
  const job = sendOrderMail(env, order.id).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return { ok: true, status: "paid" };
}

async function orderView(env, order) {
  const s = await getSettings(env);
  const tickets = order.status === "paid"
    ? await all(env, `SELECT number, category, first_name, last_name, view_key, code, status, checked_in_at, is_test FROM tickets WHERE order_id = ? ORDER BY guest_position`, order.id)
    : [];
  return {
    order_no: order.order_no, status: order.status, quantity: order.quantity, amount_cents: order.amount_cents,
    email: order.email, is_test: !!order.is_test, mail_status: order.mail_status,
    tickets,
    event: order.status === "paid" ? eventForTicket(s) : null
  };
}
const eventForTicket = s => ({ name: "TAKT Nr. 30", event_date: s.event_date, doors_time: s.doors_time, start_time: s.start_time, venue_name: s.venue_name, venue_address: s.venue_address });

async function getOrder(env, request, url) {
  if (await limited(env, `ord:${await clientKey(request, env)}`, 60, 60_000)) return fail("Zu viele Anfragen.", 429);
  const order = await orderByKey(env, url.searchParams.get("key"));
  if (!order) return fail("Bestellung nicht gefunden.", 404);
  return json(await orderView(env, order));
}

async function getTicket(env, request, url) {
  if (await limited(env, `tk:${await clientKey(request, env)}`, 60, 60_000)) return fail("Zu viele Anfragen.", 429);
  const k = cleanCode(url.searchParams.get("k"), 40);
  const t = await first(env, `SELECT number, category, helper_job, first_name, last_name, code, status, checked_in_at, is_test FROM tickets WHERE view_key = ?`, k);
  if (!t) return fail("Dieses Ticket gibt es nicht (mehr). Wurde es ersetzt, nutze bitte den neuen Link.", 404);
  if (!t.first_name) return fail("Dieses Freiticket ist noch keinem Gast zugeordnet.", 409);
  return json({ ...t, event: eventForTicket(await getSettings(env)) });
}

async function resendOrder(env, request) {
  const body = await readJson(request);
  const order = body && await orderByKey(env, body.access_key);
  if (!order || order.status !== "paid") return fail("Bestellung nicht gefunden.", 404);
  if (await limited(env, `rs:${order.id}`, 3, 60 * 60_000)) return fail("Die Mail wurde gerade erst verschickt. Bitte später erneut versuchen.", 429);
  const r = await sendOrderMail(env, order.id);
  return json({ mail_status: r });
}

/* ================= E-Mail (Resend) ================= */

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateDe = d => { const [y, m, dd] = String(d).split("-"); return `${dd}.${m}.${y}`; };

function mailHtml(s, intro, rows) {
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30</p>
<h1 style="font-weight:300;font-size:26px;margin:0 0 18px">${esc(intro)}</h1>
<p style="font-size:15px;line-height:1.6;color:#c9c9d1;margin:0 0 22px">${esc(dateDe(s.event_date))} · Einlass ab ${esc(s.doors_time)} · Beginn ${esc(s.start_time)}<br>${esc(s.venue_name)}<br>${esc(s.venue_address)}</p>
${rows.map(r => `<a href="${esc(r.url)}" style="display:block;background:#9d4dff;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:0 0 10px;font-size:15px">Ticket ${esc(r.number)} · ${esc(r.name)} öffnen</a>`).join("")}
<p style="font-size:13px;line-height:1.6;color:#8a8a96;margin:22px 0 0">Auf der Ticketseite kannst du dein Ticket als PDF speichern. Jeder QR-Code ist persönlich und nur einmal gültig. Geschlossene Gesellschaft – ohne Ticket kein Einlass.</p>
<p style="font-size:13px;line-height:1.6;color:#8a8a96;margin:14px 0 0">Fragen? ${esc(s.contact_name)} · ${esc(s.contact_phone)} · ${esc(s.contact_email)}</p>
</div></body></html>`;
}

async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return { ok: false, error: "Mailversand ist noch nicht eingerichtet." };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html, reply_to: env.MAIL_REPLY_TO || (await getSettings(env)).contact_email || undefined })
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return { ok: false, error: `Mailserver antwortet ${res.status}${detail.message ? `: ${String(detail.message).slice(0, 160)}` : ""}` };
  }
  return { ok: true };
}

async function sendOrderMail(env, orderId) {
  const order = await first(env, `SELECT * FROM orders WHERE id = ?`, orderId);
  const s = await getSettings(env);
  const tickets = await all(env, `SELECT number, first_name, last_name, view_key FROM tickets WHERE order_id = ? AND status != 'cancelled' ORDER BY guest_position`, orderId);
  const rows = tickets.map(t => ({ number: t.number, name: `${t.first_name} ${t.last_name}`, url: `${APP_URL}ticket/?k=${t.view_key}` }));
  const r = await sendMail(env, order.email, `Dein Ticket für TAKT Nr. 30${order.is_test ? " (TEST)" : ""}`,
    mailHtml(s, tickets.length > 1 ? "Ihr seid dabei." : "Du bist dabei.", rows));
  await run(env, `UPDATE orders SET mail_status = ?, mail_error = ?, mail_sent_at = CASE WHEN ? THEN ? ELSE mail_sent_at END WHERE id = ?`,
    r.ok ? "sent" : "failed", r.ok ? null : r.error, r.ok ? 1 : 0, iso(), orderId);
  return r.ok ? "sent" : "failed";
}

async function sendTicketMail(env, ticket) {
  const s = await getSettings(env);
  const r = await sendMail(env, ticket.email, ticket.helper_job ? "Dein Helfer-Ticket für TAKT Nr. 30" : "Dein Ticket für TAKT Nr. 30",
    mailHtml(s, ticket.helper_job ? `Danke fürs Helfen – ${ticket.helper_job}.` : "Du bist dabei.", [{ number: ticket.number, name: `${ticket.first_name} ${ticket.last_name}`, url: `${APP_URL}ticket/?k=${ticket.view_key}` }]));
  await run(env, `UPDATE tickets SET mail_status = ? WHERE id = ?`, r.ok ? "sent" : "failed", ticket.id);
  return r;
}

/* ================= PayPal ================= */

const paypalConfigured = env => !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);
const paypalBase = env => (env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");

async function paypalToken(env) {
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  if (!res.ok) throw new Error(`PAYPAL_AUTH_${res.status}`);
  return (await res.json()).access_token;
}
async function paypalFetch(env, path, { method = "POST", body, requestId } = {}) {
  const token = await paypalToken(env);
  const res = await fetch(`${paypalBase(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(requestId ? { "PayPal-Request-Id": requestId } : {}), Prefer: "return=representation" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
async function paypalCreateOrder(env, { orderNo, amount, quantity }) {
  const value = euro(amount);
  const r = await paypalFetch(env, "/v2/checkout/orders", {
    requestId: `create-${orderNo}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: orderNo, custom_id: orderNo, invoice_id: orderNo,
        description: "TAKT Nr. 30 – Ticket",
        amount: { currency_code: "EUR", value, breakdown: { item_total: { currency_code: "EUR", value } } },
        items: [{ name: quantity === 2 ? "TAKT Nr. 30 – 2 Tickets" : "TAKT Nr. 30 – Ticket", quantity: "1", category: "DIGITAL_GOODS", unit_amount: { currency_code: "EUR", value } }]
      }],
      payment_source: { paypal: { experience_context: { brand_name: "TAKT Nr. 30", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", locale: "de-DE" } } }
    }
  });
  if (!r.ok || !r.data.id) throw new Error(`PAYPAL_CREATE_${r.status}`);
  return r.data;
}
function captureFrom(data) {
  const unit = data?.purchase_units?.[0];
  const cap = unit?.payments?.captures?.[0];
  return cap ? { id: cap.id, status: cap.status, amount: Math.round(Number(cap.amount?.value) * 100), currency: cap.amount?.currency_code, custom_id: cap.custom_id || unit?.custom_id } : null;
}
async function paypalRefund(env, captureId, order) {
  const r = await paypalFetch(env, `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    requestId: `refund-${order.order_no}`,
    body: { amount: { currency_code: "EUR", value: euro(order.amount_cents) }, note_to_payer: "TAKT Nr. 30 war leider schon ausverkauft – du bekommst dein Geld vollständig zurück." }
  });
  if (!r.ok) throw new Error(`PAYPAL_REFUND_${r.status}`);
  return r.data;
}
async function markRefunded(env, orderId, ref, amount) {
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO payments (order_id, provider, kind, provider_ref, status, amount_cents, currency, created_at) VALUES (?, 'paypal', 'refund', ?, 'completed', ?, 'EUR', ?)`).bind(orderId, `refund-${ref}`, amount, iso()),
    env.DB.prepare(`UPDATE orders SET status = 'refunded', updated_at = ? WHERE id = ?`).bind(iso(), orderId),
    env.DB.prepare(`UPDATE tickets SET status = 'cancelled', updated_at = ? WHERE order_id = ?`).bind(iso(), orderId),
    env.DB.prepare(`UPDATE reservations SET state = 'released' WHERE order_id = ?`).bind(orderId)
  ]);
}

async function paypalCapture(env, request, ctx) {
  if (!paypalConfigured(env)) return fail("PayPal ist noch nicht eingerichtet.", 409);
  const body = await readJson(request);
  const order = body && await orderByKey(env, body.access_key);
  if (!order || order.provider !== "paypal" || !order.paypal_order_id) return fail("Bestellung nicht gefunden.", 404);
  if (order.status === "paid") return json(await orderView(env, order));
  // Vor dem Abbuchen Platz halten bzw. neu prüfen
  const t = nowMs();
  await run(env, `UPDATE reservations SET expires_at = ? WHERE order_id = ? AND state = 'active' AND expires_at > ?`, t + CAPTURE_HOLD_MS, order.id, t);
  let r = await paypalFetch(env, `/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}/capture`, { requestId: `capture-${order.order_no}` });
  if (!r.ok && r.data?.details?.[0]?.issue === "ORDER_ALREADY_CAPTURED") r = await paypalFetch(env, `/v2/checkout/orders/${encodeURIComponent(order.paypal_order_id)}`, { method: "GET" });
  if (!r.ok) {
    const issue = r.data?.details?.[0]?.issue;
    if (issue === "INSTRUMENT_DECLINED") return fail("Die Zahlung wurde abgelehnt. Bitte eine andere Zahlungsart in PayPal wählen.", 402, "DECLINED");
    return fail("Die Zahlung konnte nicht bestätigt werden. Es wurde kein Ticket ausgestellt.", 502, "CAPTURE_FAILED");
  }
  const cap = captureFrom(r.data);
  if (!cap || cap.custom_id !== order.order_no) return fail("Die Zahlung konnte nicht zugeordnet werden.", 502);
  if (cap.status === "PENDING") return json({ ...(await orderView(env, order)), payment_pending: true }, 202);
  if (cap.status !== "COMPLETED") return fail("Die Zahlung wurde nicht abgeschlossen. Es wurde kein Ticket ausgestellt.", 402);
  const result = await settleOrder(env, order, { ref: cap.id, capture_id: cap.id, amount: cap.amount, currency: cap.currency }, ctx);
  const fresh = await first(env, `SELECT * FROM orders WHERE id = ?`, order.id);
  return json(await orderView(env, fresh), result.ok ? 200 : 409);
}

async function paypalWebhook(env, request, ctx) {
  if (!paypalConfigured(env) || !env.PAYPAL_WEBHOOK_ID) return fail("not configured", 404);
  const raw = await request.text();
  let event; try { event = JSON.parse(raw); } catch { return fail("bad json"); }
  const h = n => request.headers.get(n);
  const verify = await paypalFetch(env, "/v1/notifications/verify-webhook-signature", {
    body: { auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"), transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"), webhook_id: env.PAYPAL_WEBHOOK_ID, webhook_event: event }
  });
  if (!verify.ok || verify.data.verification_status !== "SUCCESS") return fail("invalid signature", 400);
  return handleWebhookEvent(env, event, ctx);
}

async function handleWebhookEvent(env, event, ctx) {
  const fresh = changes(await run(env, `INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)`, String(event.id), String(event.event_type), iso()));
  if (!fresh) return json({ duplicate: true });
  let result = "ignored";
  const res = event.resource || {};
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const order = await first(env, `SELECT * FROM orders WHERE order_no = ?`, String(res.custom_id || ""));
    if (order) {
      const r = await settleOrder(env, order, { ref: res.id, capture_id: res.id, amount: Math.round(Number(res.amount?.value) * 100), currency: res.amount?.currency_code }, ctx);
      result = r.status;
    }
  } else if (event.event_type === "PAYMENT.CAPTURE.REFUNDED" || event.event_type === "PAYMENT.CAPTURE.REVERSED") {
    const captureId = (res.links || []).find(l => l.rel === "up")?.href?.split("/").pop();
    const pay = captureId && await first(env, `SELECT order_id, amount_cents FROM payments WHERE provider_ref = ? AND kind = 'capture'`, captureId);
    if (pay) { await markRefunded(env, pay.order_id, res.id || captureId, pay.amount_cents); result = "refunded"; }
  }
  await run(env, `UPDATE webhook_events SET processed_at = ?, result = ? WHERE event_id = ?`, iso(), result, String(event.id));
  return json({ ok: true, result });
}

/* ================= Einlass ================= */

const CODE_PREFIX = "T30.";
async function scan(env, request, who) {
  const body = await readJson(request);
  const raw = String(body?.code || "").trim();
  const code = cleanCode(raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw, 40);
  const at = iso();
  const log = (ticketId, result, detail) => run(env, `INSERT INTO checkins (ticket_id, action, result, actor, at, detail) VALUES (?, 'scan', ?, ?, ?, ?)`, ticketId, result, who.name, at, detail || null);
  if (code.length < 20) { await log(null, "unknown", raw.slice(0, 60)); return json({ result: "red", reason: "QR-Code unbekannt" }); }
  const t = await first(env, `SELECT id, number, category, helper_job, first_name, last_name, status, checked_in_at, checked_in_by, is_test FROM tickets WHERE code = ?`, code);
  if (!t) {
    const old = await first(env, `SELECT t.number, t.first_name, t.last_name FROM retired_codes r JOIN tickets t ON t.id = r.ticket_id WHERE r.code = ?`, code);
    await log(null, old ? "replaced" : "unknown", code);
    return json(old ? { result: "red", reason: "Ersetzter QR-Code – ungültig", number: old.number, name: `${old.first_name || ""} ${old.last_name || ""}`.trim() } : { result: "red", reason: "QR-Code unbekannt" });
  }
  const base = { number: t.number, category: t.category, helper_job: t.helper_job, name: `${t.first_name || ""} ${t.last_name || ""}`.trim() };
  if (!t.first_name) { await log(t.id, "unassigned"); return json({ ...base, result: "red", reason: "Freiticket keinem Gast zugeordnet" }); }
  if (t.status === "blocked") { await log(t.id, "blocked"); return json({ ...base, result: "red", reason: "Ticket gesperrt" }); }
  if (t.status === "cancelled") { await log(t.id, "cancelled"); return json({ ...base, result: "red", reason: "Ticket storniert" }); }
  const s = await getSettings(env);
  const testPhase = s.sale_mode === "test" || (s.sale_mode === "live" && env.PAYPAL_ENV !== "live");
  if (t.is_test && !testPhase) { await log(t.id, "test"); return json({ ...base, result: "red", reason: "Testticket – kein Zutritt" }); }
  // Atomar einchecken – bei gleichzeitigen Scans gewinnt genau einer.
  const r = await run(env, `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?, updated_at = ? WHERE id = ? AND status = 'valid' AND checked_in_at IS NULL`, at, who.name, at, t.id);
  if (changes(r)) { await log(t.id, "admitted"); return json({ ...base, result: "green", checked_in_at: at }); }
  const now = await first(env, `SELECT checked_in_at, checked_in_by FROM tickets WHERE id = ?`, t.id);
  await log(t.id, "already");
  return json({ ...base, result: "red", reason: "Bereits eingelöst", checked_in_at: now.checked_in_at, checked_in_by: now.checked_in_by });
}

async function scanSearch(env, url) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 40);
  if (q.length < 2) return json([]);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return json(await all(env, `SELECT id, number, category, helper_job, first_name, last_name, status, checked_in_at, checked_in_by, is_test FROM tickets
     WHERE first_name IS NOT NULL AND (first_name || ' ' || last_name LIKE ? OR number LIKE ?) ORDER BY last_name, first_name LIMIT 25`, like, like));
}

async function manualCheckin(env, who, id) {
  const at = iso();
  const r = await run(env, `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?, updated_at = ? WHERE id = ? AND status = 'valid' AND checked_in_at IS NULL AND first_name IS NOT NULL`, at, `${who.name} (manuell)`, at, id);
  await run(env, `INSERT INTO checkins (ticket_id, action, result, actor, at) VALUES (?, 'manual', ?, ?, ?)`, id, changes(r) ? "admitted" : "rejected", who.name, at);
  if (!changes(r)) return fail("Nicht möglich – Ticket ist bereits eingecheckt, gesperrt oder storniert.", 409);
  return json({ result: "green", checked_in_at: at });
}

async function undoCheckin(env, request, who, id) {
  const body = await readJson(request);
  const reason = String(body?.reason || "").trim();
  if (reason.length < 3) return fail("Bitte einen Grund angeben.");
  const r = await run(env, `UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL, updated_at = ? WHERE id = ? AND checked_in_at IS NOT NULL`, iso(), id);
  if (!changes(r)) return fail("Dieses Ticket ist nicht eingecheckt.", 409);
  await run(env, `INSERT INTO checkins (ticket_id, action, result, actor, at, detail) VALUES (?, 'undo', 'reset', ?, ?, ?)`, id, who.name, iso(), reason.slice(0, 300));
  await audit(env, who, "checkin.undo", id, { reason });
  return json({ ok: true });
}

async function scanStats(env) {
  const c = await counts(env);
  const recent = await all(env, `SELECT c.at, c.result, c.actor, t.number, t.first_name, t.last_name FROM checkins c LEFT JOIN tickets t ON t.id = c.ticket_id ORDER BY c.id DESC LIMIT 15`);
  return json({ checked_in: c.checked_in, expected: c.expected, recent });
}

/* ================= Admin ================= */

async function dashboard(env) {
  const [c, s] = await Promise.all([counts(env), getSettings(env)]);
  const invites = await first(env, `SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM invitations`);
  return json({ counts: c, invites, sale_mode: s.sale_mode, paypal_ready: paypalConfigured(env), paypal_env: env.PAYPAL_ENV === "live" ? "live" : "sandbox", test_allowed: env.ALLOW_TEST_PAYMENTS === "true", mail_ready: !!(env.RESEND_API_KEY && env.MAIL_FROM), turnstile_ready: !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY) });
}

async function listInvitations(env) {
  const t = nowMs();
  return json(await all(env, `SELECT i.id, i.code, i.name, i.note, i.max_tickets, i.status, i.created_at, i.referred_by, ref.name AS referred_by_name,
      (SELECT COUNT(*) FROM tickets tk LEFT JOIN orders o ON o.id = tk.order_id WHERE COALESCE(o.invitation_id, tk.invitation_id) = i.id AND tk.status != 'cancelled') AS issued,
      (SELECT helper_job FROM tickets tk WHERE tk.invitation_id = i.id AND tk.helper_job IS NOT NULL AND tk.status != 'cancelled') AS helper_job,
      (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE invitation_id = i.id AND state = 'active' AND expires_at > ?) AS reserved
    FROM invitations i LEFT JOIN invitations ref ON ref.id = i.referred_by ORDER BY i.created_at DESC, i.id DESC`, t));
}

async function createInvitation(env, request, who) {
  const b = await readJson(request) || {};
  const name = cleanName(b.name);
  if (!name || name.length > 80 || /[<>]/.test(name)) return fail("Bitte einen Namen angeben (max. 80 Zeichen).");
  const max = Number(b.max_tickets ?? 2);
  if (![1, 2].includes(max)) return fail("Erlaubt sind 1 oder 2 Tickets.");
  const referred = b.referred_by ? Number(b.referred_by) : null;
  if (referred && !(await first(env, `SELECT 1 FROM invitations WHERE id = ?`, referred))) return fail("Die vermittelnde Einladung gibt es nicht.");
  for (let i = 0; i < 5; i++) {
    const code = randomCode(10);
    const r = await run(env, `INSERT OR IGNORE INTO invitations (code, name, note, referred_by, max_tickets, status, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      code, name, String(b.note || "").slice(0, 300) || null, referred, max, iso(), who.actor, iso());
    if (changes(r)) {
      await audit(env, who, "invitation.create", code, { name, max, referred });
      return json({ id: r.meta.last_row_id, code, url: `${APP_URL}?e=${code}` }, 201);
    }
  }
  return fail("Code konnte nicht erzeugt werden – bitte erneut versuchen.", 500);
}

async function updateInvitation(env, request, who, id) {
  const b = await readJson(request) || {};
  const inv = await first(env, `SELECT * FROM invitations WHERE id = ?`, id);
  if (!inv) return fail("Einladung nicht gefunden.", 404);
  const next = {
    name: b.name != null ? cleanName(b.name) : inv.name,
    note: b.note != null ? String(b.note).slice(0, 300) : inv.note,
    max_tickets: b.max_tickets != null ? Number(b.max_tickets) : inv.max_tickets,
    status: b.status != null ? String(b.status) : inv.status
  };
  if (!next.name || next.name.length > 80) return fail("Name ungültig.");
  if (![1, 2].includes(next.max_tickets)) return fail("Erlaubt sind 1 oder 2 Tickets.");
  if (!["active", "disabled"].includes(next.status)) return fail("Status ungültig.");
  await run(env, `UPDATE invitations SET name = ?, note = ?, max_tickets = ?, status = ?, updated_at = ? WHERE id = ?`, next.name, next.note, next.max_tickets, next.status, iso(), id);
  await audit(env, who, "invitation.update", inv.code, next);
  return json({ ok: true });
}

async function listTickets(env, url) {
  const cat = url.searchParams.get("category");
  const where = ["free", "regular", "helper"].includes(cat) ? `WHERE t.category = '${cat}'` : "";
  return json(await all(env, `SELECT t.id, t.number, t.category, t.helper_job, hi.name AS helper_invitation, t.first_name, t.last_name, t.email, t.status, t.is_test, t.checked_in_at, t.checked_in_by, t.view_key, t.version, t.mail_status, t.note, t.created_at,
      o.order_no, o.id AS order_id, i.name AS invitation_name
    FROM tickets t LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN invitations i ON i.id = o.invitation_id LEFT JOIN invitations hi ON hi.id = t.invitation_id ${where}
    ORDER BY t.category DESC, t.id`));
}

async function createFreeTicket(env, request, who) {
  const b = await readJson(request) || {};
  const first_name = b.first_name ? cleanName(b.first_name) : null, last_name = b.last_name ? cleanName(b.last_name) : null;
  if ((first_name || last_name) && (!nameOk(first_name) || !nameOk(last_name))) return fail("Bitte Vor- und Nachnamen vollständig angeben oder beides leer lassen.");
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  if (email && !emailOk(email)) return fail("E-Mail-Adresse ungültig.");
  const count = Math.min(Math.max(Number(b.count || 1), 1), FREE_CAP);
  if (count > 1 && first_name) return fail("Mehrere Freitickets nur ohne Namen anlegen.");
  const created = [];
  for (let i = 0; i < count; i++) {
    const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, first_name, last_name, email, status, is_test, created_at, updated_at)
      SELECT printf('2T-%02d', COALESCE((SELECT MAX(CAST(substr(number, 4) AS INTEGER)) FROM tickets WHERE category = 'free'), 0) + 1), 'free', ?, ?, ?, ?, ?, 'valid', 0, ?, ?
      WHERE (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') < ?`,
      randomCode(26), randomCode(26), first_name, last_name, email, iso(), iso(), FREE_CAP);
    if (!changes(r)) break;
    created.push(r.meta.last_row_id);
  }
  if (!created.length) return fail(`Es sind bereits ${FREE_CAP} gültige Freitickets vorhanden.`, 409, "FREE_FULL");
  await audit(env, who, "free.create", created.join(","), { first_name, last_name, email, count: created.length });
  return json({ created: created.length, ids: created }, 201);
}

async function updateTicket(env, request, who, id) {
  const b = await readJson(request) || {};
  const t = await first(env, `SELECT * FROM tickets WHERE id = ?`, id);
  if (!t) return fail("Ticket nicht gefunden.", 404);
  const action = String(b.action || "");
  if (action === "assign") {
    const fn = b.first_name ? cleanName(b.first_name) : null, ln = b.last_name ? cleanName(b.last_name) : null;
    if ((fn || ln) && (!nameOk(fn) || !nameOk(ln))) return fail("Bitte Vor- und Nachnamen angeben.");
    if (t.category !== "free" && (!fn || !ln)) return fail("Gekaufte und Helfer-Tickets brauchen immer einen Namen.");
    const email = b.email ? String(b.email).trim().toLowerCase() : null;
    if (email && !emailOk(email)) return fail("E-Mail-Adresse ungültig.");
    if (t.checked_in_at) return fail("Bereits eingecheckt – Zuordnung nicht mehr änderbar.", 409);
    await run(env, `UPDATE tickets SET first_name = ?, last_name = ?, email = ?, updated_at = ? WHERE id = ?`, fn, ln, email, iso(), id);
  } else if (action === "block" || action === "unblock") {
    if (t.status === "cancelled") return fail("Stornierte Tickets lassen sich nicht ändern.", 409);
    await run(env, `UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`, action === "block" ? "blocked" : "valid", iso(), id);
  } else if (action === "replace") {
    if (t.status === "cancelled") return fail("Stornierte Tickets lassen sich nicht ersetzen.", 409);
    const code = randomCode(26), view = randomCode(26);
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO retired_codes (code, ticket_id, retired_at, reason) VALUES (?, ?, ?, ?)`).bind(t.code, id, iso(), String(b.reason || "ersetzt").slice(0, 200)),
      env.DB.prepare(`UPDATE tickets SET code = ?, view_key = ?, version = version + 1, status = 'valid', updated_at = ? WHERE id = ?`).bind(code, view, iso(), id)
    ]);
  } else if (action === "cancel") {
    if (who.role !== "main") return fail("Nur der Hauptadministrator darf stornieren.", 403);
    await run(env, `UPDATE tickets SET status = 'cancelled', updated_at = ? WHERE id = ?`, iso(), id);
  } else if (action === "note") {
    await run(env, `UPDATE tickets SET note = ?, updated_at = ? WHERE id = ?`, String(b.note || "").slice(0, 300), iso(), id);
  } else if (action === "mail") {
    const fresh = await first(env, `SELECT * FROM tickets WHERE id = ?`, id);
    if (!fresh.email || !fresh.first_name) return fail("Für dieses Ticket ist keine E-Mail-Adresse oder kein Name hinterlegt.");
    if (fresh.order_id) { const r = await sendOrderMail(env, fresh.order_id); await audit(env, who, "ticket.mail", t.number, { r }); return r === "sent" ? json({ ok: true }) : fail("Versand fehlgeschlagen. Mailversand prüfen.", 502); }
    const r = await sendTicketMail(env, fresh);
    await audit(env, who, "ticket.mail", t.number, { ok: r.ok });
    return r.ok ? json({ ok: true }) : fail(r.error || "Versand fehlgeschlagen.", 502);
  } else return fail("Unbekannte Aktion.");
  await audit(env, who, `ticket.${action}`, t.number, { reason: b.reason || undefined, first_name: b.first_name, last_name: b.last_name });
  return json({ ok: true });
}

async function listOrders(env) {
  return json(await all(env, `SELECT o.id, o.order_no, o.email, o.buyer_first, o.buyer_last, o.quantity, o.amount_cents, o.provider, o.is_test, o.status, o.paypal_order_id, o.mail_status, o.mail_error, o.created_at, o.paid_at, i.name AS invitation_name,
      (SELECT GROUP_CONCAT(kind || ':' || status || ':' || amount_cents, '|') FROM payments p WHERE p.order_id = o.id) AS payments
    FROM orders o LEFT JOIN invitations i ON i.id = o.invitation_id WHERE o.status IN ('paid','refund_required','refunded') OR o.created_at > ? ORDER BY o.id DESC LIMIT 500`, iso(nowMs() - 2 * 86400_000)));
}

async function orderAction(env, request, who, id) {
  const b = await readJson(request) || {};
  const order = await first(env, `SELECT * FROM orders WHERE id = ?`, id);
  if (!order) return fail("Bestellung nicht gefunden.", 404);
  if (b.action === "mark_refunded") {
    if (who.role !== "main") return fail("Nur der Hauptadministrator.", 403);
    await markRefunded(env, order.id, `manual-${order.order_no}-${Date.now()}`, order.amount_cents);
    await audit(env, who, "order.refunded_manual", order.order_no, { note: b.note });
    return json({ ok: true });
  }
  if (b.action === "resend") { const r = await sendOrderMail(env, order.id); await audit(env, who, "order.mail", order.order_no, { r }); return r === "sent" ? json({ ok: true }) : fail("Versand fehlgeschlagen.", 502); }
  return fail("Unbekannte Aktion.");
}

async function updateSettings(env, request, who) {
  const b = await readJson(request) || {};
  const changed = {};
  for (const [k, v] of Object.entries(b)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    let val = String(v ?? "");
    if (val.length > SETTING_LIMITS[k]) return fail(`Feld ${k} ist zu lang.`);
    if (k === "sale_mode") {
      if (!["closed", "test", "live"].includes(val)) return fail("Verkaufsmodus ungültig.");
      if (who.role !== "main") return fail("Nur der Hauptadministrator darf den Verkauf öffnen oder schließen.", 403);
      if (val === "live" && !paypalConfigured(env)) return fail("Live-Verkauf geht erst, wenn PayPal eingerichtet ist.", 409);
      if (val === "live" && env.PAYPAL_ENV === "live" && env.ALLOW_LIVE_PAYMENTS !== "true") return fail("Echte Zahlungen sind im Worker noch nicht freigegeben (ALLOW_LIVE_PAYMENTS).", 409);
      if (val === "test" && env.ALLOW_TEST_PAYMENTS !== "true") return fail("Testmodus ist im Worker nicht erlaubt.", 409);
    }
    if (k === "lineup") {
      let list; try { list = JSON.parse(val); } catch { return fail("Line-up ungültig."); }
      if (!Array.isArray(list) || list.length > 20) return fail("Line-up ungültig.");
      list = list.map(x => ({ name: cleanName(x?.name).slice(0, 60), time: String(x?.time || "").slice(0, 20), note: String(x?.note || "").slice(0, 80) })).filter(x => x.name);
      val = JSON.stringify(list);
    }
    if (k === "helper_jobs") {
      let list; try { list = JSON.parse(val); } catch { return fail("Helfer-Aufgaben ungültig."); }
      if (!Array.isArray(list) || list.length > 15) return fail("Helfer-Aufgaben ungültig.");
      list = list.map(x => ({ name: cleanName(x?.name).slice(0, 40), slots: Math.min(Math.max(Number(x?.slots) || 0, 0), HELPER_CAP), info: String(x?.info || "").slice(0, 120) })).filter(x => x.name);
      val = JSON.stringify(list);
    }
    if (k === "helper_signup" && !["0", "1"].includes(val)) return fail("Wert ungültig.");
    if (["event_date"].includes(k) && !/^\d{4}-\d{2}-\d{2}$/.test(val)) return fail("Datum im Format JJJJ-MM-TT.");
    if (["doors_time", "start_time"].includes(k) && !/^\d{2}:\d{2}$/.test(val)) return fail("Uhrzeit im Format HH:MM.");
    if (k === "contact_email" && val && !emailOk(val)) return fail("Kontakt-E-Mail ungültig.");
    changed[k] = val;
  }
  if (!Object.keys(changed).length) return fail("Nichts zu speichern.");
  await env.DB.batch(Object.entries(changed).map(([k, v]) => env.DB.prepare(`INSERT INTO event_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(k, v, iso(), who.actor)));
  await audit(env, who, "settings.update", Object.keys(changed).join(","), changed);
  return json({ ok: true });
}

async function purgeTestData(env, who) {
  const s = await getSettings(env);
  if (s.sale_mode === "test") return fail("Bitte zuerst den Testmodus beenden.", 409);
  const ids = await all(env, `SELECT id FROM orders WHERE is_test = 1`);
  const list = ids.map(r => r.id);
  if (list.length) {
    const ph = list.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM checkins WHERE ticket_id IN (SELECT id FROM tickets WHERE is_test = 1)`),
      env.DB.prepare(`DELETE FROM retired_codes WHERE ticket_id IN (SELECT id FROM tickets WHERE is_test = 1)`),
      env.DB.prepare(`DELETE FROM tickets WHERE is_test = 1`),
      env.DB.prepare(`DELETE FROM reservations WHERE order_id IN (${ph})`).bind(...list),
      env.DB.prepare(`DELETE FROM payments WHERE order_id IN (${ph})`).bind(...list),
      env.DB.prepare(`DELETE FROM guests WHERE order_id IN (${ph})`).bind(...list),
      env.DB.prepare(`DELETE FROM orders WHERE id IN (${ph})`).bind(...list)
    ]);
  }
  // Ticketnummern sauber neu beginnen lassen: echte reguläre Tickets bekommen danach fortlaufende Nummern
  await audit(env, who, "test.purge", null, { orders: list.length });
  return json({ ok: true, orders: list.length });
}

// Datenschutz: nach der Veranstaltung Personendaten entfernen (Statistik bleibt).
async function anonymize(env, request, who) {
  const b = await readJson(request) || {};
  if (b.confirm !== "ANONYMISIEREN") return fail("Bitte zur Bestätigung ANONYMISIEREN eingeben.");
  const today = new Date().toISOString().slice(0, 10);
  const s = await getSettings(env);
  if (today <= s.event_date) return fail("Erst nach der Veranstaltung möglich.", 409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE tickets SET first_name = 'Gast', last_name = number, email = NULL, note = NULL`),
    env.DB.prepare(`UPDATE guests SET first_name = 'Gast', last_name = '-'`),
    env.DB.prepare(`UPDATE orders SET email = 'geloescht@invalid', buyer_first = 'Gast', buyer_last = '-'`),
    env.DB.prepare(`UPDATE invitations SET name = 'Einladung ' || id, note = NULL`)
  ]);
  await audit(env, who, "privacy.anonymize", null, {});
  return json({ ok: true });
}

async function testMail(env, request, who) {
  const b = await readJson(request) || {};
  const s = await getSettings(env);
  const to = String(b.to || s.contact_email || "").trim();
  if (!emailOk(to)) return fail("Bitte eine gültige Empfängeradresse angeben.");
  const r = await sendMail(env, to, "Testmail – TAKT Nr. 30", mailHtml(s, "Der Mailversand funktioniert.", [{ number: "TEST", name: "Beispielticket", url: APP_URL }]));
  await audit(env, who, "mail.test", to, { ok: r.ok, error: r.error });
  return r.ok ? json({ ok: true, to }) : fail(r.error || "Versand fehlgeschlagen.", 502);
}

async function listAudit(env) {
  return json(await all(env, `SELECT id, actor_name, action, target, detail, at FROM audit_logs ORDER BY id DESC LIMIT 300`));
}

async function listScanners(env) {
  return json(await all(env, `SELECT id, name, created_at, revoked_at, last_used_at FROM scanner_access ORDER BY id DESC`));
}
async function createScanner(env, request, who) {
  const b = await readJson(request) || {};
  const name = cleanName(b.name);
  if (!name || name.length > 40) return fail("Bitte einen Namen für den Einlasshelfer angeben.");
  const token = randomCode(32);
  const r = await run(env, `INSERT INTO scanner_access (name, token_hash, created_at, created_by) VALUES (?, ?, ?, ?)`, name, await sha256Hex(`scanner|${token}`), iso(), who.actor);
  await audit(env, who, "scanner.create", r.meta.last_row_id, { name });
  return json({ id: r.meta.last_row_id, url: `${APP_ORIGIN}/taktnr30/scanner/#k=${token}` }, 201);
}
async function revokeScanner(env, who, id) {
  const r = await run(env, `UPDATE scanner_access SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, iso(), id);
  if (!changes(r)) return fail("Zugang nicht gefunden oder schon gesperrt.", 404);
  await audit(env, who, "scanner.revoke", id, {});
  return json({ ok: true });
}

async function listAdmins(env) {
  return json(await all(env, `SELECT user_id, role, name, active, created_at FROM admin_users ORDER BY created_at`));
}
async function upsertAdmin(env, request, who) {
  const b = await readJson(request) || {};
  const userId = String(b.user_id || "").trim();
  if (!/^user_[A-Za-z0-9]{10,}$/.test(userId)) return fail("Bitte die Clerk-Benutzer-ID (user_…) angeben.");
  if (!["tickets", "scanner"].includes(b.role)) return fail("Rolle ungültig.");
  const active = b.active === false ? 0 : 1;
  await run(env, `INSERT INTO admin_users (user_id, role, name, active, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, name = excluded.name, active = excluded.active`,
    userId, b.role, cleanName(b.name).slice(0, 60) || null, active, iso(), who.actor);
  await audit(env, who, "admin.upsert", userId, { role: b.role, active });
  return json({ ok: true });
}

const csvCell = v => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
async function exportCsv(env, url) {
  const kind = url.searchParams.get("kind") || "guests";
  let rows, head;
  if (kind === "orders") {
    head = ["Bestellnummer", "Status", "Test", "Käufer", "E-Mail", "Anzahl", "Betrag €", "Einladung", "Bestellt", "Bezahlt"];
    rows = (await all(env, `SELECT o.*, i.name AS inv FROM orders o LEFT JOIN invitations i ON i.id = o.invitation_id WHERE o.status IN ('paid','refund_required','refunded') ORDER BY o.id`))
      .map(o => [o.order_no, o.status, o.is_test ? "ja" : "", `${o.buyer_first} ${o.buyer_last}`, o.email, o.quantity, euro(o.amount_cents).replace(".", ","), o.inv, o.created_at, o.paid_at]);
  } else if (kind === "invitations") {
    head = ["Name", "Code", "Link", "Max", "Status", "Notiz", "Erstellt"];
    rows = (await all(env, `SELECT * FROM invitations ORDER BY id`)).map(i => [i.name, i.code, `${APP_URL}?e=${i.code}`, i.max_tickets, i.status, i.note, i.created_at]);
  } else {
    head = ["Ticket", "Kategorie", "Vorname", "Nachname", "E-Mail", "Status", "Test", "Eingecheckt", "Bestellung"];
    rows = (await all(env, `SELECT t.*, o.order_no FROM tickets t LEFT JOIN orders o ON o.id = t.order_id ORDER BY t.category DESC, t.number`))
      .map(t => [t.number, t.category === "free" ? "2TAKT" : t.category === "helper" ? `Helfer (${t.helper_job})` : "Ticket", t.first_name, t.last_name, t.email, t.status, t.is_test ? "ja" : "", t.checked_in_at, t.order_no]);
  }
  const body = "﻿" + [head, ...rows].map(r => r.map(csvCell).join(";")).join("\r\n");
  return new Response(body, { headers: { ...baseHeaders, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="takt30-${kind}.csv"` } });
}

/* ================= Router ================= */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: baseHeaders });
  await ensureSchema(env);

  // Öffentlich
  if (m === "GET" && path === "/public/event") return getEvent(env);
  if (m === "GET" && path.startsWith("/public/invite/")) return getInvite(env, request, path.split("/").pop());
  if (m === "POST" && path === "/public/checkout") return checkout(env, request, ctx);
  if (m === "POST" && path === "/public/helper") return helperSignup(env, request, ctx);
  if (m === "POST" && path === "/public/cancel") return cancelPending(env, request);
  if (m === "POST" && path === "/public/test-pay") return testPay(env, request, ctx);
  if (m === "POST" && path === "/public/paypal/capture") return paypalCapture(env, request, ctx);
  if (m === "POST" && path === "/paypal/webhook") return paypalWebhook(env, request, ctx);
  if (m === "GET" && path === "/public/order") return getOrder(env, request, url);
  if (m === "POST" && path === "/public/order/resend") return resendOrder(env, request);
  if (m === "GET" && path === "/public/ticket") return getTicket(env, request, url);
  if (m === "GET" && path === "/health") return json({ ok: true });

  // Ab hier: angemeldet
  const who = await identify(request, env);
  if (!who) return fail("Nicht angemeldet.", 401);
  if (!who.role) return fail("Kein Zugriff für dieses Konto.", 403, "NO_ROLE");
  const need = role => (can(who, role) ? null : fail("Für diese Funktion fehlt die Berechtigung.", 403));
  const id = Number(path.split("/").pop());
  let denied;

  if (m === "GET" && path === "/me") return json({ role: who.role, role_label: ROLE_LABEL[who.role], name: who.name });

  if (path.startsWith("/scan")) {
    if ((denied = need("scanner"))) return denied;
    if (m === "POST" && path === "/scan/check") return scan(env, request, who);
    if (m === "GET" && path === "/scan/search") return scanSearch(env, url);
    if (m === "GET" && path === "/scan/stats") return scanStats(env);
    if (m === "POST" && /^\/scan\/checkin\/\d+$/.test(path)) return manualCheckin(env, who, id);
    if (m === "POST" && /^\/scan\/undo\/\d+$/.test(path)) { if ((denied = need("main"))) return denied; return undoCheckin(env, request, who, id); }
    return fail("Nicht gefunden.", 404);
  }

  if ((denied = need("tickets"))) return denied;
  if (m === "GET" && path === "/admin/dashboard") return dashboard(env);
  if (m === "GET" && path === "/admin/settings") return json(await getSettings(env));
  if (m === "PUT" && path === "/admin/settings") return updateSettings(env, request, who);
  if (m === "GET" && path === "/admin/invitations") return listInvitations(env);
  if (m === "POST" && path === "/admin/invitations") return createInvitation(env, request, who);
  if (m === "PUT" && /^\/admin\/invitations\/\d+$/.test(path)) return updateInvitation(env, request, who, id);
  if (m === "GET" && path === "/admin/tickets") return listTickets(env, url);
  if (m === "POST" && path === "/admin/free-tickets") return createFreeTicket(env, request, who);
  if (m === "POST" && /^\/admin\/tickets\/\d+$/.test(path)) return updateTicket(env, request, who, id);
  if (m === "GET" && path === "/admin/orders") return listOrders(env);
  if (m === "POST" && /^\/admin\/orders\/\d+$/.test(path)) return orderAction(env, request, who, id);
  if (m === "GET" && path === "/admin/export") return exportCsv(env, url);
  if (m === "GET" && path === "/admin/scanners") return listScanners(env);
  if (m === "POST" && path === "/admin/scanners") return createScanner(env, request, who);
  if (m === "DELETE" && /^\/admin\/scanners\/\d+$/.test(path)) return revokeScanner(env, who, id);

  if ((denied = need("main"))) return denied;
  if (m === "GET" && path === "/admin/audit") return listAudit(env);
  if (m === "POST" && path === "/admin/test-mail") return testMail(env, request, who);
  if (m === "POST" && path === "/admin/purge-test") return purgeTestData(env, who);
  if (m === "POST" && path === "/admin/anonymize") return anonymize(env, request, who);
  if (m === "GET" && path === "/admin/admins") return listAdmins(env);
  if (m === "POST" && path === "/admin/admins") return upsertAdmin(env, request, who);
  return fail("Nicht gefunden.", 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error("takt30-api", e?.stack || e);
      return fail("Interner Fehler. Bitte später erneut versuchen.", 500);
    }
  }
};
