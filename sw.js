'use strict';
// ─── CACHE VERSION ───────────────────────────────────────────────────────────
// Bump CACHE on every push. If you forget, phones running the old SW will
// continue to serve stale files — the new code will never reach them.
// Format: tv-phone-vN  (N is a plain incrementing integer, never reset)
// After bumping: git commit, push, done. The SW activate handler cleans up
// all old cache entries automatically.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE = 'tv-phone-v46';

// DEV_MODE: set true to bypass the SW cache entirely while iterating locally.
// Every request goes straight to the network — no manual cache-clear needed.
// IMPORTANT: must be false before pushing to production.
const DEV_MODE = false;

const SHELL = [
  './', './index.html', './app.js', './exif.js', './manifest.json',
  './services/settings.js', './services/github.js', './services/queue.js', './services/wiki.js',
  './services/location.js', './services/timeline.js', './services/thumbs.js', './services/restore.js',
  './services/ops.js', './services/refresh.js',
  './settings/settings-ui.js',
  './core/ui.js', './core/state.js', './core/router.js',
  './tabs/wiki/wiki.js', './tabs/wiki/wiki-ui.js', './tabs/wiki/today-strip.js',
  './tabs/capture/capture-ui.js',
  './tabs/log/log.js', './tabs/log/log-ui.js', './tabs/log/detail.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return; // bypass blob:, data:
  if (url.origin !== self.location.origin) return;
  if (DEV_MODE) return; // bypass cache — all requests go to network

  // Network-first for the boot files (navigation requests, /, /index.html,
  // /app.js). A VERSION bump in app.js then propagates on the next online
  // reload — without this, the cached app.js keeps registering the old SW
  // URL and the update never lands. Falls back to cache when offline.
  const isBoot = e.request.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/app.js');
  if (isBoot) {
    e.respondWith(
      fetch(e.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
