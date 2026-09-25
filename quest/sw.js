/* 34i-Quest – Service Worker
 * App-Shell:   index.html network-first, übrige Dateien stale-while-revalidate
 * Lerninhalte: network-first (data/…), offline aus dem Cache
 * Bei neuer contentVersion in chapters.json wird der Content-Cache geleert.
 * Bei App-Updates: STATIC_VERSION erhöhen.
 */
const STATIC_VERSION = 'v17';
const STATIC_CACHE = `34i-quest-static-${STATIC_VERSION}`;
const CONTENT_CACHE = '34i-quest-content-v1';

const SHELL = [
  './', 'index.html', 'manifest.json',
  'css/style.css',
  'css/fonts/bricolage-grotesque-var.woff2',
  'css/fonts/atkinson-hyperlegible-latin-400-normal.woff2',
  'css/fonts/atkinson-hyperlegible-latin-700-normal.woff2',
  'css/fonts/atkinson-hyperlegible-latin-400-italic.woff2',
  'css/fonts/jetbrains-mono-latin-500-normal.woff2',
  'js/app.js', 'js/game.js', 'js/savegame.js', 'js/content-loader.js', 'js/audio.js',
  'assets/logo.webp', 'assets/icon-192.png', 'assets/icon-512.png', 'assets/coin.webp', 'assets/coin-lg.webp',
  'assets/world/quest-map.webp',
  'assets/ui/hud-ornate.webp', 'assets/ui/frame-ornate.webp',
  'assets/ui/icon-help.webp', 'assets/ui/icon-music.webp', 'assets/ui/icon-sound.webp', 'assets/ui/icon-save.webp'
];

self.addEventListener('install', (event) => {
  // cache: 'reload' umgeht den HTTP-Cache – sonst landen beim Update alte Dateien im neuen Cache
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' })))));
  // Kein skipWaiting hier: Die App fragt den Nutzer, bevor die neue Version übernimmt.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([STATIC_CACHE, CONTENT_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('34i-quest-') && !keep.has(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes('/data/')) { event.respondWith(contentNetworkFirst(req, url)); return; }
  if (req.mode === 'navigate') { event.respondWith(navigationNetworkFirst(req)); return; }
  event.respondWith(staleWhileRevalidate(req));
});

async function navigationNetworkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put('index.html', res.clone());
    return res;
  } catch {
    return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

async function contentNetworkFirst(req, url) {
  const cache = await caches.open(CONTENT_CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) {
      if (url.pathname.endsWith('/chapters.json')) await purgeIfNewVersion(cache, req, res.clone());
      await cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

/** Neue contentVersion? Dann alle gecachten Lerninhalte verwerfen, damit nichts Veraltetes gemischt wird. */
async function purgeIfNewVersion(cache, req, fresh) {
  try {
    const old = await cache.match(req, { ignoreSearch: true });
    if (!old) return;
    const [a, b] = await Promise.all([old.json(), fresh.json()]);
    if (a.contentVersion !== b.contentVersion) {
      const keys = await cache.keys();
      await Promise.all(keys.map((k) => cache.delete(k)));
    }
  } catch { /* ungültiges JSON – nichts löschen */ }
}
