/* Movie Nights – service worker
   - App files: try the network first (so updates arrive right away), fall back to the saved copy offline.
   - TMDB posters: saved the first time they are seen, then served from the device.
   - GitHub and TMDB API calls always go straight to the network. */
const SHELL_CACHE = 'movie-nights-shell-v1';
const POSTER_CACHE = 'movie-nights-posters-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== POSTER_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'image.tmdb.org') {
    event.respondWith(posterHandler(req));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
  // anything else (GitHub API, TMDB search) is left alone
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const index = await cache.match('./index.html');
      if (index) return index;
    }
    return Response.error();
  }
}

async function posterHandler(req) {
  const cache = await caches.open(POSTER_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    // Ask for a CORS response so it is stored at its real (small) size.
    const res = await fetch(req.url, { mode: 'cors' });
    if (res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (err) {
    try { return await fetch(req); } catch (e) { return Response.error(); }
  }
}
