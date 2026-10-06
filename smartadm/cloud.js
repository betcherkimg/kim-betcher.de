(() => {
  "use strict";

  const API = "https://smartadm-office-api.betcherkimg.workers.dev";
  const APP_URL = "/smartadm/";
  const ALLOWED_USER_ID = "user_3JMu8X64anaxeyWQBKl9OQz6Q5G";
  const SECTION_NAMES = [
    "profil", "banken", "bma", "termine", "abstimmung",
    "provisionen", "provArchiv", "provSteuer", "auswertung"
  ];

  const state = {
    versions: Object.fromEntries(SECTION_NAMES.map(k => [k, 0])),
    json: Object.fromEntries(SECTION_NAMES.map(k => [k, null])),
    saving: false,
    queued: false,
    applying: false,
    conflict: null,
    booted: false,
    pollTimer: null,
    saveTimer: null
  };

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function snapshot() {
    return {
      profil: window.PROFIL,
      banken: window.BANKEN,
      bma: window.BMA,
      termine: window.TERMINE,
      abstimmung: window.ABSTIMMUNG,
      provisionen: window.PROVISIONEN,
      provArchiv: window.PROV_ARCHIV,
      provSteuer: window.PROV_STEUER,
      auswertung: window.AUSWERTUNG
    };
  }

  function stable(value) {
    return JSON.stringify(value == null ? null : value);
  }

  async function token() {
    const t = await window.Clerk?.session?.getToken();
    if (!t) throw new Error("Nicht angemeldet.");
    return t;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${await token()}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(`${API}${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || `HTTP ${res.status}`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return data;
  }

  function redraw() {
    try { window.terminArtErgaenzen?.(); } catch {}
    try { if (window.LISTEN?.bank) window.LISTEN.bank.daten = window.BANKEN; } catch {}
    try { if (window.LISTEN?.bma) window.LISTEN.bma.daten = window.BMA; } catch {}
    try { window.termineSortieren?.(); } catch {}
    try { window.awAbgleichen?.(); } catch {}
    try { window.profilAnzeigen?.(); } catch {}
    try { window.kopfAktualisieren?.(); } catch {}
    try { window.zeichnen?.(); } catch {}
    try { window.awZeichnen?.(); } catch {}
  }

  function setSection(name, value) {
    switch (name) {
      case "profil": window.PROFIL = value; break;
      case "banken": window.BANKEN = value; break;
      case "bma": window.BMA = value; break;
      case "termine": window.TERMINE = value; break;
      case "abstimmung": window.ABSTIMMUNG = value; break;
      case "provisionen": window.PROVISIONEN = value; break;
      case "provArchiv": window.PROV_ARCHIV = value; break;
      case "provSteuer": window.PROV_STEUER = value; break;
      case "auswertung": window.AUSWERTUNG = value; break;
    }
  }

  function storageStatus(text, cls = "") {
    const el = $("speicher-stand");
    if (!el) return;
    el.textContent = text;
    el.className = `speicher-stand ${cls}`.trim();
  }

  async function fetchCloud() {
    return api("/smartadm5/data");
  }

  function applyCloud(payload, { onlyNewer = false } = {}) {
    let changed = false;
    state.applying = true;
    try {
      for (const name of SECTION_NAMES) {
        const row = payload.sections?.[name];
        if (!row) continue;
        if (onlyNewer && Number(row.version || 0) <= Number(state.versions[name] || 0)) continue;
        setSection(name, row.data);
        state.versions[name] = Number(row.version || 0);
        state.json[name] = stable(row.data);
        changed = true;
      }
    } finally {
      state.applying = false;
    }
    if (changed) redraw();
    return changed;
  }

  async function saveSection(name, data, force = false) {
    const body = {
      data,
      expectedVersion: Number(state.versions[name] || 0),
      force
    };
    const result = await api(`/smartadm5/sections/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    state.versions[name] = Number(result.version || 0);
    state.json[name] = stable(data);
  }

  async function flush() {
    if (!state.booted || state.applying || state.conflict) return;
    if (state.saving) { state.queued = true; return; }
    state.saving = true;
    storageStatus("Cloudspeicherung läuft …");
    try {
      const snap = snapshot();
      for (const name of SECTION_NAMES) {
        const now = stable(snap[name]);
        if (now === state.json[name]) continue;
        try {
          await saveSection(name, snap[name], false);
        } catch (e) {
          if (e.status === 409 && e.data?.conflict) {
            state.conflict = { name, local: snap[name], remote: e.data.current };
            showConflict();
            storageStatus("Synchronisierung angehalten: Konflikt erkannt.", "warn");
            return;
          }
          throw e;
        }
      }
      storageStatus("Automatisch in der Cloud gespeichert.", "aktiv");
    } catch (e) {
      console.error("SmartADM5 Cloud-Speicherfehler:", e);
      storageStatus("Cloudspeicherung fehlgeschlagen. Änderungen bleiben lokal geöffnet.", "warn");
    } finally {
      state.saving = false;
      if (state.queued) {
        state.queued = false;
        setTimeout(flush, 50);
      }
    }
  }

  function queueSave() {
    if (!state.booted || state.applying) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flush, 450);
  }

  async function poll() {
    if (!state.booted || state.saving || state.conflict || document.hidden) return;
    try {
      const payload = await fetchCloud();
      const local = snapshot();
      for (const name of SECTION_NAMES) {
        const row = payload.sections?.[name];
        if (!row || Number(row.version || 0) <= Number(state.versions[name] || 0)) continue;
        const localChanged = stable(local[name]) !== state.json[name];
        if (localChanged) {
          state.conflict = { name, local: local[name], remote: row };
          showConflict();
          storageStatus("Synchronisierung angehalten: Änderung auf einem anderen Gerät erkannt.", "warn");
          return;
        }
      }
      if (applyCloud(payload, { onlyNewer: true })) storageStatus("Cloudstand aktualisiert.", "aktiv");
    } catch (e) {
      console.warn("SmartADM5 Cloud-Abgleich fehlgeschlagen:", e);
    }
  }

  function ensureConflictUi() {
    if ($("cloud-conflict")) return;
    const wrap = document.createElement("div");
    wrap.id = "cloud-conflict";
    wrap.className = "cloud-conflict";
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="cloud-conflict-card" role="dialog" aria-modal="true" aria-labelledby="cloud-conflict-title">
        <h3 id="cloud-conflict-title">Änderung auf zwei Geräten</h3>
        <p>Dieser Datenbereich wurde auf einem anderen Gerät verändert. Wähle, welcher Stand erhalten bleiben soll. Es wird nichts automatisch überschrieben.</p>
        <div class="cloud-conflict-actions">
          <button class="btn" id="cloud-use-remote" type="button">Cloud-Version übernehmen</button>
          <button class="btn btn-quiet" id="cloud-use-local" type="button">Meine Version behalten</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    $("cloud-use-remote").addEventListener("click", () => {
      const c = state.conflict;
      if (!c) return;
      const row = c.remote;
      setSection(c.name, row.data);
      state.versions[c.name] = Number(row.version || 0);
      state.json[c.name] = stable(row.data);
      state.conflict = null;
      wrap.hidden = true;
      redraw();
      storageStatus("Cloud-Version übernommen.", "aktiv");
    });

    $("cloud-use-local").addEventListener("click", async () => {
      const c = state.conflict;
      if (!c) return;
      try {
        state.versions[c.name] = Number(c.remote?.version || state.versions[c.name] || 0);
        await saveSection(c.name, c.local, true);
        setSection(c.name, c.local);
        state.conflict = null;
        wrap.hidden = true;
        redraw();
        storageStatus("Deine Version wurde in der Cloud gespeichert.", "aktiv");
      } catch (e) {
        console.error(e);
        storageStatus("Konflikt konnte nicht aufgelöst werden.", "warn");
      }
    });
  }

  function showConflict() {
    ensureConflictUi();
    $("cloud-conflict").hidden = false;
  }

  async function importJson(file) {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = await api("/smartadm5/import", {
      method: "POST",
      body: JSON.stringify({ data: parsed })
    });
    applyCloud(result);
    try { window.SPEICHER?.schreiben?.("smartadm.eingerichtet", "ja"); } catch {}
    try { $("start").hidden = true; document.body.style.overflow = ""; } catch {}
    storageStatus("JSON erfolgreich importiert. Ab jetzt wird automatisch in der Cloud gespeichert.", "aktiv");
    window.melden?.("Daten wurden in die Cloud importiert");
  }

  function wireStorage() {
    $("cloud-storage-btn")?.addEventListener("click", () => {
      window.oeffnen?.("veil-speicher");
      storageStatus("Automatische Cloudspeicherung aktiv.", "aktiv");
    });
    $("cloud-import")?.addEventListener("click", () => $("cloud-import-file")?.click());
    $("cloud-import-file")?.addEventListener("change", async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        await importJson(file);
      } catch (err) {
        if (err.status === 409) {
          storageStatus("In der Cloud sind bereits Daten vorhanden. Der Einmalimport wurde nicht erneut ausgeführt.", "warn");
        } else {
          console.error(err);
          storageStatus("Import fehlgeschlagen. Bitte eine gültige SmartADM-JSON wählen.", "warn");
        }
      } finally {
        e.target.value = "";
      }
    });
  }

  function installCloudSaveHook() {
    const original = window.sichern;
    window.sichern = function() {
      try {
        // Lokale Browserkopie bleibt nur als Notfallpuffer, nicht als führender Datenstand.
        if (window.SPEICHER?.schreiben && window.ABLAGE) {
          window.SPEICHER.schreiben(window.ABLAGE, window.datenAlsText?.() || JSON.stringify(snapshot()));
        }
      } catch {}
      queueSave();
      return undefined;
    };
    window.__smartadmOriginalSichern = original;
  }

  async function showLogin() {
    document.body.classList.add("cloud-auth-pending");
    document.body.classList.remove("cloud-signed-in");
    const host = $("clerkSignIn");
    if (!host || host.dataset.mounted === "1") return;
    window.Clerk.mountSignIn(host, {
      routing: "hash",
      withSignUp: false,
      forceRedirectUrl: APP_URL,
      fallbackRedirectUrl: APP_URL,
      appearance: { variables: { colorPrimary: "#0D417F", borderRadius: "12px" } }
    });
    host.dataset.mounted = "1";
  }

  async function showApp(user) {
    if (user.id !== ALLOWED_USER_ID) {
      try { await window.Clerk.signOut(); } catch {}
      await showLogin();
      const err = $("cloud-login-error");
      if (err) { err.hidden = false; err.textContent = "Dieser Account hat keinen Zugriff auf SmartADM5."; }
      return;
    }

    const signHost = $("clerkSignIn");
    if (signHost?.dataset.mounted === "1") {
      try { window.Clerk.unmountSignIn(signHost); } catch {}
      signHost.dataset.mounted = "0";
    }

    if (!$("userMenuHost")?.dataset.mounted) {
      window.Clerk.mountUserButton($("userMenuHost"), { afterSignOutUrl: APP_URL });
      $("userMenuHost").dataset.mounted = "1";
    }

    document.body.classList.remove("cloud-auth-pending");
    document.body.classList.add("cloud-signed-in");
    try { $("start").hidden = true; document.body.style.overflow = ""; } catch {}

    const payload = await fetchCloud();
    const hasCloud = Object.keys(payload.sections || {}).length > 0;
    if (hasCloud) {
      applyCloud(payload);
      storageStatus("Cloudspeicherung aktiv.", "aktiv");
    } else {
      for (const name of SECTION_NAMES) state.json[name] = stable(snapshot()[name]);
      storageStatus("Cloud ist leer. Importiere einmal deine bisherige JSON-Datei.", "warn");
    }

    state.booted = true;
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(poll, 4000);
  }

  async function init() {
    wireStorage();
    ensureConflictUi();
    installCloudSaveHook();

    try {
      await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, afterSignOutUrl: APP_URL });
      const update = async () => {
        try {
          if (window.Clerk.session && window.Clerk.user) await showApp(window.Clerk.user);
          else await showLogin();
        } catch (e) {
          console.error("SmartADM5 Cloud-Startfehler:", e);
          const err = $("cloud-login-error");
          if (err) { err.hidden = false; err.textContent = "SmartADM5 konnte die Cloud nicht verbinden."; }
        }
      };
      await update();
      window.Clerk.addListener?.(update);
    } catch (e) {
      console.error("Clerk konnte nicht geladen werden:", e);
      const err = $("cloud-login-error");
      if (err) err.hidden = false;
    }
  }

  window.addEventListener("load", init);
  window.addEventListener("online", () => { poll(); flush(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
})();
