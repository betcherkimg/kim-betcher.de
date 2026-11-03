/* =====================================================================
   TAKT Nr. 30 – Ticket- und Einlass-API (Cloudflare Worker + D1)
   Eigenständig: eigene Datenbank, berührt SmartADM/Office nicht.
   ===================================================================== */

const APP_ORIGIN = "https://kim-betcher.de";
const APP_URL = `${APP_ORIGIN}/taktnr30/tickets/`;
const CLERK_ISSUER = "https://clerk.kim-betcher.de";
const CLERK_JWKS_URL = `${CLERK_ISSUER}/.well-known/jwks.json`;

const REGULAR_CAP = 60;          // online verkaufbares Kontingent (Papiertickets zählen nicht dazu)
const FREE_CAP = 30;             // 2TAKT-Freitickets
const HELPER_CAP_MAX = 50;       // Obergrenze für das einstellbare Helfer-Kontingent
const helperCap = s => Math.min(Math.max(Number(s?.helper_cap) || 0, 0), HELPER_CAP_MAX);
const MAX_PER_INVITE = 2;        // nie mehr als 2 Tickets je Einladung
const PRICE_CENTS = { 1: 2000, 2: 3500 };   // 1 Ticket 20 €, 2 Tickets 35 €
const VIP_CAP = 20;              // davon höchstens 20 als VIP (zählen in die 60)
const VIP_DRINKS = 3;            // Freigetränke für VIP online
const PAPER_VIP_DRINKS = 5;      // Freigetränke für VIP-Papiertickets (2TAKT)
const HELPER_DRINKS = 5;         // Helfer: 5 Getränkemarken, Wasser gratis (Essen nur, wenn Kim es einzeln dazugibt)
const PAPER_PRICE = { free: 3500, regular: 2500 };   // Reserve-Papiertickets verkauft: VIP 35 €, normal 25 €
// Was der Scanner zeigt: Ticketart, Bändchen-Schlüssel, Freigetränke – plus Extras, die Kim im Admin dazugibt
function ticketKind(t) {
  const k = baseKind(t);
  const xd = Math.max(0, Number(t.extra_drinks) || 0), xf = Math.max(0, Number(t.extra_food) || 0);
  if (xd) k.drinks = (k.drinks || 0) + xd;
  k.food = xf;
  if (xf) k.extras = [...(k.extras || []), `${xf}× Essen am Foodtruck (QR zeigen)`];
  return k;
}
function baseKind(t) {
  if (t.category === "helper") return { kind: t.helper_job ? `Helfer · ${t.helper_job}` : "Helfer", band: "helper", drinks: HELPER_DRINKS, extras: ["TAKT-Becher gratis"], perk: "Wasser gratis" };
  if (t.category === "free") return { kind: "VIP · 2TAKT", band: "free", drinks: PAPER_VIP_DRINKS, shot: true, extras: ["Begrüßungsshot"] };
  if (t.tier === "vip") return { kind: "VIP online", band: "vip", drinks: VIP_DRINKS, shot: true, extras: ["Begrüßungsshot"] };
  if (t.paper) return { kind: "Freiticket", band: "regular", drinks: 0 };
  if (!t.order_id) return { kind: "Freiticket", band: "regular", drinks: 0 };
  return { kind: "Ticket", band: "regular", drinks: 0 };
}
// Was der Einlass einem Helfer sagt (Kim kann nicht selbst einweisen)
function helperBrief(shifts, band, kind, contact) {
  return [
    `Hier sind deine ${kind.drinks} Getränkemarken und dein TAKT-Becher – gratis, den behältst du. Wasser ist den ganzen Abend gratis.`,
    ...(kind.food ? [`Essen bekommst du ${kind.food}× am Foodtruck – wann du willst. Dort einfach deinen Ticket-QR zeigen.`] : []),
    shifts ? `Deine Schicht: ${shifts}. Sei bitte 10 Minuten vorher dort.` : `Du hast noch keine Schicht – such dir eine auf deiner Ticketseite aus oder melde dich unter ${contact}.`,
    `Das Helfer-Bändchen${band.label && band.label !== "–" ? ` (${band.label})` : ""} bleibt dran – daran erkennt man dich als Crew.`
  ];
}
// Bändchen aus den Einstellungen – kommt direkt mit jedem Scan, damit der Einlass es sofort sieht
function bandInfo(s, key) {
  let b = {}; try { b = JSON.parse(s.bands || "{}"); } catch {}
  const x = b[key] || {};
  return { label: x.label || "–", color: /^#[0-9a-fA-F]{6}$/.test(x.color || "") ? x.color : "#ffffff", note: x.note || "" };
}
// Preis nach Zusammensetzung: r = Regular, v = VIP (gemischt ohne Rabatt)
const PRICE_BY_MIX = { r: 2000, v: 3000, rr: 3500, rv: 5000, vv: 5500 };
const priceOf = tiers => PRICE_BY_MIX[tiers.map(x => x === "vip" ? "v" : "r").sort().join("")];
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
  intro_title: "30 Jahre. 150 Gäste. 1 Halle.",
  intro_text: "Geschlossene Gesellschaft. Kein Gästelistenplatz, kein Einlass.\nEinlass ab 19:00. Der Takt beginnt um 20:00.",
  lineup: "[]",
  lineup_note: "Line-up folgt",
  contact_name: "Kim Betcher",
  contact_phone: "0152 22686361",
  contact_email: "betcherkimg@gmail.com",
  sale_mode: "closed",            // closed | test | live
  show_countdown: "1",
  helper_signup: "1",
  helper_cap: "13",
  bands: JSON.stringify({ regular: { label: "Weiß", color: "#ffffff" }, free: { label: "Lila", color: "#9d4dff", note: "" }, vip: { label: "Lila", color: "#9d4dff", note: "" }, helper: { label: "Neongrün", color: "#39ff14" } }),
  helper_jobs: JSON.stringify([{ name: "Bar", slots: 8 }, { name: "Ticketscan", slots: 5 }]),
  shifts_open: "1",               // Helfer dürfen ihre Schichten selbst wählen/ändern
  helper_contact: "0151 40411184", // Telefonnummer für Helfer (Absagen, Fragen)
  contact_address: ""             // Anschrift des Veranstalters für Verträge (nur in der Datenbank)
};
const SETTING_LIMITS = {
  event_date: 10, doors_time: 5, start_time: 5, place_public: 120, venue_name: 120, venue_address: 160,
  intro_title: 120, intro_text: 600, lineup: 4000, lineup_note: 80, contact_name: 80, contact_phone: 40,
  contact_email: 120, sale_mode: 6, show_countdown: 1, helper_signup: 1, helper_cap: 2, helper_jobs: 2000, bands: 900, shifts_open: 1, helper_contact: 40, contact_address: 160
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
  `CREATE TABLE IF NOT EXISTS signature_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL, purpose TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, signed_at TEXT, sent_at TEXT, revoked_at TEXT, png TEXT, png_hash TEXT, sending_at TEXT)`,
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
  `CREATE INDEX IF NOT EXISTS tickets_category ON tickets(category, status)`,
  `CREATE TABLE IF NOT EXISTS retired_codes (code TEXT PRIMARY KEY, ticket_id INTEGER NOT NULL, retired_at TEXT NOT NULL, reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS checkins (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, action TEXT NOT NULL, result TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, actor_name TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK (kind IN ('expense','income')), booked_on TEXT NOT NULL, party TEXT, purpose TEXT NOT NULL, category TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), receipt_no TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS contracts (id INTEGER PRIMARY KEY AUTOINCREMENT, view_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, party_name TEXT NOT NULL, party_email TEXT, body TEXT NOT NULL, body_sha TEXT NOT NULL, owner_sig TEXT, owner_signed_at TEXT, party_sig TEXT, party_signed_at TEXT, party_ua TEXT, annex TEXT, final_sha TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','signed','revoked')), created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dj_photos (contract_id INTEGER PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dj_links (code TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, revoked_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS insurances (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, provider TEXT, policy_no TEXT, coverage TEXT, premium_cents INTEGER, note TEXT, file_name TEXT, file_data TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT NOT NULL, spot TEXT, starts TEXT NOT NULL, ends TEXT, slots INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS shift_assignments (shift_id INTEGER NOT NULL, ticket_id INTEGER NOT NULL, assigned_at TEXT NOT NULL, assigned_by TEXT, PRIMARY KEY (shift_id, ticket_id))`,
  `CREATE INDEX IF NOT EXISTS shift_assignments_ticket ON shift_assignments(ticket_id)`,
  `CREATE TABLE IF NOT EXISTS helper_reminders (ticket_id INTEGER NOT NULL, kind TEXT NOT NULL, sent_at TEXT NOT NULL, ok INTEGER, PRIMARY KEY (ticket_id, kind))`,
  `CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT NOT NULL, title TEXT NOT NULL, note TEXT, position INTEGER NOT NULL DEFAULT 0, done_at TEXT, done_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
];

/* ================= Abrechnung (Belege, Ticketeinnahmen, GEMA) ================= */

const LEDGER_CATS = {
  expense: ["Getränke", "Technik & Licht", "Halle, Heizung & Strom", "Toiletten & Reinigung", "Druck & Material", "Deko", "Gebühren & Versicherung", "Essen & Helfer", "Sonstiges"],
  income: ["Getränkeverkauf (Bar)", "Sonstige Einnahmen"]
};

function ledgerInput(b) {
  const kind = b.kind === "income" ? "income" : "expense";
  const booked_on = String(b.booked_on || "");
  const amount = Math.round(Number(String(b.amount ?? "").replace(",", ".")) * 100);
  const purpose = String(b.purpose || "").trim().slice(0, 160);
  const category = String(b.category || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booked_on)) return { error: "Bitte ein Datum angeben." };
  if (!purpose) return { error: "Bitte angeben, wofür." };
  if (!LEDGER_CATS[kind].includes(category)) return { error: "Kategorie ungültig." };
  if (!(amount > 0) || amount > 10000000) return { error: "Bitte einen Betrag über 0 € angeben." };
  return { kind, booked_on, amount, purpose, category, party: String(b.party || "").trim().slice(0, 120) || null, receipt_no: String(b.receipt_no || "").trim().slice(0, 40) || null, note: String(b.note || "").trim().slice(0, 300) || null };
}

async function listLedger(env) {
  return json({ categories: LEDGER_CATS, rows: await all(env, `SELECT * FROM ledger ORDER BY booked_on, id`) });
}
async function createLedger(env, request, who) {
  const v = ledgerInput(await readJson(request) || {});
  if (v.error) return fail(v.error);
  const r = await run(env, `INSERT INTO ledger (kind, booked_on, party, purpose, category, amount_cents, receipt_no, note, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.kind, v.booked_on, v.party, v.purpose, v.category, v.amount, v.receipt_no, v.note, iso(), iso(), who.actor);
  await audit(env, who, "ledger.create", v.purpose, { kind: v.kind, amount: euro(v.amount) });
  return json({ id: r.meta.last_row_id }, 201);
}
async function updateLedger(env, request, who, id) {
  const v = ledgerInput(await readJson(request) || {});
  if (v.error) return fail(v.error);
  const r = await run(env, `UPDATE ledger SET kind = ?, booked_on = ?, party = ?, purpose = ?, category = ?, amount_cents = ?, receipt_no = ?, note = ?, updated_at = ? WHERE id = ?`,
    v.kind, v.booked_on, v.party, v.purpose, v.category, v.amount, v.receipt_no, v.note, iso(), id);
  if (!changes(r)) return fail("Beleg nicht gefunden.", 404);
  await audit(env, who, "ledger.update", v.purpose, { kind: v.kind, amount: euro(v.amount) });
  return json({ ok: true });
}
async function deleteLedger(env, who, id) {
  const row = await first(env, `SELECT purpose, amount_cents FROM ledger WHERE id = ?`, id);
  if (!row) return fail("Beleg nicht gefunden.", 404);
  await run(env, `DELETE FROM ledger WHERE id = ?`, id);
  await audit(env, who, "ledger.delete", row.purpose, { amount: euro(row.amount_cents) });
  return json({ ok: true });
}

// Alles, was für Steuerberater und GEMA-Rechnungslegung gebraucht wird – nur echte (keine Test-)Zahlungen.
async function report(env) {
  const s = await getSettings(env);
  const orders = await all(env, `SELECT o.order_no, o.status, o.quantity, o.vip_quantity, o.amount_cents, o.paid_at, o.buyer_first, o.buyer_last, o.email,
      (SELECT SUM(fee_cents) FROM payments p WHERE p.order_id = o.id AND p.kind = 'capture') AS fee_cents,
      (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id AND p.kind = 'capture' AND p.fee_cents IS NULL) AS fee_missing,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments p WHERE p.order_id = o.id AND p.kind = 'refund') AS refunded_cents
    FROM orders o WHERE o.is_test = 0 AND o.provider = 'paypal' AND o.status IN ('paid','refund_required','refunded') ORDER BY o.paid_at, o.id`);
  const t = await first(env, `SELECT
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 0 AND order_id IS NOT NULL AND is_test = 0 AND status != 'cancelled') AS sold,
      (SELECT COUNT(*) FROM tickets WHERE tier = 'vip' AND paper = 0 AND order_id IS NOT NULL AND is_test = 0 AND status != 'cancelled') AS sold_vip,
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 0 AND order_id IS NULL AND status != 'cancelled') AS comp,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND paper = 1 AND status != 'cancelled') AS paper_vip,
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 1 AND status != 'cancelled') AS paper_own,
      (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND is_test = 0 AND status != 'cancelled') AS helpers,
      (SELECT COUNT(*) FROM tickets WHERE checked_in_at IS NOT NULL AND is_test = 0 AND status != 'cancelled') AS checked_in`);
  const paid = orders.filter(o => o.status === "paid");
  const gross = paid.reduce((a, o) => a + o.amount_cents, 0);
  const fees = orders.reduce((a, o) => a + (o.fee_cents || 0), 0);
  const ledger = await all(env, `SELECT * FROM ledger ORDER BY booked_on, id`);
  const paperSold = await all(env, `SELECT number, category, first_name, last_name, sold_cents, sold_at, sold_via FROM tickets WHERE paper = 1 AND sold_cents IS NOT NULL AND status != 'cancelled' ORDER BY sold_at, number`);
  const paperCents = paperSold.reduce((a, x) => a + x.sold_cents, 0);
  return json({
    generated_at: iso(),
    event: { name: "TAKT Nr. 30", date: s.event_date, doors: s.doors_time, start: s.start_time, venue: s.venue_name, address: s.venue_address, organizer: s.contact_name, phone: s.contact_phone, email: s.contact_email },
    prices: { one: PRICE_CENTS[1], two: PRICE_CENTS[2], vip_one: PRICE_BY_MIX.v, vip_two: PRICE_BY_MIX.vv, mixed: PRICE_BY_MIX.rv, vip_drinks: VIP_DRINKS },
    tickets: { ...t, orders_paid: paid.length, singles: paid.filter(o => o.quantity === 1).length, pairs: paid.filter(o => o.quantity === 2).length,
      mix: Object.fromEntries(Object.keys(PRICE_BY_MIX).map(k => [k, paid.filter(o => (o.quantity === 1 ? (o.vip_quantity ? "v" : "r") : ["rr", "rv", "vv"][o.vip_quantity || 0]) === k).length])) },
    paper_sold: paperSold,
    paper: { count: paperSold.length, vip: paperSold.filter(x => x.category === "free").length, own: paperSold.filter(x => x.category === "regular").length, cents: paperCents, prices: PAPER_PRICE, vip_drinks: PAPER_VIP_DRINKS },
    money: { ticket_gross_cents: gross, paper_cents: paperCents, paypal_fee_cents: fees, fee_missing: orders.reduce((a, o) => a + (o.fee_missing || 0), 0), refunded_cents: orders.reduce((a, o) => a + (o.refunded_cents || 0), 0) },
    gema: { rate: 0.1189, base_cents: gross + paperCents, fee_cents: Math.round((gross + paperCents) * 0.1189), highest_price_cents: Math.max(PRICE_BY_MIX.v, paperSold.length ? Math.max(...paperSold.map(x => x.sold_cents)) : 0) },
    orders, ledger, categories: LEDGER_CATS
  });
}

/* ================= Verträge mit Unterschrift per Finger ================= */

const SIG_MAX = 250_000;   // Unterschrift als PNG-Data-URL
const sigOk = v => typeof v === "string" && v.startsWith("data:image/png;base64,") && v.length > 200 && v.length <= SIG_MAX;
function annexClean(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 15).map(r => ({ item: String(r?.item || "").trim().slice(0, 80), serial: String(r?.serial || "").trim().slice(0, 60), value: String(r?.value || "").trim().slice(0, 12) })).filter(r => r.item);
}
const contractFinalText = c => `${c.body}\n\nANLAGE:${c.annex || "[]"}\nVERANSTALTER:${c.owner_signed_at}\nPARTNER:${c.party_signed_at}`;

async function listContracts(env) {
  return json((await all(env, `SELECT c.id, c.view_key, c.title, c.party_name, c.party_email, c.body_sha, c.owner_signed_at, c.party_signed_at, c.status, c.created_at, c.meta, p.contract_id IS NOT NULL AS has_photo FROM contracts c LEFT JOIN dj_photos p ON p.contract_id = c.id ORDER BY c.id DESC`))
    .map(r => { let m = null; try { m = r.meta ? JSON.parse(r.meta) : null; } catch {} return { ...r, meta: m && { artist: m.artist, phone: m.phone, set_length: m.set_length, wish: m.wish != null ? fromNoon(m.wish) : null, arrival: m.arrival, hear_link: m.hear_link, price_cents: m.price_cents, guests: (m.guests || []).map(g => g.name), ticket: m.ticket } }; }));
}
async function getContractAdmin(env, id) {
  const c = await first(env, `SELECT * FROM contracts WHERE id = ?`, id);
  return c ? json(c) : fail("Vertrag nicht gefunden.", 404);
}
async function createContract(env, request, who) {
  const b = await readJson(request) || {};
  const title = String(b.title || "").trim().slice(0, 120), body = String(b.body || "").trim();
  const party_name = cleanName(b.party_name || "").slice(0, 80);
  const party_email = b.party_email ? String(b.party_email).trim().toLowerCase() : null;
  if (!title || !party_name) return fail("Titel und Name des Vertragspartners fehlen.");
  if (body.length < 50 || body.length > 30000) return fail("Vertragstext fehlt oder ist zu lang.");
  if (party_email && !emailOk(party_email)) return fail("E-Mail-Adresse ungültig.");
  const ownerSig = b.owner_sig ? (sigOk(b.owner_sig) ? b.owner_sig : null) : null;
  if (b.owner_sig && !ownerSig) return fail("Unterschrift ungültig – bitte neu unterschreiben.");
  const key = randomCode(26), t = iso();
  const annex = annexClean(b.annex);   // vorausgefüllte Geräteliste – der Partner ergänzt/bestätigt sie beim Unterschreiben
  const r = await run(env, `INSERT INTO contracts (view_key, title, party_name, party_email, body, body_sha, owner_sig, owner_signed_at, annex, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    key, title, party_name, party_email, body, await sha256Hex(body), ownerSig, ownerSig ? t : null, annex.length ? JSON.stringify(annex) : null, t, who.actor, t);
  await audit(env, who, "contract.create", title, { party: party_name });
  return json({ id: r.meta.last_row_id, view_key: key, url: `${APP_ORIGIN}/taktnr30/vertrag/?k=${key}` }, 201);
}
// Entwurf später unterschreiben (z. B. am Handy)
async function signContractOwner(env, request, who, id, ctx) {
  const b = await readJson(request) || {};
  if (!sigOk(b.sig)) return fail("Bitte im Feld unterschreiben.");
  const before = await first(env, `SELECT * FROM contracts WHERE id = ?`, id);
  if (!before || before.owner_signed_at || before.status !== "open") return fail("Dieser Vertrag ist schon unterschrieben oder zurückgezogen.", 409);
  const t = iso();
  if (before.party_signed_at) {
    // Der DJ hat über den DJ-Link schon unterschrieben → mit Kims Unterschrift ist der Vertrag fertig
    const finalSha = await sha256Hex(contractFinalText({ ...before, owner_signed_at: t }));
    const r = await run(env, `UPDATE contracts SET owner_sig = ?, owner_signed_at = ?, final_sha = ?, status = 'signed', updated_at = ? WHERE id = ? AND owner_signed_at IS NULL AND status = 'open'`, b.sig, t, finalSha, t, id);
    if (!changes(r)) return fail("Dieser Vertrag ist schon unterschrieben oder zurückgezogen.", 409);
    await audit(env, who, "contract.owner_signed", before.title, { sha: finalSha });
    const done = await djFinish(env, { ...before, owner_signed_at: t, final_sha: finalSha }, ctx);
    return json({ ok: true, finished: true, ticket: done.ticket || null, url: `${APP_ORIGIN}/taktnr30/vertrag/?k=${before.view_key}` });
  }
  const r = await run(env, `UPDATE contracts SET owner_sig = ?, owner_signed_at = ?, updated_at = ? WHERE id = ? AND owner_signed_at IS NULL AND status = 'open'`, b.sig, t, t, id);
  if (!changes(r)) return fail("Dieser Vertrag ist schon unterschrieben oder zurückgezogen.", 409);
  await audit(env, who, "contract.owner_signed", before.title, null);
  return json({ ok: true, url: `${APP_ORIGIN}/taktnr30/vertrag/?k=${before.view_key}` });
}

/* ================= DJ-Link: DJ trägt alles selbst ein, unterschreibt zuerst, Kim zeichnet gegen ================= */

const DJ_MAX_EQ = 15;
// Uhrzeiten als Minuten ab 12:00 (damit 02:00 nach 22:00 kommt)
const noonMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim()); if (!m) return null; const h = Number(m[1]), mm = Number(m[2]); if (h > 23 || mm > 59) return null; return (h < 12 ? h + 24 : h) * 60 + mm - 720; };
const fromNoon = n => { const t = (n + 720) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
const setMinutes = v => { const x = String(v || "").toLowerCase().replace(",", "."); const n = parseFloat(x); if (!Number.isFinite(n)) return null; const m = /min/.test(x) ? Math.round(n) : Math.round(n * 60); return m >= 30 && m <= 360 ? m : null; };
const setLabel = m => m % 60 ? `${(m / 60).toLocaleString("de-DE")} Stunden` : m === 60 ? "1 Stunde" : `${m / 60} Stunden`;
// Belegte Zeiten: Line-up (z. B. „02:00 – 04:00“) und DJ-Verträge mit Wunschzeit
async function djTaken(env, s) {
  const out = [];
  let lineup = []; try { lineup = JSON.parse(s.lineup || "[]"); } catch {}
  for (const x of lineup) {
    const m = /(\d{1,2}:\d{2})\s*(?:[–-]|bis)\s*(\d{1,2}:\d{2})/.exec(String(x.time || ""));
    if (m) { const a = noonMin(m[1]), b = noonMin(m[2]); if (a != null && b != null && b > a) out.push([a, b]); }
    else { const a = noonMin(String(x.time || "").trim()); if (a != null) out.push([a, a + 60]); }
  }
  for (const r of await all(env, `SELECT meta FROM contracts WHERE status != 'revoked' AND meta LIKE '%"kind":"dj"%'`)) {
    try { const m = JSON.parse(r.meta); if (m.wish != null && m.len_min) out.push([m.wish, m.wish + m.len_min]); } catch {}
  }
  return out;
}
const DJ_FIRST = 480, DJ_LAST_END = 1080;   // 20:00 bis 06:00
const DJ_MAX_GUESTS = 2;   // Gästeliste pro DJ
const moneyIn = v => { const n = Number(String(v ?? "").replace(/\s|€/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")); return Number.isFinite(n) && n >= 0 && n <= 100000 ? Math.round(n * 100) : null; };
const euroDe = c => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }) + " €";
const ibanOk = v => { const x = String(v || "").replace(/\s/g, "").toUpperCase(); if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(x)) return false;
  const r = (x.slice(4) + x.slice(0, 4)).replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55)); let m = 0; for (const d of r) m = (m * 10 + Number(d)) % 97; return m === 1; };
const ibanFmt = v => String(v || "").replace(/\s/g, "").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
const weekdayDeS = d => new Intl.DateTimeFormat("de-DE", { weekday: "long", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
const monthBefore = d => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(Date.UTC(y, m - 2, dd)); return x.toISOString().slice(0, 10); };

async function djLink(env) {
  let row = await first(env, `SELECT code, status FROM dj_links WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`);
  if (!row) {
    const code = randomCode(16);
    await run(env, `INSERT INTO dj_links (code, status, created_at) VALUES (?, 'active', ?)`, code, iso());
    row = { code, status: "active" };
  }
  return { code: row.code, url: `${APP_ORIGIN}/taktnr30/dj/?c=${row.code}` };
}
async function djLinkRenew(env, who) {
  await run(env, `UPDATE dj_links SET status = 'revoked', revoked_at = ? WHERE status = 'active'`, iso());
  const l = await djLink(env);
  await audit(env, who, "dj.link_renew", null, null);
  return json(l);
}
async function djCodeOk(env, code) {
  const c = cleanCode(code, 40);
  return c && await first(env, `SELECT code FROM dj_links WHERE code = ? AND status = 'active'`, c) ? c : null;
}

// Eingaben des DJ prüfen und vereinheitlichen
function djInput(b) {
  const f = b?.form || {};
  const v = {
    first_name: cleanName(f.first_name || "").slice(0, 60), last_name: cleanName(f.last_name || "").slice(0, 60),
    artist: cleanName(f.artist || "").slice(0, 60), street: cleanName(f.street || "").slice(0, 100), city: cleanName(f.city || "").slice(0, 80),
    email: String(f.email || "").trim().toLowerCase(), phone: cleanName(f.phone || "").slice(0, 40),
    len_min: setMinutes(f.set_length), wish_time: String(f.wish_time || "").trim(), price_cents: moneyIn(f.price),
    hear_link: String(f.hear_link || "").trim().slice(0, 300), arrival: String(f.arrival || "").trim().slice(0, 5),
    holder: cleanName(f.holder || "").slice(0, 80), iban: String(f.iban || "").replace(/\s/g, "").toUpperCase().slice(0, 34),
    annex: annexClean(f.annex),
    guests: (Array.isArray(f.guests) ? f.guests : []).slice(0, 10).map(g => ({ name: cleanName(g?.name || "").slice(0, 80), email: String(g?.email || "").trim().toLowerCase() })).filter(g => g.name || g.email)
  };
  if (v.guests.length > DJ_MAX_GUESTS) return { error: `Auf die Gästeliste passen höchstens ${DJ_MAX_GUESTS} Personen.` };
  for (const g of v.guests) {
    const parts = g.name.split(" ");
    if (parts.length < 2 || !nameOk(parts[0]) || !nameOk(parts.slice(1).join(" "))) return { error: "Bitte bei der Gästeliste Vor- und Nachnamen eintragen." };
    if (!emailOk(g.email)) return { error: `Bitte für ${g.name} eine gültige E-Mail-Adresse eintragen.` };
    if (g.email === v.email) return { error: "Gäste brauchen eine eigene E-Mail-Adresse." };
  }
  if (!nameOk(v.first_name) || !nameOk(v.last_name)) return { error: "Bitte Vor- und Nachnamen eintragen." };
  if (v.street.length < 3 || !/\d{5}/.test(v.city)) return { error: "Bitte die vollständige Adresse eintragen (Straße und PLZ Ort)." };
  if (!emailOk(v.email)) return { error: "Bitte eine gültige E-Mail-Adresse eintragen." };
  if (!/\d{6,}/.test(v.phone.replace(/\D/g, "") ) ) return { error: "Bitte eine Handynummer eintragen." };
  if (!v.len_min) return { error: "Bitte die vereinbarte Set-Länge auswählen." };
  if (v.hear_link && !/^https:\/\/[^\s<>"]+$/.test(v.hear_link)) return { error: "Bitte den Hörprobe-Link vollständig mit https:// einfügen." };
  if (v.arrival && noonMin(v.arrival) == null) return { error: "Bitte die Ankunftszeit als Uhrzeit eintragen (z. B. 21:30)." };
  v.set_length = setLabel(v.len_min);
  v.wish = v.wish_time ? noonMin(v.wish_time) : null;
  if (v.wish_time && (v.wish == null || v.wish < DJ_FIRST || v.wish + v.len_min > DJ_LAST_END)) return { error: "Bitte eine Wunsch-Uhrzeit aus der Liste wählen." };
  if (v.price_cents == null) return { error: "Bitte den vereinbarten Festpreis eintragen (0 €, wenn du ohne Gage spielst)." };
  if (v.price_cents > 0 && (!ibanOk(v.iban) || v.holder.length < 3)) return { error: "Bitte Kontoinhaber und eine gültige IBAN für die Überweisung eintragen." };
  if (/[<>{}]/.test(Object.values(v).filter(x => typeof x === "string").join(""))) return { error: "Bitte keine Sonderzeichen wie < > { } verwenden." };
  return { v };
}

function djContractBody(v, s) {
  const owner = [`${s.contact_name}${s.contact_address ? `, ${s.contact_address}` : ""}`, `Telefon ${s.contact_phone}`, s.contact_email].join(" · ");
  const party = [`${v.first_name} ${v.last_name}, ${v.street}, ${v.city}`, `Telefon ${v.phone}`, v.email].join(" · ");
  const pay = monthBefore(s.event_date);
  const value = v.annex.reduce((a, x) => a + (moneyIn(x.value) || 0), 0);
  const paid = v.price_cents > 0;
  return `# DJ-Vereinbarung – TAKT Nr. 30

**Veranstalter:** ${owner}

**DJ:** ${party}${v.artist ? `\n\nKünstlername: ${v.artist}` : ""}

## § 1 Veranstaltung und Leistung

1. Der DJ legt bei der privaten Geburtstagsfeier TAKT Nr. 30 am **${weekdayDeS(s.event_date)}, ${dateDe(s.event_date)}**, in der ${s.venue_name}, ${s.venue_address}, auf.
2. Das Set dauert **${v.set_length}**.${v.wish != null ? ` Der DJ wünscht sich einen Beginn um **${fromNoon(v.wish)} Uhr**.` : ""} Die genaue Uhrzeit stimmen Veranstalter und DJ individuell ab; sie ist nicht Teil dieses Vertrags.
3. Der DJ legt Techno nach eigener Auswahl auf, auch eigene Remixe.
4. Der DJ bringt sein eigenes Equipment mit (Anlage 1). Lautsprecheranlage, Licht und Strom stellt der Veranstalter.
5. Der DJ ist rechtzeitig vor Setbeginn vor Ort, damit Aufbau und Soundcheck ohne Zeitdruck möglich sind.

## § 2 Vergütung

${paid ? `1. Der DJ erhält einen **Festpreis von ${euroDe(v.price_cents)}**. Darin sind Anfahrt, Rückfahrt, Equipment und alle sonstigen Kosten enthalten.
2. Der Veranstalter überweist den Festpreis bis spätestens **${dateDe(pay)}** auf folgendes Konto: ${v.holder}, IBAN ${ibanFmt(v.iban)}.
3. Der DJ versteuert die Vergütung selbst.` : `1. Der DJ tritt **ohne Gage** auf und verlangt auch keine Fahrtkosten.`}
${paid ? 4 : 2}. Der DJ bekommt ein **kostenloses Ticket** für die gesamte Feier (digital per E-Mail, das Papierticket kommt per Post) sowie den ganzen Abend **Getränke und Essen kostenlos**.
${v.guests.length ? `${paid ? 5 : 3}. Auf der Gästeliste des DJ stehen: ${v.guests.map(g => g.name).join(", ")}. Jeder Gast bekommt ein kostenloses Ticket per E-Mail.\n` : ""}${paid ? (v.guests.length ? 6 : 5) : (v.guests.length ? 4 : 3)}. Weitere Vergütungen oder Kostenerstattungen gibt es nicht.

## § 3 Equipment und Versicherung

1. Das Equipment des DJ hat einen Gesamtwert von **ca. ${euroDe(value)}**. Die einzelnen Geräte stehen in Anlage 1.
2. Das Equipment des DJ ist während der Veranstaltung über die **Veranstalterversicherung** des Veranstalters gegen Sachschäden versichert, und zwar am Veranstaltungsort vom Aufbau bis zum Abbau.
3. Zahlt die Versicherung einen Schaden nicht oder nicht ganz, etwa wegen Selbstbeteiligung, ersetzt der Veranstalter den Rest selbst, höchstens bis zum Wiederbeschaffungswert und insgesamt bis ${euroDe(value)}.
4. Nicht ersetzt werden Schäden, die der DJ selbst vorsätzlich oder grob fahrlässig verursacht, sowie normaler Verschleiß.
5. Der Veranstalter sorgt für einen abgegrenzten DJ-Bereich ohne Getränke direkt am Pult und eine sichere Ablage für Taschen und Cases.
6. Beide prüfen das Equipment beim Aufbau kurz gemeinsam, gern mit Fotos. Einen Schaden meldet der DJ dem Veranstalter noch am selben Abend.

## § 4 Absage

1. Kann der DJ nicht auflegen, etwa wegen Krankheit, sagt er so früh wie möglich Bescheid.${paid ? " Einen bereits gezahlten Festpreis zahlt er innerhalb von 14 Tagen zurück." : ""} Weitere Ansprüche entstehen daraus nicht.
2. Fällt die Feier aus oder wird sie verschoben, ${paid ? "behält der DJ einen bereits gezahlten Festpreis. Ist noch nichts gezahlt, entstehen keine Ansprüche" : "entstehen dem DJ daraus keine Ansprüche"}.

## § 5 GEMA und Nennung

1. Der Veranstalter meldet die Feier bei der GEMA an und trägt die Gebühren. Für den DJ entstehen dabei keine Kosten.
2. Der Veranstalter darf den DJ mit ${v.artist ? "seinem Künstlernamen" : "seinem Namen"} im Line-up auf der Ticketseite und in Nachrichten an die Gäste nennen.

## § 6 Einlass

Der Einlass ist ab 18 Jahren. Der DJ bringt seinen Ausweis mit.

## § 7 Schlussbestimmungen

1. Änderungen gelten nur, wenn beide sie schriftlich festhalten (E-Mail oder WhatsApp genügt).
2. Ist eine Regelung unwirksam, bleiben die übrigen gültig.
3. Beide unterschreiben elektronisch per Finger. Jeder bekommt das unterschriebene PDF.

## Anlage 1: Equipmentliste

${v.annex.length ? "Die Geräte des DJ stehen in der Tabelle unten." : "Der DJ bringt kein eigenes Equipment mit."}`;
}

async function djInfo(env, request, url) {
  if (await limited(env, `dj:${await clientKey(request, env)}`, 60, 60_000)) return fail("Zu viele Anfragen.", 429);
  if (!await djCodeOk(env, url.searchParams.get("c"))) return fail("Dieser DJ-Link ist nicht (mehr) gültig. Bitte bei Kim melden.", 404);
  const s = await getSettings(env);
  return json({ event_date: s.event_date, weekday: weekdayDeS(s.event_date), venue: s.venue_name, venue_address: s.venue_address, owner: s.contact_name, pay_until: monthBefore(s.event_date),
    first: DJ_FIRST, last_end: DJ_LAST_END, taken: await djTaken(env, s), max_guests: DJ_MAX_GUESTS });
}
async function djPreview(env, request) {
  if (await limited(env, `djp:${await clientKey(request, env)}`, 30, 10 * 60_000)) return fail("Zu viele Versuche. Bitte kurz warten.", 429);
  const b = await readJson(request) || {};
  if (!await djCodeOk(env, b.c)) return fail("Dieser DJ-Link ist nicht (mehr) gültig.", 404);
  const { v, error } = djInput(b);
  if (error) return fail(error);
  const st = await getSettings(env);
  if (v.wish != null && (await djTaken(env, st)).some(([a, z]) => v.wish < z && v.wish + v.len_min > a)) return fail(`${v.wish_time} Uhr ist für ${v.set_length} leider nicht mehr frei. Bitte eine andere Uhrzeit wählen.`, 409);
  const body = djContractBody(v, st);
  return json({ title: `DJ-Vereinbarung ${v.artist || `${v.first_name} ${v.last_name}`}`, body, body_sha: await sha256Hex(body), annex: v.annex });
}
async function djSign(env, request, ctx) {
  if (await limited(env, `djs:${await clientKey(request, env)}`, 5, 60 * 60_000)) return fail("Zu viele Versuche. Bitte später erneut probieren.", 429);
  const b = await readJson(request) || {};
  if (!await djCodeOk(env, b.c)) return fail("Dieser DJ-Link ist nicht (mehr) gültig.", 404);
  const { v, error } = djInput(b);
  if (error) return fail(error);
  if (b.accept !== true) return fail("Bitte bestätige, dass du den Vertrag gelesen hast.");
  if (!sigOk(b.sig)) return fail("Bitte im Feld unterschreiben.");
  const s = await getSettings(env);
  if (v.wish != null && (await djTaken(env, s)).some(([a, z]) => v.wish < z && v.wish + v.len_min > a)) return fail(`${v.wish_time} Uhr ist inzwischen vergeben. Bitte zurückgehen und eine andere Uhrzeit wählen.`, 409);
  const body = djContractBody(v, s), sha = await sha256Hex(body);
  if (b.body_sha !== sha) return fail("Der Vertragstext hat sich geändert. Bitte noch einmal auf „Weiter“ tippen.", 409);
  const dup = await first(env, `SELECT id FROM contracts WHERE party_email = ? AND status != 'revoked' AND meta LIKE '%"kind":"dj"%'`, v.email);
  if (dup) return fail("Mit dieser E-Mail gibt es schon einen DJ-Vertrag. Bitte bei Kim melden, wenn sich etwas geändert hat.", 409);
  const key = randomCode(26), t = iso();
  const title = `DJ-Vereinbarung ${v.artist || `${v.first_name} ${v.last_name}`}`;
  const meta = { kind: "dj", first_name: v.first_name, last_name: v.last_name, artist: v.artist, phone: v.phone, set_length: v.set_length, len_min: v.len_min, wish: v.wish, price_cents: v.price_cents, guests: v.guests, hear_link: v.hear_link || null, arrival: v.arrival || null };
  const photo = typeof b.photo === "string" && /^data:image\/(jpeg|webp|png);base64,/.test(b.photo) && b.photo.length <= 600_000 ? b.photo : null;
  if (b.photo && !photo) return fail("Das Foto ist zu groß oder kein Bild. Bitte ein anderes wählen.");
  await run(env, `INSERT INTO contracts (view_key, title, party_name, party_email, body, body_sha, party_sig, party_signed_at, party_ua, annex, meta, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    key, title, `${v.first_name} ${v.last_name}`, v.email, body, sha, b.sig, t, String(request.headers.get("User-Agent") || "").slice(0, 200),
    v.annex.length ? JSON.stringify(v.annex) : null, JSON.stringify(meta), t, "dj-link", t);
  if (photo) { const row = await first(env, `SELECT id FROM contracts WHERE view_key = ?`, key); await run(env, `INSERT OR REPLACE INTO dj_photos (contract_id, data, created_at) VALUES (?, ?, ?)`, row.id, photo, t); }
  await audit(env, { actor: "dj-link", name: `${v.first_name} ${v.last_name}` }, "dj.signed", title, { price: euroDe(v.price_cents), set: v.set_length });
  const job = sendMail(env, s.contact_email, `DJ hat unterschrieben: ${v.artist || v.first_name + " " + v.last_name}`,
    `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30</p><h1 style="font-weight:300;font-size:24px;margin:0 0 18px">${esc(v.artist || v.first_name)} hat unterschrieben.</h1>
<p style="font-size:15px;line-height:1.6;color:#c9c9d1">Festpreis ${esc(euroDe(v.price_cents))} · Set ${esc(v.set_length)}${v.wish != null ? ` · Wunsch-Beginn ${fromNoon(v.wish)} Uhr` : ""}${v.arrival ? ` · Ankunft ca. ${esc(v.arrival)} Uhr` : ""}${v.hear_link ? ` · Hörprobe: ${esc(v.hear_link)}` : ""}${photo ? " · Foto fürs Line-up liegt im Admin" : ""}${v.guests.length ? ` · Gästeliste: ${esc(v.guests.map(g => g.name).join(", "))}` : ""}<br>Bitte im Admin unter „Verträge“ gegenzeichnen. Danach bekommt ${esc(v.first_name)} automatisch den Vertrag als PDF und das nächste freie 2T-Ticket.</p>
<a href="${APP_ORIGIN}/taktnr30/admin/#contracts" style="display:block;background:#9d4dff;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:18px 0;font-size:15px">Zum Gegenzeichnen</a></div></body></html>`).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true, url: `${APP_ORIGIN}/taktnr30/vertrag/?k=${key}` }, 201);
}

// Nach Kims Gegenzeichnung: nächstes freies 2T-Ticket digital zuordnen, Ticket- und Vertragsmail verschicken
async function djFinish(env, c, ctx) {
  const meta = (() => { try { return JSON.parse(c.meta || "{}"); } catch { return {}; } })();
  const s = await getSettings(env);
  const link = `${APP_ORIGIN}/taktnr30/vertrag/?k=${c.view_key}`;
  let ticket = null;
  const guestTickets = [];
  // Nächstes freies 2T-Papierticket digital zuordnen (das Papier schickt Kim per Post)
  const take = async (fn, ln, email, food, note) => {
    for (let i = 0; i < 3; i++) {
      const free = await first(env, `SELECT id, number FROM tickets WHERE category = 'free' AND paper = 1 AND status = 'valid' AND first_name IS NULL AND sold_cents IS NULL AND checked_in_at IS NULL ORDER BY CAST(substr(number, 4) AS INTEGER) LIMIT 1`);
      if (!free) return null;
      const r = await run(env, `UPDATE tickets SET first_name = ?, last_name = ?, email = ?, extra_food = MAX(extra_food, ?), note = ?, updated_at = ? WHERE id = ? AND first_name IS NULL`, fn, ln, email, food, note, iso(), free.id);
      if (changes(r)) return free.number;
    }
    return null;
  };
  if (meta.kind === "dj" && !meta.ticket) {
    ticket = await take(meta.first_name, meta.last_name, c.party_email, 1, `DJ${meta.artist ? " " + meta.artist : ""} · Getränke frei`);
    for (const g of meta.guests || []) {
      const parts = g.name.split(" ");
      const n = await take(parts[0], parts.slice(1).join(" "), g.email, 0, `Gast von DJ ${meta.artist || meta.first_name}`);
      guestTickets.push({ ...g, ticket: n });
    }
    await run(env, `UPDATE contracts SET meta = ? WHERE id = ?`, JSON.stringify({ ...meta, ticket, guest_tickets: guestTickets }), c.id);
    await audit(env, { actor: `contract:${c.id}`, name: c.party_name }, "dj.ticket", ticket || "kein freies Ticket", { guests: guestTickets.map(g => g.ticket).join(", ") });
  }
  const note = (intro, extra) => `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30</p><h1 style="font-weight:300;font-size:24px;margin:0 0 18px">${esc(intro)}</h1>
<p style="font-size:15px;line-height:1.6;color:#c9c9d1">${esc(c.title)} – unterschrieben von ${esc(s.contact_name)} und ${esc(c.party_name)}.${extra ? "<br>" + esc(extra) : ""}</p>
<a href="${esc(link)}" style="display:block;background:#9d4dff;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:18px 0;font-size:15px">Vertrag ansehen und als PDF speichern</a></div></body></html>`;
  const missing = guestTickets.filter(g => !g.ticket).map(g => g.name);
  const kimNote = [ticket ? `Ticket ${ticket} ist zugeordnet – das Papierticket noch per Post schicken.` : "Kein freies 2T-Ticket mehr – bitte von Hand ein Ticket zuordnen.",
    guestTickets.filter(g => g.ticket).length ? `Gästeliste: ${guestTickets.filter(g => g.ticket).map(g => `${g.name} (${g.ticket})`).join(", ")}.` : "",
    missing.length ? `Für ${missing.join(", ")} war kein freies Ticket mehr da.` : ""].filter(Boolean).join(" ");
  const jobs = [sendMail(env, s.contact_email, `Unterschrieben: ${c.title}`, note("Vertrag unterschrieben.", kimNote))];
  if (c.party_email) jobs.push(sendMail(env, c.party_email, `Dein unterschriebener Vertrag – ${c.title}`, note("Danke – der Vertrag ist unterschrieben.", ticket ? `Dein Ticket ${ticket} kommt in einer eigenen Mail, das Papierticket per Post.` : "")));
  for (const number of [ticket, ...guestTickets.map(g => g.ticket)].filter(Boolean)) jobs.push((async () => { const t = await first(env, `SELECT * FROM tickets WHERE number = ?`, number); if (t?.email) await sendTicketMail(env, t); })());
  const job = Promise.all(jobs).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return { ticket };
}
async function revokeContract(env, who, id) {
  const r = await run(env, `UPDATE contracts SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'open'`, iso(), id);
  if (!changes(r)) return fail("Nur noch nicht unterschriebene Verträge lassen sich zurückziehen.", 409);
  await audit(env, who, "contract.revoke", String(id), null);
  return json({ ok: true });
}
async function getContractPublic(env, request, url) {
  if (await limited(env, `ct:${await clientKey(request, env)}`, 60, 60_000)) return fail("Zu viele Anfragen.", 429);
  const c = await first(env, `SELECT title, party_name, body, body_sha, owner_sig, owner_signed_at, party_sig, party_signed_at, annex, final_sha, status FROM contracts WHERE view_key = ?`, cleanCode(url.searchParams.get("k"), 40));
  if (!c || c.status === "revoked") return fail("Diesen Vertrag gibt es nicht (mehr). Bitte beim Veranstalter melden.", 404);
  if (!c.owner_signed_at && !c.party_signed_at) return fail("Dieser Vertrag ist noch nicht freigegeben. Bitte kurz beim Veranstalter melden.", 404);
  const s = await getSettings(env);
  return json({ ...c, annex: c.annex ? JSON.parse(c.annex) : [], owner_name: s.contact_name });
}
async function signContractPublic(env, request, ctx) {
  if (await limited(env, `cs:${await clientKey(request, env)}`, 10, 10 * 60_000)) return fail("Zu viele Versuche. Bitte später erneut probieren.", 429);
  const b = await readJson(request) || {};
  const c = await first(env, `SELECT * FROM contracts WHERE view_key = ?`, cleanCode(b.k, 40));
  if (!c || c.status === "revoked" || !c.owner_signed_at) return fail("Diesen Vertrag gibt es nicht (mehr).", 404);
  if (c.party_signed_at) return fail("Dieser Vertrag ist bereits unterschrieben.", 409);
  if (b.accept !== true) return fail("Bitte bestätige, dass du den Vertrag gelesen hast.");
  if (b.body_sha !== c.body_sha) return fail("Der Vertragstext hat sich geändert. Bitte Seite neu laden.", 409);
  if (!sigOk(b.sig)) return fail("Bitte im Feld unterschreiben.");
  const annex = JSON.stringify(annexClean(b.annex));
  const t = iso();
  const finalSha = await sha256Hex(contractFinalText({ ...c, annex, party_signed_at: t }));
  const r = await run(env, `UPDATE contracts SET party_sig = ?, party_signed_at = ?, party_ua = ?, annex = ?, final_sha = ?, status = 'signed', updated_at = ? WHERE id = ? AND party_signed_at IS NULL AND status = 'open'`,
    b.sig, t, String(request.headers.get("User-Agent") || "").slice(0, 200), annex, finalSha, t, c.id);
  if (!changes(r)) return fail("Dieser Vertrag ist bereits unterschrieben.", 409);
  await audit(env, { actor: `contract:${c.id}`, name: c.party_name }, "contract.signed", c.title, { sha: finalSha });
  const s = await getSettings(env);
  const link = `${APP_ORIGIN}/taktnr30/vertrag/?k=${c.view_key}`;
  const note = (intro) => `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30</p><h1 style="font-weight:300;font-size:24px;margin:0 0 18px">${esc(intro)}</h1>
<p style="font-size:15px;line-height:1.6;color:#c9c9d1">${esc(c.title)} – unterschrieben von ${esc(s.contact_name)} und ${esc(c.party_name)}.</p>
<a href="${esc(link)}" style="display:block;background:#9d4dff;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:18px 0;font-size:15px">Vertrag ansehen und als PDF speichern</a></div></body></html>`;
  const jobs = [sendMail(env, s.contact_email, `Unterschrieben: ${c.title}`, note("Vertrag unterschrieben."))];
  if (c.party_email) jobs.push(sendMail(env, c.party_email, `Dein unterschriebener Vertrag – ${c.title}`, note("Danke – der Vertrag ist unterschrieben.")));
  const job = Promise.all(jobs).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  return json({ ok: true, party_signed_at: t, final_sha: finalSha });
}

// Versicherungen: Eckdaten + optional die Police als PDF (klein genug für eine D1-Zeile)
const FILE_MAX = 900_000;
function insuranceInput(b) {
  const kind = String(b.kind || "").trim().slice(0, 80);
  if (!kind) return { error: "Bitte angeben, welche Versicherung." };
  const premium = b.premium === "" || b.premium == null ? null : Math.round(Number(String(b.premium).replace(",", ".")) * 100);
  if (premium != null && !(premium >= 0)) return { error: "Beitrag ungültig." };
  let file_name = null, file_data = null;
  if (b.file_data) {
    if (typeof b.file_data !== "string" || !/^data:(application\/pdf|image\/(png|jpeg));base64,/.test(b.file_data) || b.file_data.length > FILE_MAX) return { error: "Datei: PDF oder Bild, höchstens ca. 650 KB." };
    file_data = b.file_data; file_name = String(b.file_name || "Police").slice(0, 100);
  }
  return { kind, provider: String(b.provider || "").trim().slice(0, 80) || null, policy_no: String(b.policy_no || "").trim().slice(0, 60) || null,
    coverage: String(b.coverage || "").trim().slice(0, 200) || null, premium, note: String(b.note || "").trim().slice(0, 300) || null, file_name, file_data };
}
async function listInsurances(env) {
  return json(await all(env, `SELECT id, kind, provider, policy_no, coverage, premium_cents, note, file_name, created_at FROM insurances ORDER BY id`));
}
async function createInsurance(env, request, who) {
  const v = insuranceInput(await readJson(request) || {});
  if (v.error) return fail(v.error);
  const r = await run(env, `INSERT INTO insurances (kind, provider, policy_no, coverage, premium_cents, note, file_name, file_data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.kind, v.provider, v.policy_no, v.coverage, v.premium, v.note, v.file_name, v.file_data, iso(), iso());
  await audit(env, who, "insurance.create", v.kind, { provider: v.provider });
  return json({ id: r.meta.last_row_id }, 201);
}
async function getInsuranceFile(env, id) {
  const r = await first(env, `SELECT file_name, file_data FROM insurances WHERE id = ?`, id);
  return r?.file_data ? json(r) : fail("Keine Datei hinterlegt.", 404);
}
async function deleteInsurance(env, who, id) {
  const r = await run(env, `DELETE FROM insurances WHERE id = ?`, id);
  if (!changes(r)) return fail("Nicht gefunden.", 404);
  await audit(env, who, "insurance.delete", String(id), null);
  return json({ ok: true });
}

/* ================= Vorbereitung (Aufgabenliste im Admin) ================= */

const TODO_PHASES = ["januar", "februar", "woche", "danach"];
const DEFAULT_TODOS = [
  ["januar", "Anzeige ans Bürgeramt schicken", "buergeramt@heidenheim.de · mind. 2 Wochen vorher", true],
  ["januar", "Halle mit Kai durchgehen", "Strom, Heizung, Toiletten, was raus muss, Notausgänge, Aufbauzeit, Versicherung der Halle · Strom an jeder Bar + Einlass (eigene Stromkreise)"],
  ["januar", "Getränkehändler festmachen", "Kommission, Kühlung, Zapfanlage, Theken, Stehtische, Becher, Eis – Freigetränke für VIPs einplanen"],
  ["januar", "Heizung reservieren", "Heizkanonen + Brennstoff – im März schnell vergriffen"],
  ["januar", "Toilettenwagen reservieren (falls nötig)", "Für ca. 180 Leute reicht ein normales WC nicht"],
  ["januar", "Line-up fix machen", "Wer legt wann auf, wer bringt welche Technik mit (Wert notieren)"],
  ["januar", "Versicherung nochmal entscheiden", "Nur Haftpflicht ca. 114 € – oder schriftlich: Technik auf eigenes Risiko"],
  ["februar", "Helferplan Bar & Einlass", "8 an der Bar, 5 am Einlass – wer wann"],
  ["februar", "Preisliste für die Bar", "Runde Preise (3 €, 4 €, 5 €) – schneller beim Wechselgeld"],
  ["februar", "Handyempfang in der Halle testen", "Scanner braucht Internet – sonst mobilen Hotspot mitbringen"],
  ["februar", "Scanner-Zugänge für Einlass-Helfer anlegen", "Admin → Einlass · dazu Powerbanks"],
  ["februar", "VIP-Getränkemarken festlegen", "Wie viele pro VIP, wer gibt sie am Einlass aus"],
  ["februar", "Garderobe organisieren", "Kleiderständer, Nummern, wer betreut sie"],
  ["februar", "Licht & Deko", "Schwarzlicht, Nebel"],
  ["februar", "Sicherheit vorbereiten", "Feuerlöscher, Erste-Hilfe-Kasten, beleuchtete Notausgänge"],
  ["februar", "Nüchterne Ansprechperson festlegen", "Bleibt den Abend über nüchtern und ansprechbar"],
  ["woche", "GEMA anmelden (Tarif M-V)", "Vor der Party anmelden – sonst doppelter Preis. Rechnung erst zahlen, wenn der Antrag nach V. B durch ist"],
  ["woche", "Wechselgeld bei der Bank bestellen und holen", "ca. 350 €: 2 Rollen 1 €, 2 Rollen 2 €, 20 × 5 €, 10 × 10 €"],
  ["woche", "Kassen vorbereiten", "Kassen, Wechselgeld aufteilen, eventuell Kartenleser"],
  ["woche", "Rundmail an alle Gäste", "Anfahrt, Parken, Einlass, Garderobe, Heimweg/Taxi"],
  ["woche", "Aufbau", "Getränke, Technik, Theken, Licht, Garderobe, Einlass"],
  ["danach", "Abbau, Müll, Reinigung", null],
  ["danach", "Ungeöffnete Getränke zurückgeben", null],
  ["danach", "Abrechnung machen", "Einnahmen (PayPal-Auszug, Bar) gegen alle Belege"],
  ["danach", "GEMA: Antrag nach Abschnitt V. B stellen", "Spätestens 6 Wochen nach Rechnung · 11,89 % der Ticketeinnahmen · Aufstellung + PayPal-Auszug unterschrieben beilegen"]
];

// Spätere Ergänzungen – jede wird genau einmal angewendet (auch auf schon bestehende Listen)
const TODO_UPGRADES = [
  ["todos_upgrade_1", t => [
    [`UPDATE todos SET phase = 'woche', title = 'GEMA anmelden (Tarif M-V)', note = 'Vor der Party anmelden – sonst doppelter Preis. Rechnung erst zahlen, wenn der Antrag nach V. B durch ist', position = 0, updated_at = ? WHERE title = 'GEMA klären' AND done_at IS NULL`, t],
    [`INSERT INTO todos (phase, title, note, position, created_at, updated_at) SELECT 'danach', 'GEMA: Antrag nach Abschnitt V. B stellen', 'Spätestens 6 Wochen nach Rechnung · 11,89 % der Ticketeinnahmen · Aufstellung + PayPal-Auszug unterschrieben beilegen', COALESCE((SELECT MAX(position) FROM todos WHERE phase = 'danach'), 0) + 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM todos WHERE title = 'GEMA: Antrag nach Abschnitt V. B stellen')`, t, t],
    [`INSERT INTO todos (phase, title, note, position, created_at, updated_at) SELECT 'februar', 'Handys besorgen (4–6 Stück)', '2–3 für die Bar (NFC: iPhone ab XS oder Android mit NFC), 2–3 für den Einlass (Kamera reicht) · Ladekabel, Powerbanks, Mehrfachsteckdosen', COALESCE((SELECT MAX(position) FROM todos WHERE phase = 'februar'), 0) + 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM todos WHERE title = 'Handys besorgen (4–6 Stück)')`, t, t],
    [`INSERT INTO todos (phase, title, note, position, created_at, updated_at) SELECT 'februar', 'Handys einrichten (Bar + Einlass)', 'Bar: PayPal POS mit Mitarbeiter-Zugang · Einlass: Scanner-App + Zugangs-QR · Sperre aus, beschriften, Hotspot · Testlauf: Ticket scannen + 1-€-Kartenzahlung', COALESCE((SELECT MAX(position) FROM todos WHERE phase = 'februar'), 0) + 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM todos WHERE title = 'Handys einrichten (Bar + Einlass)')`, t, t],
    [`UPDATE todos SET note = COALESCE(note || ' · ', '') || 'Strom an jeder Bar + Einlass (eigene Stromkreise)', updated_at = ? WHERE title = 'Halle mit Kai durchgehen' AND COALESCE(note, '') NOT LIKE '%Strom an jeder Bar%'`, t]
  ]]
];

async function upgradeTodos(env) {
  for (const [key, build] of TODO_UPGRADES) {
    const r = await run(env, `INSERT OR IGNORE INTO event_settings (key, value, updated_at, updated_by) VALUES (?, '1', ?, 'system')`, key, iso());
    if (!changes(r)) continue;
    await env.DB.batch(build(iso()).map(([sql, ...args]) => env.DB.prepare(sql).bind(...args)));
  }
}

async function seedTodos(env) {
  await seedTodosOnce(env);
  await upgradeTodos(env);
}

async function seedTodosOnce(env) {
  // Nur einmal: danach gehört die Liste dir (auch wenn du alles löschst, kommt nichts zurück)
  const r = await run(env, `INSERT OR IGNORE INTO event_settings (key, value, updated_at, updated_by) VALUES ('todos_seeded', '1', ?, 'system')`, iso());
  if (!changes(r)) return;
  const t = iso();
  const pos = {};
  await env.DB.batch(DEFAULT_TODOS.map(([phase, title, note, done]) => env.DB.prepare(
    `INSERT INTO todos (phase, title, note, position, done_at, done_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(phase, title, note || null, (pos[phase] = (pos[phase] || 0) + 1), done ? t : null, done ? "system" : null, t, t)));
}

async function listTodos(env) {
  return json(await all(env, `SELECT id, phase, title, note, position, done_at, created_at FROM todos ORDER BY position, id`));
}

async function createTodo(env, request, who) {
  const b = await readJson(request) || {};
  const title = String(b.title || "").trim().slice(0, 120), note = String(b.note || "").trim().slice(0, 300) || null;
  if (!title) return fail("Bitte einen Titel eingeben.");
  if (!TODO_PHASES.includes(b.phase)) return fail("Abschnitt ungültig.");
  const max = await first(env, `SELECT COALESCE(MAX(position), 0) AS p FROM todos WHERE phase = ?`, b.phase);
  const r = await run(env, `INSERT INTO todos (phase, title, note, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`, b.phase, title, note, (max?.p || 0) + 1, iso(), iso());
  await audit(env, who, "todo.create", title, { phase: b.phase });
  return json({ id: r.meta.last_row_id }, 201);
}

async function updateTodo(env, request, who, id) {
  const b = await readJson(request) || {};
  const todo = await first(env, `SELECT * FROM todos WHERE id = ?`, id);
  if (!todo) return fail("Aufgabe nicht gefunden.", 404);
  const title = b.title != null ? String(b.title).trim().slice(0, 120) : todo.title;
  const note = b.note !== undefined ? (String(b.note || "").trim().slice(0, 300) || null) : todo.note;
  const phase = b.phase != null ? String(b.phase) : todo.phase;
  if (!title) return fail("Bitte einen Titel eingeben.");
  if (!TODO_PHASES.includes(phase)) return fail("Abschnitt ungültig.");
  let done_at = todo.done_at, done_by = todo.done_by;
  if (b.done === true && !todo.done_at) { done_at = iso(); done_by = who.actor; }
  if (b.done === false) { done_at = null; done_by = null; }
  await run(env, `UPDATE todos SET title = ?, note = ?, phase = ?, done_at = ?, done_by = ?, updated_at = ? WHERE id = ?`, title, note, phase, done_at, done_by, iso(), id);
  return json({ ok: true });
}

async function deleteTodo(env, who, id) {
  const todo = await first(env, `SELECT title FROM todos WHERE id = ?`, id);
  if (!todo) return fail("Aufgabe nicht gefunden.", 404);
  await run(env, `DELETE FROM todos WHERE id = ?`, id);
  await audit(env, who, "todo.delete", todo.title, null);
  return json({ ok: true });
}

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql)));
  await run(env, `INSERT OR IGNORE INTO events (id, name, regular_cap, free_cap, created_at) VALUES (1, 'TAKT Nr. 30', ?, ?, ?)`, REGULAR_CAP, FREE_CAP, iso());
  const rows = Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
    env.DB.prepare(`INSERT OR IGNORE INTO event_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system')`).bind(k, v, iso()));
  await env.DB.batch(rows);
  // Ergänzungen für bestehende Datenbanken (Fehler = Spalte gibt es schon)
  for (const sql of [
    `ALTER TABLE tickets ADD COLUMN paper INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE invitations ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal'`,
    `ALTER TABLE invitations ADD COLUMN owner_ticket INTEGER`,
    `ALTER TABLE scanner_access ADD COLUMN mode TEXT NOT NULL DEFAULT 'entry'`,
    `ALTER TABLE tickets ADD COLUMN food_at TEXT`,
    `ALTER TABLE tickets ADD COLUMN food_by TEXT`,
    `ALTER TABLE tickets ADD COLUMN extra_drinks INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tickets ADD COLUMN extra_food INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tickets ADD COLUMN food_used INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE shift_assignments ADD COLUMN committed_at TEXT`,
    `ALTER TABLE orders ADD COLUMN holder TEXT`,
    `ALTER TABLE reservations ADD COLUMN holder TEXT`,
    `ALTER TABLE tickets ADD COLUMN holder TEXT`,
    `ALTER TABLE payments ADD COLUMN fee_cents INTEGER`,
    `ALTER TABLE tickets ADD COLUMN tier TEXT NOT NULL DEFAULT 'regular'`,
    `ALTER TABLE guests ADD COLUMN tier TEXT NOT NULL DEFAULT 'regular'`,
    `ALTER TABLE orders ADD COLUMN vip_quantity INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE reservations ADD COLUMN vip_quantity INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tickets ADD COLUMN sold_cents INTEGER`,
    `ALTER TABLE tickets ADD COLUMN sold_at TEXT`,
    `ALTER TABLE tickets ADD COLUMN sold_via TEXT`,
    `ALTER TABLE contracts ADD COLUMN meta TEXT`
  ]) await run(env, sql).catch(() => {});
  // Bändchen: VIP online ergänzen, 2TAKT-Hinweis auf 3 Getränkemarken (nur wenn noch der alte Standard drinsteht)
  const bandRow = await first(env, `SELECT value FROM event_settings WHERE key = 'bands'`);
  try {
    const b = JSON.parse(bandRow?.value || "{}"); let dirty = false;
    if (!b.vip) { b.vip = { label: (b.free && b.free.label) || "Lila", color: (b.free && b.free.color) || "#9d4dff", note: "" }; dirty = true; }
    if (b.free && b.free.note === "VIP · Getränke laut Absprache") { b.free.note = ""; dirty = true; }  // Freigetränke zeigt der Scanner jetzt selbst
    if (dirty) await run(env, `UPDATE event_settings SET value = ?, updated_at = ? WHERE key = 'bands'`, JSON.stringify(b), iso());
  } catch { /* ungültig gespeichert – bleibt, Admin kann neu speichern */ }
  // „holder“ = wer zählt fürs 2er-Limit: persönliche Einladung → i<ID>, gemeinsamer Link → i<ID>:<E-Mail>
  await env.DB.batch([
    `UPDATE orders SET holder = 'i' || invitation_id WHERE holder IS NULL`,
    `UPDATE reservations SET holder = 'i' || invitation_id WHERE holder IS NULL`,
    `UPDATE tickets SET holder = (SELECT holder FROM orders WHERE orders.id = tickets.order_id) WHERE holder IS NULL AND order_id IS NOT NULL`,
    `UPDATE tickets SET holder = 'i' || invitation_id WHERE holder IS NULL AND invitation_id IS NOT NULL`,
    `DROP INDEX IF EXISTS tickets_one_helper`,
    `CREATE UNIQUE INDEX IF NOT EXISTS tickets_one_helper_holder ON tickets(holder) WHERE helper_job IS NOT NULL AND status != 'cancelled'`,
    `CREATE INDEX IF NOT EXISTS tickets_holder ON tickets(holder)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS invitations_crew_owner ON invitations(owner_ticket) WHERE owner_ticket IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS reservations_holder ON reservations(holder, state)`
  ].map(q => env.DB.prepare(q)));
  await run(env, `UPDATE event_settings SET value = ?, updated_at = ?, updated_by = 'system' WHERE key = 'helper_jobs' AND value = ?`,
    DEFAULT_SETTINGS.helper_jobs, iso(), JSON.stringify([{ name: "Bar", slots: 0 }, { name: "Ticketscanner", slots: 0 }]));
  // Schichten je Person ergänzen (Standard 1 Schicht à ~3 h) – nur einmal, solange das Feld noch fehlt
  try {
    const jr = await first(env, `SELECT value FROM event_settings WHERE key = 'helper_jobs'`);
    const jl = JSON.parse(jr?.value || "[]");
    if (Array.isArray(jl) && jl.some(j => j && j.shifts === undefined))
      await run(env, `UPDATE event_settings SET value = ?, updated_at = ?, updated_by = 'system' WHERE key = 'helper_jobs'`,
        JSON.stringify(jl.map(j => ({ ...j, shifts: j.shifts ?? 1 }))), iso());
  } catch { /* ungültig gespeichert – Admin kann neu speichern */ }
  await run(env, `UPDATE tickets SET food_used = 1 WHERE food_at IS NOT NULL AND food_used = 0`).catch(() => {});
  await seedShifts(env);
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
  (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 0 AND status != 'cancelled')
  + (SELECT COALESCE(SUM(quantity), 0) FROM reservations r${alias} WHERE r${alias}.state = 'active' AND r${alias}.expires_at > ?))`;

// VIP-Kontingent (Teil der 60): ausgestellte VIP-Tickets + laufende VIP-Reservierungen
const SQL_VIP_TAKEN = `(
  (SELECT COUNT(*) FROM tickets WHERE tier = 'vip' AND paper = 0 AND status != 'cancelled')
  + (SELECT COALESCE(SUM(vip_quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ?))`;

// Belegte Plätze eines „holders“ (Tickets + laufende Reservierungen) und sein Limit
const SQL_USED = `((SELECT COUNT(*) FROM tickets WHERE holder = ? AND status != 'cancelled') + (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE holder = ? AND state = 'active' AND expires_at > ?))`;
const SQL_LIMIT = `(SELECT CASE WHEN status = 'active' THEN CASE WHEN kind = 'group' THEN ${MAX_PER_INVITE} WHEN kind = 'crew' THEN 1 ELSE max_tickets END END FROM invitations WHERE id = ?)`;
// „crew“ = Helfer-Werbelink eines Helfers: wie der gemeinsame Link je E-Mail, aber nur für 1 Helfer-Ticket, kein Kauf
const holderOf = (inv, email) => inv.kind === "group" || inv.kind === "crew" ? (email ? `i${inv.id}:${String(email).trim().toLowerCase()}` : null) : `i${inv.id}`;

async function ensureGroupInvite(env) {
  let g = await first(env, `SELECT id, code, status FROM invitations WHERE kind = 'group' ORDER BY id LIMIT 1`);
  if (!g) {
    await run(env, `INSERT OR IGNORE INTO invitations (code, name, max_tickets, status, kind, created_at, created_by, updated_at) VALUES (?, 'Gemeinsamer Ticket-Link', 2, 'active', 'group', ?, 'system', ?)`, randomCode(8), iso(), iso());
    g = await first(env, `SELECT id, code, status FROM invitations WHERE kind = 'group' ORDER BY id LIMIT 1`);
  }
  return g;
}

async function counts(env, settings) {
  const cap = helperCap(settings || await getSettings(env));
  const t = nowMs();
  const row = await first(env, `SELECT
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 0 AND status != 'cancelled') AS regular_issued,
      (SELECT COUNT(*) FROM tickets WHERE tier = 'vip' AND paper = 0 AND status != 'cancelled') AS vip_issued,
      (SELECT COALESCE(SUM(vip_quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ?) AS vip_reserved,
      (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ?) AS reserved,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') AS free_issued,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled' AND first_name IS NOT NULL) AS free_assigned,
      (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND status != 'cancelled') AS helper_issued,
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND order_id IS NULL AND paper = 0 AND status != 'cancelled') AS regular_comp,
      (SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 1 AND status = 'valid') AS paper_own,
      (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND paper = 1 AND status = 'valid') AS paper_vip,
      (SELECT COUNT(*) FROM tickets WHERE paper = 1 AND status = 'blocked') AS paper_blocked,
      (SELECT COUNT(*) FROM tickets WHERE paper = 1 AND status != 'cancelled') AS paper_total,
      (SELECT COUNT(*) FROM tickets WHERE paper = 1 AND checked_in_at IS NOT NULL AND status != 'cancelled') AS paper_checked_in,
      (SELECT COUNT(*) FROM tickets WHERE checked_in_at IS NOT NULL AND status != 'cancelled') AS checked_in,
      (SELECT COUNT(*) FROM tickets WHERE status = 'valid') AS expected,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE status = 'paid' AND is_test = 0) AS revenue_cents,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE status = 'paid' AND is_test = 1) AS test_revenue_cents,
      (SELECT COUNT(*) FROM tickets WHERE is_test = 1) AS test_tickets,
      (SELECT COUNT(*) FROM orders WHERE status = 'refund_required') AS refund_required,
      (SELECT COUNT(*) FROM orders WHERE status = 'refunded') AS refunded`, t, t);
  const available = Math.max(0, REGULAR_CAP - row.regular_issued - row.reserved);
  const vip_available = Math.min(available, Math.max(0, VIP_CAP - row.vip_issued - row.vip_reserved));
  return { ...row, regular_cap: REGULAR_CAP, free_cap: FREE_CAP, helper_cap: cap, helper_available: Math.max(0, cap - row.helper_issued), available, vip_cap: VIP_CAP, vip_available };
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
    const row = await first(env, `SELECT id, name, mode FROM scanner_access WHERE token_hash = ? AND revoked_at IS NULL`, hash);
    if (!row) return null;
    await run(env, `UPDATE scanner_access SET last_used_at = ? WHERE id = ?`, iso(), row.id).catch(() => {});
    const food = row.mode === "food";
    return { actor: `scanner:${row.id}`, name: `${food ? "Foodtruck" : "Einlass"}: ${row.name}`, role: "scanner", scan_mode: food ? "food" : "entry" };
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
  try { return JSON.parse(s.helper_jobs).filter(j => j && j.name).map(j => ({ name: String(j.name), slots: Number(j.slots) || 0, info: String(j.info || ""), shifts: Math.min(Math.max(Number(j.shifts) || 1, 1), SHIFT_MAX_PER_PERSON) })); } catch { return []; }
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
    sale: { mode, sandbox: mode === "live" && env.PAYPAL_ENV !== "live", open: mode !== "closed", sold_out: c.available <= 0, available: c.available, cap: REGULAR_CAP, sold: c.regular_issued, prices: { one: PRICE_CENTS[1], two: PRICE_CENTS[2], vip_one: PRICE_BY_MIX.v, vip_two: PRICE_BY_MIX.vv, mixed: PRICE_BY_MIX.rv },
      vip: { cap: VIP_CAP, available: c.vip_available ?? VIP_CAP, sold: c.vip_issued ?? 0, drinks: VIP_DRINKS } },
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

// Helfer-Anmeldung über einen Einladungslink → kostenloses Helfer-Ticket
async function helperSignup(env, request, ctx) {
  if (await limited(env, `hp:${await clientKey(request, env)}`, 8, 10 * 60_000)) return fail("Zu viele Versuche. Bitte in ein paar Minuten erneut probieren.", 429);
  const b = await readJson(request);
  if (!b) return fail("Ungültige Anfrage.");
  const s = await getSettings(env);
  if (s.helper_signup !== "1") return fail("Die Helfer-Anmeldung ist gerade geschlossen.", 409, "HELPER_CLOSED");
  if (!(await turnstileOk(env, b.turnstile, request))) return fail("Die Sicherheitsprüfung ist fehlgeschlagen. Bitte erneut versuchen.", 400, "TURNSTILE");
  if (b.accept !== true) return fail("Bitte bestätige Datenschutzhinweise und Teilnahmebedingungen.");
  if (!nameOk(b.first_name) || !nameOk(b.last_name)) return fail("Bitte Vor- und Nachnamen angeben.");
  if (!emailOk(b.email)) return fail("Bitte eine gültige E-Mail-Adresse angeben.");
  const email = String(b.email).trim().toLowerCase();
  const inv = await inviteState(env, cleanCode(b.invite), email);
  if (!inv) return fail("Diese Einladung kennen wir nicht.", 404, "INVITE_UNKNOWN");
  if (inv.status !== "active") return fail("Diese Einladung ist nicht mehr gültig.", 409, "INVITE_DISABLED");
  if (inv.helper_job) return fail(inv.kind === "group" || inv.kind === "crew" ? "Mit dieser E-Mail ist schon jemand als Helfer eingetragen." : "Mit dieser Einladung ist schon jemand als Helfer eingetragen.", 409, "HELPER_EXISTS");
  if (inv.remaining < 1) return fail("Für dich sind bereits alle Plätze vergeben.", 409, "INVITE_EXHAUSTED");
  const job = helperJobs(s).find(j => j.name === b.job);
  if (!job) return fail("Bitte eine Aufgabe auswählen.");
  const t = nowMs();
  const holder = holderOf(inv, email);
  // Atomar: Helferkontingent, Aufgaben-Plätze und 2er-Limit in einem Schritt prüfen
  const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, invitation_id, holder, helper_job, first_name, last_name, email, status, is_test, created_at, updated_at)
    SELECT printf('H-%02d', COALESCE((SELECT MAX(CAST(substr(number, 3) AS INTEGER)) FROM tickets WHERE category = 'helper'), 0) + 1), 'helper', ?, ?, ?, ?, ?, ?, ?, ?, 'valid', 0, ?, ?
    WHERE (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND status != 'cancelled') < ?
      AND (? = 0 OR (SELECT COUNT(*) FROM tickets WHERE category = 'helper' AND helper_job = ? AND status != 'cancelled') < ?)
      AND ${SQL_USED} + 1 <= ${SQL_LIMIT}
      AND NOT EXISTS (SELECT 1 FROM tickets WHERE holder = ? AND helper_job IS NOT NULL AND status != 'cancelled')`,
    randomCode(26), randomCode(26), inv.id, holder, job.name, cleanName(b.first_name), cleanName(b.last_name), email, iso(t), iso(t),
    helperCap(s), job.slots, job.name, job.slots, holder, holder, t, inv.id, holder).catch(() => null);
  if (!r || !changes(r)) {
    const c = await counts(env);
    if (c.helper_available <= 0) return fail("Alle Helferplätze sind schon vergeben – danke trotzdem!", 409, "HELPER_FULL");
    const jc = await jobCounts(env);
    if (job.slots && (jc[job.name] || 0) >= job.slots) return fail(`Für „${job.name}“ sind schon genug Helfer eingetragen. Bitte eine andere Aufgabe wählen.`, 409, "JOB_FULL");
    return fail("Die Anmeldung war gerade nicht möglich. Bitte erneut versuchen.", 409);
  }
  const ticket = await first(env, `SELECT * FROM tickets WHERE id = ?`, r.meta.last_row_id);
  await audit(env, { actor: `invite:${inv.id}`, name: inv.kind === "group" ? `Ticket-Link (${email})` : inv.kind === "crew" ? `${inv.name} (${email})` : inv.name }, "helper.signup", ticket.number, { job: job.name });
  const mail = sendTicketMail(env, ticket).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(mail); else await mail;
  return json({ number: ticket.number, view_key: ticket.view_key, job: job.name }, 201);
}

async function inviteState(env, code, email) {
  const inv = await first(env, `SELECT id, name, max_tickets, status, kind, owner_ticket FROM invitations WHERE code = ?`, code);
  if (!inv) return null;
  const max = inv.kind === "group" ? MAX_PER_INVITE : inv.kind === "crew" ? 1 : inv.max_tickets;
  const holder = holderOf(inv, email);
  if (!holder) return { ...inv, max, issued: 0, reserved: 0, remaining: max, helper_job: null };
  const t = nowMs();
  const used = await first(env, `SELECT
     (SELECT COUNT(*) FROM tickets WHERE holder = ? AND status != 'cancelled') AS issued,
     (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE holder = ? AND state = 'active' AND expires_at > ?) AS reserved,
     (SELECT helper_job FROM tickets WHERE holder = ? AND helper_job IS NOT NULL AND status != 'cancelled') AS helper_job`, holder, holder, t, holder);
  return { ...inv, max, holder, issued: used.issued, reserved: used.reserved, remaining: Math.max(0, max - used.issued - used.reserved), helper_job: used.helper_job || null };
}

async function getInvite(env, request, code) {
  if (await limited(env, `inv:${await clientKey(request, env)}`, 40, 60_000)) return fail("Zu viele Anfragen. Bitte kurz warten.", 429);
  const st = await inviteState(env, cleanCode(code));
  if (!st) return fail("Diese Einladung kennen wir nicht. Bitte prüfe den Link.", 404, "INVITE_UNKNOWN");
  const first_name = st.kind === "group" || st.kind === "crew" ? null : st.name.split(" ")[0];
  const from = st.kind === "crew" ? (await first(env, `SELECT first_name FROM tickets WHERE id = ?`, st.owner_ticket))?.first_name || null : undefined;
  return json({ valid: st.status === "active", status: st.status, kind: st.kind, first_name, from, max: st.max, issued: st.issued, reserved: st.reserved, remaining: st.remaining, helper_job: st.helper_job });
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

  const guests = Array.isArray(body.guests) ? body.guests.slice(0, 3) : [];
  const quantity = guests.length;
  if (quantity < 1 || quantity > MAX_PER_INVITE) return fail("Pro Person sind 1 oder 2 Tickets möglich.");
  for (const g of guests) if (!nameOk(g?.first_name) || !nameOk(g?.last_name)) return fail("Bitte für jedes Ticket Vor- und Nachnamen angeben.");
  const tiers = guests.map(g => g?.tier === "vip" ? "vip" : "regular");
  const vipQty = tiers.filter(x => x === "vip").length;
  if (!emailOk(body.email)) return fail("Bitte eine gültige E-Mail-Adresse angeben.");
  const email = String(body.email).trim().toLowerCase();

  const inv = await inviteState(env, cleanCode(body.invite), email);
  if (!inv) return fail("Diese Einladung kennen wir nicht.", 404, "INVITE_UNKNOWN");
  if (inv.status !== "active") return fail("Diese Einladung ist nicht mehr gültig.", 409, "INVITE_DISABLED");
  if (inv.kind === "crew") return fail("Mit diesem Helfer-Link kann man nur als Helfer mitmachen – Tickets gibt es darüber nicht.", 403, "CREW_ONLY");
  const exhausted = n => fail(n > 0 ? `Für dich ist noch ${n} Ticket möglich.` : "Du hast bereits 2 Tickets – mehr gehen pro Person nicht.", 409, "INVITE_EXHAUSTED");
  if (quantity > inv.max - inv.issued) return exhausted(inv.max - inv.issued);

  // Derselbe Käufer startet neu → alten, unbezahlten Versuch sofort freigeben (z. B. Abbruch am Handy, neuer Versuch am PC)
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status = 'cancelled', updated_at = ? WHERE holder = ? AND status = 'pending'`).bind(iso(), inv.holder),
    env.DB.prepare(`UPDATE reservations SET state = 'released' WHERE holder = ? AND state = 'active'`).bind(inv.holder)
  ]);

  const t = nowMs();
  const orderNo = `T30-${new Date(t).toISOString().slice(2, 10).replace(/-/g, "")}-${randomCode(5)}`;
  const accessKey = randomCode(26);
  const amount = priceOf(tiers);
  const provider = mode === "test" ? "test" : "paypal";
  const isTest = provider === "test" || env.PAYPAL_ENV !== "live";   // Sandbox = Spielgeld = Testticket

  const ins = await run(env, `INSERT INTO orders (order_no, access_key, invitation_id, holder, email, buyer_first, buyer_last, quantity, vip_quantity, amount_cents, provider, is_test, status, consent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    orderNo, accessKey, inv.id, inv.holder, email, cleanName(guests[0].first_name), cleanName(guests[0].last_name), quantity, vipQty, amount, provider, isTest ? 1 : 0, iso(t), iso(t), iso(t));
  const orderId = ins.meta.last_row_id;
  await env.DB.batch(guests.map((g, i) => env.DB.prepare(`INSERT INTO guests (order_id, position, first_name, last_name, tier) VALUES (?, ?, ?, ?, ?)`)
    .bind(orderId, i + 1, cleanName(g.first_name), cleanName(g.last_name), tiers[i])));

  // Atomar: nur reservieren, wenn Online-Kontingent, VIP-Kontingent UND 2er-Limit des Käufers reichen.
  const res = await run(env, `INSERT INTO reservations (order_id, invitation_id, holder, quantity, vip_quantity, expires_at, state, created_at)
    SELECT ?, ?, ?, ?, ?, ?, 'active', ?
    WHERE ${SQL_REGULAR_TAKEN()} + ? <= ?
      AND ${SQL_VIP_TAKEN} + ? <= ?
      AND ${SQL_USED} + ? <= ${SQL_LIMIT}`,
    orderId, inv.id, inv.holder, quantity, vipQty, t + RESERVATION_MS, iso(t), t, quantity, REGULAR_CAP, t, vipQty, VIP_CAP, inv.holder, inv.holder, t, quantity, inv.id);
  if (!changes(res)) {
    await run(env, `UPDATE orders SET status = 'failed', updated_at = ? WHERE id = ?`, iso(), orderId);
    const c = await counts(env);
    if (c.available < quantity) return fail(c.available ? `Es ist nur noch ${c.available} Ticket verfügbar.` : "Ausverkauft – es sind keine Tickets mehr verfügbar.", 409, "SOLD_OUT");
    if (c.vip_available < vipQty) return fail(c.vip_available ? `Es ist nur noch ${c.vip_available} VIP-Ticket verfügbar.` : "VIP ist ausverkauft – normale Tickets gibt es noch.", 409, "VIP_SOLD_OUT");
    return fail("Für dich ist gerade schon ein Kauf in Bearbeitung oder es sind bereits 2 Tickets vergeben.", 409, "INVITE_EXHAUSTED");
  }

  const out = { order_no: orderNo, access_key: accessKey, amount_cents: amount, quantity, vip_quantity: vipQty, provider, expires_at: t + RESERVATION_MS };
  if (provider === "paypal") {
    try {
      const pp = await paypalCreateOrder(env, { orderNo, amount, quantity, vipQty });
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
  if (payment.fee != null) await run(env, `UPDATE payments SET fee_cents = ? WHERE provider_ref = ? AND kind = 'capture' AND fee_cents IS NULL`, payment.fee, payment.ref);
  if (order.status === "paid") return { ok: true, status: "paid", already: true };
  if (["refunded", "refund_required"].includes(order.status)) return { ok: false, status: order.status };
  if (payment.amount !== order.amount_cents || payment.currency !== "EUR") {
    await run(env, `UPDATE orders SET status = 'refund_required', updated_at = ? WHERE id = ?`, iso(), order.id);
    await audit(env, null, "payment.amount_mismatch", order.order_no, payment);
    return { ok: false, status: "refund_required" };
  }
  await run(env, `INSERT OR IGNORE INTO payments (order_id, provider, kind, provider_ref, status, amount_cents, currency, created_at, fee_cents) VALUES (?, ?, 'capture', ?, 'completed', ?, ?, ?, ?)`,
    order.id, order.provider, payment.ref, payment.amount, payment.currency, iso(), payment.fee ?? null);

  const t = nowMs();
  // Platz sichern: laufende Reservierung verlängern oder – falls abgelaufen – neu belegen, wenn noch Platz ist.
  let held = changes(await run(env, `UPDATE reservations SET expires_at = ? WHERE order_id = ? AND state = 'active' AND expires_at > ?`, t + CAPTURE_HOLD_MS, order.id, t));
  if (!held) {
    const st = await first(env, `SELECT state FROM reservations WHERE order_id = ?`, order.id);
    if (st?.state === "converted") held = 1;
    else held = changes(await run(env, `UPDATE reservations SET state = 'active', expires_at = ?
        WHERE order_id = ? AND state != 'converted'
          AND ((SELECT COUNT(*) FROM tickets WHERE category = 'regular' AND paper = 0 AND status != 'cancelled')
             + (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ? AND order_id != ?)
             + quantity) <= ?
          AND ((SELECT COUNT(*) FROM tickets WHERE tier = 'vip' AND paper = 0 AND status != 'cancelled')
             + (SELECT COALESCE(SUM(vip_quantity), 0) FROM reservations WHERE state = 'active' AND expires_at > ? AND order_id != ?)
             + vip_quantity) <= ?
          AND ((SELECT COUNT(*) FROM tickets tk WHERE tk.holder = reservations.holder AND tk.status != 'cancelled')
             + (SELECT COALESCE(SUM(quantity), 0) FROM reservations r2 WHERE r2.holder = reservations.holder AND r2.state = 'active' AND r2.expires_at > ? AND r2.order_id != reservations.order_id)
             + quantity) <= (SELECT CASE WHEN kind = 'group' THEN ${MAX_PER_INVITE} WHEN kind = 'crew' THEN 0 ELSE max_tickets END FROM invitations WHERE id = reservations.invitation_id)`, t + CAPTURE_HOLD_MS, order.id, t, order.id, REGULAR_CAP, t, order.id, VIP_CAP, t));
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

  const guests = await all(env, `SELECT position, first_name, last_name, tier FROM guests WHERE order_id = ? ORDER BY position`, order.id);
  const ins = guests.map(g => env.DB.prepare(`INSERT INTO tickets (number, category, tier, code, view_key, order_id, holder, guest_position, first_name, last_name, email, status, is_test, created_at, updated_at)
      SELECT printf('T30-%03d', COALESCE((SELECT MAX(CAST(substr(number, 5) AS INTEGER)) FROM tickets WHERE category = 'regular' AND number LIKE 'T30-%'), 0) + 1), 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE order_id = ? AND guest_position = ?)`)
    .bind(g.tier === "vip" ? "vip" : "regular", randomCode(26), randomCode(26), order.id, order.holder, g.position, g.first_name, g.last_name, order.email, order.is_test, iso(), iso(), order.id, g.position));
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
    ? await all(env, `SELECT number, category, tier, first_name, last_name, view_key, code, status, checked_in_at, is_test FROM tickets WHERE order_id = ? ORDER BY guest_position`, order.id)
    : [];
  return {
    order_no: order.order_no, status: order.status, quantity: order.quantity, vip_quantity: order.vip_quantity || 0, vip_drinks: VIP_DRINKS, amount_cents: order.amount_cents,
    email: order.email, is_test: !!order.is_test, mail_status: order.mail_status,
    tickets: tickets.map(t => ({ ...t, drinks: t.tier === "vip" ? VIP_DRINKS : 0 })),
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
  if (await limited(env, `tk:${await clientKey(request, env)}`, 150, 60_000)) return fail("Zu viele Anfragen.", 429);
  const k = cleanCode(url.searchParams.get("k"), 40);
  const t = await first(env, `SELECT number, category, tier, helper_job, first_name, last_name, code, status, checked_in_at, is_test, paper, order_id, extra_drinks, extra_food FROM tickets WHERE view_key = ?`, k);
  if (!t) return fail("Dieses Ticket gibt es nicht (mehr). Wurde es ersetzt, nutze bitte den neuen Link.", 404);
  const { paper, order_id, extra_drinks, extra_food, ...pub } = t;
  return json({ ...pub, drinks: ticketKind(t).drinks, perk: ticketKind(t).perk, event: eventForTicket(await getSettings(env)) });
}

async function resendOrder(env, request) {
  const body = await readJson(request);
  const order = body && await orderByKey(env, body.access_key);
  if (!order || order.status !== "paid") return fail("Bestellung nicht gefunden.", 404);
  if (await limited(env, `rs:${order.id}`, 3, 60 * 60_000)) return fail("Die Mail wurde gerade erst verschickt. Bitte später erneut versuchen.", 429);
  const r = await sendOrderMail(env, order.id);
  return json({ mail_status: r });
}

/* ================= Schichtplan (Helfer) ================= */
// Zeiten als "HH:MM" am Partyabend. Alles vor 12 Uhr zählt zum nächsten Morgen; leeres Ende = Open End (06:00).
const SHIFT_MAX_PER_PERSON = 4;
const SHIFT_REST_MIN = 60;        // eigene Schichten nie direkt hintereinander: mind. 1 Stunde Pause
const SHIFT_OPEN_END = "06:00";
const DEFAULT_SHIFTS = [
  ["Bar", "Bar 1", "19:00", "22:00", 3], ["Bar", "Bar 2", "20:00", "22:00", 2],
  ["Bar", "Bar 1", "22:00", "01:00", 4], ["Bar", "Bar 2", "22:00", "01:00", 4],
  ["Bar", "Bar 1", "01:00", "04:00", 3], ["Bar", "Bar 2", "01:00", "04:00", 3],
  ["Bar", "Bar 1", "04:00", "", 2],
  ["Einlass", "Einlass", "19:00", "21:30", 3], ["Einlass", "Einlass", "21:30", "00:00", 2], ["Einlass", "Einlass", "00:00", "02:00", 1],
  ["Security", "Security", "21:00", "03:00", 1], ["Security", "Security", "21:00", "", 1]
];
const berlinNow = (ms = nowMs()) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = k => p.find(x => x.type === k).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
};
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const SHIFT_DROP_DAYS = 7;   // bis 7 Tage vorher selbst austragen, danach nur telefonisch
const commitText = contact => `Ich bin 10 Minuten vor Schichtbeginn da. Wenn ich nicht kann, trage ich mich bis spätestens ${SHIFT_DROP_DAYS} Tage vorher aus oder melde mich unter ${contact}.`;
const timeOk = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const shiftMin = v => { const [h, m] = String(v).split(":").map(Number); return (h < 12 ? h + 24 : h) * 60 + m; };
const shiftSpan = sh => [shiftMin(sh.starts), shiftMin(sh.ends || SHIFT_OPEN_END)];
const shiftTime = sh => `${sh.starts}–${sh.ends || "Ende"}`;
const shiftSort = (a, b) => shiftMin(a.starts) - shiftMin(b.starts) || String(a.spot || "").localeCompare(String(b.spot || "")) || a.id - b.id;
// Zu nah dran / überschneidet sich mit einer schon gewählten Schicht?
const shiftClash = (sh, mine) => mine.some(o => { const [a1, a2] = shiftSpan(sh), [b1, b2] = shiftSpan(o); return a1 < b2 + SHIFT_REST_MIN && b1 < a2 + SHIFT_REST_MIN; });

async function seedShifts(env) {
  const r = await run(env, `INSERT OR IGNORE INTO event_settings (key, value, updated_at, updated_by) VALUES ('shifts_seeded', '1', ?, 'system')`, iso());
  if (!changes(r)) return;
  if ((await first(env, `SELECT COUNT(*) AS n FROM shifts`)).n) return;
  await env.DB.batch(DEFAULT_SHIFTS.map(([area, spot, starts, ends, slots]) =>
    env.DB.prepare(`INSERT INTO shifts (area, spot, starts, ends, slots, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(area, spot, starts, ends || null, slots, iso())));
}

async function shiftRows(env, area) {
  const shifts = (await all(env, `SELECT * FROM shifts ${area ? "WHERE area = ?" : ""}`, ...(area ? [area] : []))).sort(shiftSort);
  const crew = await all(env, `SELECT a.shift_id, a.ticket_id, a.committed_at, t.number, t.first_name, t.last_name, t.status FROM shift_assignments a JOIN tickets t ON t.id = a.ticket_id WHERE t.status != 'cancelled' ORDER BY a.assigned_at`);
  return shifts.map(sh => ({ ...sh, crew: crew.filter(c => c.shift_id === sh.id) }));
}

async function shiftLine(env, ticketId) {
  const rows = (await all(env, `SELECT s.* FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.ticket_id = ?`, ticketId)).sort(shiftSort);
  return rows.map(sh => `${shiftTime(sh)}${sh.spot && sh.spot !== sh.area ? " " + sh.spot : ""}`).join(" · ");
}

// Jeder Helfer bekommt einen eigenen Werbelink („Crew-Link“) – darüber melden sich Freunde nur als Helfer an.
async function crewInvite(env, t) {
  let c = await first(env, `SELECT code, status FROM invitations WHERE kind = 'crew' AND owner_ticket = ?`, t.id);
  if (!c) {
    await run(env, `INSERT OR IGNORE INTO invitations (code, name, max_tickets, status, kind, owner_ticket, created_at, created_by, updated_at) VALUES (?, ?, 1, 'active', 'crew', ?, ?, 'system', ?)`,
      randomCode(8), `Crew-Link ${`${t.first_name || ""} ${t.last_name || ""}`.trim() || t.number}`.slice(0, 120), t.id, iso(), iso());
    c = await first(env, `SELECT code, status FROM invitations WHERE kind = 'crew' AND owner_ticket = ?`, t.id);
  }
  return c;
}
// Allgemeiner Helfer-Link von Kim (gehört keinem Helfer)
async function generalCrewInvite(env) {
  let c = await first(env, `SELECT id, code, status FROM invitations WHERE kind = 'crew' AND owner_ticket IS NULL ORDER BY id LIMIT 1`);
  if (!c) {
    await run(env, `INSERT INTO invitations (code, name, max_tickets, status, kind, created_at, created_by, updated_at) VALUES (?, 'Helfer-Link (allgemein)', 1, 'active', 'crew', ?, 'system', ?)`, randomCode(8), iso(), iso());
    c = await first(env, `SELECT id, code, status FROM invitations WHERE kind = 'crew' AND owner_ticket IS NULL ORDER BY id LIMIT 1`);
  }
  return c;
}
async function adminLinks(env) {
  const [g, h, scanners] = await Promise.all([ensureGroupInvite(env), generalCrewInvite(env),
    all(env, `SELECT id, name, mode, created_at, revoked_at, last_used_at FROM scanner_access ORDER BY revoked_at IS NOT NULL, id DESC`)]);
  const brought = await first(env, `SELECT COUNT(*) AS n FROM tickets WHERE invitation_id = ? AND status != 'cancelled'`, h.id);
  const dj = await djLink(env);
  const djCount = await first(env, `SELECT COUNT(*) AS n, SUM(CASE WHEN status = 'signed' THEN 1 ELSE 0 END) AS done FROM contracts WHERE meta LIKE '%"kind":"dj"%' AND status != 'revoked'`);
  const freePaper = await first(env, `SELECT COUNT(*) AS n FROM tickets WHERE category = 'free' AND paper = 1 AND status = 'valid' AND first_name IS NULL AND sold_cents IS NULL`);
  return json({
    dj_link: { url: dj.url, contracts: djCount?.n || 0, signed: djCount?.done || 0, free_tickets: freePaper?.n || 0 },
    ticket_link: { id: g.id, url: `${APP_URL}?e=${g.code}`, status: g.status },
    helper_link: { id: h.id, url: crewUrl(h.code), status: h.status, signups: brought.n },
    pages: { tickets: APP_URL, scanner: `${APP_ORIGIN}/taktnr30/scanner/`, admin: `${APP_ORIGIN}/taktnr30/admin/` },
    scanners
  });
}
const crewUrl = code => `${APP_URL}?e=${code}`;

async function recruitInfo(env, t, s) {
  const c = await crewInvite(env, t);
  const n = await counts(env, s);
  const brought = (await first(env, `SELECT COUNT(*) AS n FROM tickets tk JOIN invitations i ON i.id = tk.invitation_id WHERE i.kind = 'crew' AND i.owner_ticket = ? AND tk.status != 'cancelled'`, t.id)).n;
  return { url: c.status === "active" ? crewUrl(c.code) : null, open: s.helper_signup === "1" && n.helper_available > 0, available: n.helper_available, brought };
}

async function shiftView(env, t) {
  const s = await getSettings(env);
  const job = helperJobs(s).find(j => j.name === t.helper_job) || { name: t.helper_job, shifts: 1 };
  const rows = await shiftRows(env, t.helper_job);
  const mine = rows.filter(r => r.crew.some(c => c.ticket_id === t.id));
  const open = s.shifts_open === "1" && t.status === "valid" && !t.checked_in_at;
  const dropUntil = addDays(s.event_date, -SHIFT_DROP_DAYS);
  return {
    open, area: job.name, max: job.shifts, rest_min: SHIFT_REST_MIN, info: job.info || "",
    contact: s.helper_contact, commit_text: commitText(s.helper_contact), drop_locked: berlinNow().date >= dropUntil, drop_until: addDays(dropUntil, -1),
    recruit: t.status === "valid" ? await recruitInfo(env, t, s) : null,
    ticket: { number: t.number, first_name: t.first_name },
    shifts: rows.map(r => {
      const taken = r.crew.length, isMine = mine.includes(r), full = taken >= r.slots;
      const why = isMine ? null : full ? "voll" : mine.length >= job.shifts ? "max" : shiftClash(r, mine) ? "pause" : null;
      return { id: r.id, spot: r.spot, starts: r.starts, ends: r.ends || null, note: r.note || "", slots: r.slots, taken, mine: isMine, committed: isMine ? !!r.crew.find(c => c.ticket_id === t.id).committed_at : undefined, free: Math.max(0, r.slots - taken), why,
        crew: r.crew.filter(c => c.ticket_id !== t.id).map(c => c.first_name || "Helfer") };
    })
  };
}

async function helperByKey(env, k) {
  const t = await first(env, `SELECT id, number, category, helper_job, first_name, last_name, status, checked_in_at FROM tickets WHERE view_key = ?`, cleanCode(k, 40));
  return t && t.category === "helper" && t.status !== "cancelled" ? t : null;
}

async function publicShifts(env, request, url) {
  if (await limited(env, `sh:${await clientKey(request, env)}`, 120, 60_000)) return fail("Zu viele Anfragen.", 429);
  const t = await helperByKey(env, url.searchParams.get("k"));
  if (!t) return fail("Kein Helfer-Ticket.", 404);
  return json(await shiftView(env, t));
}

async function pickShift(env, request) {
  if (await limited(env, `shp:${await clientKey(request, env)}`, 40, 60_000)) return fail("Zu viele Anfragen.", 429);
  const b = await readJson(request) || {};
  const t = await helperByKey(env, b.k);
  if (!t) return fail("Kein Helfer-Ticket.", 404);
  const v = await shiftView(env, t);
  if (!v.open) return fail(t.checked_in_at ? "Du bist schon eingecheckt – Änderungen bitte direkt mit Kim." : "Die Schichtwahl ist gerade geschlossen. Melde dich bei Kim.", 409, "SHIFTS_CLOSED");
  const sh = v.shifts.find(x => x.id === Number(b.shift_id));
  if (!sh) return fail("Diese Schicht gibt es nicht (mehr).", 404);
  if (b.confirm === true) {
    if (!sh.mine) return fail("Das ist nicht deine Schicht.", 409);
    await run(env, `UPDATE shift_assignments SET committed_at = COALESCE(committed_at, ?) WHERE shift_id = ? AND ticket_id = ?`, iso(), sh.id, t.id);
    await audit(env, { actor: `ticket:${t.number}`, name: t.first_name }, "shift.commit", t.number, { shift: sh.id });
    return json(await shiftView(env, t));
  }
  if (b.take === false) {
    if (v.drop_locked) return fail(`Austragen geht jetzt nur noch telefonisch: ${v.contact}`, 409, "DROP_LOCKED");
    await run(env, `DELETE FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?`, sh.id, t.id);
    await audit(env, { actor: `ticket:${t.number}`, name: t.first_name }, "shift.drop", t.number, { shift: sh.id });
    return json(await shiftView(env, t));
  }
  if (sh.mine) return json(v);
  if (b.commit !== true) return fail("Bitte bestätige zuerst deine Zusage (Häkchen oben).", 400, "COMMIT_REQUIRED");
  // Wechseln: neue Schicht nehmen und erst danach die alte freigeben (geht die neue nicht, bleibt die alte)
  const old = b.replace != null ? v.shifts.find(x => x.id === Number(b.replace) && x.mine) : null;
  if (old) {
    const rest = v.shifts.filter(x => x.mine && x.id !== old.id);
    if (sh.free <= 0) return fail("Die Schicht ist gerade voll geworden – such dir bitte eine andere aus.", 409, "SHIFT_FULL");
    if (shiftClash(sh, rest)) return fail("Zu knapp an deiner anderen Schicht – dazwischen soll mindestens eine Stunde Pause zum Feiern sein.", 409, "SHIFT_CLASH");
    const r = await run(env, `INSERT INTO shift_assignments (shift_id, ticket_id, assigned_at, assigned_by, committed_at)
      SELECT ?, ?, ?, 'self', ? WHERE (SELECT COUNT(*) FROM shift_assignments a JOIN tickets t ON t.id = a.ticket_id WHERE a.shift_id = ? AND t.status != 'cancelled') < (SELECT slots FROM shifts WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?)`, sh.id, t.id, iso(), iso(), sh.id, sh.id, sh.id, t.id).catch(() => null);
    if (!changes(r)) return fail("Die Schicht ist gerade voll geworden – such dir bitte eine andere aus.", 409, "SHIFT_FULL");
    await run(env, `DELETE FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?`, old.id, t.id);
    await audit(env, { actor: `ticket:${t.number}`, name: t.first_name }, "shift.swap", t.number, { from: old.id, to: sh.id });
    return json(await shiftView(env, t));
  }
  if (sh.why === "max") return fail(`Du hast schon ${v.max} ${v.max === 1 ? "Schicht" : "Schichten"}. Trag dich erst aus einer aus.`, 409, "SHIFT_MAX");
  if (sh.why === "pause") return fail("Zu knapp an deiner anderen Schicht – dazwischen soll mindestens eine Stunde Pause zum Feiern sein.", 409, "SHIFT_CLASH");
  // Atomar: nur wenn noch Platz ist und das persönliche Maximum nicht erreicht ist.
  const r = await run(env, `INSERT INTO shift_assignments (shift_id, ticket_id, assigned_at, assigned_by, committed_at)
    SELECT ?, ?, ?, 'self', ? WHERE (SELECT COUNT(*) FROM shift_assignments a JOIN tickets t ON t.id = a.ticket_id WHERE a.shift_id = ? AND t.status != 'cancelled') < (SELECT slots FROM shifts WHERE id = ?)
      AND (SELECT COUNT(*) FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.ticket_id = ? AND s.area = ?) < ?
      AND NOT EXISTS (SELECT 1 FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?)`,
    sh.id, t.id, iso(), iso(), sh.id, sh.id, t.id, v.area, v.max, sh.id, t.id).catch(() => null);
  if (!changes(r)) return fail("Die Schicht ist gerade voll geworden – such dir bitte eine andere aus.", 409, "SHIFT_FULL");
  await audit(env, { actor: `ticket:${t.number}`, name: t.first_name }, "shift.take", t.number, { shift: sh.id });
  return json(await shiftView(env, t));
}

async function adminShifts(env) {
  const s = await getSettings(env);
  const [rows, helpers] = await Promise.all([shiftRows(env),
    all(env, `SELECT id, number, first_name, last_name, email, helper_job, status, view_key, checked_in_at, food_at FROM tickets WHERE category = 'helper' AND status != 'cancelled' ORDER BY number`)]);
  const crew = {};
  for (const h of helpers) if (h.status === "valid") crew[h.id] = await crewInvite(env, h);
  const brought = Object.fromEntries((await all(env, `SELECT i.owner_ticket AS id, COUNT(*) AS n FROM tickets tk JOIN invitations i ON i.id = tk.invitation_id WHERE i.kind = 'crew' AND tk.status != 'cancelled' GROUP BY i.owner_ticket`)).map(r => [r.id, r.n]));
  return json({
    open: s.shifts_open === "1", rest_min: SHIFT_REST_MIN, jobs: helperJobs(s),
    shifts: rows.map(r => ({ ...r, crew: r.crew.map(c => ({ ticket_id: c.ticket_id, number: c.number, committed: !!c.committed_at, name: `${c.first_name || ""} ${c.last_name || ""}`.trim() })) })),
    contact: s.helper_contact,
    helpers: helpers.map(h => ({ ...h, shifts: rows.filter(r => r.crew.some(c => c.ticket_id === h.id)).map(r => r.id), crew_url: crew[h.id]?.status === "active" ? crewUrl(crew[h.id].code) : null, brought: brought[h.id] || 0 }))
  });
}

async function saveShift(env, request, who, id) {
  const b = await readJson(request) || {};
  const area = cleanName(b.area).slice(0, 40), spot = cleanName(b.spot).slice(0, 40) || area;
  const starts = String(b.starts || ""), ends = String(b.ends || ""), slots = Number(b.slots);
  if (!area) return fail("Bereich fehlt.");
  if (!timeOk(starts) || (ends && !timeOk(ends))) return fail("Uhrzeit im Format HH:MM (Ende leer = Open End).");
  if (shiftMin(ends || SHIFT_OPEN_END) <= shiftMin(starts)) return fail("Das Ende muss nach dem Beginn liegen.");
  if (!Number.isInteger(slots) || slots < 1 || slots > 30) return fail("Plätze: 1 bis 30.");
  const note = String(b.note || "").slice(0, 120);
  if (id) {
    const old = await first(env, `SELECT id FROM shifts WHERE id = ?`, id);
    if (!old) return fail("Schicht nicht gefunden.", 404);
    const used = (await first(env, `SELECT COUNT(*) AS n FROM shift_assignments a JOIN tickets t ON t.id = a.ticket_id WHERE a.shift_id = ? AND t.status != 'cancelled'`, id)).n;
    if (slots < used) return fail(`Es sind schon ${used} eingetragen – erst jemanden austragen.`, 409);
    await run(env, `UPDATE shifts SET area = ?, spot = ?, starts = ?, ends = ?, slots = ?, note = ?, updated_at = ? WHERE id = ?`, area, spot, starts, ends || null, slots, note, iso(), id);
  } else {
    await run(env, `INSERT INTO shifts (area, spot, starts, ends, slots, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, area, spot, starts, ends || null, slots, note, iso());
  }
  await audit(env, who, id ? "shift.update" : "shift.create", `${spot} ${starts}`, { area, ends, slots });
  return json({ ok: true });
}

async function deleteShift(env, who, id) {
  const sh = await first(env, `SELECT * FROM shifts WHERE id = ?`, id);
  if (!sh) return fail("Schicht nicht gefunden.", 404);
  await env.DB.batch([env.DB.prepare(`DELETE FROM shift_assignments WHERE shift_id = ?`).bind(id), env.DB.prepare(`DELETE FROM shifts WHERE id = ?`).bind(id)]);
  await audit(env, who, "shift.delete", `${sh.spot} ${sh.starts}`, {});
  return json({ ok: true });
}

// Kim teilt zu oder trägt aus – darf Pausen- und Maximum-Regel übergehen, nicht aber die Platzzahl.
async function assignShift(env, request, who, id) {
  const b = await readJson(request) || {};
  const sh = await first(env, `SELECT * FROM shifts WHERE id = ?`, id);
  const t = await first(env, `SELECT id, number, category, status FROM tickets WHERE id = ?`, Number(b.ticket_id));
  if (!sh || !t || t.category !== "helper" || t.status === "cancelled") return fail("Schicht oder Helfer nicht gefunden.", 404);
  if (b.remove) {
    await run(env, `DELETE FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?`, id, t.id);
  } else {
    const r = await run(env, `INSERT INTO shift_assignments (shift_id, ticket_id, assigned_at, assigned_by)
      SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM shift_assignments a JOIN tickets t ON t.id = a.ticket_id WHERE a.shift_id = ? AND t.status != 'cancelled') < ?
        AND NOT EXISTS (SELECT 1 FROM shift_assignments WHERE shift_id = ? AND ticket_id = ?)`, id, t.id, iso(), who.name || who.actor, id, sh.slots, id, t.id).catch(() => null);
    if (!changes(r)) return fail("Schicht ist voll (oder schon eingetragen). Erst die Plätze erhöhen.", 409, "SHIFT_FULL");
  }
  await audit(env, who, b.remove ? "shift.unassign" : "shift.assign", t.number, { shift: id });
  return json({ ok: true });
}

/* ---- Erinnerungen an Helfer: 7 Tage vorher und am Partytag (je ab 10 Uhr) ---- */
function reminderHtml(s, t, kind, mine) {
  const url = `${APP_URL}ticket/?k=${t.view_key}#schichten`;
  const p = txt => `<p style="font-size:15px;line-height:1.6;color:#c9c9d1;margin:0 0 16px">${txt}</p>`;
  const list = mine.map(x => `<li style="margin:0 0 6px"><strong style="color:#f2f2f4">${esc(`${x.starts}–${x.ends || "Ende"}`)}</strong> · ${esc(x.spot || x.area)}</li>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30 · CREW</p>
<h1 style="font-weight:300;font-size:26px;margin:0 0 18px">${kind === "day" ? `Heute ist es so weit, ${esc(t.first_name)}!` : `In einer Woche geht's los, ${esc(t.first_name)}.`}</h1>
${mine.length ? `${p(`Deine Schicht${mine.length > 1 ? "en" : ""}:`)}<ul style="font-size:16px;line-height:1.5;color:#c9c9d1;margin:-8px 0 16px;padding-left:20px">${list}</ul>
${p(`Bitte sei <strong style="color:#f2f2f4">10 Minuten vor Schichtbeginn</strong> da. Einlass ab ${esc(s.doors_time)} Uhr – am Einlass bekommst du deine Marken.`)}`
  : p(`Du hast noch <strong style="color:#f2f2f4">keine Schicht</strong> gewählt – bitte such dir jetzt eine aus.`)}
${p(`Kannst du doch nicht? Dann melde dich bitte <strong style="color:#f2f2f4">sofort</strong> unter ${esc(s.helper_contact)}.`)}
<a href="${esc(url)}" style="display:block;background:#39ff14;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:6px 0 10px;font-size:15px;text-align:center;font-weight:bold">${mine.length ? "Ticket & Schicht öffnen" : "Schicht auswählen"}</a>
<p style="font-size:13px;line-height:1.6;color:#8a8a96;margin:18px 0 0">${esc(dateDe(s.event_date))} · ${esc(s.venue_name)} · ${esc(s.venue_address)}</p>
</div></body></html>`;
}
async function helperReminders(env, ms = nowMs()) {
  const s = await getSettings(env);
  const { date, hour } = berlinNow(ms);
  if (hour < 10 || date > s.event_date) return { sent: 0 };
  const kind = date === s.event_date ? "day" : date >= addDays(s.event_date, -7) ? "week" : null;
  if (!kind) return { sent: 0 };
  const list = await all(env, `SELECT * FROM tickets t WHERE category = 'helper' AND status = 'valid' AND is_test = 0 AND email IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM helper_reminders r WHERE r.ticket_id = t.id AND r.kind = ?) ORDER BY id LIMIT 25`, kind);
  let sent = 0;
  for (const t of list) {
    const claim = await run(env, `INSERT OR IGNORE INTO helper_reminders (ticket_id, kind, sent_at) VALUES (?, ?, ?)`, t.id, kind, iso());
    if (!changes(claim)) continue;
    const mine = (await all(env, `SELECT s.* FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.ticket_id = ?`, t.id)).sort(shiftSort);
    const r = await sendMail(env, t.email, kind === "day" ? "Heute: TAKT Nr. 30 – deine Schicht" : "TAKT Nr. 30: In einer Woche – deine Schicht", reminderHtml(s, t, kind, mine)).catch(e => ({ ok: false }));
    await run(env, `UPDATE helper_reminders SET ok = ? WHERE ticket_id = ? AND kind = ?`, r.ok ? 1 : 0, t.id, kind);
    if (r.ok) sent++;
  }
  return { sent };
}

function shiftMailHtml(s, t, v) {
  const url = `${APP_URL}ticket/?k=${t.view_key}#schichten`;
  const mine = v.shifts.filter(x => x.mine);
  const p = txt => `<p style="font-size:15px;line-height:1.6;color:#c9c9d1;margin:0 0 16px">${txt}</p>`;
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30 · CREW</p>
<h1 style="font-weight:300;font-size:26px;margin:0 0 18px">Hey ${esc(t.first_name)}, such dir deine Schicht${v.max > 1 ? "en" : ""} aus.</h1>
${p(`Danke, dass du am ${esc(dateDe(s.event_date))} hilfst (${esc(v.area)}). Du übernimmst <strong style="color:#f2f2f4">${v.max === 1 ? "eine Schicht (rund 3 Stunden)" : `${v.max} Schichten`}</strong>${v.max > 1 ? " – nie direkt hintereinander, damit du dazwischen feiern kannst" : ""}.`)}
${p(`Dafür ist dein <strong style="color:#f2f2f4">Eintritt frei</strong>, du bekommst <strong style="color:#f2f2f4">${HELPER_DRINKS} Getränkemarken und deinen eigenen TAKT-Becher</strong> – Wasser gibt es den ganzen Abend gratis. Den Rest der Nacht feierst du einfach mit.`)}
${mine.length ? p(`Schon eingetragen: ${mine.map(x => esc(`${x.starts}–${x.ends || "Ende"}${x.spot && x.spot !== v.area ? " " + x.spot : ""}`)).join(", ")}`) : ""}
<a href="${esc(url)}" style="display:block;background:#39ff14;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:6px 0 10px;font-size:15px;text-align:center;font-weight:bold">${mine.length ? (v.max > 1 ? "Schichten ansehen" : "Schicht ansehen") : (v.max > 1 ? "Schichten auswählen" : "Schicht auswählen")}</a>
${v.recruit?.url && v.recruit.open ? `<div style="border:1px solid #33333d;border-radius:6px;padding:16px 18px;margin:22px 0 0;background:#111116">
<p style="letter-spacing:3px;font-size:12px;color:#39ff14;margin:0 0 8px">WIR SUCHEN NOCH HELFER</p>
<p style="font-size:15px;line-height:1.6;color:#f2f2f4;margin:0 0 10px">Du kennst Leute, die auch helfen würden? Dann schick ihnen diesen Link. Darüber können sie sich nur als Helfer eintragen – Tickets gibt es darüber nicht.</p>
<p style="font-size:15px;margin:0"><a href="${esc(v.recruit.url)}" style="color:#39ff14">${esc(v.recruit.url)}</a></p></div>` : ""}
<p style="font-size:13px;line-height:1.6;color:#8a8a96;margin:18px 0 0">Wer zuerst kommt, wählt zuerst. Mit der Wahl sagst du verbindlich zu: 10 Minuten vor Schichtbeginn da sein – und wenn's nicht klappt, bis ${SHIFT_DROP_DAYS} Tage vorher austragen oder unter ${esc(s.helper_contact)} melden. Fragen? ${esc(s.helper_contact)}</p>
</div></body></html>`;
}

async function sendShiftMail(env, ticket) {
  const s = await getSettings(env);
  const v = await shiftView(env, ticket);
  return sendMail(env, ticket.email, "TAKT Nr. 30: Such dir deine Schicht aus", shiftMailHtml(s, ticket, v));
}

/* ================= E-Mail (Resend) ================= */

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dateDe = d => { const [y, m, dd] = String(d).split("-"); return `${dd}.${m}.${y}`; };

function vipBlock(vip, total) {
  const who = total > 1 && vip.length < total ? ` für ${vip.map(v => esc(v.name)).join(" und ")}` : "";
  return `<div style="border:1px solid #9d4dff;border-radius:6px;padding:16px 18px;margin:0 0 22px;background:#16101f">
<p style="letter-spacing:3px;font-size:12px;color:#b98cff;margin:0 0 8px">VIP${who.toUpperCase()}</p>
<p style="font-size:15px;line-height:1.6;color:#f2f2f4;margin:0">Am Einlass bekommst du dein <strong>lila VIP-Bändchen</strong>, einen <strong>Begrüßungsshot</strong> und <strong>${VIP_DRINKS} Getränkemarken</strong> – einzulösen an jeder Bar für ein Getränk deiner Wahl.</p></div>`;
}

function mailHtml(s, intro, rows, extra = "") {
  return `<!doctype html><html><body style="margin:0;background:#0a0a0c;color:#f2f2f4;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:32px 24px">
<p style="letter-spacing:4px;font-size:13px;color:#b98cff;margin:0 0 6px">TAKT NR. 30</p>
<h1 style="font-weight:300;font-size:26px;margin:0 0 18px">${esc(intro)}</h1>
<p style="font-size:15px;line-height:1.6;color:#c9c9d1;margin:0 0 22px">${esc(dateDe(s.event_date))} · Einlass ab ${esc(s.doors_time)} · Beginn ${esc(s.start_time)}<br>${esc(s.venue_name)}<br>${esc(s.venue_address)}</p>
${extra}${rows.map(r => `<a href="${esc(r.url)}" style="display:block;background:#9d4dff;color:#0a0a0c;text-decoration:none;padding:14px 18px;border-radius:4px;margin:0 0 10px;font-size:15px">${r.vip ? "VIP-" : ""}Ticket ${esc(r.number)} · ${esc(r.name)} öffnen</a>`).join("")}
<p style="font-size:13px;line-height:1.6;color:#8a8a96;margin:22px 0 0">Auf der Ticketseite kannst du dein Ticket als PDF speichern. Jeder QR-Code ist persönlich und nur einmal gültig. Geschlossene Gesellschaft – ohne Ticket kein Einlass.</p>
<p style="font-size:14px;line-height:1.6;color:#f2f2f4;margin:14px 0 0"><strong>Einlass erst ab 18 – bitte Ausweis mitbringen.</strong></p>
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
  const tickets = await all(env, `SELECT number, first_name, last_name, view_key, tier FROM tickets WHERE order_id = ? AND status != 'cancelled' ORDER BY guest_position`, orderId);
  const rows = tickets.map(t => ({ number: t.number, name: `${t.first_name} ${t.last_name}`, url: `${APP_URL}ticket/?k=${t.view_key}`, vip: t.tier === "vip" }));
  const vip = rows.filter(r => r.vip);
  const subject = vip.length === rows.length && vip.length ? `Dein VIP-Ticket für TAKT Nr. 30` : vip.length ? "Deine Tickets für TAKT Nr. 30 (inkl. VIP)" : "Dein Ticket für TAKT Nr. 30";
  const intro = vip.length ? (rows.length > 1 && vip.length === rows.length ? "Ihr seid VIP." : vip.length === rows.length ? "Du bist VIP." : "Ihr seid dabei – mit VIP.") : rows.length > 1 ? "Ihr seid dabei." : "Du bist dabei.";
  const r = await sendMail(env, order.email, `${subject}${order.is_test ? " (TEST)" : ""}`, mailHtml(s, intro, rows, vip.length ? vipBlock(vip, rows.length) : ""));
  await run(env, `UPDATE orders SET mail_status = ?, mail_error = ?, mail_sent_at = CASE WHEN ? THEN ? ELSE mail_sent_at END WHERE id = ?`,
    r.ok ? "sent" : "failed", r.ok ? null : r.error, r.ok ? 1 : 0, iso(), orderId);
  return r.ok ? "sent" : "failed";
}

async function sendTicketMail(env, ticket) {
  const s = await getSettings(env);
  const r = await sendMail(env, ticket.email, ticket.helper_job ? "Dein Helfer-Ticket für TAKT Nr. 30" : "Dein Ticket für TAKT Nr. 30",
    mailHtml(s, ticket.helper_job ? `Danke fürs Helfen – ${ticket.helper_job}.` : "Du bist dabei.", [{ number: ticket.number, name: `${ticket.first_name} ${ticket.last_name}`, url: `${APP_URL}ticket/?k=${ticket.view_key}` }],
      ticket.helper_job ? `<div style="border:1px solid #39ff14;border-radius:6px;padding:16px 18px;margin:0 0 22px;background:#0f1a0c"><p style="letter-spacing:3px;font-size:12px;color:#39ff14;margin:0 0 8px">CREW</p><p style="font-size:15px;line-height:1.6;color:#f2f2f4;margin:0">Dein Eintritt ist frei, am Einlass bekommst du <strong>${HELPER_DRINKS} Getränkemarken und deinen TAKT-Becher</strong> gratis, Wasser ist gratis. Deine Schicht wählst du auf deiner Ticketseite unter <strong>„Deine Schicht“</strong>.</p></div>` : ""));
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
async function paypalCreateOrder(env, { orderNo, amount, quantity, vipQty = 0 }) {
  const itemName = quantity === 2
    ? (vipQty === 2 ? "TAKT Nr. 30 – 2 VIP-Tickets" : vipQty === 1 ? "TAKT Nr. 30 – 1 Ticket + 1 VIP-Ticket" : "TAKT Nr. 30 – 2 Tickets")
    : (vipQty ? "TAKT Nr. 30 – VIP-Ticket" : "TAKT Nr. 30 – Ticket");
  const value = euro(amount);
  const r = await paypalFetch(env, "/v2/checkout/orders", {
    requestId: `create-${orderNo}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: orderNo, custom_id: orderNo, invoice_id: orderNo,
        description: "TAKT Nr. 30 – Ticket",
        amount: { currency_code: "EUR", value, breakdown: { item_total: { currency_code: "EUR", value } } },
        items: [{ name: itemName, quantity: "1", category: "DIGITAL_GOODS", unit_amount: { currency_code: "EUR", value } }]
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
  return cap ? { id: cap.id, status: cap.status, amount: Math.round(Number(cap.amount?.value) * 100), currency: cap.amount?.currency_code, custom_id: cap.custom_id || unit?.custom_id, fee: feeOf(cap) } : null;
}
function feeOf(cap) {
  const v = cap?.seller_receivable_breakdown?.paypal_fee?.value;
  return v == null || !isFinite(Number(v)) ? null : Math.round(Number(v) * 100);
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
  const result = await settleOrder(env, order, { ref: cap.id, capture_id: cap.id, amount: cap.amount, currency: cap.currency, fee: cap.fee }, ctx);
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
      const r = await settleOrder(env, order, { ref: res.id, capture_id: res.id, amount: Math.round(Number(res.amount?.value) * 100), currency: res.amount?.currency_code, fee: feeOf(res) }, ctx);
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
  const t = await first(env, `SELECT id, number, category, tier, helper_job, first_name, last_name, status, checked_in_at, checked_in_by, is_test, paper, order_id, extra_drinks, extra_food FROM tickets WHERE code = ?`, code);
  if (!t) {
    const old = await first(env, `SELECT t.number, t.first_name, t.last_name FROM retired_codes r JOIN tickets t ON t.id = r.ticket_id WHERE r.code = ?`, code);
    await log(null, old ? "replaced" : "unknown", code);
    return json(old ? { result: "red", reason: "Ersetzter QR-Code – ungültig", number: old.number, name: `${old.first_name || ""} ${old.last_name || ""}`.trim() } : { result: "red", reason: "QR-Code unbekannt" });
  }
  const s = await getSettings(env);
  const kind = ticketKind(t);
  const shifts = t.category === "helper" ? await shiftLine(env, t.id) : undefined;
  const base = { number: t.number, category: t.category, tier: t.tier, ...kind, band_info: bandInfo(s, kind.band), helper_job: t.helper_job, shifts, brief: t.category === "helper" ? helperBrief(shifts, bandInfo(s, "helper"), kind, s.helper_contact) : undefined, name: `${t.first_name || ""} ${t.last_name || ""}`.trim() || (t.category === "free" ? "VIP · 2TAKT" : t.paper ? "Freiticket" : "") };
  if (t.status === "blocked") { await log(t.id, "blocked"); return json({ ...base, result: "red", reason: "Ticket gesperrt" }); }
  if (t.status === "cancelled") { await log(t.id, "cancelled"); return json({ ...base, result: "red", reason: "Ticket storniert" }); }
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
  const rows = await all(env, `SELECT id, number, category, tier, paper, order_id, helper_job, first_name, last_name, status, checked_in_at, checked_in_by, is_test, extra_drinks, extra_food FROM tickets
     WHERE (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') LIKE ? OR number LIKE ?) ORDER BY last_name IS NULL, last_name, first_name, number LIMIT 25`, like, like);
  return json(rows.map(({ paper, order_id, extra_drinks, extra_food, ...r }) => ({ ...r, ...ticketKind({ ...r, paper, order_id, extra_drinks, extra_food }) })));
}

async function manualCheckin(env, who, id) {
  const at = iso();
  const r = await run(env, `UPDATE tickets SET checked_in_at = ?, checked_in_by = ?, updated_at = ? WHERE id = ? AND status = 'valid' AND checked_in_at IS NULL`, at, `${who.name} (manuell)`, at, id);
  await run(env, `INSERT INTO checkins (ticket_id, action, result, actor, at) VALUES (?, 'manual', ?, ?, ?)`, id, changes(r) ? "admitted" : "rejected", who.name, at);
  if (!changes(r)) return fail("Nicht möglich – Ticket ist bereits eingecheckt, gesperrt oder storniert.", 409);
  const t = await first(env, `SELECT id, category, tier, paper, order_id, helper_job, extra_drinks, extra_food FROM tickets WHERE id = ?`, id);
  const kind = t ? ticketKind(t) : {};
  const set = await getSettings(env);
  const shifts = t?.category === "helper" ? await shiftLine(env, t.id) : undefined;
  return json({ result: "green", checked_in_at: at, category: t?.category, ...kind, band_info: t ? bandInfo(set, kind.band) : undefined, shifts, brief: t?.category === "helper" ? helperBrief(shifts, bandInfo(set, "helper"), kind, set.helper_contact) : undefined });
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
  const [c, s] = await Promise.all([counts(env), getSettings(env)]);
  let bands = {}; try { bands = JSON.parse(s.bands); } catch {}
  const recent = await all(env, `SELECT c.at, c.result, c.actor, t.number, t.first_name, t.last_name FROM checkins c LEFT JOIN tickets t ON t.id = c.ticket_id ORDER BY c.id DESC LIMIT 15`);
  return json({ checked_in: c.checked_in, expected: c.expected, recent, bands });
}

// Kim gibt einem ausgegebenen Ticket (auch Papier) Getränkemarken oder Essen dazu – absolute Werte
async function setExtras(env, request, who) {
  const b = await readJson(request) || {};
  const number = String(b.number || "").trim().toUpperCase();
  const t = await first(env, `SELECT id, number, status, extra_drinks, extra_food, food_used, checked_in_at FROM tickets WHERE number = ?`, number);
  if (!t) return fail("Ticket mit dieser Nummer nicht gefunden.", 404);
  if (t.status === "cancelled") return fail("Stornierte Tickets lassen sich nicht ändern.", 409);
  const d = Number(b.drinks), f = Number(b.food);
  if (!Number.isInteger(d) || !Number.isInteger(f) || d < 0 || f < 0 || d > 20 || f > 5) return fail("Getränke 0–20, Essen 0–5.");
  if (f < t.food_used) return fail(`Es wurde schon ${t.food_used}× gegessen – weniger geht nicht.`, 409);
  await run(env, `UPDATE tickets SET extra_drinks = ?, extra_food = ?, updated_at = ? WHERE id = ?`, d, f, iso(), t.id);
  await audit(env, who, "ticket.extras", t.number, { drinks: d, food: f });
  return json({ ok: true, checked_in: !!t.checked_in_at });
}

/* ================= Essen am Foodtruck (nur wenn Kim es einem Ticket dazugibt) ================= */
async function foodGive(env, who, id, viaCode) {
  const t = await first(env, `SELECT id, number, category, helper_job, first_name, last_name, status, food_at, food_by, food_used, extra_food FROM tickets WHERE id = ?`, id);
  if (!t) return json({ result: "red", food: true, reason: "Ticket nicht gefunden" });
  const allowed = Number(t.extra_food) || 0;
  const base = { food: true, number: t.number, name: `${t.first_name || ""} ${t.last_name || ""}`.trim(), kind: t.helper_job ? `Helfer · ${t.helper_job}` : t.category === "helper" ? "Helfer" : t.category === "free" ? "VIP · 2TAKT" : "Gast", allowed };
  if (!allowed) return json({ ...base, result: "red", reason: "Kein Essen hinterlegt – nur gegen Bezahlung" });
  if (t.status !== "valid") return json({ ...base, result: "red", reason: t.status === "blocked" ? "Ticket gesperrt" : "Ticket storniert" });
  const at = iso();
  const r = await run(env, `UPDATE tickets SET food_used = food_used + 1, food_at = ?, food_by = ?, updated_at = ? WHERE id = ? AND status = 'valid' AND food_used < ?`, at, who.name + (viaCode ? "" : " (manuell)"), at, t.id, allowed);
  await run(env, `INSERT INTO checkins (ticket_id, action, result, actor, at) VALUES (?, 'food', ?, ?, ?)`, t.id, changes(r) ? "food" : "food_again", who.name, at);
  const now = await first(env, `SELECT food_at, food_by, food_used FROM tickets WHERE id = ?`, t.id);
  if (changes(r)) return json({ ...base, result: "green", food_at: at, used: now.food_used, left: allowed - now.food_used });
  return json({ ...base, result: "red", reason: allowed > 1 ? `Hat schon ${allowed}× gegessen` : "Hat schon gegessen", food_at: now.food_at, food_by: now.food_by, used: now.food_used });
}
async function foodScan(env, request, who) {
  const body = await readJson(request);
  const raw = String(body?.code || "").trim();
  const code = cleanCode(raw.startsWith(CODE_PREFIX) ? raw.slice(CODE_PREFIX.length) : raw, 40);
  const t = code.length >= 20 ? await first(env, `SELECT id FROM tickets WHERE code = ?`, code) : null;
  if (!t) return json({ result: "red", food: true, reason: "QR-Code unbekannt" });
  return foodGive(env, who, t.id, true);
}
async function foodSearch(env, url) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 40);
  if (q.length < 2) return json([]);
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return json(await all(env, `SELECT id, number, category, helper_job, first_name, last_name, status, food_at, food_used,
      extra_food AS allowed FROM tickets
    WHERE extra_food > 0 AND status != 'cancelled' AND (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '') LIKE ? OR number LIKE ?) ORDER BY first_name LIMIT 25`, like, like));
}
async function foodStats(env) {
  const c = await first(env, `SELECT SUM(extra_food) AS helpers, SUM(food_used) AS eaten FROM tickets WHERE status = 'valid' AND extra_food > 0`);
  const recent = await all(env, `SELECT c.at, c.result, c.actor, t.number, t.first_name, t.last_name FROM checkins c LEFT JOIN tickets t ON t.id = c.ticket_id WHERE c.action = 'food' ORDER BY c.id DESC LIMIT 15`);
  return json({ mode: "food", eaten: c.eaten || 0, helpers: c.helpers || 0, recent });
}

/* ================= Admin ================= */

async function dashboard(env) {
  const [c, s] = await Promise.all([counts(env), getSettings(env)]);
  const group = await ensureGroupInvite(env);
  await paperSetup(env, { actor: "system", name: "System" });
  const invites = await first(env, `SELECT COUNT(*) AS total, SUM(status = 'active') AS active FROM invitations WHERE kind = 'personal'`);
  return json({ counts: c, invites, group_link: { id: group.id, url: `${APP_URL}?e=${group.code}`, status: group.status }, sale_mode: s.sale_mode, paypal_ready: paypalConfigured(env), paypal_env: env.PAYPAL_ENV === "live" ? "live" : "sandbox", test_allowed: env.ALLOW_TEST_PAYMENTS === "true", mail_ready: !!(env.RESEND_API_KEY && env.MAIL_FROM), turnstile_ready: !!(env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY) });
}

async function listInvitations(env) {
  const t = nowMs();
  await ensureGroupInvite(env);
  return json(await all(env, `SELECT i.id, i.code, i.name, i.note, i.max_tickets, i.status, i.kind, i.created_at, i.referred_by, ref.name AS referred_by_name,
      (SELECT COUNT(*) FROM tickets tk WHERE tk.invitation_id = i.id AND tk.status != 'cancelled')
        + (SELECT COUNT(*) FROM tickets tk JOIN orders o ON o.id = tk.order_id WHERE o.invitation_id = i.id AND tk.invitation_id IS NULL AND tk.status != 'cancelled') AS issued,
      (SELECT GROUP_CONCAT(helper_job, ', ') FROM tickets tk WHERE tk.invitation_id = i.id AND tk.helper_job IS NOT NULL AND tk.status != 'cancelled') AS helper_job,
      (SELECT COALESCE(SUM(quantity), 0) FROM reservations WHERE invitation_id = i.id AND state = 'active' AND expires_at > ?) AS reserved
    FROM invitations i LEFT JOIN invitations ref ON ref.id = i.referred_by WHERE i.kind != 'crew' ORDER BY i.kind = 'group' DESC, i.created_at DESC, i.id DESC`, t));
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
  if (b.new_code === true) {
    // Neuer Code für den Link: alter Link wird ungültig, Käufe/Limits hängen an der ID und bleiben erhalten
    if (who.role !== "main") return fail("Nur der Hauptadministrator darf den Link erneuern.", 403);
    for (let i = 0; i < 5; i++) {
      const code = randomCode(8);
      const r = await run(env, `UPDATE OR IGNORE invitations SET code = ?, updated_at = ? WHERE id = ?`, code, iso(), id);
      if (changes(r)) {
        await audit(env, who, "invitation.new_code", code, { old: inv.code });
        return json({ ok: true, code, url: `${APP_URL}?e=${code}` });
      }
    }
    return fail("Code konnte nicht erzeugt werden – bitte erneut versuchen.", 500);
  }
  const next = {
    name: b.name != null ? cleanName(b.name) : inv.name,
    note: b.note != null ? String(b.note).slice(0, 300) : inv.note,
    max_tickets: b.max_tickets != null ? Number(b.max_tickets) : inv.max_tickets,
    status: b.status != null ? String(b.status) : inv.status
  };
  if (!next.name || next.name.length > 80) return fail("Name ungültig.");
  if (![1, 2].includes(next.max_tickets)) return fail("Erlaubt sind 1 oder 2 Tickets.");
  if (inv.kind === "group") next.max_tickets = MAX_PER_INVITE;
  if (!["active", "disabled"].includes(next.status)) return fail("Status ungültig.");
  await run(env, `UPDATE invitations SET name = ?, note = ?, max_tickets = ?, status = ?, updated_at = ? WHERE id = ?`, next.name, next.note, next.max_tickets, next.status, iso(), id);
  await audit(env, who, "invitation.update", inv.code, next);
  return json({ ok: true });
}

async function listTickets(env, url) {
  const cat = url.searchParams.get("category");
  // Papiertickets haben dieselbe Online-Ansicht (gleicher QR-Code) – eigene Liste unter „Papiertickets“
  const where = cat === "paper" ? "WHERE t.paper = 1" : ["free", "regular", "helper"].includes(cat) ? `WHERE t.paper = 0 AND t.category = '${cat}'` : "WHERE t.paper = 0";
  return json(await all(env, `SELECT t.id, t.number, t.category, t.tier, t.helper_job, hi.name AS helper_invitation, t.first_name, t.last_name, t.email, t.status, t.is_test, t.checked_in_at, t.checked_in_by, t.view_key, t.version, t.mail_status, t.note, t.created_at, t.extra_drinks, t.extra_food, t.food_used, t.food_at, t.paper,
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

// Papiertickets: 30 VIP (2TAKT) + 20 eigene Freitickets – beide zusätzlich zu den 60 online. Idempotent.
const PAPER_VIP_TOTAL = 50, PAPER_OWN_TOTAL = 50; // gedruckt (Mindestmenge der Druckerei 100), alle sofort gültig
const PAPER_VIP = PAPER_VIP_TOTAL, PAPER_OWN = PAPER_OWN_TOTAL;
async function paperSetup(env, who) {
  const t = nowMs();
  await run(env, `UPDATE tickets SET paper = 1, updated_at = ? WHERE category = 'free' AND status != 'cancelled' AND paper = 0`, iso(t));
  // Alle Papiertickets sind gültig (Sperren nur einzeln bei Verlust)
  for (let i = 0; i < PAPER_VIP_TOTAL; i++) {
    const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, status, is_test, paper, note, created_at, updated_at)
      SELECT printf('2T-%02d', COALESCE((SELECT MAX(CAST(substr(number, 4) AS INTEGER)) FROM tickets WHERE category = 'free'), 0) + 1), 'free', ?, ?,
        CASE WHEN (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') < ? THEN 'valid' ELSE 'blocked' END, 0, 1,
        CASE WHEN (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') < ? THEN 'VIP (Papier)' ELSE 'VIP (Papier)' END, ?, ?
      WHERE (SELECT COUNT(*) FROM tickets WHERE category = 'free' AND status != 'cancelled') < ?`, randomCode(26), randomCode(26), PAPER_VIP, PAPER_VIP, iso(t), iso(t), PAPER_VIP_TOTAL);
    if (!changes(r)) break;
  }
  for (let i = 0; i < PAPER_OWN_TOTAL; i++) {
    const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, status, is_test, paper, note, created_at, updated_at)
      SELECT printf('FK-%02d', COALESCE((SELECT MAX(CAST(substr(number, 4) AS INTEGER)) FROM tickets WHERE number LIKE 'FK-%'), 0) + 1), 'regular', ?, ?,
        CASE WHEN (SELECT COUNT(*) FROM tickets WHERE number LIKE 'FK-%' AND status != 'cancelled') < ? THEN 'valid' ELSE 'blocked' END, 0, 1,
        CASE WHEN (SELECT COUNT(*) FROM tickets WHERE number LIKE 'FK-%' AND status != 'cancelled') < ? THEN 'Freiticket Kim (Papier)' ELSE 'Freiticket Kim (Papier)' END, ?, ?
      WHERE (SELECT COUNT(*) FROM tickets WHERE number LIKE 'FK-%' AND status != 'cancelled') < ?`, randomCode(26), randomCode(26), PAPER_OWN, PAPER_OWN, iso(t), iso(t), PAPER_OWN_TOTAL);
    if (!changes(r)) break;
  }
  const c = await counts(env);
  if (paperSetup.last !== `${c.paper_vip}/${c.paper_own}`) {
    const prev = await first(env, `SELECT detail FROM audit_logs WHERE action = 'paper.setup' ORDER BY id DESC LIMIT 1`);
    const now = JSON.stringify({ vip: c.paper_vip, own: c.paper_own });
    if (!prev || prev.detail !== now) await audit(env, who, "paper.setup", null, { vip: c.paper_vip, own: c.paper_own });
    paperSetup.last = `${c.paper_vip}/${c.paper_own}`;
  }
  return c;
}
async function paperList(env, who) {
  const c = await paperSetup(env, who);
  const rows = await all(env, `SELECT number, category, code, status, checked_in_at, first_name, last_name, sold_cents, sold_at, sold_via, extra_drinks, extra_food, food_used FROM tickets WHERE paper = 1 AND status != 'cancelled' ORDER BY category DESC, number`);
  return json({ vip: rows.filter(r => r.category === "free"), own: rows.filter(r => r.category === "regular"), counts: c, prices: PAPER_PRICE, event: eventForTicket(await getSettings(env)) });
}

// Reserve-Papierticket verkauft (bar oder PayPal an Kim) – zählt als Eintritt für Abrechnung und GEMA
async function paperSell(env, request, who) {
  const b = await readJson(request) || {};
  const number = String(b.number || "").trim().toUpperCase();
  const t = await first(env, `SELECT id, category, sold_cents FROM tickets WHERE paper = 1 AND number = ? AND status != 'cancelled'`, number);
  if (!t) return fail("Papierticket mit dieser Nummer nicht gefunden.", 404);
  if (b.undo) {
    await run(env, `UPDATE tickets SET sold_cents = NULL, sold_at = NULL, sold_via = NULL, updated_at = ? WHERE id = ?`, iso(), t.id);
    await audit(env, who, "paper.sell_undo", number, {});
    return json({ ok: true, number, sold: false });
  }
  if (t.sold_cents != null) return fail(`${number} ist schon als verkauft eingetragen.`, 409);
  const cents = b.price != null && b.price !== "" ? Math.round(Number(String(b.price).replace(",", ".")) * 100) : PAPER_PRICE[t.category];
  if (!(cents >= 0) || cents > 100000) return fail("Preis ungültig.");
  const via = b.via === "paypal" ? "paypal" : "bar";
  const fn = b.first_name ? cleanName(b.first_name) : null, ln = b.last_name ? cleanName(b.last_name) : null;
  if ((fn || ln) && (!nameOk(fn) || !nameOk(ln))) return fail("Bitte Vor- und Nachnamen vollständig angeben oder beides leer lassen.");
  await run(env, `UPDATE tickets SET sold_cents = ?, sold_at = ?, sold_via = ?, first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), updated_at = ? WHERE id = ?`,
    cents, iso(), via, fn, ln, iso(), t.id);
  await audit(env, who, "paper.sell", number, { price: euro(cents), via });
  return json({ ok: true, number, sold_cents: cents, via });
}
async function paperBlock(env, request, who) {
  const b = await readJson(request) || {};
  const number = String(b.number || "").trim().toUpperCase();
  const t = await first(env, `SELECT id, status FROM tickets WHERE paper = 1 AND number = ?`, number);
  if (!t) return fail("Papierticket mit dieser Nummer nicht gefunden.", 404);
  const status = b.unblock ? "valid" : "blocked";
  await run(env, `UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status != 'cancelled'`, status, iso(), t.id);
  await audit(env, who, b.unblock ? "paper.unblock" : "paper.block", number, {});
  return json({ ok: true, number, status });
}

// Kostenloses Ticket aus dem Online-Kontingent (zählt zu den 60, kein Umsatz)
async function createCompTicket(env, request, who) {
  const b = await readJson(request) || {};
  const fn = cleanName(b.first_name), ln = cleanName(b.last_name);
  if (!nameOk(fn) || !nameOk(ln)) return fail("Bitte Vor- und Nachnamen angeben.");
  const email = b.email ? String(b.email).trim().toLowerCase() : null;
  if (email && !emailOk(email)) return fail("E-Mail-Adresse ungültig.");
  const invId = b.invitation_id ? Number(b.invitation_id) : null;
  const inv = invId ? await first(env, `SELECT id, kind FROM invitations WHERE id = ?`, invId) : null;
  if (invId && !inv) return fail("Einladung nicht gefunden.");
  if (inv && inv.kind === "group") return fail("Ein Ticket lässt sich nur einer persönlichen Einladung zuordnen.");
  const holder = inv ? holderOf(inv) : null;
  const t = nowMs();
  const r = await run(env, `INSERT INTO tickets (number, category, code, view_key, invitation_id, holder, first_name, last_name, email, status, is_test, note, created_at, updated_at)
    SELECT printf('T30-%03d', COALESCE((SELECT MAX(CAST(substr(number, 5) AS INTEGER)) FROM tickets WHERE category = 'regular' AND number LIKE 'T30-%'), 0) + 1), 'regular', ?, ?, ?, ?, ?, ?, ?, 'valid', 0, 'kostenlos (Admin)', ?, ?
    WHERE ${SQL_REGULAR_TAKEN()} + 1 <= ?
      AND (? IS NULL OR ${SQL_USED} + 1 <= ${SQL_LIMIT})`,
    randomCode(26), randomCode(26), invId, holder, fn, ln, email, iso(t), iso(t), t, REGULAR_CAP, holder, holder, holder, t, invId);
  if (!changes(r)) {
    const c = await counts(env);
    return c.available <= 0 ? fail(`Alle ${REGULAR_CAP} Online-Plätze sind vergeben.`, 409, "SOLD_OUT") : fail("Diese Einladung hat schon 2 Plätze.", 409, "INVITE_EXHAUSTED");
  }
  const ticket = await first(env, `SELECT * FROM tickets WHERE id = ?`, r.meta.last_row_id);
  await audit(env, who, "ticket.comp", ticket.number, { first_name: fn, last_name: ln, invitation_id: invId });
  let mail = null;
  if (email && b.send_mail) mail = (await sendTicketMail(env, ticket)).ok ? "sent" : "failed";
  return json({ id: ticket.id, number: ticket.number, view_key: ticket.view_key, mail }, 201);
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
    await env.DB.batch([
      env.DB.prepare(`UPDATE tickets SET status = 'cancelled', updated_at = ? WHERE id = ?`).bind(iso(), id),
      env.DB.prepare(`DELETE FROM shift_assignments WHERE ticket_id = ?`).bind(id),
      env.DB.prepare(`UPDATE invitations SET status = 'disabled', updated_at = ? WHERE kind = 'crew' AND owner_ticket = ?`).bind(iso(), id)
    ]);
  } else if (action === "note") {
    await run(env, `UPDATE tickets SET note = ?, updated_at = ? WHERE id = ?`, String(b.note || "").slice(0, 300), iso(), id);
  } else if (action === "mail") {
    const fresh = await first(env, `SELECT * FROM tickets WHERE id = ?`, id);
    if (!fresh.email || !fresh.first_name) return fail("Für dieses Ticket ist keine E-Mail-Adresse oder kein Name hinterlegt.");
    if (fresh.order_id) { const r = await sendOrderMail(env, fresh.order_id); await audit(env, who, "ticket.mail", t.number, { r }); return r === "sent" ? json({ ok: true }) : fail("Versand fehlgeschlagen. Mailversand prüfen.", 502); }
    const r = await sendTicketMail(env, fresh);
    await audit(env, who, "ticket.mail", t.number, { ok: r.ok });
    return r.ok ? json({ ok: true }) : fail(r.error || "Versand fehlgeschlagen.", 502);
  } else if (action === "shift_mail") {
    if (t.category !== "helper" || t.status !== "valid") return fail("Nur für gültige Helfer-Tickets.", 409);
    if (!t.email || !t.first_name) return fail("Für dieses Ticket ist keine E-Mail-Adresse hinterlegt.");
    const r = await sendShiftMail(env, t);
    await audit(env, who, "ticket.shift_mail", t.number, { ok: r.ok });
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
      // Bild nur aus dem eigenen Ordner /taktnr30/assets/lineup/ (kein fremder Link)
      // Hörprobe: nur https-Links, Tracking-Parameter (?si=…) fliegen raus
      const linkOk = v => { try { const u = new URL(String(v || "").trim()); if (u.protocol !== "https:" || u.href.length > 200) return null; u.search = ""; u.hash = ""; return u.href.replace(/\/intl-[a-z]{2}\//, "/"); } catch { return null; } };
      const imgOk = v => /^\/taktnr30\/assets\/lineup\/[a-z0-9_-]{1,40}\.(webp|png|jpg)$/.test(String(v || ""));
      list = list.map(x => ({ name: cleanName(x?.name).slice(0, 60), time: String(x?.time || "").slice(0, 20), note: String(x?.note || "").slice(0, 80), ...(imgOk(x?.img) ? { img: x.img } : {}), ...(linkOk(x?.link) ? { link: linkOk(x.link) } : {}) })).filter(x => x.name);
      val = JSON.stringify(list);
    }
    if (k === "helper_jobs") {
      let list; try { list = JSON.parse(val); } catch { return fail("Helfer-Aufgaben ungültig."); }
      if (!Array.isArray(list) || list.length > 15) return fail("Helfer-Aufgaben ungültig.");
      list = list.map(x => ({ name: cleanName(x?.name).slice(0, 40), slots: Math.min(Math.max(Number(x?.slots) || 0, 0), HELPER_CAP_MAX), info: String(x?.info || "").slice(0, 120), shifts: Math.min(Math.max(Number(x?.shifts) || 1, 1), SHIFT_MAX_PER_PERSON) })).filter(x => x.name);
      val = JSON.stringify(list);
    }
    if ((k === "helper_signup" || k === "shifts_open") && !["0", "1"].includes(val)) return fail("Wert ungültig.");
    if (k === "bands") {
      let b; try { b = JSON.parse(val); } catch { return fail("Bändchen ungültig."); }
      const clean = {};
      for (const cat of ["regular", "free", "vip", "helper"]) {
        const x = b?.[cat] || {};
        const color = /^#[0-9a-fA-F]{6}$/.test(x.color || "") ? x.color : "#ffffff";
        clean[cat] = { label: cleanName(x.label).slice(0, 20) || "–", color, note: String(x.note || "").slice(0, 60) };
      }
      val = JSON.stringify(clean);
    }
    if (k === "helper_cap") {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0 || n > HELPER_CAP_MAX) return fail(`Helferplätze: 0 bis ${HELPER_CAP_MAX}.`);
      const used = (await first(env, `SELECT COUNT(*) AS n FROM tickets WHERE category = 'helper' AND status != 'cancelled'`)).n;
      if (n < used) return fail(`Es sind schon ${used} Helfer eingetragen – weniger Plätze geht nicht.`, 409);
    }
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
      env.DB.prepare(`DELETE FROM shift_assignments WHERE ticket_id IN (SELECT id FROM tickets WHERE is_test = 1)`),
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

// Alles zurücksetzen (vor dem echten Verkauf): löscht Online-/Helfer-Tickets, Bestellungen und persönlichen Einladungen. Papiertickets bleiben.
async function resetAll(env, request, who) {
  const b = await readJson(request) || {};
  if (b.confirm !== "ALLES LÖSCHEN") return fail("Bitte zur Bestätigung ALLES LÖSCHEN eingeben.");
  const real = await first(env, `SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND is_test = 0`);
  if (real.n) return fail(`Es gibt ${real.n} echte, bezahlte Bestellungen – Zurücksetzen ist gesperrt.`, 409);
  await env.DB.batch([
    // Papiertickets sind gedruckt – sie bleiben immer erhalten (nur ihre Check-ins werden zurückgesetzt)
    `DELETE FROM checkins`, `DELETE FROM retired_codes WHERE ticket_id NOT IN (SELECT id FROM tickets WHERE paper = 1)`,
    `UPDATE tickets SET checked_in_at = NULL, checked_in_by = NULL WHERE paper = 1`,
    `DELETE FROM shift_assignments`, `DELETE FROM tickets WHERE paper = 0`, `DELETE FROM reservations`,
    `DELETE FROM payments`, `DELETE FROM guests`, `DELETE FROM orders`, `DELETE FROM webhook_events`,
    `DELETE FROM invitations WHERE kind != 'group'`
  ].map(q => env.DB.prepare(q)));
  await audit(env, who, "reset.all", null, {});
  return json({ ok: true });
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
    env.DB.prepare(`UPDATE orders SET email = 'geloescht@invalid', buyer_first = 'Gast', buyer_last = '-', holder = 'anon'`),
    env.DB.prepare(`UPDATE tickets SET holder = 'anon' WHERE holder LIKE '%:%'`),
    env.DB.prepare(`UPDATE reservations SET holder = 'anon' WHERE holder LIKE '%:%'`),
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
  return json(await all(env, `SELECT id, name, mode, created_at, revoked_at, last_used_at FROM scanner_access ORDER BY id DESC`));
}
async function createScanner(env, request, who) {
  const b = await readJson(request) || {};
  const name = cleanName(b.name);
  if (!name || name.length > 40) return fail("Bitte einen Namen für den Einlasshelfer angeben.");
  const token = randomCode(32);
  const mode = b.mode === "food" ? "food" : "entry";
  const r = await run(env, `INSERT INTO scanner_access (name, token_hash, created_at, created_by, mode) VALUES (?, ?, ?, ?, ?)`, name, await sha256Hex(`scanner|${token}`), iso(), who.actor, mode);
  await audit(env, who, "scanner.create", r.meta.last_row_id, { name, mode });
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
    head = ["Bestellnummer", "Status", "Test", "Käufer", "E-Mail", "Anzahl", "Betrag €", "PayPal-Gebühr €", "Erstattet €", "Einladung", "Bestellt", "Bezahlt"];
    rows = (await all(env, `SELECT o.*, i.name AS inv,
        (SELECT SUM(fee_cents) FROM payments p WHERE p.order_id = o.id AND p.kind = 'capture') AS fee,
        (SELECT SUM(amount_cents) FROM payments p WHERE p.order_id = o.id AND p.kind = 'refund') AS refunded
      FROM orders o LEFT JOIN invitations i ON i.id = o.invitation_id WHERE o.status IN ('paid','refund_required','refunded') ORDER BY o.id`))
      .map(o => [o.order_no, o.status, o.is_test ? "ja" : "", `${o.buyer_first} ${o.buyer_last}`, o.email, o.quantity, euro(o.amount_cents).replace(".", ","), o.fee == null ? "" : euro(o.fee).replace(".", ","), o.refunded ? euro(o.refunded).replace(".", ",") : "", o.inv, o.created_at, o.paid_at]);
  } else if (kind === "ledger") {
    head = ["Datum", "Art", "Kategorie", "Wofür", "Firma/Person", "Beleg-Nr.", "Betrag €", "Notiz"];
    rows = (await all(env, `SELECT * FROM ledger ORDER BY booked_on, id`))
      .map(l => [l.booked_on, l.kind === "income" ? "Einnahme" : "Ausgabe", l.category, l.purpose, l.party, l.receipt_no, (l.kind === "income" ? "" : "-") + euro(l.amount_cents).replace(".", ","), l.note]);
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

/* ================= Unterschriften für Kim Betcher ================= */
const SIGNATURE_RECIPIENT = "kim.betcher@schwaebisch-hall.de";
const signatureCodeOk = code => /^\d{49}$/.test(String(code || ""));
const signatureHash = code => sha256Hex(`signature-link|${code}`);
function signatureCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return BigInt('0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')).toString().padStart(49, '0');
}
async function signatureBody(request) {
  // Bound the stream too: Content-Length alone is not trustworthy.
  if (!request.body) return null;
  const reader = request.body.getReader(), parts = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.length;
    if (length > 350000) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const data = new Uint8Array(length); let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { return null; }
}
function signaturePng(value) {
  if (typeof value !== 'string' || value.length > 300000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value)) return null;
  try {
    const b64 = value.split(',')[1], raw = atob(b64);
    if (raw.length < 100 || raw.slice(0, 8) !== '\x89PNG\r\n\x1a\n' || raw.slice(12, 16) !== 'IHDR' || raw.slice(-8, -4) !== 'IEND') return null;
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0)), v = new DataView(bytes.buffer);
    if (v.getUint32(8) !== 13 || v.getUint32(16) < 100 || v.getUint32(16) > 1600 || v.getUint32(20) < 50 || v.getUint32(20) > 800) return null;
    return b64;
  } catch { return null; }
}
async function cleanupSignatures(env) {
  await run(env, `UPDATE signature_requests SET png = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE png IS NOT NULL AND (expires_at <= ? OR signed_at <= ?)`, iso(), iso(), iso(nowMs() - 23 * 3600000));
}
async function listSignatureLinks(env) {
  return json(await all(env, `SELECT id, customer_name, purpose, expires_at, signed_at, sent_at, revoked_at, png IS NOT NULL AS pending FROM signature_requests ORDER BY id DESC LIMIT 100`));
}
async function createSignatureLink(env, request, who) {
  const b = await signatureBody(request);
  const name = String(b?.customer_name || '').trim(), purpose = String(b?.purpose || '').trim();
  if (!name || name.length > 120 || !purpose || purpose.length > 500 || /[\u0000-\u001f]/.test(name + purpose)) return fail('Bitte Name und Vorgang angeben (höchstens 120 bzw. 500 Zeichen).');
  if (!env.RESEND_API_KEY) return fail('Mailversand ist noch nicht eingerichtet.', 503);
  const code = signatureCode(), t = iso(), expires = iso(nowMs() + 7 * 86400000);
  const r = await run(env, `INSERT INTO signature_requests (code_hash, customer_name, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`, await signatureHash(code), name, purpose, t, expires);
  await audit(env, who, 'signature.create', r.meta.last_row_id, { expires_at: expires });
  return json({ id: r.meta.last_row_id, url: `${APP_ORIGIN}/unterschriften/${code}`, expires_at: expires }, 201);
}
async function getSignatureLink(env, code) {
  const row = signatureCodeOk(code) && await first(env, `SELECT customer_name, purpose, expires_at, signed_at, sent_at, revoked_at, png IS NOT NULL AS pending FROM signature_requests WHERE code_hash = ?`, await signatureHash(code));
  if (!row || row.revoked_at || row.expires_at <= iso()) return fail('Dieser Unterschriftslink ist ungültig oder abgelaufen.', 404);
  return json({ customer_name: row.customer_name, purpose: row.purpose, recipient: SIGNATURE_RECIPIENT, sent: Boolean(row.sent_at), pending: Boolean(row.pending), expires_at: row.expires_at });
}
async function mailSignature(env, row) {
  if (row.sent_at) return json({ sent: true });
  if (!row.png || row.revoked_at || row.expires_at <= iso() || row.signed_at <= iso(nowMs() - 23 * 3600000)) return fail('Dieser Unterschriftslink ist nicht mehr verfügbar.', 409);
  const lease = iso(), stale = iso(nowMs() - 90000);
  const lock = await run(env, `UPDATE signature_requests SET sending_at = ? WHERE id = ? AND sent_at IS NULL AND revoked_at IS NULL AND (sending_at IS NULL OR sending_at < ?)`, lease, row.id, stale);
  if (!changes(lock)) return fail('Die Unterschrift wird gerade versendet. Bitte kurz warten und erneut prüfen.', 409);
  let accepted = false;
  try {
    const when = new Date(row.signed_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `signature-${row.id}-${row.png_hash}` },
      body: JSON.stringify({ from: 'Kim Betcher <unterschriften@kim-betcher.de>', to: [SIGNATURE_RECIPIENT], reply_to: SIGNATURE_RECIPIENT,
        subject: `Unterschrift: ${row.customer_name.replace(/[\r\n]/g, ' ')} · ${row.purpose.slice(0, 80)}`,
        html: `<h2>Unterschrift eingegangen</h2><p><b>Name:</b> ${esc(row.customer_name)}</p><p><b>Vorgang:</b> ${esc(row.purpose)}</p><p><b>Abgesendet:</b> ${esc(when)} (Europe/Berlin)</p><p>Die Person hat bestätigt: „Ich sende meine Unterschrift zum oben genannten Vorgang an Kim Betcher.“</p><p>Die Unterschrift ist als transparente PNG-Datei angehängt.</p><p>Referenz: ${row.id}<br>SHA-256 der PNG: ${row.png_hash}</p>`,
        attachments: [{ filename: `Unterschrift-${row.customer_name.replace(/[^\p{L}\p{N}-]/gu, '_')}-${row.id}.png`, content: row.png }]
      })
    });
    if (!res.ok) throw new Error('mail rejected');
    accepted = true;
    await run(env, `UPDATE signature_requests SET sent_at = ?, png = NULL, sending_at = NULL WHERE id = ? AND sent_at IS NULL`, iso(), row.id);
    return json({ sent: true });
  } catch {
    // Same stored PNG + provider idempotency key make retries safe, including an ambiguous timeout.
    await run(env, `UPDATE signature_requests SET sending_at = NULL WHERE id = ? AND sending_at = ?`, row.id, lease).catch(() => {});
    return fail(accepted ? 'Versand bestätigt, Status konnte noch nicht gespeichert werden. Bitte erneut prüfen.' : 'Mailversand hat noch nicht geklappt. Die Unterschrift bleibt für einen erneuten Versuch hinterlegt.', 503);
  }
}
async function submitSignature(env, request, code) {
  if (!signatureCodeOk(code)) return fail('Unterschriftslink ungültig.', 404);
  let row = await first(env, `SELECT * FROM signature_requests WHERE code_hash = ?`, await signatureHash(code));
  if (!row || row.revoked_at || row.expires_at <= iso()) return fail('Dieser Unterschriftslink ist ungültig oder abgelaufen.', 404);
  if (row.sent_at) return json({ sent: true });
  const b = await signatureBody(request);
  if (!b || b.confirmed !== true) return fail('Bitte das Absenden der Unterschrift bestätigen.');
  if (!row.png) {
    const png = signaturePng(b.png);
    if (!png) return fail('Bitte im Feld unterschreiben und erneut absenden.');
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    await run(env, `UPDATE signature_requests SET png = ?, png_hash = ?, signed_at = ? WHERE id = ? AND png IS NULL AND sent_at IS NULL AND revoked_at IS NULL`, png, hash, iso(), row.id);
    row = await first(env, `SELECT * FROM signature_requests WHERE id = ?`, row.id);
  }
  return mailSignature(env, row);
}
async function signatureAdminAction(env, request, who, id) {
  if (request.method === 'POST') {
    const row = await first(env, `SELECT * FROM signature_requests WHERE id = ?`, id);
    return row ? mailSignature(env, row) : fail('Nicht gefunden.', 404);
  }
  const revoked = await run(env, `UPDATE signature_requests SET revoked_at = ?, png = NULL WHERE id = ? AND sent_at IS NULL AND (sending_at IS NULL OR sending_at < ?)`, iso(), id, iso(nowMs() - 90000));
  if (!changes(revoked)) return fail('Der Link wurde bereits verwendet oder der Versand läuft gerade.', 409);
  await audit(env, who, 'signature.revoke', id, null);
  return json({ ok: true });
}

/* ================= Router ================= */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;
  if (m === "OPTIONS") return new Response(null, { status: 204, headers: baseHeaders });
  await ensureSchema(env);

  if (path.startsWith('/public/signatures/') || path.startsWith('/admin/signatures')) {
    await cleanupSignatures(env);
    const code = path.split('/')[3];
    if (path.startsWith('/public/signatures/') && path.split('/').length === 4) {
      if (m === 'GET') return getSignatureLink(env, code);
      if (m === 'POST') return submitSignature(env, request, code);
    }
    const owner = await identify(request, env);
    if (!owner) return fail('Nicht angemeldet.', 401);
    if (owner.actor !== env.MAIN_ADMIN_ID) return fail('Nur Kim kann Unterschriftslinks verwalten.', 403);
    if (path === '/admin/signatures' && m === 'GET') return listSignatureLinks(env);
    if (path === '/admin/signatures' && m === 'POST') return createSignatureLink(env, request, owner);
    if (/^\/admin\/signatures\/\d+$/.test(path) && ['DELETE','POST'].includes(m)) return signatureAdminAction(env, request, owner, Number(code));
    return fail('Nicht gefunden.', 404);
  }

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
  if (m === "GET" && path === "/public/shifts") return publicShifts(env, request, url);
  if (m === "POST" && path === "/public/shifts") return pickShift(env, request);
  if (m === "GET" && path === "/health") return json({ ok: true });
  if (m === "GET" && path === "/public/contract") return getContractPublic(env, request, url);
  if (m === "POST" && path === "/public/contract/sign") return signContractPublic(env, request, ctx);
  if (m === "GET" && path === "/public/dj") return djInfo(env, request, url);
  if (m === "POST" && path === "/public/dj/preview") return djPreview(env, request);
  if (m === "POST" && path === "/public/dj/sign") return djSign(env, request, ctx);

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
    // Essen am Foodtruck (nur Tickets mit Essen). Ein Foodtruck-Zugang darf nichts anderes.
    if (m === "POST" && path === "/scan/food") return foodScan(env, request, who);
    if (m === "GET" && path === "/scan/food/search") return foodSearch(env, url);
    if (m === "POST" && /^\/scan\/food\/\d+$/.test(path)) return foodGive(env, who, id, null);
    if (who.scan_mode === "food") return m === "GET" && path === "/scan/stats" ? foodStats(env) : fail("Dieser Zugang ist nur für den Foodtruck.", 403);
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
  if (m === "POST" && path === "/admin/comp-tickets") return createCompTicket(env, request, who);
  if (m === "POST" && path === "/admin/tickets/extras") return setExtras(env, request, who);
  if (m === "POST" && /^\/admin\/tickets\/\d+$/.test(path)) return updateTicket(env, request, who, id);
  if (m === "GET" && path === "/admin/links") return adminLinks(env);
  if (m === "GET" && /^\/admin\/contracts\/\d+\/photo$/.test(path)) { const r = await first(env, `SELECT data FROM dj_photos WHERE contract_id = ?`, Number(path.split("/")[3])); return r ? json(r) : fail("Kein Foto.", 404); }
  if (m === "POST" && path === "/admin/dj-link/renew") { if ((denied = need("main"))) return denied; return djLinkRenew(env, who); }
  if (m === "GET" && path === "/admin/orders") return listOrders(env);
  if (m === "POST" && /^\/admin\/orders\/\d+$/.test(path)) return orderAction(env, request, who, id);
  if (m === "GET" && path === "/admin/export") { if (url.searchParams.get("kind") === "ledger" && (denied = need("main"))) return denied; return exportCsv(env, url); }
  if (m === "GET" && path === "/admin/scanners") return listScanners(env);
  if (m === "POST" && path === "/admin/scanners") return createScanner(env, request, who);
  if (m === "DELETE" && /^\/admin\/scanners\/\d+$/.test(path)) return revokeScanner(env, who, id);
  if (m === "GET" && path === "/admin/shifts") return adminShifts(env);
  if (m === "POST" && path === "/admin/shifts") return saveShift(env, request, who, null);
  if (m === "PUT" && /^\/admin\/shifts\/\d+$/.test(path)) return saveShift(env, request, who, id);
  if (m === "DELETE" && /^\/admin\/shifts\/\d+$/.test(path)) return deleteShift(env, who, id);
  if (m === "POST" && /^\/admin\/shifts\/\d+\/assign$/.test(path)) return assignShift(env, request, who, Number(path.split("/")[3]));
  if (m === "GET" && path === "/admin/todos") { await seedTodos(env); return listTodos(env); }
  if (m === "POST" && path === "/admin/todos") return createTodo(env, request, who);
  if (m === "PUT" && /^\/admin\/todos\/\d+$/.test(path)) return updateTodo(env, request, who, id);
  if (m === "DELETE" && /^\/admin\/todos\/\d+$/.test(path)) return deleteTodo(env, who, id);

  if ((denied = need("main"))) return denied;
  if (m === "GET" && path === "/admin/audit") return listAudit(env);
  if (m === "GET" && path === "/admin/report") return report(env);
  if (m === "GET" && path === "/admin/contracts") return listContracts(env);
  if (m === "GET" && path === "/admin/insurances") return listInsurances(env);
  if (m === "POST" && path === "/admin/insurances") return createInsurance(env, request, who);
  if (m === "GET" && /^\/admin\/insurances\/\d+$/.test(path)) return getInsuranceFile(env, id);
  if (m === "DELETE" && /^\/admin\/insurances\/\d+$/.test(path)) return deleteInsurance(env, who, id);
  if (m === "POST" && path === "/admin/contracts") return createContract(env, request, who);
  if (m === "GET" && /^\/admin\/contracts\/\d+$/.test(path)) return getContractAdmin(env, id);
  if (m === "DELETE" && /^\/admin\/contracts\/\d+$/.test(path)) return revokeContract(env, who, id);
  if (m === "POST" && /^\/admin\/contracts\/\d+\/sign$/.test(path)) return signContractOwner(env, request, who, Number(path.split("/")[3]), ctx);
  if (m === "GET" && path === "/admin/ledger") return listLedger(env);
  if (m === "POST" && path === "/admin/ledger") return createLedger(env, request, who);
  if (m === "PUT" && /^\/admin\/ledger\/\d+$/.test(path)) return updateLedger(env, request, who, id);
  if (m === "DELETE" && /^\/admin\/ledger\/\d+$/.test(path)) return deleteLedger(env, who, id);
  if (m === "POST" && path === "/admin/test-mail") return testMail(env, request, who);
  if (m === "POST" && path === "/admin/purge-test") return purgeTestData(env, who);
  if (m === "POST" && path === "/admin/reset") return resetAll(env, request, who);
  if (m === "GET" && path === "/admin/paper") return paperList(env, who);
  if (m === "POST" && path === "/admin/paper/block") return paperBlock(env, request, who);
  if (m === "POST" && path === "/admin/paper/sell") return paperSell(env, request, who);
  if (m === "POST" && path === "/admin/anonymize") return anonymize(env, request, who);
  if (m === "GET" && path === "/admin/admins") return listAdmins(env);
  if (m === "POST" && path === "/admin/admins") return upsertAdmin(env, request, who);
  return fail("Nicht gefunden.", 404);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => { await ensureSchema(env); await cleanupSignatures(env); await helperReminders(env, event?.scheduledTime || nowMs()).catch(e => console.error("reminders", e)); })());
  },
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error("takt30-api", e?.stack || e);
      return fail("Interner Fehler. Bitte später erneut versuchen.", 500);
    }
  }
};
