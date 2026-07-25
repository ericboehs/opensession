# OpenSession for Chrome (os1-chrome)

Internal Chrome extension (MV3) — a side panel that captures context from the
page you're looking at (tella-fusion webapp, localhost dev, anywhere) and kicks
off OpenSession agent sessions with it. In the spirit of Claude for Chrome and
Ramp's Inspect extension, but deliberately small: it's a **capture + dispatch**
surface, not a full OpenSession client. Never distributed via the Web Store.

## What it does

- **Composer** (default view): write a prompt, attach context, start a session.
  - **Page chip** — active tab URL + title, auto-attached.
  - **Screenshot** — visible-tab PNG, sent as a real image attachment.
  - **Pick element** — click any element on the page: captures its DOM path,
    text, aria/testid, a cropped screenshot of it, and — via a MAIN-world React
    fiber walk — the React component stack (with `file:line` sources on dev
    builds that carry `_debugSource`) plus the nearest component's props.
  - Repo (guessed from the page: tella.tv/localhost → tella-fusion,
    os.tella.dev → backstage), ask/code mode, model picker.
- **Sessions**: recent sessions with live state (running / needs input /
  queued), click through to a transcript view.
- **Session detail**: transcript tail (polled), follow-up prompts (steer/queue
  semantics, same as the web UI), link out to the full web UI.
- **Right-click → "Send to OpenSession"**: seeds the composer with the page +
  selection.

## Install (unpacked — internal only)

1. `chrome://extensions` → enable Developer mode.
2. "Load unpacked" → select this `os1-chrome/` directory.
3. Click the toolbar icon → the side panel opens → Settings → **Sign in with
   GitHub** (device flow; you must be on the configured team and on the
   Tailscale network — os.tella.dev is tailnet-only).

No build step. Plain JS/HTML/CSS; edit and hit reload on chrome://extensions.

## How it talks to the server

Bearer token (from the device flow's `native: true` poll, same as os1-ios)
against the REST surface:

- `POST /backstage/api/sessions` — create with `{ prompt, repo, mode, model, images }`
- `POST /backstage/api/sessions/:id/prompt` — follow-up via `deliverToSession`
- `GET /backstage/api/sessions`, `GET /backstage/api/sessions/:id/transcript`
- `GET /backstage/api/repos`, `GET /backstage/api/models`
- `POST /backstage/api/auth/device` + `/auth/device/poll` — sign-in

Chrome extensions with host permissions bypass CORS, so the server needs no
CORS headers. Mutations pass the server's cross-site check because requests
with an explicit `Authorization: Bearer` header are exempt (and the pre-token
device-flow POSTs are covered by a `chrome-extension://` origin carve-out) —
see `crossSiteViolation` in `src/server/web-auth.ts`.

## Files

- `manifest.json` — MV3; host permissions for os.tella.dev (API) and
  tella.tv/tella.dev/localhost (capture); `activeTab` covers everything else
  when invoked from the toolbar.
- `background.js` — tiny service worker: opens the panel on icon click, owns
  the context-menu entry.
- `sidepanel.html/css/js` — the whole client. No frameworks.
- `picker.js` — injected on demand (isolated world): hover-highlight element
  picker; tags the chosen node with `data-os1-picked` so the follow-up
  MAIN-world script (`readPickedReactInfo` in sidepanel.js) can walk its React
  fiber — isolated worlds can't see page-JS expandos.
