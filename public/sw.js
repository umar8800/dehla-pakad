// Dehla Pakad offline support.
// The whole app (page, fonts, icons) is saved on the phone the first time it opens with internet.
// After that it opens instantly from the phone, with or without internet: the saved copy is shown
// straight away and a fresh copy is fetched quietly in the background for next time.
const VERSION = 'dp-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/fonts/figtree.woff2', '/fonts/bricolage.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Fetch the page again in the background; tell open tabs when a new version has arrived.
async function refreshShell(cache) {
  try {
    const old = await cache.match('/');
    const res = await withTimeout(fetch('/', { cache: 'no-cache' }), 20000);
    if (!res.ok) return;
    const changed = !old || old.headers.get('etag') !== res.headers.get('etag');
    await cache.put('/', res.clone());
    if (changed && old) (await self.clients.matchAll()).forEach(c => c.postMessage({ type: 'update' }));
  } catch (e) { /* offline or slow: keep the saved copy */ }
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/ws') || url.pathname === '/healthz') return;

  // Any page address (/, /1234 invite links, /f/CODE, /admin) is the same app.
  // With internet: get the newest page (wait up to 3 s). No internet or server asleep: use the saved copy.
  if (req.mode === 'navigate' || url.pathname === '/') {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const saved = await cache.match('/');
      const net = fetch('/', { cache: 'no-cache' }).then(res => { if (res.ok) cache.put('/', res.clone()); return res; });
      if (saved) { e.waitUntil(net.catch(() => {})); try { return await withTimeout(net.then(r => r.clone()), 3000); } catch (err) { return saved; } }
      try { return await withTimeout(net, 30000); }
      catch (err) { return new Response('<h2 style="font-family:sans-serif;padding:24px">Dehla Pakad pehli baar kholne ke liye internet chahiye. Internet on karke dobara kholo.</h2>', { headers: { 'content-type': 'text/html; charset=utf-8' } }); }
    }));
    return;
  }

  // Everything else (fonts, icons, voice library): saved copy first, otherwise download and save it.
  e.respondWith(caches.open(VERSION).then(async cache => {
    const saved = await cache.match(req);
    if (saved) return saved;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  }));
});
