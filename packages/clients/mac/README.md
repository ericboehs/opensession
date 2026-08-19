# Open Session for Mac

A thin Electron shell around a configured Open Session server. The app owns
the window, navigation policy, notifications, dock badge and deep links.

The shell lives in `packages/clients/mac/` inside the Open Session repository so native
window changes and their frontend counterparts can ship together.

## Its name, and what a rename costs

The app's label is **OS** (`productName`), the full product name is **Open
Session**. On macOS that label is one knob for four things, and they cannot be
separated:

| Follows `productName` | Why it matters |
| --- | --- |
| `OS.app` and its executable | what Finder and the Dock show |
| `CFBundleName` | the menu-bar title |
| `OS Helper.app` (and friends) | Electron looks child processes up by `CFBundleName`; a mismatch is a fatal "Unable to find helper app" |
| Keychain item `OS Safe Storage` | the key Chromium encrypts the cookie jar with |

So each rename costs one sign-in: Electron resolves the Keychain name from the
bundle before `src/main.js` is loaded, and the new key cannot read what the old
one wrote. Nothing else has to move, because the profile folder no longer
follows the label — `src/main.js` pins `userData` (and `sessionData`) to a
fixed name, so window bounds, zoom, notification grant, preferences and drafts
stay put. The release artifacts keep the full name (`OpenSession-<version>-arm64.zip`)
because the update feed matches on it.

Fresh installs from the DMG land as `OS.app`; copies that auto-update keep
whatever filename they already had, because Squirrel replaces the bundle in
place. Both are the same app.

## Development

```sh
cd packages/clients/mac
bun install
bun start
```

Requires network access to the configured server; otherwise you get the
built-in retry screen.

### Iterating on the frontend before it ships

The shell renders whatever the server serves. To test unmerged Open Session
frontend changes against **live production data**, run this from the
repository root:

```sh
bun app:dev
```

This starts the local SPA on `:3851`, waits for it to become ready, prepares a
lightweight unsigned development `.app`, launches it with the proper Open
Session Dock name/icon, and stops both processes together on `Ctrl+C`. Fully
quit an already-running Open Session first (`⌘Q`); closing its window only
hides it and the single-instance lock would otherwise reuse that older process.

Edits hot-reload in place (React Fast Refresh + CSS hot-swap; Tailwind output
refreshes within ~3s). ⚠️ Writes are real — prompts/steers/archives hit
production. For a fully isolated sandbox instead, run the whole server locally
(`mkdir -p ~/.opensession-sessions && bun --hot run opensession.ts`, port 3850) —
empty local state, optionally rsync'd from prod.
## Which server

The app asks the first time it opens and keeps the answer in its profile
(`server.json`), so a build is not tied to the address it was made with. A bare
host resolves to `https`, except on this machine, and the answer is checked
against `/api/health` before it is saved; the address that answered is what gets
stored, which is how a plain-http instance on a LAN or a tailnet is found.
Change Server in the app menu, and a button on the status page, bring the
question back; changing it restarts the app, since the update feed and the
window's own origins are wired at launch.

`OS1_URL` overrides the stored answer for one run. Distributions set the address
the first-run screen offers with `opensession.defaultServer` in `package.json`
(or `OS1_CLOUD_URL`); a profile that already worked keeps using it and is never
asked.

## Architecture

- `src/main.js` — a single sandboxed `BrowserWindow` loading the configured
  server (`contextIsolation`, no Node in the renderer). In-window
  navigation is limited to the active app origin; everything else opens in the
  default browser. Window close hides to the dock; state persists across
  launches.
- `src/preload.js`: exposes `window.os1` (`desktop`, `setBadge`, `clearBadge`,
  `updates`) for the frontend to feature-detect and mirror its app badge to the
  dock, plus `server` for the two shell pages below. The main process refuses
  `server` calls from anything but a `file://` page, so the app a server serves
  cannot repoint the shell.
- `src/setup.html`: the server prompt, shown when nothing is stored yet and
  again from Change Server. It checks the address before saving it.
- `src/offline.html` — retry screen for when the configured server is
  unreachable, with a way back to that prompt, since a stored address that is
  wrong looks exactly like a server that is down.
- `src/shell.css`: the tokens and splash those two pages share. They load from
  `file://` with the server possibly gone, so they can fetch nothing from it;
  `src/mark.png` is that splash's mark.
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

GitHub web sign-in is the device flow: the sign-in screen shows a code, "Open
GitHub" hands github.com to the default browser, and this window stays on the
waiting screen until the poll comes back. The `opensession_auth` cookie
persists in Electron's default session.

## Deep links

- `os1://…` opens the app and maps to the active server
  (e.g. `os1://session/abc` → `/session/abc`). Shared session, workspace and
  PR pages show a dismissible **Open app** card at the bottom of the sidebar in
  a Mac browser. The click opens this protocol while leaving the web page in
  place when the app is not installed.
- **Universal links** (plain `https://os.tella.dev/…` links opening the app,
  e.g. from Slack — Tella's host; see the rebrand note under Signing & release):
  the server side is done — Open Session serves
  `/.well-known/apple-app-site-association` for app IDs
  `6GUXT43C8B.dev.tella.os1` (the iOS + Mac App Store pair) and
  `6GUXT43C8B.dev.tella.os1.shell` (this shell). Signed CI
  builds install the
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
  enable Associated Domains development mode for native Universal Links. The
  **Open app** action above is the fallback on Macs without that setting.

## Signing & release

This section (and the universal-links app IDs above) documents **Tella's own
release setup** — Apple team `6GUXT43C8B` and the `dev.tella.os1.*` bundle ids.
If you fork, rebrand those identifiers to your own namespace (your Apple team
id, your bundle id prefix, your server URL) and supply your own signing
secrets; nothing in the shell depends on Tella's values.

CI (`../../../.github/workflows/os1-mac-release.yml`) builds, signs, notarizes and
publishes a GitHub Release on every `v*` tag. Manual "Run workflow" does a dry
run with artifacts attached to the run. Repository secrets (the values below
are Tella's — supply your own):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATES_P12` | "Developer ID Application: Tella HQ Inc. (6GUXT43C8B)" as base64 .p12 |
| `APPLE_CERTIFICATES_PASSWORD` | password of that .p12 export |
| `APPLE_ID` | Apple ID with app access |
| `APPLE_APP_PASSWORD` | app-specific password for that Apple ID |

Releasing: `git tag v0.1.0 && git push origin v0.1.0`.

Local `bun run dist` produces an unsigned build when signing credentials are
absent. Release builds package the Electron shell and its icon resources. The
pipeline embeds the Developer ID provisioning profile and signs only the outer
app with the associated-domains entitlement, so Universal Links work without
Electron helpers claiming an entitlement they cannot support. The package keeps
only Electron's English locale resources because Open Session is currently English-only;
Chromium's unused locale set otherwise adds roughly 49 MB to the installed app.

The shell has no production dependencies, and `package.json` declares an empty
`workspaces` list to say so structurally. Without it, electron-builder finds no
node modules here, walks up to the repository's own workspace root and tries to
resolve *that* package's production dependencies, which the release runner never
installs: the build then fails with "Production dependency ... not found for
package opensession". The empty list stops the search at this directory.

## Auto-update

The packaged app keeps itself current via Electron's built-in Squirrel.Mac
updater. It polls `<cloud server>/api/packages/clients/mac/update?version=<installed>`
on launch and every 4 hours — served by `packages/core/opensession-server/src/server/routes/os1-update.ts` in
this repository, which serves the latest GitHub release in Squirrel's static
JSON feed format and proxies the signed arm64 zip out of it (Squirrel can't
reach a private GitHub repo itself). When an update is found Squirrel downloads it
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
  Open Session repo: when `window.os1` exists, also call `window.os1.setBadge(n)`.
- **Universal links**: see above.
- **Web Push**: push events don't arrive in Electron (no FCM); notifications
  while the app is running come through the page's WebSocket + Notification
  API, which works. Clicking one raises the window through
  `window.os1.focusWindow()`, since a renderer-side `window.focus()` does not
  bring a BrowserWindow forward on macOS. Closed-app push would need a native
  APNs story — not planned.
