# OpenSession — build review (2026-07-08 → 2026-07-09)

Two-day autonomous build run (Michael orchestrating ~30 agents, ~150 commits, 14 restarts),
from "evaluate oak.space / code.storage" to a renamed, opencode-only, sandbox-native,
self-hostable OpenSession. This file is the handoff: what shipped, what was decided,
what's left. Written 2026-07-09 ~17:00 UTC.

---

## 1. What shipped

### Sandboxes (docs/sandboxes-plan.md — Phases 0–4 + S all DONE)
- **SandboxProvider abstraction** with three backends: `local` (default worktree flow),
  **docker** (container-per-session, bind + volume workspaces, engine-state volumes,
  IMDS-blocked, resource limits), **daytona** (live-certified, Tier 3), e2b (implemented,
  uncertified — needs an API key).
- **Runner image** `backstage-runner` (bun/git/gh/claude/codex/opencode/direnv/just, pinned,
  version-asserted at build; rebuild required after `src/runner-host/` changes — documented).
- **Snapshots**: docker-commit on idle + restore + post-prompt hook (`snapshots` config).
- **Prewarm (warm-on-typing)**: pool for remote providers, atomic adopt-or-wait
  (adopted attach ≈ 1–3 s vs ~30–120 s cold), quadruple-redundant reaping.
- **WS transport**: outbound-dial run-ws/rpc-ws with seq/ack buffer-replay, ws-opt-in token
  registry (constant-time), **public ingress** on michael.tella.dev (serves ONLY the two WS
  endpoints + health, rate-limited; Caddy routes both /opensession and /backstage paths).
- **Previews**: unified boot resolver — repo `.opensession/{start,setup}.sh` (tella-fusion
  PR #4651 MERGED) → repo-config `previewCommand` → tella-local fallback; namespaced
  preview ports; `.tunnels.env` contract; **Start opens a tab that redirects when green**
  (out-of-scope origin ⇒ default-browser handoff on desktop PWA); segmented copy-link
  control (phone) + ⌘-click / popover copy (desktop). Host previews fixed for real
  (IMDS-deny starved AWS creds → injected via getAgentAwsEnv).
- **Terminals**: Shell tab lands inside the sandbox — `docker exec -it` (docker) /
  SSH gateway (daytona, works on any tier); shared ssh-agent, per-shell revoked tokens.
- **Verification harnesses** (run them after risky changes):
  `deploy/sandbox/verify.ts` (~97 checks), `deploy/sandbox/conformance.ts`
  (provider matrix incl. concurrent-exec attach check), `scripts/verify-opencode.ts`,
  `deploy/sandbox/verify-opencode-sandbox.ts`.

### OpenCode as THE engine
- `opencode-runner.ts`: per-session `opencode serve`, StreamEvent mapping, persisted
  claude-shape transcripts (`~/.claude/projects/-opencode-engine/`) + host-side mirror for
  remote runs (user entries written at dispatch — fixes "Sending…" forever), 90 s
  first-byte liveness guard, account rotation on usage caps (model-scoped exhaustion),
  turn deadline, proc.exited watcher.
- **Claude models via bundled Meridian** (opencode-with-claude 1.6.14 + meridian 1.45.0 +
  scrub 0.2.0, exact-pinned): flat Max-subscription quota verified for haiku/sonnet/opus
  (service_tier standard). Per-account CLAUDE_CONFIG_DIR isolation; personal-first account
  pick; our own anti-evasion bridge (`anthropic-bridge.ts`) kept as non-default fallback.
  NO extra-usage credits (Michiel decision).
- **GPT models via opencode-native ChatGPT OAuth** (same client id as Codex CLI):
  rotation-proof seeding (access-token-only + poisoned refresh — host codex auth can
  never be invalidated), works on remote sandboxes via per-launch seed upload.
- **Fleet migrated**: 68 non-archived sessions (handoff-note + transcript-seed continuity,
  PELICAN/OSPREY-verified), **1,598 archived sessions DELETED** (backup:
  `~/.opensession-orchestration/archived-sessions-backup-20260709T1600.tgz`).
- **All 22 automations on opencode**: gate lifted with least-privilege intact — 24-tool
  deny-set (19 Plain/WorkOS + 5 Stripe money-movers incl. the NEW `stripe_api_write`,
  a previously-uncovered money tool found during migration) enforced by tool-stripping;
  Stripe approval card intentionally NOT ported (deny-with-note = prior unattended
  behavior). Canary automation verified live before migrating the rest.
- **Single-engine core** (077ad5e6): picker serves only the 6 opencode models
  (Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5 / GPT-5.5 / GPT-5.4 mini — friendly names,
  no engine branding), default `opencode/anthropic/claude-sonnet-5`, fallback chains
  opencode-internal. Model×environment validity enforced at create time (server + UI).

### Rename: Backstage → OpenSession (docs/rename-opensession-plan.md — EXECUTED)
- New-name-primary everywhere with full compat: `OPENSESSION_*` env (BACKSTAGE_*/MICHAEL_*
  aliases), `~/.opensession-*` state (31 dirs migrated, symlinks at old names),
  `/opensession/` URLs (`/backstage/` dual-served — PWA installs + baked sandbox dial-back
  URLs keep working), `opensession.ts` entry + `opensession.service` unit (old unit gone;
  **`systemctl restart opensession`**, `journalctl -u opensession`), package `opensession`,
  brand "OpenSession"/"OS" via config (`branding`/`persona` in `~/.backstage/config.json`
  → agent name "Michael" configurable). Never renamed (by design): `bks-`/`prj-` ids,
  `michael-*` MCP ids, wire markers, repo id.

### Portability / open-source readiness
- `~/.backstage/config.json` loader: repos registry (+ per-repo previewCommand/depsInstall),
  paths, identity table, branding/persona — zero-config = byte-identical ("ship it" review).
- Operator docs: `docs/setup/` (install, slack, github, linear, plain, integrations,
  engines) + root README + `docs/self-hosting-sandboxes.md`.
- Research committed: `docs/crucible-comparison.md` (John's repo — adoption plan),
  `docs/portability-audit.md` (remaining batches), background-agents + code.storage analyses
  in the plan doc.

### Reliability finds (memorized, load-bearing)
- **Bun --hot timer poisoning**: a failed hot reload permanently kills ALL timers
  process-wide while health stays 200. Tripwire in run-ws.ts screams "TIMERS ARE DEAD" in
  the journal; the only cure is a restart. Check for failed reloads BEFORE debugging hangs.
- Drain-timeout fixed (agent shutdown bounded 10 s — restarts now drain in ~2 s).
- Launch step-marks + parked-frame warnings instrument the whole sandbox launch chain.

---

## 2. What's left

### Follow-ups (ranked)
1. **Migrate the 4 direct agent loops** (Slack, Linear, Plain, GitHub — they call the
   Claude/Codex SDKs directly, now via `resolveDirectSdkModel()` opencode→native mapping)
   onto the opencode engine; THEN physically delete `claude-runner`/`codex-runner`/
   `codex-appserver` engine paths and update CLAUDE.md's model-routing section (deliberately
   not yet claiming single-engine). NOTE: `@anthropic-ai/claude-agent-sdk` package STAYS
   (Meridian's motor); `codex-accounts.ts` STAYS (feeds opencode openai auth).
2. **`aws:true` in the opencode runner** (short-lived instance-role creds for automations
   needing AWS CLI reads — currently a silent gap).
3. **Crucible adoption** (docs/crucible-comparison.md): golden repo@sha build-validated
   snapshots (#1, M), reversibility-axis + hash-bound approvals (#2, M — would restore a
   principled approval story on opencode), repo build contract (#3, S). Talk to John first
   (open questions listed in the doc — esp. replace/coexist and extracting his
   grant/enforce schema as a shared lib).
4. **Portability batches 2–4** (audit doc): channel IDs/OAuth-redirect/publicBaseUrl
   consolidation, fail-closed integration gating, gh-repo templating in prompts, deploy
   parameterization; + backstage.ts:4912 fusion-only guard; remaining `/home/ubuntu/bin/wt`
   spawns.
5. **Open-source launch list** (thread-validated): app-level auth/allowlist layer (top ask),
   per-repo secrets vault, opensession TUI (engine-agnostic session TUI + PTY attach),
   macOS runner adapter (xcodebuild niche), memory productization, E2B certification
   (needs key), Daytona BYOC evaluation on a dedicated node (NOT this box).

### Michiel's external checklist
- GitHub repo rename `tellahq/backstage` → `tellahq/opensession` (redirects are automatic).
- `@opensession` npm scope + org names (bare `opensession` npm = opencode's viewer).
- CloudWatch/IAM names (`/tella/backstage/prod`), domains, when convenient.

### Known gaps / quirks (documented, not broken)
- Remote (daytona) runs: audit events stay in-sandbox (host mirror = follow-up); pre-fix
  daytona sandboxes need recreation (error says so); `previewPorts` changes are
  create-time; `devServerInSandbox` default-off pending port-namespace hardening notes.
- Test suite: 3–4 known cross-file ordering flakes (zz-run-journal, 2× sessions.test,
  opencode-state-paths) — all pass in isolation; fix-the-ordering is a nice-to-have.
- opencode engine: no mid-turn steer (queues, like exec codex); automation accountId pins
  ignored by meridian picker; per-account XDG session db = account switch starts a fresh
  engine session.
- CLAUDE.md + memory carry the operational rules (shared-checkout discipline, restart
  classes, timer-poisoning tripwire, image-rebuild rule).

## 3. Operational quick reference
- Unit: `opensession.service` · health `/opensession/api/health` · both URL prefixes serve.
- Kill switches: `~/.opensession-chats/disable-sandboxes` (file), `~/.backstage-opencode.json`
  `enabled:false` (engine off), `prewarm.enabled:false`, bridge `mode:"native"|"off"`.
- Configs: `~/.backstage-sandbox.json` (provider/image/snapshots/prewarm/publicIngress/
  daytona/cloneCredential), `~/.backstage-opencode.json` (bridge/pickerModels),
  `~/.backstage/config.json` (repos/paths/identity/branding/persona) — all dual-read
  under new names too.
- Rollback of the single-engine core: `git revert 077ad5e6` (self-contained).
- Archived-sessions backup + deletion manifest: `~/.opensession-orchestration/`.
