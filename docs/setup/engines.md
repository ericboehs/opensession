# Engines: Claude, Codex, OpenCode

Every session/automation turn runs on one of three engines, dispatched by
model id in the runner layer. **Engine/runner code does not hot-reload** —
after changing anything here, `systemctl restart backstage`
([install.md](install.md#8-hot-reload-vs-restart)).

## Claude (Claude Agent SDK) — default

`src/server/claude-runner.ts` drives the `@anthropic-ai/claude-agent-sdk`,
which spawns the `claude` CLI:

- **Binary**: `BACKSTAGE_CLAUDE_BIN` env → `paths.claudeBin` in
  `~/.backstage/config.json` → `/home/ubuntu/.local/bin/claude`.
- **Accounts**: `~/.backstage-claude-accounts.json` (override with
  `BACKSTAGE_CLAUDE_ACCOUNTS_PATH`; written mode 0600). Shape
  (`src/server/claude-accounts.ts`):

```json
{
  "accounts": [
    {
      "id": "acc-…",
      "name": "michiel-max",
      "token": "sk-ant-…",
      "email": "optional",
      "plan": "optional",
      "createdAt": "ISO date",
      "owner": "Michiel",
      "credentialsPath": "/home/ubuntu/.claude/accounts/michiel/credentials.json"
    }
  ]
}
```

- **Minting a token**: run `claude setup-token` on a Max-subscription login;
  paste the `sk-ant-…` value (whitespace from terminal wrapping is stripped).
  Setup-tokens lack the `user:profile` scope, so usage polling 403s and the
  account is marked `usageScope: "missing"`; point `credentialsPath` at a
  full login-scoped credentials file to restore usage visibility (it's used
  only for polling — runs still use `token`).
- **Picking**: personal accounts (`owner` matched through the identity
  table) are preferred for that user's runs; automations and everyone else
  draw from owner-less pool accounts, least-utilized first. Accounts at ≥97%
  of the 5-hour window are sidelined until reset. Sessions can pin an
  `accountId`; automations can hard-pin (`accountStrict`) as a cost cap.
- Fallback env vars: `MICHAEL_FALLBACK_MODEL` (global fallback model when a
  pool is exhausted; `none` disables), `CLAUDE_FALLBACK_PROFILE` (legacy
  on-disk `~/.claude` credential-swap path), `MICHAEL_FORCE_LIMIT=1`
  (dev-only: fake a usage limit to exercise the fallback chain).

## Codex

`src/server/codex-runner.ts` via `@openai/codex-sdk`:

- **Accounts**: `~/.backstage-codex-accounts.json` (no env override; 0600):

```json
{
  "accounts": [
    { "id": "…", "name": "key-1", "kind": "api_key", "value": "sk-…", "createdAt": "…" },
    { "id": "…", "name": "plan-1", "kind": "home", "value": "/home/ubuntu/.codex-homes/plan-1", "createdAt": "…" }
  ]
}
```

  `kind: "api_key"` injects an OpenAI key; `kind: "home"` points at a
  `CODEX_HOME` directory containing `auth.json` from `CODEX_HOME=<dir> codex
  login` on a ChatGPT plan. Rotation is least-recently-picked with a 1-hour
  cool-off on rate limits (no usage endpoint exists to poll).
- **Transport toggle**: `~/.backstage-codex-transport.json` with
  `{ "transport": "app-server" }` or `"exec"` (file wins; then
  `MICHAEL_CODEX_TRANSPORT=app-server`; default `exec`). The app-server
  transport (`src/server/codex-appserver.ts`) drives `codex app-server` over
  JSON-RPC and adds mid-turn steering (`turn/steer`) and fast interrupt
  (`turn/interrupt`). Both transports share the same thread/rollout files,
  so toggling is safe mid-session.

## OpenCode (+ the Anthropic bridge)

`src/server/opencode-runner.ts` spawns `opencode serve` per session and talks
HTTP+SSE. Model ids look like `opencode/<provider>/<model>` — this is the
"bring any LLM" engine. Binary resolution: `BACKSTAGE_OPENCODE_BIN` →
`Bun.which("opencode")` → an nvm fallback path.

Config: `~/.backstage-opencode.json` (override with
`BACKSTAGE_OPENCODE_CONFIG`), schema from `src/server/opencode-config.ts`:

```json
{
  "enabled": true,
  "bridge": { "mode": "meridian", "accounts": ["acc-id-1"] },
  "port": 3456,
  "pickerModels": ["opencode/anthropic/claude-sonnet-5"],
  "turnTimeoutMinutes": 60,
  "bridgeMaxRequestsPerHour": 300
}
```

- `enabled: false` (or a missing file) = engine off; `opencode/anthropic/*`
  models error.
- `pickerModels` adds opencode model ids to the UI model picker (folded into
  the registry at load).
- `bridge.mode` controls how `opencode/anthropic/*` models get Claude
  capacity:
  - `"meridian"` (default): the bundled community opencode-with-claude /
    Meridian stack (`@rynfar/meridian` + scrub plugin, pinned in
    package.json), injected as an OpenCode plugin. `accounts` optionally
    restricts which Claude accounts serve it.
  - `"native"`: the in-repo bridge (`src/server/anthropic-bridge.ts`) — a
    loopback-only Anthropic-Messages-compatible endpoint served by the
    official Claude Agent SDK on **designated** accounts (`accounts` is
    required; never the pool), with a per-boot API key, body cap, hourly
    rate cap, and full audit.
  - `"off"`: bridge disabled.

Honest quota note, in two sentences: the meridian path scrubs opencode's
fingerprints so Anthropic bills it as first-party flat subscription quota,
which works today but is a moving enforcement target; the native bridge
deliberately does **not** scrub, so Anthropic bills it to extra-usage
credits and returns 400 without them. Details, billing tests, and the
containment rules are in
[sandboxes-plan.md — Workstream E](../sandboxes-plan.md).

## Model routing

`src/server/models.ts`:

- **Default model**: UI override file `~/.backstage-default-model.json`
  (`{ "model": "<id>" | null }`) → `MICHAEL_MODEL` env → `claude-fable-5`.
- **Fallback auto-switch**: `~/.backstage-model-fallback.json`
  (`{ "auto": boolean }`, default true) — whether interactive sessions
  auto-fall-back when their model's pool is exhausted. The built-in fallback
  order: claude-opus-4-8 → claude-fable-5 → claude-sonnet-5 → gpt-5.5 →
  gpt-5.4 → claude-sonnet-4-6 → claude-haiku-4-5 → gpt-5.4-mini →
  gpt-5.3-codex-spark (a session's configured `preferredFallbackModel` is
  tried first).
- **Cheap-task models**: several features run small classifier prompts on
  haiku by default, each overridable by env where it's read:
  `SUGGEST_BRANCH_MODEL`, `NOTE_EDIT_MODEL`, `MONITOR_ANSWER_MODEL`,
  `SCHEDULE_WHEN_MODEL`, `DRAFT_AUTOMATION_MODEL`,
  `SLACK_MENTION_INTENT_MODEL`, `PLAIN_SPAM_CHECK_MODEL`,
  `PLAIN_REFUND_INTENT_MODEL`, `PLAIN_TOPISSUES_QUOTE_MODEL` (all default
  `claude-haiku-4-5`).

Direction note: the long-term plan is to converge on OpenCode as the single
engine, with the Claude Agent SDK path staying for subscription economics
until parity holds — see the staged-migration section of
[sandboxes-plan.md — Workstream E](../sandboxes-plan.md).
