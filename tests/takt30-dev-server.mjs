// Lokaler Testserver: führt den echten TAKT-Worker mit SQLite (D1-kompatibel) aus.
// Nur für Tests – keine Produktionsdaten, keine echten Zahlungen, keine echten Mails.
//   node tests/takt30-dev-server.mjs 8799
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8799);
const worker = (await import(pathToFileURL(path.join(here, "../cloudflare/takt30-api/worker.js")).href)).default;

const db = new DatabaseSync(":memory:");
const wrap = (sql, args = []) => ({
  bind: (...a) => wrap(sql, a),
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  _exec: () => db.prepare(sql).run(...args)
});
const D1 = {
  prepare: sql => wrap(sql),
  async batch(items) { db.exec("BEGIN"); try { const o = items.map(i => { const r = i._exec(); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }); db.exec("COMMIT"); return o; } catch (e) { db.exec("ROLLBACK"); throw e; } }
};

const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "dev", alg: "RS256" };
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
async function token(sub) {
  const h = b64({ alg: "RS256", kid: "dev" }), p = b64({ sub, iss: "https://clerk.kim-betcher.de", azp: "https://kim-betcher.de", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/.well-known/jwks.json")) return new Response(JSON.stringify({ keys: [jwk] }));
  if (String(url).startsWith("https://api.resend.com")) return new Response("{}");
  return realFetch(url, init);
};
const env = { DB: D1, MAIN_ADMIN_ID: "user_DevMainAdmin0001", ALLOW_TEST_PAYMENTS: "true", RESEND_API_KEY: "dev", MAIL_FROM: "dev@example.invalid" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/__token") { res.end(await token(url.searchParams.get("sub") || env.MAIN_ADMIN_ID)); return; }
  if (url.pathname === "/__sql") { // nur Test-Hilfe
    let body = ""; for await (const c of req) body += c;
    const { sql, args = [] } = JSON.parse(body);
    const out = /^\s*select/i.test(sql) ? db.prepare(sql).all(...args) : db.prepare(sql).run(...args);
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(out, (k, v) => typeof v === "bigint" ? Number(v) : v)); return;
  }
  let body = ""; for await (const c of req) body += c;
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const r = await worker.fetch(new Request(`https://api.local${url.pathname}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : body }), env, { waitUntil: p => p.catch(() => {}) });
  res.statusCode = r.status; r.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, "127.0.0.1", () => console.log(`takt30 dev api on ${port}`));
