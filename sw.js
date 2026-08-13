// sw.js — Halal Income service worker.
//
// Scope is deliberately narrow: this exists to satisfy PWA installability
// (Chrome/Android require a service worker with a fetch handler) and to make
// the app shell (nav, styles, logo) load instantly and work offline. It does
// NOT cache anything under /api/ — ever. This is a site that shows account
// balances and money movement; serving a stale balance or a stale "pending"
// list from cache would be actively misleading, so every API request always
// goes to the network, full stop.
//
// Bump CACHE_VERSION when the precached shell files change so old clients
// pick up the new ones instead of serving a stale cached copy forever.
const CACHE_VERSION = "v2";
const SHELL_CACHE = `halal-income-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `halal-income-runtime-${CACHE_VERSION}`;

const SHELL_URLS = [
  "/",
  "/index.html",
  "/styles.css",
  "/script.js",
  "/auth.js",
  "/notifications-ui.js",
  "/i18n.js",
  "/i18n-extra2.js",
  "/logo.svg",
  "/manifest.json",
  "/offline.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never touch POST/PATCH/etc — those are all API writes

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // don't intercept fonts/CDN calls
  if (url.pathname.startsWith("/api/")) return; // API data is always live, never cached

  const isNavigation =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    // Network-first for pages: an admin approving a withdrawal offline-first
    // would be a disaster, so always prefer the live page. Cache is only a
    // fallback for when the network is genuinely unreachable.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(
          () =>
            caches.match(request).then((cached) => cached) ||
            caches.match("/offline.html")
        )
        .then((response) => response || caches.match("/offline.html"))
    );
    return;
  }

  // Static assets (css/js/svg/png): network-first, falling back to cache.
  //
  // This was stale-while-revalidate, which shipped a real bug: pages are
  // network-first, so after a deploy a browser gets the NEW html immediately
  // but keeps serving the OLD js from cache. When a release makes the html
  // depend on something new in a js file (as adding the shared escapeHtml()
  // helper did), that mismatch throws mid-render — the admin panel's tables
  // came up empty, with no approve/reject buttons at all.
  //
  // Serving fresh assets whenever the network is reachable makes a
  // half-updated app impossible. It costs a round trip per asset, which is
  // negligible for a handful of small same-origin files, and the cache
  // fallback still covers genuinely-offline use.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cache.match(request).then((cached) => cached || Response.error()))
    )
  );
});
