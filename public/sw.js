// sw.js - Service worker minimo (solo para permitir instalar la app).
// No cachea datos de la API a proposito: la info tiene que ser siempre la mas reciente.
//
// Estrategia "network-first": siempre intenta traer la version mas nueva del servidor;
// solo usa la copia guardada si no hay internet en ese momento. Asi, cuando actualizamos
// la app, todos la ven actualizada la proxima vez que la abren (con internet), sin
// quedar pegados a una version vieja guardada en el celular.
//
// Hecho a prueba de fallos: si el servidor esta lento/dormido (plan gratuito de Render)
// en el momento de instalar la app, no rompe la instalacion ni deja la pantalla en blanco.
const CACHE_NAME = 'sd-vendedores-v3';
const STATIC_FILES = ['/', '/index.html', '/app.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Si algun archivo individual falla al pre-cachear (ej: servidor lento),
      // no hacemos fallar toda la instalacion del service worker por eso.
      Promise.allSettled(STATIC_FILES.map((f) => cache.add(f)))
    )
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
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // Ni red ni cache disponibles: devolvemos algo en vez de dejar la pantalla en blanco.
        return new Response(
          '<!DOCTYPE html><html><body style="background:#16233d;color:#eef2f9;font-family:sans-serif;padding:24px;">' +
          '<h3>Sin conexion</h3><p>No se pudo conectar con el servidor. Revisa tu internet e intenta de nuevo.</p>' +
          '</body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
  );
});
