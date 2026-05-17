// NEON Infinito · Service Worker
// Cachea assets estáticos + revalida en background. Para API (worker) usa
// network-first así siempre ves data fresca. Si falla la red, devuelve el
// último cache si existe.

const CACHE_NAME = 'neon-ni-v3';
const STATIC_ASSETS = [
  '/ni-ventas/',
  '/ni-ventas/index.html',
  '/ni-ventas/manifest.webmanifest',
  '/ni-ventas/assets/app.js',
  '/ni-ventas/assets/app.css',
  '/ni-ventas/assets/brand.css',
  '/ni-ventas/assets/logo.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // API del worker (tracker, /admin/*) → network-first, no cachear privado.
  if (url.hostname.includes('workers.dev')) {
    event.respondWith(fetch(req).catch(() => new Response('{"error":"offline"}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // Sheets / Apps Script → network-first (data fresca).
  if (url.hostname.includes('googleusercontent.com') || url.hostname.includes('docs.google.com') || url.hostname.includes('script.google.com')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Assets propios (mismo origen) → stale-while-revalidate.
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then(cached => {
        const networkFetch = fetch(req).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Resto → network-first.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
