// App-shell service worker: network-first for our own files (so updates land
// immediately), cached fallback when offline. API calls go straight to the network;
// the app keeps its own last-known snapshot for offline use.
const VERSION = 'wx-v3';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/app.js', 'manifest.webmanifest',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css',
  'fonts/space-grotesk.woff2', 'fonts/jetbrains-mono-400.woff2', 'fonts/jetbrains-mono-500.woff2',
  'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
