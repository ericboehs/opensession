// Exposed to the OS¹ web app. The frontend can feature-detect `window.os1`
// to route its app-badge updates through the dock (navigator.setAppBadge in a
// service worker doesn't reach Electron's dock badge).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("os1", {
  desktop: true,
  setBadge: (count) => ipcRenderer.send("os1:set-badge", Number(count) || 0),
  clearBadge: () => ipcRenderer.send("os1:set-badge", 0),
});
