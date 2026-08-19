# Single-executable build (`bun build --compile`)

Open Session's server can be built as one self-contained executable with
[`bun build --compile`](https://bun.com/docs/bundler/executables), in addition
to the source checkout and the tarball/install flow (which are unchanged). The
binary boots the server and serves the UI with nothing on `PATH` except the
external engine CLIs (`opencode` / `claude`).

## Build

```bash
bun scripts/build-compile.ts                 # → ./opensession
bun scripts/build-compile.ts --outfile dist/opensession
```

The script builds the prod frontend into `.frontend-dist`, bakes those assets
into the binary, then runs `bun build --compile src/main.ts` with `sharp` and
`@img/*` marked external. It restores the `src/server/embedded-frontend.ts`
stub afterward, so the working tree stays clean.

Build on the target platform: a compiled binary is platform-specific
(darwin/arm64 here), and the embedded `sharp` native (below) must match.

## One binary, four entrypoints

From source these are four processes (`opensession.ts`, `scripts/cli.ts`,
`src/runner-host/host.ts`, `src/runner-host/mcp-proxy.ts`). The compiled binary
has no `bun`/`.ts` tree to re-exec, so `src/main.ts` dispatches on a leading
subcommand and the self-spawn sites emit those subcommands
(`src/runner-host/exe.ts`):

| Invocation | Runs |
| --- | --- |
| `opensession server` | the HTTP/WS server (`opensession.ts`) |
| `opensession runner-host <spec>` | one detached agent run (`host.ts`) |
| `opensession mcp-proxy` | the stdio↔RPC MCP proxy (`mcp-proxy.ts`) |
| `opensession <anything else>` | the CLI (`onboard`, `start`, `doctor`, …) |

`isCompiledBinary()` (execPath basename ≠ `bun`) gates compiled-vs-source
behavior; source mode is byte-identical to before.

## Embedded vs external

**Embedded in the binary** (via `Bun.embeddedFiles` / `import … with { type:
"file" }`): the prebuilt SPA — the stitched `index.html` plus the hashed
JS/CSS/wasm from `.frontend-dist`. In compiled mode `isPrebuiltFrontend()` is
true: the server serves these and never runs the in-process frontend build
(there is no source tree or Tailwind CLI beside the binary). The frontend
file-watch is skipped too.

Frozen at build time, since they come from the build-time config: the SPA's
`window.__OPENSESSION_INSTANCE__` (product name/mark, `publicBaseUrl`, default
repo). Per-install branding customization remains a source/tarball feature.

Cosmetic assets under `src/frontend/` (app icons, splash images, `sw.js`,
sign-in backgrounds) are **not** embedded; those routes `404` under the
compiled binary. The app still renders (the manifest is generated dynamically).

**External — `sharp`** (dynamic social-card PNG rasterizer). Its platform
native (`@img/sharp-<platform>` + libvips) is resolved at runtime and cannot be
embedded. `src/server/session-social-card.ts` loads sharp lazily: without it the
server still boots and serves the UI, and the `/session-card/*.png` endpoint
returns `501` (the Open Graph meta tags still emit). To enable social cards,
place a minimal `node_modules` with `sharp` + the platform `@img/sharp-*`
beside the binary — e.g. copy `node_modules/sharp` and
`node_modules/@img/sharp-<platform>` (+ its `sharp-libvips-<platform>`).

Other native addons in the dependency tree (`@libsql/*`, `@cbor-extract/*`,
`@anthropic-ai/claude-agent-sdk` audio-capture, `@mariozechner/clipboard`,
`@earendil-works/pi-tui`) are not on the server boot/serve path, so the binary
boots and serves without them; features that reach one only need it when that
feature runs. The build-only natives (`@tailwindcss/oxide`, `lightningcss`,
`@parcel/watcher`) are never used in prebuilt-frontend mode.

## State

Runtime state stays external and is unchanged: `OPENSESSION_CONFIG`
(`config.json`), `OPENSESSION_STATE_DIR`, the sessions dir, and
`mcp-config.json` are read by path as usual.
