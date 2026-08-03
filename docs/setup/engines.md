# Engine: OpenCode

Every session, automation, agent-loop turn and one-shot utility call runs on
the OpenCode engine — a per-session `opencode serve` process driven over
HTTP+SSE by `src/server/opencode-runner.ts` (one-shots go through
`src/server/opencode-oneshot.ts` on a shared tool-less server). Model ids
look like `opencode/<provider>/<model>`; bare native ids (`claude-sonnet-5`,
`gpt-5.6-sol`) are mapped onto that form at dispatch (`toOpencodeModel`).
After changing engine/runner code, restart with `systemctl restart opensession`
([install.md](install.md#10-frontend-rebuilds-vs-restart)).

Binary resolution: `OPENSESSION_OPENCODE_BIN` → `Bun.which("opencode")` → an
nvm fallback path.

## Engine config

`~/.opensession-opencode.json` (override with `OPENSESSION_OPENCODE_CONFIG`),
schema from `src/server/opencode-config.ts`:

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

- `enabled: false` (or a missing file) = the Anthropic bridge is off;
  `opencode/anthropic/*` models error with a clear message (there is no
  fallback engine).
- `pickerModels` adds opencode model ids to the UI model picker (folded into
  the registry at load).
- Providers beyond the two subscription bridges below use OpenCode's own auth
  (`opencode auth login` → `~/.local/share/opencode/auth.json`; HOME is
  passed through to the engine).

## Anthropic models (the Claude bridge)

`opencode/anthropic/*` models get Claude subscription capacity through
**Meridian** — the bundled opencode-with-claude / `@rynfar/meridian` stack
(pinned in package.json), injected as an OpenCode plugin. This is the default
mode when the bridge is enabled: flat Max-subscription quota. `accounts`
optionally restricts which Claude accounts serve it. Per-account
`CLAUDE_CONFIG_DIR` isolation pins the selected account.

Other `bridge.mode` values exist as non-default escape hatches: `"native"`
(the in-repo `src/server/anthropic-bridge.ts`, a loopback-only
Anthropic-Messages endpoint on the official Claude Agent SDK — designated
accounts only, bills to extra-usage credits; alongside the flag-gated
experimental claude-direct engine adapter it is the last consumer of
`@anthropic-ai/claude-agent-sdk`) and `"off"`.

### Claude accounts

`~/.opensession-claude-accounts.json` (override with
`OPENSESSION_CLAUDE_ACCOUNTS_PATH`; written mode 0600). Shape
(`src/server/claude-accounts.ts`):

```json
{
  "accounts": [
    {
      "id": "acc-…",
      "name": "alice-max",
      "token": "sk-ant-…",
      "email": "optional",
      "plan": "optional",
      "createdAt": "ISO date",
      "owner": "Alice",
      "credentialsPath": "/home/user/.claude/accounts/alice/credentials.json"
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
  Each account gets an isolated `CLAUDE_CONFIG_DIR` for Meridian's SDK
  subprocesses, so the selected account is the only reachable credential.
- Fallback env vars: `OPENSESSION_FALLBACK_MODEL` (global fallback model when
  a pool is exhausted; `none` disables), `OPENSESSION_FORCE_LIMIT=1`
  (dev-only: fake a usage limit to exercise the fallback chain).

## OpenAI models (ChatGPT OAuth)

`opencode/openai/*` models run on OpenCode's native ChatGPT OAuth using the
codex-accounts pool — `~/.opensession-codex-accounts.json` (no env override;
0600), managed by `src/server/codex-accounts.ts` and seeded into opencode by
`src/server/opencode-openai-auth.ts` (access-token-only + poisoned refresh so
the host `codex login` can never be invalidated):

```json
{
  "accounts": [
    { "id": "…", "name": "key-1", "kind": "api_key", "value": "sk-…", "createdAt": "…" },
    { "id": "…", "name": "plan-1", "kind": "home", "value": "/home/user/.codex-homes/plan-1", "createdAt": "…" }
  ]
}
```

`kind: "api_key"` injects an OpenAI key; `kind: "home"` points at a
`CODEX_HOME` directory containing `auth.json` from `CODEX_HOME=<dir> codex
login` on a ChatGPT plan. Rotation is least-recently-picked with a cool-off
on rate limits.

## Model routing

`src/server/models.ts`:

- **Default model**: UI override file `~/.opensession-default-model.json`
  (`{ "model": "<id>" | null }`) → `OPENSESSION_MODEL` env → `claude-fable-5`.
- **Fallback auto-switch**: `~/.opensession-model-fallback.json`
  (`{ "auto": boolean }`, default true) — whether interactive sessions
  auto-fall-back when their model's pool is exhausted. The built-in fallback
  order: gpt-5.6-sol → gpt-5.6-terra → gpt-5.6-luna → claude-opus-5 →
  claude-sonnet-5 → claude-sonnet-4-6 → claude-haiku-4-5 (a session's
  configured `preferredFallbackModel` is tried first). Every fallback is
  mapped onto opencode too.
- **Cheap-task models**: several features run small classifier prompts on
  haiku by default via `opencodeOneShot`, each overridable by env where it's
  read: `SUGGEST_BRANCH_MODEL`, `NOTE_EDIT_MODEL`, `SCHEDULE_WHEN_MODEL`,
  `DRAFT_AUTOMATION_MODEL`, `SLACK_MENTION_INTENT_MODEL`,
  `PLAIN_SPAM_CHECK_MODEL`, `PLAIN_REFUND_INTENT_MODEL` (all default
  `claude-haiku-4-5`; native ids map onto opencode at dispatch), plus
  `OPENSESSION_ONESHOT_MODEL` as the one-shot default.

## Run gate + least privilege

The engine is deny-by-default on run kind (`opencodeGateReason`):
interactive kinds (`prompt`, `goal`, `create`, `linear`, `slack`,
`workflow`) and unattended kinds (`automation`, `plain`, `action`,
`security-scan`, `github-*`) are allowed; anything else — including runs
with no journal kind — is refused. Denied and confirm-listed tools are
STRIPPED from the model's tool list via OpenCode's `tools` config
(`opencodeRunPolicy`) — there is no per-call approval card on this engine,
so a confirm tool is never callable; the run's guidance differs by type
(unattended runs are told to post the proposed action in their internal
note, interactive runs to ask the human in the session). The rest of the
MCP server stays mounted, so reads keep working.
