// OS¹ desktop — thin shell around the cloud or a supervised local server.
// The frontend ships from the server, so this app only owns the window,
// navigation policy, local process lifecycle, notifications, badge and links.
const {
  app,
  BrowserWindow,
  shell,
  session,
  ipcMain,
  autoUpdater,
  systemPreferences,
  Menu,
  clipboard,
  dialog,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { configForCloudSession, LocalServerSupervisor } = require("./local-server.js");
const packageConfig = require("../package.json").opensession || {};

// AppKit can show its persistent-window crash-recovery prompt before Electron
// finishes launching. On macOS 26 that modal can trap the browser process and
// leave the app in a startup crash loop. OS¹ restores its own window bounds, so
// native persistent UI state is both redundant and unsafe here.
if (process.platform === "darwin") {
  systemPreferences.setUserDefault("ApplePersistenceIgnoreState", "boolean", true);
}

// OS1_URL selects the hosted instance. Distributors can set OS1_CLOUD_URL;
// the portable fallback is a locally running OpenSession server.
const CLOUD_URL =
  process.env.OS1_CLOUD_URL ||
  packageConfig.defaultServer ||
  "http://127.0.0.1:3850/";
const CLOUD_ORIGIN = new URL(CLOUD_URL).origin;
let APP_URL = process.env.OS1_URL || CLOUD_URL;
let APP_ORIGIN = new URL(APP_URL).origin;
// github.com stays in-window for the OAuth redirect flow (authorize → callback).
let IN_WINDOW_ORIGINS = [APP_ORIGIN, "https://github.com"];

const stateFile = () => path.join(app.getPath("userData"), "window-state.json");
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

let win = null;
let quitting = false;
let appReady = false;
let pendingDeepLink = null;
let shellSettings = {};
let localMode = false;
let localSupervisor = null;
let localPageLoaded = false;
let localRecoveryTimer = null;
let windowReady = false;

function loadShellSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveShellSettings(next) {
  const file = settingsFile();
  const temporary = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function setAppUrl(url) {
  APP_URL = url;
  APP_ORIGIN = new URL(url).origin;
  IN_WINDOW_ORIGINS = [APP_ORIGIN, "https://github.com"];
}

// ---- Auto-update ------------------------------------------------------------
// Electron's built-in Squirrel.Mac updater against the OpenSession server's
// release proxy (src/server/routes/os1-update.ts server-side). The server
// serves Squirrel's static JSON feed; Squirrel compares versions and downloads
// the signed zip immediately when newer, so "available" doubles as
// "downloading". State mirrors to the renderer (window.os1.updates in preload.js),
// which shows the update toast and calls install to restart.
let updateState = { state: "idle", version: null };

function setUpdateState(next) {
  updateState = next;
  if (win && !win.isDestroyed()) {
    win.webContents.send("os1:update-state", updateState);
  }
}

// True while a menu-initiated check is in flight: the periodic background
// check stays silent, but a manual one reports its outcome in dialogs
// (the toast only appears once an update is actually staged).
let manualCheck = false;
let updaterReady = false;

async function promptRestartToUpdate() {
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    message: "Update ready",
    detail: updateState.version
      ? `OS¹ ${updateState.version} has been downloaded. Restart to install it.`
      : "An update has been downloaded. Restart to install it.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    quitting = true;
    autoUpdater.quitAndInstall();
  }
}

function checkForUpdatesFromMenu() {
  if (!updaterReady) {
    dialog.showMessageBox(win, {
      type: "info",
      message: "Updates unavailable",
      detail: app.isPackaged
        ? "The updater failed to initialize — check the logs."
        : "Auto-update only works in the packaged, signed app.",
    });
    return;
  }
  if (updateState.state === "downloaded") {
    promptRestartToUpdate();
    return;
  }
  manualCheck = true;
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    manualCheck = false;
    dialog.showMessageBox(win, {
      type: "error",
      message: "Update check failed",
      detail: String(err),
    });
  }
}

function initAutoUpdate() {
  // Dev runs (`electron .`) are unsigned — Squirrel refuses to initialize.
  if (!app.isPackaged || process.platform !== "darwin") return;
  try {
    autoUpdater.setFeedURL({
      url: `${CLOUD_ORIGIN}/api/os1-mac/update?version=${encodeURIComponent(app.getVersion())}`,
      serverType: "json",
    });
  } catch (err) {
    console.error("[update] setFeedURL failed", err);
    return;
  }
  updaterReady = true;
  autoUpdater.on("update-available", () => {
    setUpdateState({ state: "available", version: null });
    if (manualCheck) {
      // Keep manualCheck set: update-downloaded finishes the interaction.
      dialog.showMessageBox(win, {
        type: "info",
        message: "Update available",
        detail: "Downloading in the background — you'll be asked to restart once it's ready.",
      });
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(win, {
        type: "info",
        message: "You're up to date",
        detail: `OS¹ ${app.getVersion()} is the latest version.`,
      });
    }
  });
  autoUpdater.on("update-downloaded", (_e, _notes, releaseName) => {
    setUpdateState({ state: "downloaded", version: releaseName || null });
    if (manualCheck) {
      manualCheck = false;
      promptRestartToUpdate();
    }
  });
  autoUpdater.on("error", (err) => {
    // Offline / tailnet-down is normal; log and retry on the next tick.
    console.error("[update]", err);
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(win, {
        type: "error",
        message: "Update check failed",
        detail: String(err),
      });
    }
  });
  const check = () => {
    if (updateState.state === "downloaded") return; // already staged
    try {
      autoUpdater.checkForUpdates();
    } catch (err) {
      console.error("[update] check failed", err);
    }
  };
  // Give launch (and the tailnet) a moment before the first check.
  setTimeout(check, 15 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

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

// Sign-in pages for external services (e.g. the ChatGPT device-code sign-in
// from Settings → Models). The default browser is often not where you're
// logged into these accounts, so prefer Chrome and fall back to the default
// browser when it isn't installed. The app's own GitHub OAuth is NOT in this
// list — it must stay in-window so the session cookie lands in the app.
const CHROME_AUTH_HOSTS = ["auth.openai.com"];

function openExternal(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (process.platform === "darwin" && CHROME_AUTH_HOSTS.includes(host)) {
    execFile("open", ["-a", "Google Chrome", url], (err) => {
      if (err) shell.openExternal(url);
    });
    return;
  }
  shell.openExternal(url);
}

// os1://session/abc → <configured instance>/session/abc; app links pass through.
function deepLinkToUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === "os1:") {
      const target = new URL(APP_URL);
      target.pathname = "/" + (u.host || "") + u.pathname;
      target.search = u.search;
      target.hash = u.hash;
      return target.toString();
    }
    if (u.origin === APP_ORIGIN) return raw;
    if (localMode && u.origin === CLOUD_ORIGIN) {
      const target = new URL(APP_URL);
      target.pathname = u.pathname;
      target.search = u.search;
      target.hash = u.hash;
      return target.toString();
    }
  } catch {}
  return null;
}

function openDeepLink(raw) {
  const url = deepLinkToUrl(raw);
  if (!url) return;
  if (!appReady || (localMode && localSupervisor?.state !== "ready")) {
    pendingDeepLink = raw;
    return;
  }
  showWindow();
  win?.loadURL(url);
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    if (appReady) createWindow();
  } else if (windowReady) {
    win.show();
    win.focus();
  }
}

function showStatusPage(mode, detail = "", logFile = "") {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, "offline.html"), {
    query: { detail, logFile, mode, url: APP_URL },
  });
}

function scheduleLocalRecovery() {
  if (localRecoveryTimer || quitting || !localSupervisor?.prepared) return;
  localRecoveryTimer = setTimeout(async () => {
    localRecoveryTimer = null;
    if (quitting || !win || win.isDestroyed()) return;
    try {
      const response = await fetch(new URL("api/health", APP_URL), {
        signal: AbortSignal.timeout(1_500),
      });
      const body = response.ok ? await response.json() : null;
      if (body?.ok) {
        localPageLoaded = true;
        win.loadURL(pendingDeepLink ? deepLinkToUrl(pendingDeepLink) : APP_URL);
        pendingDeepLink = null;
        return;
      }
    } catch {}
    scheduleLocalRecovery();
  }, 1_000);
  localRecoveryTimer.unref();
}

function handleLocalServerState({ state, detail, logFile }) {
  if (state === "ready") {
    if (localRecoveryTimer) clearTimeout(localRecoveryTimer);
    localRecoveryTimer = null;
    const showingStatus = win?.webContents.getURL().startsWith("file:");
    if (win && !win.isDestroyed() && (!localPageLoaded || showingStatus || pendingDeepLink)) {
      localPageLoaded = true;
      win.loadURL(pendingDeepLink ? deepLinkToUrl(pendingDeepLink) : APP_URL);
      pendingDeepLink = null;
    }
    return;
  }
  if (!localPageLoaded && (state === "starting" || state === "backoff")) {
    showStatusPage("starting", detail, logFile);
  }
}

function createWindow(initialStatus = null) {
  const state = loadWindowState();
  windowReady = false;
  win = new BrowserWindow({
    ...state,
    minWidth: 700,
    minHeight: 480,
    // The web app keeps its workspace opaque and reveals this native material
    // only through the sidebar and narrow outer gutter. Unlike the original
    // vibrancy pass, the renderer does not add CSS backdrop filters on top.
    transparent: true,
    backgroundColor: "#00000000",
    vibrancy: "sidebar",
    visualEffectState: "followWindow",
    // Do not expose the raw material before Chromium has painted its first
    // frame; this avoids a bright launch flash when the system is in light mode.
    show: false,
    // The frontend already lays itself out for Window Controls Overlay (its PWA
    // manifest declares display_override: window-controls-overlay).
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    // No dedicated titlebar band in the frontend: its first content row (48px)
    // is the titlebar, so center the ~12px traffic lights on it ((48 - 12) / 2).
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const createdWindow = win;
  createdWindow.once("ready-to-show", () => {
    if (createdWindow.isDestroyed() || win !== createdWindow) return;
    windowReady = true;
    createdWindow.show();
    createdWindow.focus();
  });

  win.on("close", (e) => {
    saveWindowState();
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    windowReady = false;
    win = null;
  });

  // Keep app navigation + the GitHub OAuth redirect in-window; everything else
  // (PR links, docs, …) goes to the default browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!inWindow(url)) {
      e.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === APP_ORIGIN) return { action: "allow" };
    openExternal(url);
    return { action: "deny" };
  });

  // Native right-click menu (copy link, copy, paste, …) — Electron shows
  // nothing by default.
  win.webContents.on("context-menu", (_e, params) => {
    const items = [];

    if (params.linkURL) {
      items.push(
        {
          label: "Open Link in Browser",
          click: () => openExternal(params.linkURL),
        },
        {
          label: "Copy Link",
          click: () => clipboard.writeText(params.linkURL),
        },
        { type: "separator" },
      );
    }

    if (params.hasImageContents && params.srcURL) {
      items.push(
        { label: "Copy Image", click: () => win.webContents.copyImageAt(params.x, params.y) },
        { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
        { type: "separator" },
      );
    }

    if (params.isEditable) {
      items.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: "copy" });
    }

    // Drop a trailing separator so link-only menus end cleanly.
    while (items.length && items[items.length - 1].type === "separator") items.pop();
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Show a themed recovery page instead of Chromium's network error.
  win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    showStatusPage(
      localMode ? (localPageLoaded ? "local-offline" : "starting") : "offline",
      "",
      localSupervisor?.logFile,
    );
    if (localMode) scheduleLocalRecovery();
  });

  // Belt-and-braces: if the renderer ever dies, come back instead of showing
  // a dead window.
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    if (localMode && localSupervisor?.state !== "ready") {
      showStatusPage("starting", "Waiting for the local server to restart…", localSupervisor.logFile);
      scheduleLocalRecovery();
    } else {
      win.loadURL(APP_URL);
    }
  });

  if (initialStatus) showStatusPage(initialStatus.mode, initialStatus.detail, initialStatus.logFile);
  else if (localMode && localSupervisor?.state !== "ready") {
    showStatusPage("starting", "Waiting for the local server to start…", localSupervisor.logFile);
    scheduleLocalRecovery();
  } else win.loadURL(APP_URL);
}

// Electron's default menu, plus "Check for Updates…" in the app menu — the
// standard roles keep all the stock items and shortcuts (edit, view, window).
function buildAppMenu() {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { label: "Check for Updates…", click: checkForUpdatesFromMenu },
          {
            label: "Use Local Sessions",
            type: "checkbox",
            checked: localMode,
            enabled: process.env.OS1_LOCAL !== "1",
            click: (item) => {
              shellSettings = { ...shellSettings, localMode: item.checked };
              saveShellSettings(shellSettings);
              localSupervisor?.stop();
              quitting = true;
              app.relaunch();
              app.quit();
            },
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

app.whenReady().then(async () => {
  // `electron .` is not a packaged .app, so macOS otherwise shows Electron's
  // default Dock icon. Packaged builds get their signed bundle icon from
  // electron-builder; only the development runtime needs this explicit PNG.
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock.setIcon(path.join(__dirname, "../build/icon-512.png"));
  }

  shellSettings = loadShellSettings();
  localMode = process.env.OS1_LOCAL === "1" || shellSettings.localMode === true;
  let initialStatus = null;
  if (localMode) {
    const cloudSession = await session.defaultSession.cookies
      .get({ url: CLOUD_URL, name: "opensession_auth" })
      .then((cookies) => cookies[0]?.value || null)
      .catch(() => null);
    localSupervisor = new LocalServerSupervisor({
      config: configForCloudSession(shellSettings, cloudSession),
      resourcesPath: process.resourcesPath,
      userDataDir: app.getPath("userData"),
      onState: handleLocalServerState,
    });
    try {
      const prepared = await localSupervisor.prepare();
      setAppUrl(prepared.url);
      initialStatus = {
        mode: "starting",
        detail: `Starting local server on port ${prepared.port}…`,
        logFile: localSupervisor.logFile,
      };
    } catch (error) {
      localSupervisor.setState("error", error.message);
      const missingServer = String(error.message).startsWith("OpenSession server source is missing");
      initialStatus = {
        mode: missingServer ? "missing" : "error",
        detail: error.message,
        logFile: localSupervisor.logFile,
      };
    }
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

  ipcMain.handle("os1:update-state", (e) =>
    inWindow(e.senderFrame?.url ?? "")
      ? updateState
      : { state: "idle", version: null },
  );
  ipcMain.on("os1:update-install", (e) => {
    if (!inWindow(e.senderFrame?.url ?? "")) return;
    if (updateState.state !== "downloaded") return;
    // quitAndInstall closes every window; flip `quitting` first so the
    // close-to-hide handler doesn't cancel the relaunch.
    quitting = true;
    autoUpdater.quitAndInstall();
  });

  buildAppMenu();

  appReady = true;
  createWindow(initialStatus);

  if (localMode && localSupervisor?.prepared) localSupervisor.start();
  else if (pendingDeepLink && !localMode) {
    const deepLink = pendingDeepLink;
    pendingDeepLink = null;
    openDeepLink(deepLink);
  }

  initAutoUpdate();

  app.on("activate", showWindow);
});

app.on("open-url", (e, url) => {
  e.preventDefault();
  openDeepLink(url);
});

// Universal links for the configured instance arrive here
// once the associated-domains entitlement + AASA are in place — see README.
app.on("continue-activity", (e, _type, _userInfo, details) => {
  if (details?.webpageURL) {
    e.preventDefault();
    openDeepLink(details.webpageURL);
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (localRecoveryTimer) clearTimeout(localRecoveryTimer);
  localRecoveryTimer = null;
  localSupervisor?.stop();
  saveWindowState();
});

app.on("window-all-closed", () => {
  // macOS convention: stay in the dock until Cmd+Q.
});
