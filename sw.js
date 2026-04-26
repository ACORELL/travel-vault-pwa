'use strict';
// ─── CACHE VERSION ───────────────────────────────────────────────────────────
// Bump CACHE on every push. If you forget, phones running the old SW will
// continue to serve stale files — the new code will never reach them.
// Format: tv-phone-vN  (N is a plain incrementing integer, never reset)
// After bumping: git commit, push, done. The SW activate handler cleans up
// all old cache entries automatically.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE = 'tv-phone-v38';

// DEV_MODE: set true to bypass the SW cache entirely while iterating locally.
// Every request goes straight to the network — no manual cache-clear needed.
// IMPORTANT: must be false before pushing to production.
const DEV_MODE = false;

const SHELL = [
  './', './index.html', './app.js', './db.js', './vault.js', './exif.js', './manifest.json',
  './services/settings.js', './services/github.js', './services/queue.js', './services/wiki.js',
  './services/location.js',
  './settings/settings-ui.js',
  './core/ui.js', './core/state.js', './core/router.js',
  './tabs/wiki/wiki.js', './tabs/wiki/wiki-ui.js', './tabs/wiki/today-strip.js',
  './tabs/capture/capture-ui.js',
  './tabs/log/log.js', './tabs/log/log-ui.js',
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
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
});
