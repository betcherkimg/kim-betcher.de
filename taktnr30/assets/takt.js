/* TAKT Nr. 30 – gemeinsame Helfer für alle Seiten */
(function () {
  "use strict";
  const API = "https://takt30-api.betcherkimg.workers.dev";
  const BASE = "/taktnr30/tickets/";

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  class ApiError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  }

  async function api(path, { method = "GET", body, headers = {}, timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(API + path, {
        method, signal: ctrl.signal,
        headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new ApiError("Keine Verbindung zum Server. Bitte Internet prüfen und erneut versuchen.", 0, "OFFLINE");
    } finally { clearTimeout(timer); }
    const type = res.headers.get("Content-Type") || "";
    const data = type.includes("json") ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) throw new ApiError((data && data.error) || `Fehler ${res.status}`, res.status, data && data.code);
    return data;
  }

  const pad = n => String(n).padStart(2, "0");
  function dateDe(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return `${d}.${m}.${y}`;
  }
  function weekdayDe(iso) {
    const d = new Date(`${iso}T12:00:00`);
    return ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"][d.getDay()];
  }
  function timeDe(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const euro = cents => (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }) + " €";

  // Berlin-Zeit → Date (Startzeitpunkt für den Countdown)
  function eventStart(date, time) {
    const guess = new Date(`${date}T${time}:00Z`);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess);
    const h = +parts.find(p => p.type === "hour").value, m = +parts.find(p => p.type === "minute").value;
    const [th, tm] = time.split(":").map(Number);
    return new Date(guess.getTime() - ((h * 60 + m) - (th * 60 + tm)) * 60000);
  }

  // QR-Code als SVG (kein Personenbezug im Inhalt – nur die zufällige Ticketkennung)
  function qrMatrix(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text); qr.make();
    const n = qr.getModuleCount(), rows = [];
    for (let y = 0; y < n; y++) { const row = []; for (let x = 0; x < n; x++) row.push(qr.isDark(y, x)); rows.push(row); }
    return rows;
  }
  function qrSvg(text, { quiet = 2, label = "QR-Code" } = {}) {
    const m = qrMatrix(text), n = m.length, size = n + quiet * 2;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  // Ring aus 70 Segmenten um das Logo (verkauft = UV)
  function ringSvg(total, filled, { size = 300, stroke = 4.5, gap = 0.36 } = {}) {
    const c = size / 2, r = c - stroke - 2, step = (Math.PI * 2) / total;
    let out = "";
    for (let i = 0; i < total; i++) {
      const a1 = i * step - Math.PI / 2, a2 = a1 + step * (1 - gap);
      const p = (a) => `${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
      out += `<path d="M${p(a1)} A${r} ${r} 0 0 1 ${p(a2)}" class="${i < filled ? "seg on" : "seg"}"/>`;
    }
    return `<svg viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><g fill="none" stroke-width="${stroke}" stroke-linecap="butt">${out}</g></svg>`;
  }

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(`takt30.${key}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`takt30.${key}`, JSON.stringify(value)); } catch {} },
    del(key) { try { localStorage.removeItem(`takt30.${key}`); } catch {} }
  };

  const guestName = t => `${t.first_name || ""} ${t.last_name || ""}`.trim() || (t.category === "free" ? "VIP · 2TAKT" : "Freiticket");
  const categoryLabel = (t) => t.category === "free" ? "2TAKT" : t.category === "helper" ? `Helfer${t.helper_job ? " · " + t.helper_job : ""}` : "Ticket";

  // Turnstile nur laden, wenn ein Site-Key konfiguriert ist
  let turnstilePromise = null;
  function turnstile(siteKey, host) {
    if (!siteKey) return Promise.resolve(null);
    turnstilePromise ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.onload = () => resolve(window.turnstile); s.onerror = reject;
      document.head.appendChild(s);
    });
    return turnstilePromise.then(ts => {
      let token = null;
      const id = ts.render(host, { sitekey: siteKey, theme: "dark", language: "de", callback: t => { token = t; }, "expired-callback": () => { token = null; } });
      return { get: () => token, reset: () => { token = null; ts.reset(id); } };
    });
  }

  window.TAKT = { API, BASE, api, ApiError, esc, $, $$, dateDe, weekdayDe, timeDe, euro, eventStart, qrSvg, qrMatrix, ringSvg, store, categoryLabel, guestName, turnstile, pad };
})();
