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
const CACHE_VERSION = "v1";
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

  // Static assets (css/js/svg/png/etc): stale-while-revalidate — serve the
  // cached copy instantly if there is one, and refresh it in the background.
  event.respondWith(
    caches.open(RUNTIME_CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
