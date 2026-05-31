// NEON Infinito · Service Worker
// Cachea assets estáticos + revalida en background. Para API (worker) usa
// network-first así siempre ves data fresca. Si falla la red, devuelve el
// último cache si existe.

// IMPORTANTE: bumpear CACHE_NAME cada vez que cambia app.js o app.css —
// el activate borra los caches viejos y fuerza re-descarga del bundle.
const CACHE_NAME = 'neon-ni-v15';
const STATIC_ASSETS = [
  '/ni-ventas/',
  '/ni-ventas/index.html',
  '/ni-ventas/manifest.webmanifest',
  '/ni-ventas/assets/logo.svg',
  '/ni-ventas/assets/brand.css'
];
// app.js y app.css se sirven NETWORK-FIRST (no precacheamos) porque cambian
// seguido. Antes con stale-while-revalidate el usuario veía la versión vieja
// hasta el segundo refresh — problema serio cuando hay un bugfix urgente.
const NETWORK_FIRST_ASSETS = ['/ni-ventas/assets/app.js', '/ni-ventas/assets/app.css'];

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

  // app.js y app.css → network-first SIEMPRE. Si hay red, traer fresco.
  // Solo caer al cache si la red falla (modo offline). Así un bugfix se
  // ve al primer refresh, no al segundo.
  if (url.origin === location.origin && NETWORK_FIRST_ASSETS.some(p => url.pathname === p || url.pathname.startsWith(p))) {
    event.respondWith(
      // cache: 'reload' fuerza ir a la red ignorando el HTTP cache del navegador.
      // Sin esto, GitHub Pages servía la versión vieja de app.js hasta ~10 min
      // aunque el SW fuera "network-first" (el fetch usaba el HTTP cache).
      fetch(req, { cache: 'reload' }).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Otros assets propios (logo, CSS de brand, etc.) → stale-while-revalidate.
  // Cambian muy de vez en cuando y nos sirve velocidad.
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
