// sw.js - Service worker minimo (solo para permitir instalar la app).
// No cachea datos de la API a proposito: la info tiene que ser siempre la mas reciente.
const CACHE_NAME = 'sd-vendedores-v1';
const STATIC_FILES = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // API siempre en vivo, nunca cacheada
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
