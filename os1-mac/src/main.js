// OS¹ desktop — thin shell around https://os.tella.dev.
// The frontend ships from the server (bun --hot), so this app rarely changes:
// it only owns the window, navigation policy, notifications, badge and deep links.
const { app, BrowserWindow, shell, session, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// OS1_URL is a dev-only escape hatch for pointing the shell at a local
// OpenSession checkout (`bun --hot run opensession.ts`, then
// `OS1_URL=http://127.0.0.1:3850 bun start`) to iterate on frontend changes
// before they merge. Production builds always hit the hardcoded default.
const APP_URL = process.env.OS1_URL || "https://os.tella.dev/";
const APP_ORIGIN = new URL(APP_URL).origin;
// github.com stays in-window for the OAuth redirect flow (authorize → callback).
const IN_WINDOW_ORIGINS = [APP_ORIGIN, "https://github.com"];

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");

let win = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    showWindow();
    const url = argv.find((a) => a.startsWith("os1://"));
    if (url) openDeepLink(url);
  });
}

app.setAsDefaultProtocolClient("os1");

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return { width: 1360, height: 900 };
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(win.getNormalBounds()));
  } catch {}
}

function inWindow(url) {
  try {
    return IN_WINDOW_ORIGINS.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

// os1://session/abc → https://os.tella.dev/session/abc; https app links pass through.
function deepLinkToUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "os1:") {
      return APP_ORIGIN + "/" + (u.host || "") + u.pathname + u.search;
    }
    if (u.origin === APP_ORIGIN) return raw;
  } catch {}
  return null;
}

function openDeepLink(raw) {
  const url = deepLinkToUrl(raw);
  if (!url) return;
  showWindow();
  win?.loadURL(url);
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    win.focus();
  }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    ...state,
    minWidth: 700,
    minHeight: 480,
    // Keep Chromium's canvas transparent so the frontend sidebar can reveal
    // the native macOS visual-effect surface. The web app paints its detail
    // pane opaque; only its translucent sidebar exposes this material.
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "active",
    // The frontend already lays itself out for Window Controls Overlay (its PWA
    // manifest declares display_override: window-controls-overlay).
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.on("close", (e) => {
    saveWindowState();
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  // Keep app navigation + the GitHub OAuth redirect in-window; everything else
  // (PR links, docs, …) goes to the default browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!inWindow(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === APP_ORIGIN) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Tailnet-only server: show a local retry page instead of Chromium's error.
  win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    win.loadFile(path.join(__dirname, "offline.html"), {
      query: { url: APP_URL },
    });
  });

  // Belt-and-braces: if the renderer ever dies, come back instead of showing
  // a dead window.
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") win.loadURL(APP_URL);
  });

  win.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  // `electron .` is not a packaged .app, so macOS otherwise shows Electron's
  // default Dock icon. Packaged builds get their signed bundle icon from
  // electron-builder; only the development runtime needs this explicit PNG.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, "../build/icon-512.png"));
  }

  // The web app's service worker only exists for Web Push, app-shell caching
  // and the PWA badge — none of which function in Electron — and its Cache
  // Storage writes crash Electron 43's renderer (bad CacheStorageCache Mojo
  // message). Keep it out entirely: block the script and clear any prior
  // registration. The shell's offline.html covers the offline case.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: [APP_ORIGIN + "/*sw.js*"] },
    (_details, callback) => callback({ cancel: true }),
  );
  await session.defaultSession
    .clearStorageData({ storages: ["serviceworkers", "cachestorage"] })
    .catch(() => {});

  // Remote content gets browser-level permissions only.
  session.defaultSession.setPermissionRequestHandler(
    (wc, permission, callback) => {
      const allowed = ["notifications", "clipboard-sanitized-write", "fullscreen"];
      callback(allowed.includes(permission) && inWindow(wc.getURL()));
    },
  );

  ipcMain.on("os1:set-badge", (e, count) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return;
    app.setBadgeCount(Number.isFinite(count) && count > 0 ? Math.floor(count) : 0);
  });

  createWindow();

  app.on("activate", showWindow);
});

app.on("open-url", (e, url) => {
  e.preventDefault();
  openDeepLink(url);
});

// Universal links (https://os.tella.dev/… clicked in Slack etc.) arrive here
// once the associated-domains entitlement + AASA are in place — see README.
app.on("continue-activity", (e, _type, _userInfo, details) => {
  if (details?.webpageURL) {
    e.preventDefault();
    openDeepLink(details.webpageURL);
  }
});

app.on("before-quit", () => {
  quitting = true;
  saveWindowState();
});

app.on("window-all-closed", () => {
  // macOS convention: stay in the dock until Cmd+Q.
});
