// Tests für die TAKT-Nr.-30-API: echte SQL-Statements gegen SQLite (D1-kompatibel),
// echte RS256-Signaturen für den Admin-Login, PayPal und Mail per gemocktem fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerUrl = pathToFileURL(path.join(here, "../cloudflare/takt30-api/worker.js")).href;
const MAIN = "user_MainAdmin0000000001";
const HELPER = "user_TicketHelper000000002";
const STRANGER = "user_Stranger00000000003";

function d1() {
  const db = new DatabaseSync(":memory:");
  const wrap = (sql, args = []) => ({
    bind(...a) { return wrap(sql, a); },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    _exec() { return db.prepare(sql).run(...args); }
  });
  return {
    raw: db,
    prepare: sql => wrap(sql),
    async batch(items) {
      db.exec("BEGIN");
      try {
        const out = items.map(i => { const r = i._exec(); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; });
        db.exec("COMMIT"); return out;
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    }
  };
}

// Clerk-Schlüssel + Tokens
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
const b64 = obj => Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)).toString("base64url");
async function token(sub) {
  const h = b64({ alg: "RS256", kid: "test-kid", typ: "JWT" });
  const p = b64({ sub, iss: "https://clerk.kim-betcher.de", azp: "https://kim-betcher.de", exp: Math.floor(Date.now() / 1000) + 600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}

let instance = 0;
async function setup(envExtra = {}, fetchHandler) {
  const mod = await import(`${workerUrl}?i=${++instance}`);
  const env = { DB: d1(), MAIN_ADMIN_ID: MAIN, ALLOW_TEST_PAYMENTS: "true", ...envExtra };
  const mails = [];
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.endsWith("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys: [jwk] }));
    if (url.startsWith("https://api.resend.com")) { mails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    if (fetchHandler) return fetchHandler(url, init);
    throw new Error("unexpected fetch " + url);
  };
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  async function call(method, p, body, { user, scanner, ip = "1.2.3.4" } = {}) {
    const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
    if (user) headers.Authorization = `Bearer ${await token(user)}`;
    if (scanner) headers["X-Scanner-Key"] = scanner;
    const res = await mod.default.fetch(new Request(`https://api.test${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await Promise.all(waits.splice(0));
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  const admin = (m, p, b) => call(m, p, b, { user: MAIN });
  return { env, call, admin, mails, db: env.DB.raw };
}

async function openTestSale(t) {
  assert.equal((await t.admin("PUT", "/admin/settings", { sale_mode: "test" })).status, 200);
}
async function invite(t, name = "Lisa Muster", max = 2) {
  const r = await t.admin("POST", "/admin/invitations", { name, max_tickets: max });
  assert.equal(r.status, 201); return r.data.code;
}
const guest = (f = "Lisa", l = "Muster") => ({ first_name: f, last_name: l });
async function buy(t, code, guests = [guest()], ip) {
  return t.call("POST", "/public/checkout", { invite: code, guests, email: "lisa@example.org", accept: true }, { ip });
}

test("Verkauf geschlossen: kein Kauf möglich, Event ohne Adresse", async () => {
  const t = await setup();
  const ev = await t.call("GET", "/public/event");
  assert.equal(ev.data.sale.mode, "closed");
  assert.equal(ev.data.sale.available, 70);
  assert.equal(JSON.stringify(ev.data).includes("Seewiesen"), false);
  const code = await invite(t);
  assert.equal((await buy(t, code)).data.code, "SALE_CLOSED");
});

test("Testkauf: 2 Tickets für 35 €, Tickets mit QR, Adresse nur nach Kauf, Mail verschickt", async () => {
  const t = await setup({ RESEND_API_KEY: "k", MAIL_FROM: "TAKT Nr. 30 <tickets@kim-betcher.de>" });
  await openTestSale(t);
  const code = await invite(t);
  const inv = await t.call("GET", `/public/invite/${code}`);
  assert.equal(inv.data.first_name, "Lisa"); assert.equal(inv.data.remaining, 2);
  const co = await buy(t, code, [guest(), guest("Ben", "Muster")]);
  assert.equal(co.status, 201); assert.equal(co.data.amount_cents, 3500); assert.equal(co.data.provider, "test");
  const before = await t.call("GET", `/public/order?key=${co.data.access_key}`);
  assert.equal(before.data.status, "pending"); assert.equal(before.data.tickets.length, 0); assert.equal(before.data.event, null);
  const pay = await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  assert.equal(pay.status, 200);
  const o = await t.call("GET", `/public/order?key=${co.data.access_key}`);
  assert.equal(o.data.status, "paid"); assert.equal(o.data.tickets.length, 2);
  assert.match(o.data.event.venue_address, /Seewiesen 84/);
  assert.notEqual(o.data.tickets[0].code, o.data.tickets[1].code);
  assert.ok(o.data.tickets[0].code.length >= 26);
  assert.equal(t.mails.length, 1); assert.match(t.mails[0].subject, /TEST/);
  const tk = await t.call("GET", `/public/ticket?k=${o.data.tickets[1].view_key}`);
  assert.equal(tk.data.first_name, "Ben");
  // doppelte Zahlungsbestätigung erzeugt keine weiteren Tickets
  await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets").get().n, 2);
  // Einladung ausgeschöpft
  const again = await buy(t, code);
  assert.equal(again.data.code, "INVITE_EXHAUSTED");
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 68);
});

test("1 Ticket kostet 20 €, nie mehr als 2 pro Einladung, auch über mehrere Käufe", async () => {
  const t = await setup(); await openTestSale(t);
  const code = await invite(t);
  const three = await buy(t, code, [guest(), guest("A", "B"), guest("C", "D")]);
  assert.equal(three.status, 400);
  const a = await buy(t, code); assert.equal(a.data.amount_cents, 2000);
  await t.call("POST", "/public/test-pay", { access_key: a.data.access_key });
  const b = await buy(t, code, [guest("Ben", "M"), guest("Eva", "M")]);
  assert.equal(b.data.code, "INVITE_EXHAUSTED");
  const c = await buy(t, code, [guest("Ben", "M")]); assert.equal(c.status, 201);
  // neuer Versuch gibt den unbezahlten alten frei – es bleibt bei höchstens 2
  const d = await buy(t, code, [guest("Eva", "M")]); assert.equal(d.status, 201);
  assert.equal((await t.call("GET", `/public/order?key=${c.data.access_key}`)).data.status, "cancelled");
  // zahlt der alte Versuch trotzdem noch (z. B. in der PayPal-App), wird das Einladungslimit trotzdem eingehalten
  await t.call("POST", "/public/test-pay", { access_key: d.data.access_key });
  assert.equal((await t.call("POST", "/public/test-pay", { access_key: c.data.access_key })).data.status, "refund_required");
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets").get().n, 2);
});

test("Abgebrochene Zahlung: kein Ticket, Platz sofort wieder frei; Reservierung läuft ab", async () => {
  const t = await setup(); await openTestSale(t);
  const code = await invite(t);
  const co = await buy(t, code, [guest(), guest("Ben", "M")]);
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 68);
  await t.call("POST", "/public/cancel", { access_key: co.data.access_key });
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 70);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets").get().n, 0);
  const co2 = await buy(t, code);
  t.db.prepare("UPDATE reservations SET expires_at = 1 WHERE order_id = (SELECT id FROM orders WHERE access_key = ?)").run(co2.data.access_key);
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 70);
});

test("Ausverkauf bei genau 70 und gleichzeitiger Kauf des letzten Tickets", async () => {
  const t = await setup(); await openTestSale(t);
  for (let i = 0; i < 34; i++) {
    const c = await invite(t, `Gast ${i}`);
    const co = await buy(t, c, [guest(`A${i}`, "X"), guest(`B${i}`, "X")], `10.0.${i}.1`);
    assert.equal(co.status, 201, JSON.stringify(co.data));
    await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  }
  const c1 = await invite(t, "Letzte"); const c2 = await invite(t, "Vorletzte");
  const one = await buy(t, c1, [guest()], "10.9.9.1"); await t.call("POST", "/public/test-pay", { access_key: one.data.access_key });
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 1);
  const c3 = await invite(t, "Racer A"), c4 = await invite(t, "Racer B");
  const [x, y] = await Promise.all([buy(t, c3, [guest("R", "A")], "10.8.0.1"), buy(t, c4, [guest("R", "B")], "10.8.0.2")]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  const winner = x.status === 201 ? x : y;
  await t.call("POST", "/public/test-pay", { access_key: winner.data.access_key });
  const ev = (await t.call("GET", "/public/event")).data;
  assert.equal(ev.sale.available, 0); assert.equal(ev.sale.sold_out, true);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets WHERE category='regular'").get().n, 70);
  assert.equal((await buy(t, c2, [guest()], "10.7.0.1")).data.code, "SOLD_OUT");
});

test("Verspätete Zahlung nach abgelaufener Reservierung bei Ausverkauf → Erstattung statt Ticket", async () => {
  const t = await setup(); await openTestSale(t);
  const late = await invite(t, "Spät");
  const co = await buy(t, late, [guest("Spät", "Zahler")], "9.9.9.9");
  t.db.prepare("UPDATE reservations SET expires_at = 1").run();
  for (let i = 0; i < 35; i++) {
    const c = await invite(t, `Gast ${i}`);
    const r = await buy(t, c, [guest(`A${i}`, "X"), guest(`B${i}`, "X")], `10.1.${i}.1`);
    await t.call("POST", "/public/test-pay", { access_key: r.data.access_key });
  }
  const pay = await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  assert.equal(pay.data.status, "refund_required");
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets WHERE category='regular'").get().n, 70);
  const d = await t.admin("GET", "/admin/dashboard"); assert.equal(d.data.counts.refund_required, 1);
});

test("Genau 30 Freitickets, nicht aus dem Verkaufskontingent; Ersetzen macht alten QR ungültig", async () => {
  const t = await setup();
  const r = await t.admin("POST", "/admin/free-tickets", { count: 30 });
  assert.equal(r.data.created, 30);
  assert.equal((await t.admin("POST", "/admin/free-tickets", { first_name: "Zu", last_name: "Viel" })).data.code, "FREE_FULL");
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 70);
  const list = (await t.admin("GET", "/admin/tickets?category=free")).data;
  assert.equal(list.filter(x => !x.first_name).length, 30);
  const tk = list[0];
  // nicht zugeordnet → kein Zutritt
  const sc = await t.admin("POST", "/admin/scanners", { name: "Tür" });
  const key = sc.data.url.split("#k=")[1];
  const codeOf = id => t.db.prepare("SELECT code FROM tickets WHERE id = ?").get(id).code;
  assert.equal((await t.call("POST", "/scan/check", { code: codeOf(tk.id) }, { scanner: key })).data.reason, "Freiticket keinem Gast zugeordnet");
  await t.admin("POST", `/admin/tickets/${tk.id}`, { action: "assign", first_name: "Max", last_name: "Frei" });
  const oldCode = codeOf(tk.id);
  await t.admin("POST", `/admin/tickets/${tk.id}`, { action: "replace", reason: "verloren" });
  assert.equal((await t.call("POST", "/scan/check", { code: oldCode }, { scanner: key })).data.reason, "Ersetzter QR-Code – ungültig");
  assert.equal((await t.call("POST", "/scan/check", { code: "T30." + codeOf(tk.id) }, { scanner: key })).data.result, "green");
  // Stornieren gibt einen Freiplatz wieder frei, aber nie mehr als 30 gleichzeitig gültig
  await t.admin("POST", `/admin/tickets/${list[1].id}`, { action: "cancel" });
  assert.equal((await t.admin("POST", "/admin/free-tickets", {})).status, 201);
  assert.equal((await t.admin("POST", "/admin/free-tickets", {})).data.code, "FREE_FULL");
});

test("Einlass: gültig, doppelt, gleichzeitig, ungültig, gesperrt, Testticket außerhalb Testmodus, Zurücksetzen", async () => {
  const t = await setup(); await openTestSale(t);
  const code = await invite(t);
  const co = await buy(t, code, [guest(), guest("Ben", "M")]);
  await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  const [a, b] = (await t.call("GET", `/public/order?key=${co.data.access_key}`)).data.tickets;
  const key = (await t.admin("POST", "/admin/scanners", { name: "Tür" })).data.url.split("#k=")[1];
  const scan = c => t.call("POST", "/scan/check", { code: c }, { scanner: key });
  const first = await scan(a.code);
  assert.equal(first.data.result, "green"); assert.equal(first.data.name, "Lisa Muster");
  const second = await scan(a.code);
  assert.equal(second.data.result, "red"); assert.equal(second.data.reason, "Bereits eingelöst");
  const both = await Promise.all([scan(b.code), scan(b.code)]);
  assert.deepEqual(both.map(x => x.data.result).sort(), ["green", "red"]);
  assert.equal((await scan("ABCDEFGHJKLMNPQRSTUVWXYZ23")).data.reason, "QR-Code unbekannt");
  assert.equal((await scan("kaputt")).data.result, "red");
  // Zurücksetzen nur Hauptadmin, mit Grund
  const helperUndo = await t.call("POST", `/scan/undo/1`, { reason: "Fehlscan" }, { scanner: key });
  assert.equal(helperUndo.status, 403);
  assert.equal((await t.admin("POST", "/scan/undo/1", { reason: "Fehlscan" })).status, 200);
  assert.equal((await scan(a.code)).data.result, "green");
  // Testtickets gelten nach dem Testmodus nicht
  await t.admin("PUT", "/admin/settings", { sale_mode: "closed" });
  await t.admin("POST", "/scan/undo/1", { reason: "Test" });
  assert.equal((await scan(a.code)).data.reason, "Testticket – kein Zutritt");
  // gesperrter Zugang
  const sc = (await t.admin("GET", "/admin/scanners")).data[0];
  await t.call("DELETE", `/admin/scanners/${sc.id}`, undefined, { user: MAIN });
  assert.equal((await scan(a.code)).status, 401);
  // Testdaten löschen
  assert.equal((await t.admin("POST", "/admin/purge-test")).data.orders, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets").get().n, 0);
});

test("Rechte: anonym, fremdes Konto, Ticketverwaltung, Scanner-Zugang", async () => {
  const t = await setup();
  assert.equal((await t.call("GET", "/admin/dashboard")).status, 401);
  assert.equal((await t.call("GET", "/admin/dashboard", undefined, { user: STRANGER })).status, 403);
  assert.equal((await t.call("GET", "/scan/stats", undefined, { user: STRANGER })).status, 403);
  assert.equal((await t.call("POST", "/scan/check", { code: "x" }, { scanner: "falsch" })).status, 401);
  await t.admin("POST", "/admin/admins", { user_id: HELPER, role: "tickets", name: "Franzi" });
  assert.equal((await t.call("GET", "/admin/dashboard", undefined, { user: HELPER })).status, 200);
  assert.equal((await t.call("PUT", "/admin/settings", { sale_mode: "test" }, { user: HELPER })).status, 403);
  assert.equal((await t.call("GET", "/admin/audit", undefined, { user: HELPER })).status, 403);
  const key = (await t.admin("POST", "/admin/scanners", { name: "Tür" })).data.url.split("#k=")[1];
  assert.equal((await t.call("GET", "/admin/dashboard", undefined, { scanner: key })).status, 403);
  assert.equal((await t.call("GET", "/scan/stats", undefined, { scanner: key })).status, 200);
  // Manipulierter Token
  const bad = (await token(MAIN)).slice(0, -4) + "AAAA";
  const res = await (await import(`${workerUrl}?i=${instance}`)).default.fetch(new Request("https://api.test/admin/dashboard", { headers: { Authorization: `Bearer ${bad}` } }), t.env, {});
  assert.equal(res.status, 401);
  const audit = (await t.admin("GET", "/admin/audit")).data;
  assert.ok(audit.some(a => a.action === "admin.upsert" && a.actor_name === "Hauptadministrator"));
});

test("Helfer: eigenes Kontingent von 20, Aufgabe wählbar, zählt zum Einladungslimit, nicht zu den 70", async () => {
  const t = await setup(); await openTestSale(t);
  await t.admin("PUT", "/admin/settings", { helper_cap: "20", helper_jobs: JSON.stringify([{ name: "Bar", slots: 1 }, { name: "Ticketscanner", slots: 0 }]) });
  const code = await invite(t);
  const h = await t.call("POST", "/public/helper", { invite: code, first_name: "Lisa", last_name: "Muster", email: "l@example.org", job: "Bar", accept: true });
  assert.equal(h.status, 201); assert.equal(h.data.number, "H-01");
  assert.equal((await t.call("GET", `/public/invite/${code}`)).data.helper_job, "Bar");
  assert.equal((await t.call("POST", "/public/helper", { invite: code, first_name: "Ben", last_name: "M", email: "b@example.org", job: "Ticketscanner", accept: true })).data.code, "HELPER_EXISTS");
  // Begleitung kann noch 1 Ticket kaufen, 2 nicht
  assert.equal((await buy(t, code, [guest("Ben", "M"), guest("Eva", "M")])).data.code, "INVITE_EXHAUSTED");
  assert.equal((await buy(t, code, [guest("Ben", "M")])).status, 201);
  const ev = (await t.call("GET", "/public/event")).data;
  assert.equal(ev.sale.available, 69);
  assert.equal(ev.helpers.available, 19);
  assert.equal(ev.helpers.jobs.find(j => j.name === "Bar").full, true);
  const c2 = await invite(t, "Zweite");
  assert.equal((await t.call("POST", "/public/helper", { invite: c2, first_name: "Z", last_name: "W", email: "z@example.org", job: "Bar", accept: true })).data.code, "JOB_FULL");
  for (let i = 0; i < 19; i++) {
    const c = await invite(t, `H ${i}`);
    const r = await t.call("POST", "/public/helper", { invite: c, first_name: `H${i}`, last_name: "X", email: "h@example.org", job: "Ticketscanner", accept: true }, { ip: `7.7.${i}.7` });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const c3 = await invite(t, "Zu spät");
  assert.equal((await t.call("POST", "/public/helper", { invite: c3, first_name: "Z", last_name: "S", email: "z@example.org", job: "Ticketscanner", accept: true }, { ip: "8.8.8.8" })).data.code, "HELPER_FULL");
  const key = (await t.admin("POST", "/admin/scanners", { name: "Tür" })).data.url.split("#k=")[1];
  const code1 = t.db.prepare("SELECT code FROM tickets WHERE number = 'H-01'").get().code;
  const s = await t.call("POST", "/scan/check", { code: code1 }, { scanner: key });
  assert.equal(s.data.result, "green"); assert.equal(s.data.helper_job, "Bar");
});

test("Gesperrte Einladung und Rate Limit", async () => {
  const t = await setup(); await openTestSale(t);
  const code = await invite(t);
  const id = (await t.admin("GET", "/admin/invitations")).data[0].id;
  await t.admin("PUT", `/admin/invitations/${id}`, { status: "disabled" });
  assert.equal((await buy(t, code)).data.code, "INVITE_DISABLED");
  let last;
  for (let i = 0; i < 45; i++) last = await t.call("GET", `/public/invite/${code}`, undefined, { ip: "5.5.5.5" });
  assert.equal(last.status, 429);
});

test("PayPal: Erstellen, Capture, doppelter Webhook ohne Duplikate, Erstattung sperrt Tickets", async () => {
  const calls = [];
  const handler = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }));
    if (url.endsWith("/v2/checkout/orders")) return new Response(JSON.stringify({ id: "PP-ORDER-1", status: "CREATED" }), { status: 201 });
    if (url.endsWith("/capture")) {
      const orderNo = globalThis.__orderNo;
      return new Response(JSON.stringify({ id: "PP-ORDER-1", status: "COMPLETED", purchase_units: [{ custom_id: orderNo, payments: { captures: [{ id: "CAP-1", status: "COMPLETED", custom_id: orderNo, amount: { value: "35.00", currency_code: "EUR" } }] } }] }), { status: 201 });
    }
    if (url.endsWith("/verify-webhook-signature")) return new Response(JSON.stringify({ verification_status: "SUCCESS" }));
    throw new Error("unexpected " + url);
  };
  const t = await setup({ PAYPAL_CLIENT_ID: "cid", PAYPAL_SECRET: "sec", PAYPAL_ENV: "sandbox", PAYPAL_WEBHOOK_ID: "WH" }, handler);
  assert.equal((await t.admin("PUT", "/admin/settings", { sale_mode: "live" })).status, 200);
  const ev = (await t.call("GET", "/public/event")).data;
  assert.equal(ev.sale.mode, "live"); assert.equal(ev.paypal.client_id, "cid");
  const code = await invite(t);
  const co = await buy(t, code, [guest(), guest("Ben", "M")]);
  assert.equal(co.data.paypal_order_id, "PP-ORDER-1");
  globalThis.__orderNo = co.data.order_no;
  const cap = await t.call("POST", "/public/paypal/capture", { access_key: co.data.access_key });
  assert.equal(cap.status, 200); assert.equal(cap.data.status, "paid"); assert.equal(cap.data.tickets.length, 2);
  // Webhook für dieselbe Zahlung – zweimal – erzeugt keine weiteren Tickets
  const mod = await import(`${workerUrl}?i=${instance}`);
  const hook = async ev => (await mod.default.fetch(new Request("https://api.test/paypal/webhook", { method: "POST", body: JSON.stringify(ev), headers: { "paypal-transmission-id": "x" } }), t.env, {})).json();
  const evt = { id: "WH-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", custom_id: co.data.order_no, amount: { value: "35.00", currency_code: "EUR" } } };
  await hook(evt);
  assert.equal((await hook(evt)).duplicate, true);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets").get().n, 2);
  // Erstattung → Tickets gesperrt, Scan rot
  await hook({ id: "WH-2", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: { id: "REF-1", links: [{ rel: "up", href: "https://api/v2/payments/captures/CAP-1" }] } });
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='cancelled'").get().n, 2);
  const key = (await t.admin("POST", "/admin/scanners", { name: "Tür" })).data.url.split("#k=")[1];
  const c = t.db.prepare("SELECT code FROM tickets LIMIT 1").get().code;
  assert.equal((await t.call("POST", "/scan/check", { code: c }, { scanner: key })).data.reason, "Ticket storniert");
  assert.equal((await t.call("GET", "/public/event")).data.sale.available, 70);
  // Echte Zahlungen bleiben gesperrt ohne ausdrückliche Freigabe
  t.env.PAYPAL_ENV = "live";
  assert.equal((await t.admin("PUT", "/admin/settings", { sale_mode: "live" })).status, 409);
});

test("CSV-Export schützt vor Formel-Injection", async () => {
  const t = await setup(); await openTestSale(t);
  const code = await invite(t);
  const co = await buy(t, code, [guest("=HYPERLINK(1)", "X")]);
  await t.call("POST", "/public/test-pay", { access_key: co.data.access_key });
  const csv = (await t.admin("GET", "/admin/export?kind=guests")).data;
  assert.match(csv, /"'=HYPERLINK\(1\)"/);
});

test("Ticketnummern bleiben eindeutig, auch wenn Testtickets später gelöscht werden", async () => {
  const t = await setup(); await openTestSale(t);
  const a = await buy(t, await invite(t, "A"), [guest("A", "A")]); await t.call("POST", "/public/test-pay", { access_key: a.data.access_key });
  const b = await buy(t, await invite(t, "B"), [guest("B", "B")]); await t.call("POST", "/public/test-pay", { access_key: b.data.access_key });
  t.db.prepare("DELETE FROM tickets WHERE number = 'T30-001'").run();
  const c = await buy(t, await invite(t, "C"), [guest("C", "C")]); await t.call("POST", "/public/test-pay", { access_key: c.data.access_key });
  const nums = t.db.prepare("SELECT number FROM tickets ORDER BY number").all().map(r => r.number);
  assert.deepEqual(nums, ["T30-002", "T30-003"]);
});

test("Testmail: nur Hauptadmin, Fehler von Resend werden verständlich gemeldet", async () => {
  const t = await setup({ RESEND_API_KEY: "k", MAIL_FROM: "TAKT Nr. 30 <tickets@kim-betcher.de>" });
  const ok = await t.admin("POST", "/admin/test-mail", { to: "kim@example.org" });
  assert.equal(ok.status, 200); assert.equal(t.mails.at(-1).to[0], "kim@example.org"); assert.equal(t.mails.at(-1).reply_to, "betcherkimg@gmail.com");
  await t.admin("POST", "/admin/admins", { user_id: HELPER, role: "tickets" });
  assert.equal((await t.call("POST", "/admin/test-mail", { to: "x@example.org" }, { user: HELPER })).status, 403);
  const t2 = await setup({ RESEND_API_KEY: "k", MAIL_FROM: "x@kim-betcher.de" });
  globalThis.fetch = (orig => async (url, init) => String(url).startsWith("https://api.resend.com") ? new Response(JSON.stringify({ message: "The kim-betcher.de domain is not verified." }), { status: 403 }) : orig(url, init))(globalThis.fetch);
  const bad = await t2.admin("POST", "/admin/test-mail", { to: "kim@example.org" });
  assert.equal(bad.status, 502); assert.match(bad.data.error, /not verified/);
});

test("PayPal-Sandbox: Käufe sind Testtickets und zählen nicht als Umsatz", async () => {
  const handler = async (url) => {
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok" }));
    if (url.endsWith("/v2/checkout/orders")) return new Response(JSON.stringify({ id: "PP-S", status: "CREATED" }), { status: 201 });
    if (url.endsWith("/capture")) return new Response(JSON.stringify({ purchase_units: [{ custom_id: globalThis.__no, payments: { captures: [{ id: "CAP-S", status: "COMPLETED", custom_id: globalThis.__no, amount: { value: "20.00", currency_code: "EUR" } }] } }] }), { status: 201 });
    throw new Error(url);
  };
  const t = await setup({ PAYPAL_CLIENT_ID: "c", PAYPAL_SECRET: "s", PAYPAL_ENV: "sandbox" }, handler);
  await t.admin("PUT", "/admin/settings", { sale_mode: "live" });
  assert.equal((await t.call("GET", "/public/event")).data.sale.sandbox, true);
  const co = await buy(t, await invite(t));
  globalThis.__no = co.data.order_no;
  const cap = await t.call("POST", "/public/paypal/capture", { access_key: co.data.access_key });
  assert.equal(cap.data.is_test, true); assert.equal(cap.data.tickets[0].is_test, 1);
  const d = (await t.admin("GET", "/admin/dashboard")).data.counts;
  assert.equal(d.revenue_cents, 0); assert.equal(d.test_revenue_cents, 2000);
  const key = (await t.admin("POST", "/admin/scanners", { name: "Tür" })).data.url.split("#k=")[1];
  assert.equal((await t.call("POST", "/scan/check", { code: cap.data.tickets[0].code }, { scanner: key })).data.result, "green");
});

test("Helfer-Standard: 13 Plätze, 8 Bar und 5 Ticketscan; alte Standard-Aufgaben werden übernommen", async () => {
  const t = await setup();
  const ev = (await t.call("GET", "/public/event")).data;
  assert.equal(ev.helpers.available, 13);
  assert.deepEqual(ev.helpers.jobs.map(j => [j.name, j.slots]), [["Bar", 8], ["Ticketscan", 5]]);
  for (let i = 0; i < 5; i++) {
    const r = await t.call("POST", "/public/helper", { invite: await invite(t, `S${i}`), first_name: "S", last_name: `${i}`, email: "s@example.org", job: "Ticketscan", accept: true }, { ip: `6.6.${i}.6` });
    assert.equal(r.status, 201);
  }
  const full = await t.call("POST", "/public/helper", { invite: await invite(t, "S6"), first_name: "S", last_name: "6", email: "s@example.org", job: "Ticketscan", accept: true }, { ip: "6.6.9.6" });
  assert.equal(full.data.code, "JOB_FULL");
  assert.equal((await t.admin("PUT", "/admin/settings", { helper_cap: "4" })).status, 409);
  // Bestand mit den alten Standard-Aufgaben (0 Plätze) wird beim Start umgestellt
  const t2 = await setup();
  t2.db.exec(`CREATE TABLE event_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`);
  t2.db.prepare("INSERT INTO event_settings VALUES ('helper_jobs', ?, '', 'system')").run(JSON.stringify([{ name: "Bar", slots: 0 }, { name: "Ticketscanner", slots: 0 }]));
  assert.deepEqual((await t2.call("GET", "/public/event")).data.helpers.jobs.map(j => j.slots), [8, 5]);
});
