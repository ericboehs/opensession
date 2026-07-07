/*
 * Backstage service worker — Web Push only (no fetch interception / caching:
 * the app ships hashed bundles and handles its own updates). Shows pushes as
 * notifications and focuses/opens the right session on tap.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
  const title = data.title || "Michael";
  event.waitUntil(
    self.registration
      .showNotification(title, {
        body: data.body || "",
        tag: data.tag || undefined,
        icon: "/backstage/icon-192.png",
        badge: "/backstage/icon-192.png",
        data: { url: data.url || "/backstage/" },
      })
      .then(() => updateAppBadge()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/backstage/";
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
