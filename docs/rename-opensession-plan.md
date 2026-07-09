# Rename plan: Backstage → OpenSession

**Status: EXECUTED (2026-07-09).** See "Execution record" at the end for what
shipped, what was deliberately kept, and what remains on the external checklist.
This doc stays as the one historical record of the old name — per Michiel's
directive, no other doc/UI copy references it; the product is simply OpenSession.

**Naming facts (from the July 2026 collision research):**
- Bare `opensession` on npm is **taken by the sst/opencode team** (their session
  viewer, same niche). Publish under the **`@opensession/*` scope**; never fight
  for the bare name. README needs a one-line disambiguation vs their viewer and
  vs ColeMurray/background-agents ("Open-Inspect").
- Tella already owns **opensession.com**. GitHub org `opensession` was squatted/
  empty as of Mar 2025 — reclaim attempt is an external checklist item.
- The old name collides with Spotify's CNCF Backstage, which is why the rename
  exists at all.

**What already exists (rename-prep landed tonight):**
- `productName()` / `productMark()` in `src/server/config.ts` (config:
  `branding.productName` / `branding.productMark`, defaults "Backstage").
- `personaName()` in the same file (config `persona.name`, default "Michael") —
  the agent's name is now config, orthogonal to the product rename.
- `src/frontend/lib/brand.ts` — the frontend's single source for
  `PRODUCT_NAME` / `PRODUCT_MARK` / `AGENT_NAME` / document titles. The visible
  UI rename is a one-line flip there.

---

## Short brand: "OS" monogram

Michiel: "you can shorten OpenSession to OS in some places if it makes things
look cooler." Rules of engagement:

**Where "OS" works (visual wordmark contexts):**
- The UI brand mark / logo chip (sidebar brand row, mobile top-bar logo)
- Favicon / PWA icons / apple-touch-icon / splash screens
- The loading-splash monogram (currently the "M" splash spinner)
- Docs headers / hero art where it reads as a logo, not a word

**Where "OS" must NOT be used:**
- CLI binary/command names, npm package names, env-var prefixes, code
  identifiers, config keys, service/socket names. "os" collides with
  operating-system terminology everywhere, `os` is a Node/Bun builtin module,
  and `OS_*` env vars read as operating-system settings.
- Prose where it's ambiguous ("open the OS settings" is a trap).

**Pattern:** full "OpenSession" in prose and first mentions; "OS" only as the
visual monogram. The frontend module already carries both: `PRODUCT_NAME`
("OpenSession" post-flip) and `PRODUCT_MARK` ("OS" post-flip) — UI brand-mark
sites should consume `PRODUCT_MARK`, text sites `PRODUCT_NAME`. Server config
mirrors this (`branding.productName` / `branding.productMark`).

---

## Inventory (grep census, 2026-07-08)

~1,800 case-insensitive "backstage" occurrences across `src/`, `backstage.ts`,
`deploy/`, `.github/`, `scripts/`, plus the `michael-*` / `MICHAEL_*` families.
Grouped by rename difficulty:

### Tier A — Cosmetic/UI strings (rename freely at switch time)

| What | Count | Representative |
|---|---|---|
| Frontend "Backstage" display strings | ~23 (most now routed via brand.ts) | `src/frontend/components/SettingsMenu.tsx` wordmark; document titles in Automations/Goals/Archived/Actions/Security/Connections/Notes/SessionViewer; `RestartOverlay.tsx` |
| Server-side "Backstage" in prompts/comments | ~207 (mostly comments; ~30 reach models/users) | `src/server/system-prompt.ts` ("your other Backstage sessions"), `src/server/codex-runner.ts`, `src/agents/*/prompts.ts`, `human-asks.ts` ("Open the session in Backstage") |
| Conversational "Michael" strings in the frontend | ~50 | `AskCard.tsx` ("Michael needs input"), `SessionViewer.tsx` ("Ask Michael…"), `DiffPanel.tsx`, `Automations.tsx` — should consume `AGENT_NAME` from brand.ts |
| "You are Michael …" prompt preambles in agents | ~40 (entangled with company copy — persona batch 2f in docs/portability-audit.md) | `src/agents/github/prompts.ts:29,169,190,218,262,281`, `src/agents/linear/prompts.ts:14,90`, `src/agents/plain/prompts.ts:6,55`, `src/agents/loops/{sweep,monitor,cron-jobs}.ts`, `src/agents/slack/mention-intent.ts:29,47`, `createdBy: "Michael (…)"` session labels |
| Static HTML shell | 2 | `src/frontend/index.html:9,11` (`apple-mobile-web-app-title`, `<title>`) — served/rewritten by backstage.ts, replace at flip time |
| PWA manifest payload | 1 route | `backstage.ts:3939` (`name`/`short_name: "Backstage"`) — should read `productName()` when backstage.ts unfreezes |

Effort: trivial per site; the frontend is already one flip. The server prompt
copy should consume `productName()` opportunistically (strangler pattern), or in
one sweep at flip time. **~0.5–1 day.**

> Handoff note (2026-07-08): `src/server/opencode-runner.ts` was owned by
> another session when the persona conversion landed, so its persona lines are
> still hardcoded — 409 ("You are Michael in Ask mode…"), 420-421 (session-link
> "this Michael session"), 426 ("## Managing Michael"). Convert them to
> `personaName()` exactly like the parallel blocks in codex-runner.ts
> (`buildCodexDeveloperInstructions`) and system-prompt.ts.

### Tier B — Config/state paths (need back-compat aliases + migration)

| What | Count | Representative |
|---|---|---|
| `~/.backstage-*` state dirs | 33 distinct names, ~140 refs | `.backstage-chats` (16), `.backstage-sandbox` (18), `.backstage-opencode` (15), `.backstage-audit` (13), `.backstage-claude-accounts` (10), … full list via `grep -roh '\.backstage-[a-z-]*' src backstage.ts \| sort -u` |
| `~/.backstage/config.json` itself | 12 refs | `src/server/config.ts:22` (`BACKSTAGE_CONFIG` override exists) |
| `BACKSTAGE_*` env vars | 18 distinct, ~180 refs | `BACKSTAGE_CHATS_DIR` (77), `BACKSTAGE_SESSIONS_DIR`, `BACKSTAGE_VIDEO`, `BACKSTAGE_RUN_JOURNAL`, `BACKSTAGE_CONFIG`, `BACKSTAGE_BOOT_MODE`, `BACKSTAGE_SANDBOX_CONFIG`, `BACKSTAGE_DEV`, … |
| `MICHAEL_*` env vars | 8 distinct, ~55 refs | `MICHAEL_UI_BASE` (19), `MICHAEL_MODEL` (18), `MICHAEL_FORCE_LIMIT`, `MICHAEL_CODEX_TRANSPORT`, `MICHAEL_FALLBACK_MODEL` |
| `bks-` session-id prefix | ~91 refs | `src/frontend/lib/markdown.ts:18` parses it; ids are persisted in every chat file — **treat as opaque protocol, do NOT rename** (see Tier C) |
| `prj-` workspace-id prefix | few | `src/server/workspaces.ts:134` — same: opaque, keep |
| `backstage-rpc.sock` | 4 | `src/server/run-rpc-protocol.ts:5` — path embeds the chats dir; live runs hold the socket |
| `backstage.service` systemd unit | 8 files | repo root `backstage.service`; referenced in `src/server/audit.ts`, `host-client.ts`, `aws-creds.ts`, `src/runner-host/{host,protocol}.ts`, `deploy/deploy.sh`, `deploy/sandbox/setup-host.sh` |
| Deploy workflow | 5 refs | `.github/workflows/deploy.yml` (`deploy-backstage-prod` group, IAM role `backstage-deploy`, checkout path `tella-backstage`) |
| CloudWatch log group | 1 | `deploy/cloudwatch-agent-backstage.json` (`/tella/backstage/prod`, `.backstage-audit` path) |
| Checkout dir name `tella-backstage` | ~24 refs | `src/server/run-rpc-protocol.ts`, deploy scripts, `config.ts` mcpConfig default |
| Port 3850 / webhook 3848 | 8 refs | already config (`server.port`) — not a rename item, listed for completeness |
| `package.json` name `tella-backstage` | 1 | becomes `@opensession/server` (or similar) under the scope |

**Back-compat pattern (proposed):** new name primary, old accepted with a
one-time deprecation warning.
- **Env vars:** `const env = (k) => process.env[`OPENSESSION_${k}`] ?? process.env[`BACKSTAGE_${k}`]` —
  one helper in config.ts, applied at the ~20 read sites (most already funnel
  through config.ts getters). Same for `MICHAEL_*` → persona-neutral names
  (`OPENSESSION_UI_BASE`, `OPENSESSION_MODEL`). Log a deprecation once per key.
- **State dirs:** the repo already has the proven precedent —
  `src/server/paths.ts` dual-reads `~/.backstage-chats` (new) falling back to
  `~/.backstage-sessions` (legacy), with an explicit migration script
  (`scripts/migrate-workspaces.ts`) run in a restart window. Generalize:
  resolve-once helper `stateDir(name)` that prefers `~/.opensession-<name>`,
  falls back to `~/.backstage-<name>`; migration = rename dirs (or symlink
  `~/.backstage-*` → `~/.opensession-*` for tools that hardcode) during one
  restart window. Do NOT dual-write.
- **Socket/service:** `opensession.service` ships alongside; deploy copies the
  new unit, `systemctl disable backstage && enable opensession` in one window.
  The rpc socket name follows the chats dir automatically.

Effort: **~2–3 days** including the migration script + one restart window.

### Tier C — Protocol/identifier constants (rename = breaking; keep or sequence)

These are wire/persisted identifiers. Renaming them breaks running sessions,
persisted transcripts, and paired clients. Default: **don't rename**; where we
do, it needs an explicit compat window.

| What | Count | Why breaking |
|---|---|---|
| `michael-*` in-process MCP server ids | `michael-sessions` (44), `michael-admin` (21), `michael-goal(s)` (17), `michael-humans` (14), `michael-ask` (14), `michael-sidebar` (8), `michael-repos` (8), `michael-preview` (7), `michael-simplify` (6) | Tool names are persisted in transcripts and referenced in prompts/automations stored in `~/.backstage-automations`; a resumed session would call tools that no longer exist. If renamed at all: register BOTH ids for a release, migrate stored automation prompts, then drop. Recommendation: rename only if the persona-neutral ids (`agent-sessions`, …) are worth the churn — otherwise keep forever (users never see them; they're addressed via the persona name in prose). |
| `===MICHAEL-SUMMARY===` markers | 6 (`MICHAEL_MARKERS` family) | Parsed out of historical transcripts; old chats re-render through the same parser. Parser must accept old + new forever; emit-side can switch. |
| `bks-` / `prj-` id prefixes | 91 / few | Persisted in every session/workspace file and in shared links. Opaque — never rename. |
| localStorage `backstage-user` (+ other `backstage-*` keys: pins, theme, tab colors) | 7+ | Every team member's browser logs out / loses prefs on rename. If renamed: read-old-write-new shim in the frontend for a few weeks. Cheap but must be deliberate. |
| `/backstage/` URL path prefix | ~266 in code + sw.js + index.html + Caddy + Tailscale serve config | Deep links in Slack/Linear/PR bodies ("Created by this Michael session"), PWA `start_url`, service-worker scope, push-notification URLs, `shot.mjs` tooling. Rename = redirect layer (`/backstage/*` → `/opensession/*` 308) kept for months, PWA re-install on every phone (iOS pins `start_url`). Consider keeping the path and only rebranding display strings, or do it as the LAST breaking step with the redirect. |
| PWA identity (manifest name, icons, `apple-mobile-web-app-title`) | index.html + backstage.ts manifest route | Renaming mid-life changes the installed-app identity; iOS users re-add to Home Screen. Bundle with the URL-prefix change so there's one re-install event, not two. |
| Caddy preview routing | port-keyed routes in `src/server/preview.ts` (no name-keyed routes found — keys are ports) | No rename needed; only the `server.previewHost` config matters. |
| GitHub bot login | `BOT_LOGIN = env GITHUB_BOT_LOGIN \|\| "tella-butler"`, mention handles in `src/agents/github/mention.ts:36-44` | Already env-configurable; external account rename is a Tier D item. |

Effort if we rename the renameable subset (markers emit-side, localStorage
shim, URL prefix + PWA): **~2–3 days + a comms/re-install window.** Keeping
them: ~0.

### Tier D — External (checklist for Michiel; code references follow later)

- [ ] GitHub repo rename `tellahq/backstage` → new org/repo (GitHub auto-redirects
      old URLs + git remotes indefinitely, so this is LOW risk — but update
      `config.ts` builtinRepos `ghRepo: "tellahq/backstage"`, deploy.yml checkout
      path, and every clone on the VPS at leisure). Decide: `tellahq/opensession`
      vs reclaiming the `opensession` org.
- [ ] npm org/scope `@opensession` — register early (bare name is opencode's).
- [ ] Domains: opensession.com (owned). opensession.dev / getopensession.com if
      wanted. opensession.ai is taken by a third party.
- [ ] Tailscale hostname `michael.taila5d766.ts.net` — persona-tied, not
      product-tied; renaming it breaks `MICHAEL_UI_BASE`, every stored deep link,
      HTTPS push origin (`~/.backstage-push/subscriptions.json` is origin-bound),
      and the PWA install origin. Recommendation: leave the tailnet name alone
      until/unless the box is rebuilt; `server.publicBaseUrl` is already config.
- [ ] `michael.tella.dev` Linear OAuth redirect (portability audit 1e) — becomes
      config in portability batch 3 regardless of rename.
- [ ] Slack bot display name "Michael" — persona, not product; stays unless the
      instance persona changes (now just config + a Slack app-settings edit).
- [ ] IAM role `backstage-deploy`, SSM deploy group, CloudWatch group
      `/tella/backstage/prod` — Tella-internal infra names; rename opportunistically
      or never (portability batch 4 makes them config for other orgs anyway).
- [ ] README disambiguation lines (opencode's `opensession` viewer; Open-Inspect).

---

## Recommended execution order

1. **Config aliases first** (Tier B pattern, no behavior change): the
   `OPENSESSION_*`-primary env helper, `stateDir()` dual-read helper, ship
   `opensession.service` file alongside. Everything still answers to the old
   names. ~1 day.
2. **Cosmetic sweep** (Tier A): flip `brand.ts` (`PRODUCT_NAME = "OpenSession"`,
   `PRODUCT_MARK = "OS"`) + set `branding` in config.json; sweep server prompt
   copy through `productName()`; manifest/index.html strings. Persona strings
   ride `personaName()`/`AGENT_NAME` (independent — Tella can keep "Michael").
   ~0.5–1 day.
3. **State migration** (Tier B): one restart window; migration script renames
   `~/.backstage-*` dirs (or symlinks), systemd unit switch, deploy.yml update.
   ~1 day incl. rehearsal.
4. **Breaking identifiers — decide, mostly keep** (Tier C): recommend keeping
   `michael-*` tool ids, `bks-`/`prj-`, and (initially) the `/backstage/` URL
   prefix; do markers emit-side + localStorage shim cheaply; URL prefix + PWA
   identity only as a deliberate final step with a redirect layer. 0–3 days
   depending on appetite.
5. **Repo rename last** (Tier D): after code refers to the new names, rename
   the GitHub repo (redirects cover stragglers), publish `@opensession/*`.

Total: **~4–6 working days** of engineering spread over a few restart windows,
plus external/account chores. Steps 1–2 are safe any time; 3 needs a window;
4's URL/PWA piece is the only user-visible break and is optional/deferrable.

## Pending backend wire-up: Settings → Workspace → General

The Settings UI (Workspace → General) shows Agent name / Product name as
disabled read-only fields (built-in defaults). To make them live, backstage.ts
(frozen the night this was written) needs one small route pair:

- `GET /backstage/api/instance-config` → `{ personaName: personaName(),
  productName: productName(), productMark: productMark() }` — lets the UI (and
  `brand.ts` at bootstrap) display the *actual* configured values instead of
  build-time defaults.
- `PUT /backstage/api/instance-config` `{ personaName?, productName?,
  productMark? }` → read `~/.backstage/config.json` (the `BACKSTAGE_CONFIG`
  path), deep-merge `persona.name` / `branding.*`, write back atomically
  (`writeJsonAtomic`), return the new values. Config is mtime-cached and read
  fresh per call, so no restart is needed for new runs — but note
  `RESUME_CONTINUATION_PROMPT` (agent-runner.ts) bakes the name at module load,
  and any hot code holding the old string keeps it until reload.

Then in `Settings.tsx` swap `WorkspacePanel`'s static values for a
fetch + save (same shape as `MonitorPanel`), and have `brand.ts` hydrate from
the GET at app boot with the constants as fallback.

## Non-goals of the rename

- The agent persona ("Michael") does NOT rename with the product — it's
  `persona.name` config now. Tella keeps Michael; other installs pick their own.
- No dual-write of state; migrations are one-shot in a restart window.
- No chasing `backstage` inside third-party config people typed into their own
  automations/notes — parser-side compat only.


---

## Execution record (2026-07-09)

Shipped, new-name-primary with every old name still working:

- **Compat layer** `src/server/rename-compat.ts`: `envAlias()` (OPENSESSION_*
  primary, BACKSTAGE_*/MICHAEL_* accepted with a one-time log line) and
  `statePath()`/`stateDir()` (~/.opensession-* primary, ~/.backstage-*
  dual-read, create-new at the new name; cached per process). Unit tests in
  rename-compat.test.ts.
- **Env vars**: every BACKSTAGE_* read + the generic MICHAEL_* config vars
  (UI_BASE, MODEL, FALLBACK_MODEL, CODEX_TRANSPORT, FORCE_LIMIT) go through
  envAlias. Child/remote envs (run hosts, docker exec, remote bootstrap,
  Plain automation) export BOTH names so older runner bundles keep working.
- **State dirs**: all ~/.backstage-* call sites resolve through stateDir;
  scripts/migrate-opensession-state.sh renames on disk and leaves symlinks
  (run 2026-07-09 in the swap window). Remote-sandbox upload destinations
  keep the legacy filenames (that's what exists remotely; the in-sandbox
  build dual-reads).
- **URLs**: the app dual-serves /opensession (primary) + the legacy prefix as
  a permanent alias — same handlers, no redirects (API/WS clients, PWA
  installs, baked sandbox dial-back URLs). Frontend BASE_PATH follows the
  prefix the page was served under; sw.js re-prefixes pushed URLs onto its
  own scope; manifest/PWA identity is per-prefix. public-ingress accepts
  both run-ws/rpc-ws prefixes; new launches dial back on /opensession.
- **Entry/unit/deploy**: opensession.ts is the entry (backstage.ts is a
  one-line alias, still COPY'd by the sandbox Dockerfile); opensession.service
  is the unit (swap executed; the old unit file is removed from the repo and
  the host); deploy.sh + workflow are opensession-only; package.json name is
  `opensession`.
- **Identifiers**: productName() default is OpenSession; model/user-facing
  prose interpolates productName()/personaName(); monitor loop accepts both
  unit names; localStorage keys are opensession-* with read-old fallback.
- **Docs**: setup/README/config.example rewritten OpenSession-native (no
  rename narrative, per directive).

Deliberately KEPT (protocol/wire/persisted/external — renaming breaks live
things for zero user-visible gain):

- `bks-` / `prj-` id prefixes; the `backstage` repo id; SessionSource value
  `"backstage"`; `michael-*` in-process MCP server ids; `===MICHAEL-SUMMARY===`
  markers; `BACKSTAGE_VIDEO:` transcript markers (printed by external tooling);
  `backstage-rpc.sock` filename; daytona/e2b sandbox labels
  (`backstage.session`, `backstageSandbox`) used to adopt live sandboxes;
  codex app-server clientInfo (persisted in rollouts); `__backstageBooted` &
  co. globalThis keys (live hot-reload state); internal type names
  (BackstageSessionFile etc. — safe cleanup any time).
- External infra names: CloudWatch group `/tella/backstage/prod`, IAM role
  `backstage-deploy`, GitHub repo `tellahq/backstage`, checkout dir
  `~/projects/tella-backstage`, Tailscale hostname — Tier D checklist below.

External checklist (Michiel):

- [ ] GitHub repo rename `tellahq/backstage` → decide org/name (auto-redirects
      make this low-risk; then update config.ts builtinRepos ghRepo, deploy.yml
      comment, clones at leisure)
- [ ] npm `@opensession` scope registration
- [ ] IAM role / SSM group / CloudWatch group renames (or never — config
      batches make them irrelevant for other orgs)
- [ ] Domains: opensession.com live; decide on others
