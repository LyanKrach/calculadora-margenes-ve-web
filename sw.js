/* MargenCalcu · Service worker mínimo para instalación PWA y uso sin conexión.
   Estrategia: red primero; si falla, caché. Nunca cachea peticiones que no sean GET del mismo origen. */
const CACHE = 'margencalcu-v6';
const SHELL = [
  './',
  './styles.css',
  './app.js',
  './firebase-config.js',
  './pro-config.js',
  './pro-core.js',
  './pro-files.js',
  './pro-ui.js',
  './pwa.js',
  './tools-panel.js',
  './auth.js',
  './site.webmanifest',
  './icon-192x192.png',
  './icon-512x512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && !response.redirected) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') return caches.match('./');
          return Response.error();
        })
      )
  );
});
