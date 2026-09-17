/* SmartADM 5 Office – Service Worker
 * Bei jeder Änderung an dieser Datei VERSION erhöhen.
 */
const VERSION = "office-v5.6";
const SCOPE = "/smartadm/office/";
const ICON = `${SCOPE}office-icon-192.png`;
const SHELL = [SCOPE, `${SCOPE}manifest.webmanifest`, ICON];

/* ---------- Installation & Aktualisierung ---------- */

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/* ---------- Laden: immer zuerst Netzwerk, Cache nur offline ----------
 * So kommt jede neue index.html sofort an. API und Clerk laufen
 * über andere Domains und werden hier nicht angefasst.
 */
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;

  const isPage = request.mode === "navigate";
  const cacheKey = isPage ? SCOPE : request;
  if (!isPage && !SHELL.includes(url.pathname)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(VERSION).then(cache => cache.put(cacheKey, copy)));
      }
      return response;
    } catch {
      return (await caches.match(cacheKey)) || Response.error();
    }
  })());
});

/* ---------- Push: Benachrichtigung anzeigen ---------- */

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(Promise.all([
    self.registration.showNotification(data.title || "SmartADM Office", {
      body: data.body || "",
      icon: ICON,
      badge: ICON,
      tag: data.tag,
      data: { url: data.url || SCOPE }
    }),
    // Geöffnete App-Fenster laden die Aufgaben neu
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(windows => windows.forEach(client => client.postMessage({ type: "tasks-changed" })))
  ]));
});

/* ---------- Tippen auf die Benachrichtigung ---------- */

self.addEventListener("notificationclick", event => {
  event.notification.close();

  const target = new URL(event.notification.data?.url || SCOPE, self.location.origin);
  const page = target.searchParams.get("page");

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).pathname.startsWith(SCOPE));

    if (open) {
      await open.focus();
      if (page) open.postMessage({ type: "open-page", page });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
