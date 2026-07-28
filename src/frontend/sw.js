/*
 * OpenSession service worker — Web Push + app-shell cache. Shows pushes as
 * notifications and focuses/opens the right session on tap; caches the SPA
 * shell so cold starts are instant and a dead/black-holed tailnet gets the
 * app's own reconnecting state instead of a white error page.
 *
 * Prefix-agnostic: the app is served under /opensession/ (primary) and the
 * legacy /backstage/ alias; one registration exists per prefix (scope). All
 * asset/navigation URLs derive from this registration's scope, and pushed
 * URLs are re-prefixed onto it — so a payload built with either prefix opens
 * correctly inside whichever install received it.
 */
const PREFIX = new URL(self.registration.scope).pathname.replace(/\/$/, "");

/** Rewrite a pushed app URL onto this registration's own prefix. */
function localUrl(url) {
  if (!url) return PREFIX + "/";
  return url
    .replace(/^\/opensession(\/|$)/, PREFIX + "$1")
    .replace(/^\/backstage(\/|$)/, PREFIX + "$1");
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Drop caches left by older worker versions (names carry a -v suffix).
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (k) =>
                  k.startsWith("os1-shell-") &&
                  k !== HTML_CACHE &&
                  k !== ASSET_CACHE,
              )
              .map((k) => caches.delete(k)),
          ),
        ),
    ]),
  ),
);

/* ── App-shell caching ────────────────────────────────────────────────────
 * Navigations are NETWORK-FIRST: freshness stays authoritative — an in-process
 * rebuild (frontend_updated) is picked up on the very next load exactly as
 * before, so the cache can never pin a stale build on a working connection.
 * The cached shell is served only when the network fails, or stalls past
 * NAV_STALL_MS (the "VPN is up but the tailnet is unreachable" white-screen
 * case). Bundle assets are content-hashed (App-<hash>.js, global-<hash>.css)
 * and served immutable, so those are CACHE-FIRST: a cached entry can never be
 * stale, a new build simply asks for new names.
 */
const HTML_CACHE = "os1-shell-html-v1";
const ASSET_CACHE = "os1-shell-assets-v1";
// One shell entry per prefix (both registrations share the origin's caches).
const SHELL_KEY = PREFIX + "/__app-shell__";
const NAV_STALL_MS = 5000;
// Hashed js/css at the root or a legacy prefix: <name>-<hash>.js|css. Never
// matches sw.js itself (no dash) or icons/splash (not js/css).
const ASSET_RE = /^\/(?:opensession\/|backstage\/)?[\w.]+-\w+\.(?:js|css)$/;
const API_RE = /^\/(?:opensession\/|backstage\/)?api\//;
// A build ships ~a dozen chunks; 80 keeps a few builds' worth before pruning.
const MAX_ASSETS = 80;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" && !API_RE.test(url.pathname)) {
    event.respondWith(shellNavigate(req));
  } else if (ASSET_RE.test(url.pathname)) {
    event.respondWith(hashedAsset(req));
  }
});

async function shellNavigate(req) {
  const cache = await caches.open(HTML_CACHE);
  const cached = await cache.match(SHELL_KEY);
  const network = fetch(req).then((res) => {
    // Tee only genuine SPA-shell responses into the cache; API/media
    // navigations (non-HTML) pass through untouched.
    const type = res.headers.get("content-type") || "";
    if (res.ok && type.includes("text/html")) cache.put(SHELL_KEY, res.clone());
    return res;
  });
  if (!cached) return network;
  return Promise.race([
    network.catch(() => cached),
    // Stall guard: a black-holed connection hangs for 60s+; after NAV_STALL_MS
    // paint the cached shell (the network fetch still completes above and
    // refreshes the cache for the next load).
    new Promise((r) => setTimeout(r, NAV_STALL_MS)).then(() => cached),
  ]);
}

async function hashedAsset(req) {
  const cache = await caches.open(ASSET_CACHE);
  // ignoreVary: asset responses carry `Vary: Accept-Encoding`, which would
  // otherwise fragment the cache on header differences that don't matter here.
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    await cache.put(req, res.clone());
    trimAssets(cache).catch(() => {});
  }
  return res;
}

async function trimAssets(cache) {
  const keys = await cache.keys(); // insertion order — oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) {
    await cache.delete(k);
  }
}

// App-icon badge (iOS/macOS PWA dock + home screen): there's no read-state
// here in the worker, so the count mirrors the notifications still on screen.
// The open app overwrites it with the real unread count (App.tsx).
async function updateAppBadge(excludeTag) {
  if (!self.navigator.setAppBadge) return;
  try {
    let notifs = await self.registration.getNotifications();
    // A just-closed notification can still be listed for a beat — drop it.
    if (excludeTag) notifs = notifs.filter((n) => n.tag !== excludeTag);
    if (notifs.length > 0) await self.navigator.setAppBadge(notifs.length);
    else await self.navigator.clearAppBadge();
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const title = data.title || "OpenSession";
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        icon: PREFIX + "/icon-192.png",
        badge: PREFIX + "/icon-192.png",
        data: { url: localUrl(data.url) },
      })
      .then(() => updateAppBadge()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = localUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    Promise.all([
      updateAppBadge(event.notification.tag),
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((wins) => {
          for (const w of wins) {
            if ("focus" in w) {
              if (w.navigate) w.navigate(url);
              return w.focus();
            }
          }
          return self.clients.openWindow(url);
        }),
    ]),
  );
});
