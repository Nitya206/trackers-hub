/**
 * sw.js · TRACKERS HUB — service worker
 * ============================================================================
 * This exists for two reasons:
 *   1. iOS only offers "Add to Home Screen" as a real web app (and only ever
 *      allows web push) when a site has a manifest AND a service worker.
 *   2. Speed and offline. Once cached, every page opens without the network.
 *
 * The installed app goes through this worker on every launch (a browser tab
 * mostly doesn't — it resumes from memory), so everything here is tuned for a
 * cold start on a slow phone connection:
 *
 *  • ONE long-lived cache. It used to be named per release and wiped on every
 *    deploy, so the first open after each deploy re-downloaded all ~3MB.
 *  • Versioned files (?v=…), fonts and the pinned Supabase SDK never change
 *    at a given URL, so they're served straight from cache with no network
 *    check at all. Previously each one was re-fetched on every launch.
 *  • Pages are stale-while-revalidate — shown instantly from cache — but the
 *    background refresh now waits a few seconds, so re-downloading Study's
 *    1.6MB no longer competes with the page that's trying to start.
 *
 * Cross-origin requests are left alone — sync must always reach the live
 * Supabase server. The exceptions are the version-pinned Supabase SDK and
 * Google Fonts (see CDN_ALLOW).
 */

const VERSION = 'th-2026-09-25c';   // bump to ship a new worker; the cache itself survives
const CACHE   = 'trackers-hub';      // stable on purpose — see above
// Must match the ?v= on the pages' <script> tags, so precached copies are the
// exact URLs the pages ask for (a different query string is a different entry).
const ASSET_V = '20260925a';
const VERSIONED = ['sync-config.js', 'sync-engine.js', 'push-client.js', 'hub-nav.js', 'day-parts.js', 'zen-rules.js', 'budget-core.js'];

// Split deliberately: install takes only the light shell, so the first visit
// isn't slowed by downloading the heavy pages it isn't showing yet.
const CORE = [
  './',
  './index.html',
  './rituals-tracker.html',
  './Shopping-List.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png'
].concat(VERSIONED.map((f) => './' + f + '?v=' + ASSET_V));

// ~2.8MB. Fetched in the background after activation, one at a time.
const WARM = [
  './Study-Schedule-Pro.html',
  './Procrastination-Hub.html',
  './zen-garden-tracker.html',
  // Study's charts load this the first time Review → Logs is opened — warm it so that
  // still works offline. The query string must match the page's exactly.
  './chart.umd.min.js?v=4.4.1',
  './icons/icon-512.png'
];

const FONT_CSS_HOST  = 'fonts.googleapis.com';
const FONT_FILE_HOST = 'fonts.gstatic.com';
const SDK_HOST       = 'cdn.jsdelivr.net';     // every SDK URL pins an exact version
const CDN_ALLOW = [SDK_HOST, FONT_CSS_HOST, FONT_FILE_HOST];
const REVALIDATE_DELAY = 4000;                 // let the page start before refreshing it

// The pages themselves. A new worker means a new deploy, so these are fetched
// fresh (past the browser's HTTP cache) while it installs — by the time it
// takes over and tells the open app to reload, the new version is already on
// the device. Otherwise the app kept showing the old build until a second open.
const PAGES = ['./', './index.html', './rituals-tracker.html', './Study-Schedule-Pro.html',
               './Procrastination-Hub.html', './zen-garden-tracker.html', './Shopping-List.html',
               './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(
        PAGES.map((u) => fetch(new Request(u, { cache: 'reload' })).then((res) => {
          if (res && res.ok && !res.redirected) return cache.put(u, res);
        })).concat(
          // Everything else only if missing — versioned files never change at a URL.
          CORE.filter((u) => PAGES.indexOf(u) === -1).map((u) =>
            cache.match(u).then((hit) => hit || cache.add(u)))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Was there a worker before this one? (First install: nothing to announce.)
    // A marker the previous worker left behind (or the old per-release caches).
    const replacedOld = !!(await cache.match('./__sw_version'))
      || (await caches.keys()).some((n) => n.startsWith('trackers-hub-'));
    await cache.put('./__sw_version', new Response(VERSION));

    // One-time move from the old per-release caches, so switching to the
    // stable cache doesn't itself cost a cold start.
    for (const name of await caches.keys()) {
      if (name === CACHE || !name.startsWith('trackers-hub-')) continue;
      const old = await caches.open(name);
      for (const req of await old.keys()) {
        if (!(await cache.match(req))) {
          const res = await old.match(req);
          if (res) await cache.put(req, res);
        }
      }
      await caches.delete(name);
    }

    // Drop copies of our scripts from older releases.
    for (const req of await cache.keys()) {
      const u = new URL(req.url);
      if (u.origin !== self.location.origin) continue;
      const file = u.pathname.split('/').pop();
      if (VERSIONED.indexOf(file) !== -1 && u.searchParams.get('v') !== ASSET_V) await cache.delete(req);
    }

    await self.clients.claim();

    // Tell open pages a new version is in place (they reload, or offer to).
    // Only worth saying when this replaced an older worker.
    if (replacedOld) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      wins.forEach((w) => w.postMessage({ type: 'sw-updated', version: VERSION }));
    }

    // Not awaited — warming must never hold up the page that triggered it.
    WARM.reduce(
      (chain, u) => chain.then(() => cache.match(u).then((hit) => hit || cache.add(u).catch(() => {}))),
      Promise.resolve()
    );
  })());
});

function cacheable(res, url) {
  if (!res || res.redirected) return false;                  // Safari rejects redirected navigations
  if (res.status === 200 && (res.type === 'basic' || res.type === 'cors')) return true;
  // The font stylesheet is requested without CORS, so it comes back opaque.
  return res.type === 'opaque' && url.hostname === FONT_CSS_HOST;
}

function fetchAndStore(req, url) {
  return fetch(req).then((res) => {
    if (cacheable(res, url)) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && CDN_ALLOW.indexOf(url.hostname) === -1) return;   // Supabase API etc.

  // Content that never changes at this URL: cache first, network only on a miss.
  const immutable = !sameOrigin || url.searchParams.has('v');
  if (immutable) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetchAndStore(req, url).catch(() =>
        new Response('', { status: 504, statusText: 'Offline' })))
    );
    return;
  }

  // Pages and other unversioned files: instant from cache, refreshed later.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        event.waitUntil(
          new Promise((r) => setTimeout(r, REVALIDATE_DELAY))
            .then(() => fetchAndStore(req, url))
            .catch(() => {})
        );
        return hit;
      }
      return fetchAndStore(req, url).catch(() =>
        req.mode === 'navigate'
          ? caches.match('./index.html')
          : new Response('', { status: 504, statusText: 'Offline' }));
    })
  );
});

// Lets the page trigger an immediate update instead of waiting for a reload.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

/* ══════════════════════════════════════════════════════════════════════════
   PUSH NOTIFICATIONS
   On iOS this only runs when the site was added to the Home Screen — Safari
   tabs never receive push, no matter what permission was granted.
══════════════════════════════════════════════════════════════════════════ */

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { title: 'Trackers Hub', body: event.data ? event.data.text() : '' }; }

  event.waitUntil(
    self.registration.showNotification(d.title || 'Trackers Hub', {
      body: d.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      // A stable tag means a newer notification of the same kind REPLACES the
      // old one instead of stacking — so re-planning can't pile up duplicates.
      tag: d.tag || 'trackers',
      renotify: !!d.renotify,
      data: { url: d.url || './index.html' },
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';

  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse an open window when there is one, rather than piling up copies.
    for (const w of wins) {
      if ('focus' in w) {
        try { if ('navigate' in w) await w.navigate(target); } catch (_) {}
        return w.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// iOS/Chrome can rotate a subscription; re-register so pushes keep arriving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'resubscribe' }));
  })());
});
