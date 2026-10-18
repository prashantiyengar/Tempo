// Tempo web app service worker: keeps the app working offline. Google API calls are never cached.
const VERSION = '__BUILD__';
const CACHE = 'tempo-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', ...__ASSETS__])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('tempo-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Same-origin files: serve from cache straight away, refresh the cache in the background.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
    const hit = await cache.match(key, { ignoreSearch: e.request.mode === 'navigate' });
    const fresh = fetch(e.request).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});

// Tapping a reminder opens (or focuses) the app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow('./'))));
});
