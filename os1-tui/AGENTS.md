# Working on os1-tui

`os` is the fifth OpenSession client (after the web UI, `os1-mac`, `os1-ios`,
`os1-chrome`). Read `README.md` first — it has the key table, the module map and
the protocol notes. This file is the build/verify loop and the invariants.

## Verify loop

```bash
cd os1-tui
bun test           # everything, incl. real render tests — must be green
bun run typecheck  # strict, noUncheckedIndexedAccess
```

Both are fast (~2s) and need neither a server nor a terminal. Run them on every
change; there's no excuse for landing a red tree here.

Against a real server:

```bash
bun src/index.ts sessions --host http://127.0.0.1:3850   # no TUI, quickest check
bun src/index.ts --host http://127.0.0.1:3850            # the real thing
```

On a box with the sign-in gate on and no browser, pass a token from the
web-sessions store for a one-off check:

```bash
OPENSESSION_TOKEN=$(python3 -c "
import json; d=json.load(open('$HOME/.opensession-web-sessions.json'))
s=d.get('sessions',d); l=list(s.values()) if isinstance(s,dict) else s
print(next(e['token'] for e in l if e.get('token')))") \
  bun src/index.ts sessions --host http://127.0.0.1:3850
```

To see the TUI render without a TTY (CI, an agent session), drive it through a
pty and inspect the stream:

```bash
COLUMNS=120 LINES=30 timeout 10 script -qec "bun src/index.ts --host http://127.0.0.1:3850" /dev/null
```

## Invariants

- **No server imports.** Nothing under `src/` may import from `../src/server`,
  `../opensession.ts`, or anything outside this package. The whole point is a
  binary that compiles and runs with only its own deps. `src/client/types.ts` is
  a deliberate hand-written copy of the wire shapes, same as os1-ios's Codable
  models — update it when the server adds a field you need, don't import.
- **Keys resolve to Actions; only `runAction` mutates.** Add a key by adding an
  `Action` variant + a `resolveKey` case + a `runAction` case, and a `KEY_HELP`
  row (the help overlay and README both read from that constant). A key handler
  that reaches into a store directly is a bug.
- **There is always a way out, and it's discoverable.** The renderer runs with
  `exitOnCtrlC: false` (inside a session ^c means "interrupt the turn"), so
  quitting is the app's job: `q`, `^b q`, `^b d`, and a second `ctrl+c` inside
  two seconds. The status bar advertises `^b q` at all times. Don't take a key
  away from that set without replacing it with a louder one — a TUI you can't
  leave is the worst bug this client can ship.
- **Don't bind `ctrl+letter` or rely on `ctrl+arrow` alone.** ctrl+h/j/k/l are
  backspace and newline; ctrl+arrows are eaten by tmux and by most terminals'
  word-jump. Prefix-less movement lives on alt+arrows, with prefixed
  equivalents (`^b o`, `^b n`, `^b p`) as the always-available fallback.
- **The sidebar is scoped, and the scope is visible.** `GET /api/sessions`
  returns the whole install — thousands of rows, mostly automation runs — so
  `src/client/identity.ts` filters to mine / team / all (`f`), the poller caps
  the result at 200 newest, and the header shows which scope with a count. An
  empty *unchosen* scope widens itself; a scope the user picked never does.
- **Never read render-scoped state inside a key handler.** A terminal delivers
  `^b w` as two keypresses in one tick, before React re-renders — that's why
  `UiStore` is ref-backed and why `flatRef`/`stateRef`/`watchedRef` exist. Read
  `uiStore.getState()`, not the `ui` from render.
- **Store getters passed to `useSyncExternalStore` must be arrow properties.** An
  unbound method reference loses `this` and blows up at mount (it did once).
- **A tab is a WebSocket.** The server's `watch` handles one session per
  connection; `WatchPool` owns that mapping and is the only thing that opens or
  closes sockets.
- **`watch` is sent from the socket's open handler only** — never also at
  construction, or the session gets double-watched and pays for two full
  transcript snapshots.

## Adding server surface

New endpoint → a method on `Api` (in `src/client/api.ts`) with the bare `/api/…`
path; the server normalizes onto its internal `/backstage/api/*` literals. New
WebSocket frame → a variant in `ServerFrame` plus a `applyFrame` case plus a test
in `test/session-store.test.ts`. Frames this client doesn't model are ignored by
identity, so an unknown frame can never crash a session.

## Releasing

```bash
bun build --compile --minify --target=bun-linux-x64   src/index.ts --outfile os
bun build --compile --minify --target=bun-darwin-arm64 src/index.ts --outfile os-darwin-arm64
bun build --compile --minify --target=bun-linux-arm64  src/index.ts --outfile os-linux-arm64
```

OpenTUI is a native FFI dep, so a target only works if its prebuilt is present —
if a target fails to launch with a dlopen error, that's why, not the bundle.
