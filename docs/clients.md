# The clients

OpenSession is one server with several front ends. Only the first is required —
everything else is optional and talks to the same instance.

| Client | Where | Needs building? |
| --- | --- | --- |
| Web UI | `src/frontend/` | no — the server builds and serves it |
| PWA | same web UI, installed to a home screen | no |
| Electron desktop shell | `os1-mac/` | yes |
| Native Swift app (iOS + macOS) | `os1-ios/` | yes, with Xcode |
| Chrome extension | `os1-chrome/` | no — load unpacked |
| Terminal client (`os`) | `os1-tui/` | yes, one `bun build` |

**All of them let you set the server address**, and the versions in this
repository default to `http://127.0.0.1:3850` rather than anyone else's
instance. See [instance-configuration.md](instance-configuration.md) for how a
distributor stamps in their own default.

## Web UI

The one that matters. React, built by the server itself at startup and on every
change — no separate dev server, no Vite. Frontend edits rebuild live and the
browser reloads; only backend changes need `opensession restart`.

Served at the root of whatever address you bound to. If you use nothing else,
you are not missing core functionality.

## PWA

The same web UI, installed to a phone home screen via the browser's "Add to Home
Screen". No build, no store, no separate codebase.

Worth doing on iOS specifically: **web push notifications only work in the
installed PWA**, not in Safari tabs. If you want your phone to tell you a
session is waiting on an answer, this is how.

Keyboard handling and safe-area insets are handled for the installed case, which
is why it feels like an app rather than a website in a frame.

## Electron desktop shell

`os1-mac/` — a thin native window around the web UI. It exists for the things a
browser tab cannot do: a dock icon, native window materials, deep links
(`opensession://`), and staying out of the way of your browser's tab bar.

It renders the *server's* frontend, so it does not lag behind the web UI. Server
selection is `OS1_URL` / `OS1_CLOUD_URL`, falling back to the packaged default.

```sh
cd os1-mac && bun install && bun start
```

Despite the directory name it is an ordinary Electron app; the macOS-specific
parts are signing and notarisation, not the runtime.

## Native Swift app (iOS and macOS)

`os1-ios/` — one SwiftUI codebase, two targets. This is *not* a web view: it is
a native client against the REST and WebSocket surface, which is why it feels
different from the PWA and why it can do things like native settings panes and
proper background behaviour.

Set the server under Settings → Server. There are `OS1_SERVER` / `OS1_TOKEN`
environment overrides for simulator runs, which are deliberately not persisted.

Read `os1-ios/AGENTS.md` before changing it — the build and verification
workflow, the release trigger, and some load-bearing performance invariants live
there rather than being obvious from the code.

Needs Xcode and an Apple developer account to run on a device. TestFlight builds
come from `.github/workflows/os1-ios-testflight.yml`.

## Chrome extension

`os1-chrome/` — an MV3 side panel. Its job is capturing context from the page
you are looking at: a screenshot, or a picked element complete with its React
fiber info, handed straight into a new session. For debugging a web app with an
agent, that is a much better starting prompt than a description.

Loaded unpacked, never from the Web Store:

```
chrome://extensions → Developer mode → Load unpacked → os1-chrome/
```

Set the server in the side panel's Server field. It authenticates with a Bearer
token and talks to the same REST surface as everything else.

## Terminal client

`os1-tui/` — OpenSession in a terminal. A TUI with a workspace sidebar, live
transcripts, tabs and tmux keys, for when you are already in a terminal and do
not want to reach for a browser.

```sh
os                          # loopback
os --host os.company.dev    # a specific server (remembered afterwards)
```

Host resolution is `--host` → `OPENSESSION_HOST` → saved config → loopback.

It is **a client and nothing else**: HTTP plus one WebSocket per watched session.
It never spawns an agent, never touches a worktree, and imports nothing from the
server — which is what lets it compile to a standalone binary you can drop on any
machine that can reach your instance. `opensession tui` is an alias.

Read `os1-tui/AGENTS.md` before changing it.

## Which to use

Start with the web UI. Add the PWA if you want notifications on your phone. The
Electron shell is a comfort upgrade, the Swift app is the good phone experience,
the terminal client is the one to reach for if you live in tmux, and the Chrome
extension is worth it specifically if you debug web front ends.

None of them add capability the web UI lacks — they add ergonomics, native
integration, and in the extension's case a much better way to point an agent at
something you are looking at.
