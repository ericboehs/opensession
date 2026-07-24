# OS¹ for Mac

A thin Electron shell around [https://os.tella.dev](https://os.tella.dev), with
an opt-in local mode that supervises a local OpenSession server. The frontend
still ships from the selected server, so this app only owns the window,
navigation policy, local process lifecycle, notifications, dock badge and deep
links.

The shell lives in `os1-mac/` inside the Backstage repository so native window
changes and their frontend counterparts can ship together.

## Development

```sh
cd os1-mac
bun install
bun start
```

Requires being on the tailnet (the server is Tailscale-only); otherwise you get
the built-in retry screen.

### Local sessions

Choose **OS¹ → Use Local Sessions** and the app relaunches against a supervised
local server. `OS1_LOCAL=1 bun start` forces the same mode for development. The
shell does not clone or update server source: install it once with:

```sh
git clone https://github.com/tellahq/backstage ~/os1/server
cd ~/os1/server
bun install
```

The shell configuration is `settings.json` in Electron's `app.getPath("userData")`
directory:

```json
{
  "localMode": true,
  "serverDir": "/Users/ada/code/backstage",
  "cloudToken": "optional-web-session-bearer-token"
}
```

All fields are optional. `localMode` defaults to `false`; `serverDir` defaults to
`~/os1/server` when that directory exists. `cloudToken` falls back to the
`token` field in `~/.opensession-frontend-dev-token.json`. With no token the
server remains purely local. Child output is appended to `local-server.log` in
the same user-data directory.

### Iterating on the frontend before it ships

The shell renders whatever the server serves. To test unmerged OpenSession
frontend changes against **live production data**, run this from the Backstage
repository root:

```sh
bun app:dev
```

This starts the local SPA on `:3851`, waits for it to become ready, prepares a
lightweight unsigned development `.app`, launches it with the proper OS¹ Dock
name/icon, and stops both processes together on `Ctrl+C`. Fully quit an
already-running OS¹ first (`⌘Q`); closing its window only hides it and the
single-instance lock would otherwise reuse that older process.

Edits hot-reload in place (React Fast Refresh + CSS hot-swap; Tailwind output
refreshes within ~3s). ⚠️ Writes are real — prompts/steers/archives hit
production. For a fully isolated sandbox instead, run the whole server locally
(`mkdir -p ~/.opensession-chats && bun --hot run opensession.ts`, port 3850) —
empty local state, optionally rsync'd from prod.
`OS1_URL` is dev-only — packaged builds always load https://os.tella.dev.

## Architecture

- `src/main.js` — a single sandboxed `BrowserWindow` loading the cloud or active
  loopback server (`contextIsolation`, no Node in the renderer). In-window
  navigation is limited to the active app origin plus
  `github.com` (the OAuth redirect flow); everything else opens in the default
  browser. Window close hides to the dock; state persists across launches.
- `src/local-server.js` — local-mode server resolution and supervision. It picks
  a free loopback port, starts `bun run opensession.ts`, waits for `/api/health`,
  restarts crashes with exponential backoff, logs output under user data, and
  sends SIGTERM on app quit.
- `src/preload.js` — exposes `window.os1` (`desktop`, `setBadge`, `clearBadge`)
  for the frontend to feature-detect and mirror its app badge to the dock.
- `src/offline.html` — retry screen for when the tailnet is unreachable.
- **The web app's service worker is deliberately blocked** (request to `sw.js`
  cancelled + registrations cleared at boot). Its jobs — Web Push, app-shell
  cache, PWA badge — don't function in Electron anyway, and its Cache Storage
  writes crash Electron 43's renderer with a bad `CacheStorageCache` Mojo
  message (reproducible on every launch; likely an Electron/Chromium bug —
  re-test when bumping Electron majors).
- Window chrome: the frontend already supports Window Controls Overlay (its PWA
  manifest), which Electron activates via `titleBarStyle: hidden` +
  `titleBarOverlay`. The window uses macOS's native `sidebar` vibrancy material;
  the frontend keeps the detail pane opaque and exposes that material only
  beneath its translucent sidebar.

## Auth

GitHub web sign-in works in-window via the redirect flow (github.com is an
allowed navigation origin); the device-flow fallback link works too. The
`opensession_auth` cookie persists in Electron's default session.

## Deep links

- `os1://…` opens the app and maps to the active server
  (e.g. `os1://session/abc` → `/session/abc`). In local mode, incoming
  `https://os.tella.dev/…` universal links preserve their path on the local
  origin.
- **Universal links** (plain `https://os.tella.dev/…` links opening the app,
  e.g. from Slack): the server side is done — OpenSession serves
  `/.well-known/apple-app-site-association` for app ID
  `6GUXT43C8B.dev.tella.os1` (backstage PR #67). Signed CI builds install the
  Developer ID profile from the `OS1_PROVISIONING_PROFILE_BASE64` repository
  secret and sign the top-level app with `build/entitlements.mac.applinks.plist`;
  the release fails if either the signed entitlement or embedded profile is
  missing. The Electron helpers keep inheriting `build/entitlements.mac.plist`
  (no associated-domains): they carry no provisioning profile, and macOS
  SIGKILLs any helper that claims a restricted entitlement it can't back with
  one — which surfaces as `GPU process isn't usable. Goodbye.` at launch. Local
  unsigned builds use `build/entitlements.mac.plist` for both and need no
  profile.
  Caveat: os.tella.dev resolves to a tailnet IP, so Apple's AASA CDN cannot
  fetch the association file. The entitlement therefore also lists the
  `?mode=developer` alternate, which fetches directly — each team device must
  enable Associated Domains development mode for the links to activate. If
  that proves too fiddly, `os1://` links remain the reliable path.

## Signing & release

CI (`../.github/workflows/os1-mac-release.yml`) builds, signs, notarizes and
publishes a GitHub Release on every `v*` tag. Manual "Run workflow" does a dry
run with artifacts attached to the run. Repository secrets mirror
[tellahq/tella-mac](https://github.com/tellahq/tella-mac)
(`Docs/ReleaseAutomation.md` there documents how each value is produced):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATES_P12` | "Developer ID Application: Tella HQ Inc. (6GUXT43C8B)" as base64 .p12 |
| `APPLE_CERTIFICATES_PASSWORD` | password of that .p12 export |
| `APPLE_ID` | Apple ID with app access |
| `APPLE_APP_PASSWORD` | app-specific password for that Apple ID |

Releasing: `git tag v0.1.0 && git push origin v0.1.0`.

Local `bun run dist` produces an unsigned build (signing/notarization are
skipped with a warning when no identity/credentials are present). It first
downloads pinned OpenCode 1.18.4 into the gitignored `build/vendor/` directory.
Release builds copy that binary to `Contents/Resources/opencode` and sign it
with `build/entitlements.opencode.plist`; the workflow verifies the version,
Developer ID signature, hardened-runtime JIT entitlement, and enclosing app
signature before notarization.

## Auto-update

The packaged app keeps itself current via Electron's built-in Squirrel.Mac
updater. It polls `https://os.tella.dev/api/os1-mac/update?version=<installed>`
on launch and every 4 hours — served by `src/server/routes/os1-update.ts` in
this repository, which serves the latest GitHub release in Squirrel's static
JSON feed format and proxies the signed arm64 zip out of it (Squirrel can't
reach the private repo itself). When an update is found Squirrel downloads it
in the background; the web frontend shows a persistent bottom-right toast
(`DesktopUpdateToast`, driven by `window.os1.updates` from `src/preload.js`)
that flips to "Restart to update" once the download is staged, and restarting
installs + relaunches.

Shipping an update is unchanged: bump `version` in `package.json`, tag, push
the tag. Installed apps (≥ 0.2.0) pick it up on their next check. Dev runs
(`electron .`, unsigned) skip the updater entirely.

## Follow-ups tracked

- **Dock badge**: the web app sets its badge via `navigator.setAppBadge` in the
  service worker, which doesn't reach Electron's dock. Frontend change in the
  OpenSession repo: when `window.os1` exists, also call `window.os1.setBadge(n)`.
- **Universal links**: see above.
- **Web Push**: push events don't arrive in Electron (no FCM); notifications
  while the app is running come through the page's WebSocket + Notification
  API, which works. Closed-app push would need a native APNs story — not
  planned.
