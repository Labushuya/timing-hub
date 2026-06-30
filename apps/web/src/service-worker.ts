/// <reference lib="webworker" />
/// <reference types="vite-plugin-pwa/svelte" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { NetworkOnly } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

// Take control immediately on update
self.skipWaiting();
clientsClaim();

// Precache all assets injected by vite-plugin-pwa
precacheAndRoute(self.__WB_MANIFEST);

// Remove stale caches from previous SW versions
cleanupOutdatedCaches();

// ---------------------------------------------------------------------------
// App shell — HTML, layout CSS, core JS
// ---------------------------------------------------------------------------
registerRoute(
  ({ request }) =>
    request.destination === 'document' ||
    (request.destination === 'style' && request.url.includes('layout')) ||
    (request.destination === 'script' && request.url.includes('_app')),
  new CacheFirst({
    cacheName: 'app-shell-v1',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 30,
        maxAgeSeconds: 60 * 60 * 24 * 7 // 7 days
      })
    ]
  })
);

// ---------------------------------------------------------------------------
// API calls — NetworkFirst with 3s timeout, fallback to cache
// ---------------------------------------------------------------------------
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    cacheName: 'api-cache-v1',
    networkTimeoutSeconds: 3,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 100,
        maxAgeSeconds: 60 * 60 * 24 // 24 hours
      })
    ]
  })
);

// ---------------------------------------------------------------------------
// Zeitnehmer route /p/** — StaleWhileRevalidate (works offline)
// ---------------------------------------------------------------------------
registerRoute(
  ({ url }) => url.pathname.startsWith('/p/'),
  new StaleWhileRevalidate({
    cacheName: 'zeitnehmer-cache-v1',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 50,
        maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
      })
    ]
  })
);

// ---------------------------------------------------------------------------
// Static assets — fonts, icons (CacheFirst, 30 days)
// ---------------------------------------------------------------------------
registerRoute(
  ({ request }) =>
    request.destination === 'font' ||
    request.destination === 'image',
  new CacheFirst({
    cacheName: 'static-assets-v1',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 60,
        maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
      })
    ]
  })
);

// ---------------------------------------------------------------------------
// SPA navigation fallback — serve index.html for all navigations
// ---------------------------------------------------------------------------
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/'), {
    // Exclude API routes and static files from the SPA fallback
    denylist: [/^\/api\//, /^\/icons\//, /\.(webmanifest|ico|png|svg)$/]
  })
);

// ---------------------------------------------------------------------------
// Offline fallback
// ---------------------------------------------------------------------------
const OFFLINE_CACHE = 'offline-v1';
const OFFLINE_URL = '/offline';

// Cache the offline page during SW install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then((cache) =>
      // Use a simple inline offline response instead of a separate HTML file
      cache.put(
        new Request(OFFLINE_URL),
        new Response(
          `<!doctype html>
<html lang="de" class="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Offline – Timing Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#0f0f0f;color:#f0f0f0;font-family:system-ui,sans-serif;
         display:flex;flex-direction:column;align-items:center;justify-content:center;
         min-height:100dvh;gap:1rem;padding:1.5rem;text-align:center}
    h1{font-size:1.5rem;font-weight:700}
    p{color:#aaa;font-size:0.95rem;max-width:30ch}
    .dot{display:inline-block;width:10px;height:10px;border-radius:50%;
         background:#e63012;margin-right:0.4rem}
  </style>
</head>
<body>
  <span class="dot"></span>
  <h1>Timing Hub</h1>
  <p>Keine Internetverbindung. Bereits besuchte Zeitnehmer-Sessions sind offline verfügbar.</p>
</body>
</html>`,
          {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store'
            }
          }
        )
      )
    )
  );
});

// Catch navigation failures (offline) and serve the offline page
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL, { cacheName: OFFLINE_CACHE });
        return (
          cached ??
          new Response('Offline', {
            status: 503,
            headers: { 'Content-Type': 'text/plain' }
          })
        );
      })
    );
  }
});
