// Exposed to the OS¹ web app. The frontend can feature-detect `window.os1`
// to route its app-badge updates through the dock (navigator.setAppBadge in a
// service worker doesn't reach Electron's dock badge).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("os1", {
  desktop: true,
  // Capability flag rather than `desktop` alone: the remotely served frontend
  // must stay opaque in older shell builds that do not provide native material.
  materialBackdrop: true,
  setBadge: (count) => ipcRenderer.send("os1:set-badge", Number(count) || 0),
  clearBadge: () => ipcRenderer.send("os1:set-badge", 0),
  // App auto-update (Squirrel.Mac, driven by main.js). `onState(cb)` reports
  // the current state immediately and again on every change, and returns an
  // unsubscribe. States: idle | available (= downloading) | downloaded.
  // `install()` restarts the app into a downloaded update.
  updates: {
    onState: (cb) => {
      const listener = (_e, state) => cb(state);
      ipcRenderer.on("os1:update-state", listener);
      ipcRenderer.invoke("os1:update-state").then(cb).catch(() => {});
      return () => ipcRenderer.removeListener("os1:update-state", listener);
    },
    install: () => ipcRenderer.send("os1:update-install"),
  },
});
