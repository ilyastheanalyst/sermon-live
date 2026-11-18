/**
 * Service worker for the display.
 *
 * This app is live by nature — the words arrive over a websocket and are
 * never cached. What the cache is for is the shell: so tapping the icon
 * opens the app instantly and shows "Reconnecting" rather than a browser
 * error page when the wifi drops, which in a hall it will.
 *
 * Bump VERSION whenever the shell changes. Old caches are deleted on
 * activate, and the new worker takes over immediately, so a phone that has
 * had this installed for months still picks up changes on next open.
 */

const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const FONTS = `fonts-${VERSION}`;

const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // One missing file must not fail the whole install, so each is added
      // on its own and failures are tolerated.
      .then((cache) => Promise.allSettled(SHELL_FILES.map((f) => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== FONTS).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch the websocket or the API — those must always be live.
  if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/')) return;

  // Google Fonts: cache-first. They never change, and a cold network on a
  // phone at the back of a hall shouldn't leave the text in a fallback face.
  if (url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com')) {
    event.respondWith(
      caches.open(FONTS).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        try {
          const res = await fetch(request);
          if (res.ok) cache.put(request, res.clone());
          return res;
        } catch {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Everything local: network-first so a republished page lands straight
  // away, with the cache as the fallback when the network is gone.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        if (request.mode === 'navigate') return caches.match('/');
        return Response.error();
      })
  );
});
