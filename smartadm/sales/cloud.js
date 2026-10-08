/* SmartADM 5 – Cloudspeicher
 *
 * Teil 1 (Kern): gleicht die Daten je Eintrag mit dem Server ab. Läuft ohne Browser
 *                und ist deshalb testbar.
 * Teil 2 (Oberfläche): Clerk-Anmeldung, Statusanzeige, Import, Konfliktdialog.
 *
 * Prinzip: Jeder Eintrag (ein Termin, eine Bank, ein Profilfeld …) wird einzeln mit einer
 * Versionsnummer gespeichert. Ein Gerät darf nur schreiben, wenn es die aktuelle Version
 * kennt. Haben Handy und PC denselben Eintrag unterschiedlich geändert, entscheidest du.
 */
(function (root) {
  "use strict";

  /* =====================================================================
     Teil 1 – Kern
     ===================================================================== */

  const T = "\u0001";                       // trennt Bereich und Schlüssel
  const MAX_OPS = 40;                       // Grenze des Workers je Aufruf

  // Listen: woran ein Eintrag wiedererkannt wird
  const LISTEN = {
    banken: e => e.id,
    bma: e => e.name,
    termine: e => e.id,
    auswertung: e => e.id,
    provisionen: e => e.id,
    provArchiv: e => e.monat
  };
  const SELBST_SORTIERT = ["termine", "auswertung"];   // diese Listen ordnet die App nach Datum
  const KARTEN = ["profil", "abstimmung"];  // Objekte: je Feld bzw. je Name ein Eintrag
  const WERTE = ["provSteuer"];             // Einzelwerte im Bereich „einstellung“

  // Reihenfolge beim Hochladen: Auswertung vor Terminen, damit ein anderes Gerät
  // nie einen Termin ohne seinen Auswertungseintrag sieht.
  const RANG = { profil: 0, einstellung: 1, banken: 2, bma: 3, abstimmung: 4, auswertung: 5, termine: 6, provisionen: 7, provArchiv: 8 };

  const leeresDokument = () => ({
    profil: {}, banken: [], bma: [], termine: [], abstimmung: {},
    provisionen: [], provArchiv: [], provSteuer: 0, auswertung: []
  });

  // JSON mit sortierten Schlüsseln – gleiche Inhalte ergeben immer denselben Text
  function stabil(wert) {
    if (wert === null || typeof wert !== "object") return JSON.stringify(wert === undefined ? null : wert);
    if (Array.isArray(wert)) return "[" + wert.map(stabil).join(",") + "]";
    return "{" + Object.keys(wert).sort()
      .filter(k => wert[k] !== undefined)
      .map(k => JSON.stringify(k) + ":" + stabil(wert[k])).join(",") + "}";
  }

  // Kurzer Fingerabdruck (cyrb53) – genügt, um Änderungen zu erkennen
  function fingerabdruck(wert) {
    const text = stabil(wert);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const kopie = wert => JSON.parse(JSON.stringify(wert));

  function natuerlicherSchluessel(bereich, eintrag) {
    const roh = eintrag && typeof eintrag === "object" ? LISTEN[bereich](eintrag) : null;
    if (roh === null || roh === undefined || roh === "") return "";
    const k = String(roh);
    return k.length > 200 || k.includes("\u0000") || k.includes(T) ? "" : k;
  }

  // Schlüssel je Listeneintrag. Ohne eigene Kennung zählt der Inhalt;
  // doppelte Schlüssel werden in Listenreihenfolge durchnummeriert.
  function listenSchluessel(bereich, liste) {
    const gesehen = {};
    return liste.map(e => {
      const k = natuerlicherSchluessel(bereich, e) || "#" + fingerabdruck(e);
      const n = (gesehen[k] = (gesehen[k] || 0) + 1);
      return n > 1 ? k + "~" + n : k;
    });
  }

  // Neue Einträge bekommen einen Platz zwischen ihren bekannten Nachbarn
  function plaetzeFuellen(platz) {
    const n = platz.length;
    let i = 0;
    while (i < n) {
      if (platz[i] !== null) { i++; continue; }
      let j = i;
      while (j < n && platz[j] === null) j++;
      const vor = i > 0 ? platz[i - 1] : null;
      const nach = j < n ? platz[j] : null;
      const anzahl = j - i;
      for (let t = 0; t < anzahl; t++) {
        if (vor !== null && nach !== null && nach > vor) platz[i + t] = vor + (nach - vor) * (t + 1) / (anzahl + 1);
        else if (vor !== null) platz[i + t] = vor + t + 1;
        else if (nach !== null) platz[i + t] = nach - (anzahl - t);
        else platz[i + t] = t;
      }
      i = j;
    }
    return platz;
  }

  const gueltig = wert => wert !== null && wert !== undefined;

  // Leere Felder und Vorgabewerte (z. B. Anrede „Herr“) werden nicht gespeichert.
  // So gilt ein frisch geöffnetes Gerät nicht als „hat das Profil geändert“.
  const istVorgabe = (wert, vorgabe) =>
    wert === "" || (vorgabe !== undefined && stabil(wert) === stabil(vorgabe));

  // Dokument → einzelne Einträge. schatten = was der Server nach unserem Wissen hat.
  function zerlegen(doc, schatten, standard) {
    const std = standard || {};
    const map = new Map();
    Object.keys(LISTEN).forEach(s => {
      const liste = (Array.isArray(doc[s]) ? doc[s] : []).filter(gueltig);
      const schluessel = listenSchluessel(s, liste);
      const platz = plaetzeFuellen(schluessel.map(k => {
        const sh = schatten[s + T + k];
        return sh && !sh.x ? sh.o : null;
      }));
      liste.forEach((e, i) => map.set(s + T + schluessel[i],
        { s, k: schluessel[i], w: e, h: fingerabdruck(e), o: platz[i] }));
    });
    KARTEN.forEach(s => {
      const karte = doc[s] && typeof doc[s] === "object" ? doc[s] : {};
      Object.keys(karte).forEach(k => {
        const vorgabe = std[s] && k in std[s] ? std[s][k] : (std.jeder || {})[s];
        if (!k || !gueltig(karte[k]) || istVorgabe(karte[k], vorgabe)) return;
        map.set(s + T + k, { s, k, w: karte[k], h: fingerabdruck(karte[k]), o: 0 });
      });
    });
    WERTE.forEach(k => {
      if (!gueltig(doc[k]) || istVorgabe(doc[k], std[k])) return;
      map.set("einstellung" + T + k, { s: "einstellung", k, w: doc[k], h: fingerabdruck(doc[k]), o: 0 });
    });
    return map;
  }

  // Einzelne Einträge → Dokument
  function zusammenbauen(map) {
    const doc = leeresDokument();
    const listen = {};
    map.forEach(e => {
      if (LISTEN[e.s]) (listen[e.s] = listen[e.s] || []).push(e);
      else if (KARTEN.includes(e.s)) doc[e.s][e.k] = e.w;
      else if (e.s === "einstellung" && WERTE.includes(e.k)) doc[e.k] = e.w;
    });
    Object.keys(listen).forEach(s => {
      doc[s] = listen[s]
        .sort((a, b) => (a.o - b.o) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
        .map(e => e.w);
    });
    return doc;
  }

  // Steht eine Liste anders als nach ihren Plätzen sortiert? Dann würde sie auf einem
  // anderen Gerät in anderer Reihenfolge erscheinen.
  function unordentlich(map) {
    const letzter = {};
    let schief = false;
    map.forEach(e => {
      if (!LISTEN[e.s] || SELBST_SORTIERT.includes(e.s)) return;
      const v = letzter[e.s];
      if (v && (v.o > e.o || (v.o === e.o && v.k > e.k))) schief = true;
      letzter[e.s] = e;
    });
    return schief;
  }

  const bekannt = (s, k) =>
    Boolean(LISTEN[s]) || KARTEN.includes(s) || (s === "einstellung" && WERTE.includes(k));

  function istLeer(doc) {
    const p = doc.profil || {};
    return !Object.keys(LISTEN).some(s => (doc[s] || []).length)
      && !String(p.vorname || "").trim() && !String(p.nachname || "").trim();
  }

  // Fingerabdruck ohne Kennung – erkennt denselben Eintrag aus einer alten Datei wieder
  function ohneKennung(eintrag) {
    if (!eintrag || typeof eintrag !== "object") return fingerabdruck(eintrag);
    const c = {};
    Object.keys(eintrag).forEach(k => { if (k !== "id") c[k] = eintrag[k]; });
    return fingerabdruck(c);
  }

  // Datei in den Bestand einfügen: nur ergänzen, was fehlt. Mehrfaches Importieren
  // derselben Datei erzeugt keine Duplikate.
  function ergaenzen(aktuell, datei) {
    const doc = Object.assign(leeresDokument(), kopie(aktuell));
    const leer = istLeer(doc);
    let neu = 0;

    Object.keys(LISTEN).forEach(s => {
      const da = Array.isArray(doc[s]) ? doc[s] : (doc[s] = []);
      const schluessel = new Set(da.map(e => natuerlicherSchluessel(s, e)).filter(Boolean));
      const vorhanden = {};
      da.forEach(e => { const f = ohneKennung(e); vorhanden[f] = (vorhanden[f] || 0) + 1; });
      const gezaehlt = {};

      (Array.isArray(datei[s]) ? datei[s] : []).forEach(e => {
        if (!e || typeof e !== "object") return;
        const k = natuerlicherSchluessel(s, e);
        if (k && schluessel.has(k)) return;
        const f = ohneKennung(e);
        gezaehlt[f] = (gezaehlt[f] || 0) + 1;
        if (gezaehlt[f] <= (vorhanden[f] || 0)) return;
        da.push(kopie(e));
        neu++;
      });
    });

    KARTEN.forEach(s => {
      const quelle = datei[s] && typeof datei[s] === "object" && !Array.isArray(datei[s]) ? datei[s] : {};
      Object.keys(quelle).forEach(k => {
        if (!gueltig(quelle[k])) return;
        const fehlt = !gueltig(doc[s][k]) || doc[s][k] === "";
        if (!fehlt && !(leer && s === "profil")) return;
        if (stabil(doc[s][k]) === stabil(quelle[k])) return;
        doc[s][k] = kopie(quelle[k]);
        if (s !== "profil") neu++;
      });
    });

    if (typeof datei.provSteuer === "number" && (leer || !doc.provSteuer)) doc.provSteuer = datei.provSteuer;
    return { doc, neu };
  }

  /* ---------- Abgleich ---------- */

  function erzeuge(o) {
    // o: { api(methode, pfad, body), lesen(), schreiben(doc, quelle), beschaeftigt(),
    //      ablage: { get(), set(text), del() }, aufStatus(status), standard, warte(fn, ms), stopp(id) }
    const warte = o.warte || ((fn, ms) => setTimeout(fn, ms));
    const stopp = o.stopp || (id => clearTimeout(id));

    const z = { rev: 0, schatten: {}, konflikte: {} };
    let geladen = false;        // mindestens einmal vollständig abgeglichen
    let schmutzig = false;      // lokale Änderungen warten
    let laeuft = null;
    let nochmal = false;
    let wartend = [];           // Serverstände aus abgewiesenen Schreibversuchen
    let uhr = null;
    let gestoppt = false;
    let fehlversuche = 0;
    let letzter = 0;
    let zustand = { art: "start", text: "" };
    let ablageOk = true;

    function melde(art, text) {
      zustand = { art, text: text || "", konflikte: Object.keys(z.konflikte).length, zuletzt: letzter, ablageOk };
      if (o.aufStatus) o.aufStatus(zustand);
    }

    function lage() {
      if (gestoppt && zustand.art === "gesperrt") return melde("gesperrt");
      if (Object.keys(z.konflikte).length) return melde("konflikt");
      if (schmutzig || laeuft) return melde("speichert");
      melde("ok");
    }

    function ablegen(doc) {
      try {
        o.ablage.set(JSON.stringify({ v: 1, rev: z.rev, schatten: z.schatten, konflikte: z.konflikte, doc: doc || o.lesen() }));
        ablageOk = true;
      } catch (e) {
        ablageOk = false;       // Speicher voll oder gesperrt: Cloud läuft trotzdem weiter
      }
    }

    function planen(ms) {
      if (gestoppt) return;
      stopp(uhr);
      uhr = warte(() => { uhr = null; abgleichen(); }, ms);
    }

    const istNeu = it => {
      if (!bekannt(it.s, it.k)) return false;
      const sh = z.schatten[it.s + T + it.k];
      return !(sh && it.v <= sh.v);
    };

    // Einen Serverstand einarbeiten. true = der lokale Bestand hat sich geändert.
    function verarbeite(it, lokal) {
      if (!istNeu(it)) return false;
      const id = it.s + T + it.k;
      const sh = z.schatten[id];
      const fernH = it.x ? null : fingerabdruck(it.d);
      const lok = lokal.get(id);
      const lokH = lok ? lok.h : null;
      const basisH = sh && !sh.x ? sh.h : null;
      const neuerSchatten = { v: it.v, h: fernH, o: it.o, x: it.x ? 1 : 0 };
      const kf = z.konflikte[id];

      if (kf) {                                   // schon offen: neuesten Fremdstand merken
        if (lokH === fernH) { delete z.konflikte[id]; z.schatten[id] = neuerSchatten; return false; }
        Object.assign(kf, { v: it.v, o: it.o, x: it.x ? 1 : 0, d: it.x ? null : it.d });
        return false;
      }
      if (lokH === basisH) {                      // hier unverändert → übernehmen
        z.schatten[id] = neuerSchatten;
        if (it.x) { if (!lok) return false; lokal.delete(id); return true; }
        if (lokH === fernH) { lok.o = it.o; return false; }
        lokal.set(id, { s: it.s, k: it.k, w: it.d, h: fernH, o: it.o });
        return true;
      }
      if (lokH === fernH) {                       // beide gleich geändert
        z.schatten[id] = neuerSchatten;
        if (lok) lok.o = it.o;
        return false;
      }
      if (!sh && it.x) { z.schatten[id] = neuerSchatten; return false; }         // alte Löschmarke, hier neu angelegt
      z.konflikte[id] = { s: it.s, k: it.k, v: it.v, o: it.o, x: it.x ? 1 : 0, d: it.x ? null : it.d };
      return false;
    }

    // Konflikte, die sich von selbst erledigt haben (beide Seiten inzwischen gleich)
    function konflikteNachpruefen(lokal) {
      Object.keys(z.konflikte).forEach(id => {
        const kf = z.konflikte[id];
        const fernH = kf.x ? null : fingerabdruck(kf.d);
        const lok = lokal.get(id);
        if ((lok ? lok.h : null) !== fernH) return;
        z.schatten[id] = { v: kf.v, h: fernH, o: kf.o, x: kf.x };
        delete z.konflikte[id];
      });
    }

    function unterschiede(lokal) {
      const ops = [];
      lokal.forEach((e, id) => {
        if (z.konflikte[id]) return;
        const sh = z.schatten[id];
        const basisH = sh && !sh.x ? sh.h : null;
        if (e.h !== basisH) ops.push({ id, s: e.s, k: e.k, d: e.w, h: e.h, o: e.o, b: sh ? sh.v : 0, x: 0 });
      });
      Object.keys(z.schatten).forEach(id => {
        const sh = z.schatten[id];
        if (sh.x || lokal.has(id) || z.konflikte[id]) return;
        const i = id.indexOf(T);
        ops.push({ id, s: id.slice(0, i), k: id.slice(i + 1), h: null, o: sh.o, b: sh.v, x: 1 });
      });
      return ops.sort((a, b) => (RANG[a.s] - RANG[b.s]) || (a.o - b.o));
    }

    async function runde() {
      const antwort = await o.api("GET", "/s5/pull?since=" + z.rev);

      // Der Server kennt weniger als wir: Datenbank wurde zurückgesetzt. Dann zählt der
      // Stand dieses Geräts als neu und wird wieder hochgeladen.
      if ((Number(antwort.rev) || 0) < z.rev) {
        z.rev = 0; z.schatten = {}; z.konflikte = {};
        schmutzig = true; nochmal = true;
        return true;
      }
      const eingang = wartend.concat(antwort.items || []);
      const hatFern = eingang.some(istNeu);

      // Während ein Formular offen ist oder getippt wird, nichts unter den Händen austauschen
      if (hatFern && geladen && o.beschaeftigt && o.beschaeftigt()) {
        planen(4000);
        return true;
      }
      wartend = [];

      let doc = null;
      let lokal = null;
      if (hatFern || schmutzig || !geladen || Object.keys(z.konflikte).length) {
        doc = o.lesen();
        lokal = zerlegen(doc, z.schatten, o.standard);
      }
      const wolltenSpeichern = schmutzig;
      schmutzig = false;

      let fern = false;
      if (hatFern) eingang.forEach(it => { if (verarbeite(it, lokal)) fern = true; });
      z.rev = Math.max(z.rev, Number(antwort.rev) || 0);

      // Gleiche Reihenfolge auf allen Geräten – aber nie, während ein Formular offen ist
      if (lokal && !fern && unordentlich(lokal) && !(geladen && o.beschaeftigt && o.beschaeftigt())) fern = true;

      if (fern) {
        doc = zusammenbauen(lokal);
        o.schreiben(doc, "cloud");
      }
      geladen = true;

      if (lokal) {
        konflikteNachpruefen(lokal);
        const ops = unterschiede(lokal);
        ablegen(doc);
        if (ops.length) melde("speichert");

        try {
          for (let i = 0; i < ops.length; i += MAX_OPS) {
            const teil = ops.slice(i, i + MAX_OPS);
            const r = await o.api("POST", "/s5/push", {
              ops: teil.map(op => (op.x ? { s: op.s, k: op.k, x: 1, o: op.o, b: op.b } : { s: op.s, k: op.k, d: op.d, o: op.o, b: op.b }))
            });
            const nachId = {};
            teil.forEach(op => { nachId[op.s + T + op.k] = op; });
            (r.applied || []).forEach(a => {
              const op = nachId[a.s + T + a.k];
              if (op) z.schatten[op.id] = { v: a.v, h: op.h, o: op.o, x: op.x ? 1 : 0 };
            });
            if ((r.conflicts || []).length) { wartend = wartend.concat(r.conflicts); nochmal = true; }
            // Lag zwischen Abholen und Schreiben kein fremder Schreibvorgang, kennen wir den Stand bereits
            if (Number(r.rev) === z.rev + 1) z.rev = Number(r.rev);
            ablegen();
          }
        } catch (e) {
          if (ops.length || wolltenSpeichern) schmutzig = true;
          throw e;
        }
      }

      letzter = Date.now();
      fehlversuche = 0;
      return true;
    }

    function abgleichen() {
      if (gestoppt) return Promise.resolve(false);
      if (laeuft) { nochmal = true; return laeuft; }
      stopp(uhr); uhr = null;

      laeuft = runde().then(() => true, e => {
        const status = e && e.status;
        if (status === 403) { gestoppt = true; zustand = { art: "gesperrt" }; return false; }
        fehlversuche++;
        if (status === 400 || status === 413) {
          melde("fehler", (e && e.message) || "Speichern abgelehnt");
          planen(60000);
        } else {
          melde("offline");
          planen(Math.min(60000, 3000 * Math.pow(2, Math.min(fehlversuche - 1, 5))));
        }
        return false;
      }).then(ok => {
        laeuft = null;
        if (ok && nochmal && !gestoppt) { nochmal = false; return abgleichen(); }
        nochmal = false;
        if (ok || gestoppt) lage();
        return ok;
      });
      return laeuft;
    }

    return {
      // Gespeicherten Stand dieses Geräts laden (auch offline nutzbar), dann abgleichen
      start() {
        let cache = null;
        try { cache = JSON.parse(o.ablage.get() || "null"); } catch (e) {}
        const ausCache = Boolean(cache && cache.v === 1 && cache.doc);
        if (ausCache) {
          z.rev = Number(cache.rev) || 0;
          z.schatten = cache.schatten || {};
          z.konflikte = cache.konflikte || {};
          o.schreiben(cache.doc, "cache");
          schmutzig = true;                       // offline Geändertes könnte warten
        }
        return abgleichen().then(ok => ({ ok, ausCache, gesperrt: gestoppt && zustand.art === "gesperrt" }));
      },

      // Die App hat etwas geändert
      geaendert() {
        if (gestoppt) return;
        schmutzig = true;
        ablegen();
        if (!Object.keys(z.konflikte).length) melde("speichert");
        planen(700);
      },

      abgleichen,

      konflikte() {
        const lokal = zerlegen(o.lesen(), z.schatten, o.standard);
        return Object.keys(z.konflikte).map(id => {
          const kf = z.konflikte[id];
          const lok = lokal.get(id);
          return { id, s: kf.s, k: kf.k, mein: lok ? lok.w : undefined, deren: kf.x ? undefined : kf.d };
        });
      },

      // wahl: "mein" (Stand dieses Geräts gilt) oder "deren" (Stand des anderen Geräts gilt)
      loesen(id, wahl) {
        const kf = z.konflikte[id];
        if (!kf) return;
        const fernH = kf.x ? null : fingerabdruck(kf.d);
        z.schatten[id] = { v: kf.v, h: fernH, o: kf.o, x: kf.x };
        delete z.konflikte[id];
        if (wahl === "deren") {
          const lokal = zerlegen(o.lesen(), z.schatten, o.standard);
          if (kf.x) lokal.delete(id);
          else lokal.set(id, { s: kf.s, k: kf.k, w: kf.d, h: fernH, o: kf.o });
          o.schreiben(zusammenbauen(lokal), "cloud");
        }
        schmutzig = true;
        ablegen();
        lage();
        return abgleichen();
      },

      status: () => zustand,
      offen: () => schmutzig || Boolean(laeuft),
      cloudLeer: () => !Object.keys(z.schatten).some(id => !z.schatten[id].x),
      bereit: () => geladen,
      ablageOk: () => ablageOk,

      stop() {
        gestoppt = true;
        stopp(uhr); uhr = null;
      }
    };
  }

  const Kern = { erzeuge, zerlegen, zusammenbauen, ergaenzen, istLeer, leeresDokument, fingerabdruck, stabil, listenSchluessel };

  if (typeof module !== "undefined" && module.exports) { module.exports = Kern; return; }

  /* =====================================================================
     Teil 2 – Oberfläche
     ===================================================================== */

  const API = "https://smartadm-office-api.betcherkimg.workers.dev";
  const APP_URL = "/smartadm/sales/";
  const ABLAGE = "smartadm.cloud.v1.";
  const TAKT_MS = 20000;                    // so oft wird nach Änderungen anderer Geräte geschaut

  const $ = id => document.getElementById(id);
  let app = null;                           // Brücke zur App (window.SmartApp)
  let motor = null;
  let aktiverNutzer = null;
  let anmeldungSichtbar = false;
  let knopfSichtbar = false;
  let konfliktGezeigt = false;

  async function api(methode, pfad, body) {
    const token = await root.Clerk.session.getToken();
    if (!token) { const e = new Error("Nicht angemeldet"); e.status = 401; throw e; }
    const text = body ? JSON.stringify(body) : undefined;
    const antwort = await fetch(API + pfad, {
      method: methode,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: text,
      cache: "no-store",
      keepalive: Boolean(text) && text.length < 60000
    });
    const daten = await antwort.json().catch(() => null);
    if (!antwort.ok) {
      const e = new Error((daten && daten.error) || "HTTP " + antwort.status);
      e.status = antwort.status;
      throw e;
    }
    return daten || {};
  }

  /* ---------- Anmeldeschirm ---------- */

  // zustand: pruefen | anmelden | laden | gesperrt | offline | fehler
  function schirm(zustand, text) {
    const login = $("login");
    login.hidden = false;
    login.dataset.zustand = zustand;
    $("login-hinweis").textContent = text || "";
    $("login-abmelden").hidden = zustand !== "gesperrt";
    $("login-nochmal").hidden = zustand !== "offline" && zustand !== "fehler";
    document.body.classList.remove("angemeldet");
    hintergrundSperren(true);
  }

  function schirmWeg() {
    $("login").hidden = true;
    document.body.classList.add("angemeldet");
    hintergrundSperren(false);
  }

  // Solange der Anmeldeschirm steht, ist die App dahinter nicht bedienbar
  function hintergrundSperren(an) {
    Array.from(document.body.children).forEach(el => {
      if (el.id === "login" || el.tagName === "SCRIPT" || el.id === "toast") return;
      if (an) { el.inert = true; el.dataset.loginSperre = "1"; }
      else if (el.dataset.loginSperre) { el.inert = false; delete el.dataset.loginSperre; }
    });
  }

  function anmeldungZeigen() {
    schirm("anmelden");
    if (anmeldungSichtbar) return;
    root.Clerk.mountSignIn($("login-clerk"), {
      routing: "hash",
      withSignUp: false,
      forceRedirectUrl: APP_URL,
      fallbackRedirectUrl: APP_URL,
      appearance: { variables: { colorPrimary: "#0D417F", borderRadius: "12px" } }
    });
    anmeldungSichtbar = true;
  }

  function anmeldungWeg() {
    if (!anmeldungSichtbar) return;
    try { root.Clerk.unmountSignIn($("login-clerk")); } catch (e) {}
    anmeldungSichtbar = false;
  }

  const symbol = pfad => el => {
    el.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + pfad + "</svg>";
  };

  function profilKnopfZeigen() {
    if (knopfSichtbar) return;
    root.Clerk.mountUserButton($("clerk-user"), {
      afterSignOutUrl: APP_URL,
      customMenuItems: [
        { label: "Profil bearbeiten", onClick: () => app.profilOeffnen(),
          mountIcon: symbol('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5"/>'), unmountIcon: () => {} },
        { label: "Datenspeicher", onClick: () => speicherOeffnen(),
          mountIcon: symbol('<path d="M7 18a4 4 0 0 1-.6-7.96 5.5 5.5 0 0 1 10.7 1.2A3.5 3.5 0 0 1 17 18Z"/>'), unmountIcon: () => {} },
        { label: "manageAccount" },
        { label: "signOut" }
      ]
    });
    knopfSichtbar = true;
  }

  /* ---------- Statusanzeige ---------- */

  // [ausführlich, kurz fürs Handy]
  const STATUS_TEXT = {
    speichert: ["Speichert …", "Speichert …"],
    offline: ["Offline – Änderungen warten", "Offline"],
    konflikt: ["Konflikt klären", "Konflikt"],
    fehler: ["Speicherfehler", "Fehler"]
  };

  function statusZeigen(s) {
    const feld = $("cloud-stand");
    const text = STATUS_TEXT[s.art];
    feld.hidden = !text;
    feld.textContent = "";
    (text || []).forEach((t, i) => {
      const teil = document.createElement("span");
      teil.className = i ? "kurz" : "lang";
      teil.textContent = t;
      feld.appendChild(teil);
    });
    feld.dataset.art = s.art;
    feld.title = s.art === "fehler" ? s.text : (s.art === "offline" ? "Wird gespeichert, sobald wieder Verbindung besteht." : "");
    speicherStand();

    if (s.art === "konflikt" && !konfliktGezeigt && !app.beschaeftigt()) konfliktZeigen();
    if (s.art !== "konflikt") konfliktGezeigt = false;
  }

  const uhrzeit = ms => new Date(ms).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  function speicherStand() {
    const feld = $("speicher-stand");
    if (!feld || !motor) return;
    const s = motor.status();
    const texte = {
      ok: "Alles in der Cloud gespeichert" + (s.zuletzt ? " · zuletzt abgeglichen " + uhrzeit(s.zuletzt) : ""),
      speichert: "Änderungen werden gespeichert …",
      offline: "Keine Verbindung – deine Änderungen liegen auf diesem Gerät und werden nachgereicht.",
      konflikt: "Ein Eintrag wurde auf zwei Geräten unterschiedlich geändert – bitte klären.",
      fehler: "Speichern abgelehnt: " + (s.text || "unbekannter Fehler")
    };
    feld.textContent = texte[s.art] || "Verbindung wird aufgebaut …";
    feld.className = "speicher-stand " + (s.art === "ok" ? "aktiv" : (s.art === "speichert" ? "" : "warn"));
  }

  function speicherOeffnen() {
    speicherStand();
    app.oeffnen("veil-speicher");
  }

  /* ---------- Import ---------- */

  function dateiWaehlen() {
    const eingabe = $("datei-eingabe");
    eingabe.value = "";
    eingabe.click();
  }

  function dateiGewaehlt() {
    const datei = $("datei-eingabe").files && $("datei-eingabe").files[0];
    if (!datei) return;
    datei.text().then(text => {
      let daten = null;
      try { daten = JSON.parse(text); } catch (e) {}
      const felder = ["profil", "banken", "bma", "termine", "abstimmung", "provisionen", "provArchiv", "auswertung"];
      if (!daten || typeof daten !== "object" || Array.isArray(daten) || !felder.some(f => daten[f])) {
        app.melden("Das ist keine SmartADM-Datei.");
        return;
      }
      einfuegen(daten, datei.name);
    }).catch(() => app.melden("Die Datei konnte nicht gelesen werden."));
  }

  function einfuegen(daten, name) {
    const aktuell = app.lesen();
    const tun = () => {
      const ergebnis = Kern.ergaenzen(aktuell, app.normalisieren(daten));
      app.uebernehmen(ergebnis.doc);
      $("start").hidden = true;
      document.body.style.overflow = "";
      app.schliessen("veil-speicher");
      app.melden(ergebnis.neu
        ? ergebnis.neu + (ergebnis.neu === 1 ? " Eintrag" : " Einträge") + " aus " + name + " übernommen"
        : "Alles aus " + name + " ist bereits vorhanden");
    };
    if (Kern.istLeer(aktuell)) { tun(); return; }
    app.schliessen("veil-speicher");
    app.frage("Es sind bereits Daten gespeichert. Aus der Datei werden nur Einträge ergänzt, "
      + "die noch fehlen – vorhandene bleiben unverändert.", "Ergänzen", tun);
  }

  function allesLoeschen() {
    app.schliessen("veil-speicher");
    app.frage("Alle SmartADM-Daten werden auf allen Geräten gelöscht. Lade vorher eine Sicherung herunter – "
      + "das lässt sich nicht rückgängig machen.", "Alles löschen", () => {
      app.uebernehmen(Kern.leeresDokument());
      app.melden("Alle Daten gelöscht");
      startZeigen();
    });
  }

  /* ---------- Erster Start ---------- */

  function startZeigen() {
    $("start-alt").hidden = !app.altbestand();
    $("start").hidden = false;
    document.body.style.overflow = "hidden";
  }

  function startWeg() {
    $("start").hidden = true;
    document.body.style.overflow = "";
  }

  /* ---------- Konflikte ---------- */

  const BEREICH_NAME = {
    termine: "Termin", auswertung: "Termin in der Auswertung", banken: "Bank", bma: "Bankmitarbeiter",
    provisionen: "Provisionseintrag", provArchiv: "Provisions-Archiv", abstimmung: "Adressabstimmung",
    profil: "Profil", einstellung: "Einstellung"
  };
  const FELD_NAME = {
    kunde: "Kunde", datum: "Datum", protokoll: "Protokoll", wv: "Wiedervorlage", status: "Status", ort: "Ort",
    bma: "Bankmitarbeiter", terminart: "Terminart", personen: "Personen", gespraechPersonen: "Gesprächspartner",
    name: "Name", adresse: "Adresse", blz: "BLZ", betreuung: "Betreuung", bank: "Bank", rolle: "Rolle",
    mail: "E-Mail", telefon: "Telefon", mobil: "Mobil", wvFertig: "Wiedervorlage erledigt", betrag: "Betrag",
    art: "Art", vorname: "Vorname", nachname: "Nachname", strasse: "Straße", plz: "PLZ", vo: "VO-Nummer",
    gebiet: "Gebiet", funktion: "Funktion", anrede: "Anrede", bild: "Profilbild", provSteuer: "Steuersatz"
  };

  function datumDe(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "." + m[2] + "." + m[1] : String(iso || "");
  }

  function titelVon(k) {
    const w = k.mein !== undefined ? k.mein : k.deren;
    const name = BEREICH_NAME[k.s] || k.s;
    if (k.s === "profil" || k.s === "einstellung") return name + ": " + (FELD_NAME[k.k] || k.k);
    if (k.s === "abstimmung") return name + ": " + k.k;
    if (!w || typeof w !== "object") return name;
    if (k.s === "termine" || k.s === "auswertung") return name + ": " + [w.kunde, datumDe(w.datum)].filter(Boolean).join(" · ");
    return name + ": " + (w.name || w.kunde || w.monat || k.k);
  }

  function kurz(wert) {
    if (wert === undefined || wert === null || wert === "") return "–";
    if (typeof wert === "boolean") return wert ? "ja" : "nein";
    let text = typeof wert === "object" ? JSON.stringify(wert) : String(wert);
    if (/^data:image\//.test(text)) return "(Bild)";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = datumDe(text);
    return text.length > 220 ? text.slice(0, 220) + " …" : text;
  }

  function zeile(tabelle, feld, mein, deren) {
    const tr = document.createElement("tr");
    [feld, mein, deren].forEach((text, i) => {
      const zelle = document.createElement(i ? "td" : "th");
      zelle.textContent = text;
      tr.appendChild(zelle);
    });
    tabelle.appendChild(tr);
  }

  function konfliktZeigen() {
    const liste = motor ? motor.konflikte() : [];
    if (!liste.length) { app.schliessen("veil-konflikt"); return; }
    konfliktGezeigt = true;

    const k = liste[0];
    $("konflikt-zaehler").textContent = liste.length > 1 ? "Noch " + liste.length + " offen" : "";
    $("konflikt-titel").textContent = titelVon(k);

    const tabelle = $("konflikt-tabelle");
    tabelle.textContent = "";
    zeile(tabelle, "", "Dieses Gerät", "Anderes Gerät");

    const beideObjekte = [k.mein, k.deren].every(w => w && typeof w === "object" && !Array.isArray(w));
    if (k.mein === undefined) zeile(tabelle, "Eintrag", "gelöscht", "geändert");
    else if (k.deren === undefined) zeile(tabelle, "Eintrag", "geändert", "gelöscht");
    else if (beideObjekte) {
      Array.from(new Set(Object.keys(k.mein).concat(Object.keys(k.deren)))).forEach(feld => {
        if (Kern.stabil(k.mein[feld]) === Kern.stabil(k.deren[feld])) return;
        zeile(tabelle, FELD_NAME[feld] || feld, kurz(k.mein[feld]), kurz(k.deren[feld]));
      });
    } else zeile(tabelle, "Inhalt", kurz(k.mein), kurz(k.deren));

    $("konflikt-mein").onclick = () => entscheiden(k.id, "mein");
    $("konflikt-deren").onclick = () => entscheiden(k.id, "deren");
    app.oeffnen("veil-konflikt");
  }

  function entscheiden(id, wahl) {
    motor.loesen(id, wahl);
    if (motor.konflikte().length) konfliktZeigen();
    else { app.schliessen("veil-konflikt"); app.melden("Geklärt"); }
  }

  /* ---------- Sitzung ---------- */

  const ablageFuer = nutzer => ({
    get: () => root.localStorage.getItem(ABLAGE + nutzer),
    set: text => root.localStorage.setItem(ABLAGE + nutzer, text),
    del: () => { try { root.localStorage.removeItem(ABLAGE + nutzer); } catch (e) {} }
  });

  async function sitzungStarten(nutzer) {
    if (aktiverNutzer === nutzer.id) return;
    aktiverNutzer = nutzer.id;
    anmeldungWeg();
    profilKnopfZeigen();
    app.leeren();
    schirm("laden", "Daten werden geladen …");

    const ablage = ablageFuer(nutzer.id);
    const eigener = Kern.erzeuge({
      api, ablage,
      standard: app.standard,
      lesen: app.lesen,
      schreiben: app.schreiben,
      beschaeftigt: app.beschaeftigt,
      aufStatus: s => { if (motor === eigener) statusZeigen(s); }
    });
    motor = eigener;

    const ergebnis = await eigener.start();
    if (motor !== eigener) return;            // inzwischen abgemeldet

    if (ergebnis.gesperrt) {
      ablage.del();
      app.leeren();
      schirm("gesperrt", "Dieses Konto hat keinen Zugriff auf SmartADM 5.");
      return;
    }
    if (!ergebnis.ok && !ergebnis.ausCache) {
      schirm("offline", "Keine Verbindung. Für den ersten Abgleich auf diesem Gerät wird Internet gebraucht.");
      return;
    }

    schirmWeg();
    statusZeigen(eigener.status());
    if (ergebnis.ok && eigener.cloudLeer() && Kern.istLeer(app.lesen())) startZeigen();
  }

  function sitzungBeenden() {
    if (motor) {
      const nutzer = aktiverNutzer;
      const offen = motor.offen();
      motor.stop();
      // Ungespeichertes bleibt auf dem Gerät und wird bei der nächsten Anmeldung nachgereicht
      if (!offen && nutzer) ablageFuer(nutzer).del();
      motor = null;
    }
    aktiverNutzer = null;
    if (app) { app.leeren(); startWeg(); }
    anmeldungZeigen();
  }

  function sitzungPruefen() {
    const C = root.Clerk;
    if (C.session && C.user) sitzungStarten(C.user);
    else if (aktiverNutzer || !anmeldungSichtbar) sitzungBeenden();
  }

  /* ---------- Start ---------- */

  function verdrahten() {
    $("cloud-stand").addEventListener("click", () => {
      const art = motor && motor.status().art;
      if (art === "konflikt") konfliktZeigen();
      else if (art === "offline" || art === "fehler") { speicherOeffnen(); motor.abgleichen(); }
    });

    $("datei-import").addEventListener("click", dateiWaehlen);
    $("datei-eingabe").addEventListener("change", dateiGewaehlt);
    $("daten-loeschen").addEventListener("click", allesLoeschen);

    $("start-import").addEventListener("click", dateiWaehlen);
    $("start-alt").addEventListener("click", () => {
      const alt = app.altbestand();
      if (alt) einfuegen(alt, "diesem Browser");
    });
    $("start-neu").addEventListener("click", () => {
      startWeg();
      app.profilOeffnen();
      app.melden("Bitte trage zuerst dein Profil ein");
    });

    $("login-abmelden").addEventListener("click", () => root.Clerk.signOut({ redirectUrl: APP_URL }));
    $("login-nochmal").addEventListener("click", () => {
      const nutzer = root.Clerk && root.Clerk.user;
      if (!root.Clerk || !root.Clerk.loaded) { root.location.reload(); return; }
      if (motor) motor.stop();
      motor = null;
      aktiverNutzer = null;
      if (nutzer) sitzungStarten(nutzer); else sitzungPruefen();
    });

    // Regelmäßig und beim Zurückkehren nach Änderungen anderer Geräte schauen
    setInterval(() => {
      if (motor && document.visibilityState === "visible") motor.abgleichen();
    }, TAKT_MS);
    const sofort = () => { if (motor) motor.abgleichen(); };
    document.addEventListener("visibilitychange", sofort);
    root.addEventListener("focus", sofort);
    root.addEventListener("online", sofort);
    root.addEventListener("pagehide", sofort);

    root.addEventListener("beforeunload", e => {
      // Ungespeichertes liegt im Gerätespeicher. Nur wenn der gesperrt ist, nachfragen.
      if (!motor || !motor.offen() || motor.ablageOk()) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  root.SmartCloud = {
    Kern,
    geaendert: () => { if (motor) motor.geaendert(); },
    // Strg+S: sofort abgleichen
    jetzt: () => {
      if (!motor) return;
      motor.abgleichen().then(ok => app.melden(ok
        ? "In der Cloud gespeichert"
        : "Keine Verbindung – wird gespeichert, sobald sie wieder da ist"));
    },
    speicherOeffnen,
    konfliktZeigen
  };

  root.addEventListener("load", async () => {
    app = root.SmartApp;
    verdrahten();
    schirm("pruefen");
    try {
      if (!root.Clerk) throw new Error("Clerk fehlt");
      await root.Clerk.load({ ui: { ClerkUI: root.__internal_ClerkUICtor }, afterSignOutUrl: APP_URL });
      sitzungPruefen();
      if (root.Clerk.addListener) root.Clerk.addListener(sitzungPruefen);
    } catch (e) {
      console.error("Clerk konnte nicht geladen werden:", e);
      schirm("fehler", "Die Anmeldung konnte nicht geladen werden. Bitte Verbindung prüfen.");
    }
  });
})(typeof window !== "undefined" ? window : globalThis);
