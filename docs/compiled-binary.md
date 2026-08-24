# Single-executable build (`bun build --compile`)

The default simple-mode artefact is one self-contained executable built with
[`bun build --compile`](https://bun.com/docs/bundler/executables): the server,
CLI, run host and MCP proxy behind one argv, with the prebuilt frontend baked
in. It boots and serves the UI with nothing on `PATH` except the `claude` CLI
(and `codex` for the ChatGPT path); the Pi engine and its Anthropic bridge are
compiled in and run in-process. The `--source` install (a git checkout +
`bun install`) stays as the self-development and contributor path.

## Build

```bash
# Release artefact (the default install downloads this): the target binary +
# a sharp sidecar + the session-kernel worker sidecar + the service templates
# + release.json, tarred.
bun scripts/build-compile.ts --os linux --arch arm64 --out ~/.cache/opensession-release

# Just the host binary, for local testing (no sidecar).
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

**External: the session-kernel worker.** The kernel actor runs in a real Worker
thread. The gateway blocks on `Atomics.wait` against a `SharedArrayBuffer` the
worker fills, so it cannot run in-process or as a subprocess, and `bun build
--compile` does not embed Worker entry points. The worker therefore ships as a
`session-kernel-worker.js` sidecar beside the binary;
`src/server/session-kernel/actor-runtime.ts` loads it from `process.execPath`'s
directory in compiled mode, and from the TypeScript entry in a source checkout.
Unlike sharp it is not lazy: the kernel is authoritative and starts before the
gateway hydrates session state, so a missing sidecar fails boot, not one feature.

**External: the `claude` CLI.** The Anthropic bridge is the Claude Agent SDK
running in-process (`src/server/anthropic-bridge.ts`), and the SDK shells out
to the installed `claude` binary (`OPENSESSION_CLAUDE_BIN`, default `claude` on
`PATH`) for every `pi/anthropic/*` turn. The binary is not embedded: the
installer puts it on the box (`--no-engine` skips it) and `doctor` reports it
when missing. The Pi engine and its provider adapters compile into the binary
and resolve from the embedded graph, so no plugins sidecar ships beside it.

Other native addons in the dependency tree (`@libsql/*`, `@cbor-extract/*`,
`@anthropic-ai/claude-agent-sdk` audio-capture, `@mariozechner/clipboard`,
`@earendil-works/pi-tui`) are not on the server boot/serve path, so the binary
boots and serves without them; features that reach one only need it when that
feature runs. The build-only natives (`@tailwindcss/oxide`, `lightningcss`,
`@parcel/watcher`) are never used in prebuilt-frontend mode.

## What doesn't work in this mode

Features absent or degraded in the compiled binary versus a source/tarball
install. Everything the shipped artefact covers (the sharp sidecar,
install/service/update, non-sandbox turns) works and is not listed here.

- **On-box self-development.** No source tree ships in the binary, so code
  sessions cannot run against the Open Session checkout itself (the
  `sharedCheckout` self-hosting path). Use the `--source` install (git checkout
  + bun) for self-development.
- **Changing the primary product wordmark/mark/agent name at runtime.** These
  and the base HTML `<title>` are stitched into the embedded `index.html` at
  build time and served verbatim (the embedded boot path never re-runs
  `renderIndexHtml`). To change them you build a custom binary with that
  config. Workspace name/icon, the PWA install name, and session social-card
  titles still follow live config per request. Clean fix if per-install
  re-branding of one shared binary is wanted: re-run `renderIndexHtml` against
  live config on the embedded boot path instead of serving the pre-stitched
  HTML (the stitching logic exists and is instance-pure, just bypassed here).
- **Cosmetic PWA assets.** App icons, splash images, `sw.js`, and sign-in
  background art under `src/frontend/` are not embedded and `404`; the app
  still renders (the manifest is generated dynamically).
- **Bundled agent skills.** The `.agents/skills` tree is not in the binary
  artefact, so the installer's global-skills step is skipped (it degrades
  without error). The `--source` install still ships them.
- **Live frontend rebuild / CSS hot edits.** The in-process watcher and
  `scheduleFrontendRebuild` are off in prebuilt mode. Use `--source` for live
  edits.
- **Sandboxed agent runs launched from a compiled host** are untested: the
  sandbox re-exec sites run `bun run <host-entry>` inside a container that
  carries its own bun + checkout. Non-sandbox / local runs work (the dispatcher
  self-execs the binary for `runner-host` and `mcp-proxy`).
- **Features that spawn a `scripts/*.ts` helper by path.** A few paths resolve
  a helper script through `import.meta.dir` (which is `/$bunfs` in the binary),
  so the file is not on disk for the spawned process: PR-checks
  (`GH_CHECKS_CLI_PATH` → `scripts/gh-checks.ts`, `run-instructions.ts`) and the
  code-storage credential mint (`scripts/cs-credential.ts`,
  `codestorage/remote.ts`). The default self-repo / `mcp-config.json` path
  (`OPENSESSION_ROOT`, `config.ts`) also resolves under `/$bunfs`; simple mode
  uses the scratch repo and a written config, so it is unaffected, but a
  self-repo default would be wrong. These are separate from the turn path
  (Claude turns work) and would each need their own on-disk-sidecar treatment.

## State

Runtime state stays external and is unchanged: `OPENSESSION_CONFIG`
(`config.json`), `OPENSESSION_STATE_DIR`, the sessions dir, and
`mcp-config.json` are read by path as usual.
