# Effective config

`GET /api/sessions/:id/effective-config` prints the configuration a session's
next turn would run with, one row at a time, each naming the file or code path
that decided it.

It exists because the answer to "why did this session not get tool X" is spread
across `mcp-config.json`, `~/.opensession-engines.json`, an automation's
allowlist, a feed project's descriptor, a per-user model default, and policy
code in three modules. This reads all of them at once.

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3850/api/sessions/os-…/effective-config | jq .
```

Query parameters:

| Param | Meaning |
| --- | --- |
| `user` | Who the next turn is attributed to. The `allowedUsers` gate and the shared-server key both key off it. Ignored while web sign-in is active: the verified identity wins, the same rule that stops anyone acting under another name (`requestUser`). |
| `verbose=1` | Add the static tables that are the same for every session (the ask-mode bash allowlist). |

So on a signed-in instance the dump answers "how would this session run *for me*". A loopback caller is the `Automation` machine identity, which is why a curl from the box reports `identity.runUser: "Automation"` rather than the session's owner.

Auth is the same as every other session route. The endpoint is read-only: the
account row *peeks* the pool (`recordPick: false`) rather than picking from it.

## Reading the output

Every leaf is a row:

```json
{
  "value": ["grafana", "incident"],
  "source": "session-run-inputs.ts — automation \"Production Watchdog\" recipe allowlist",
  "stability": "load-dependent",
  "note": "…"
}
```

`stability` marks rows that are re-resolved at dispatch: which account the
bridge picks, and therefore the shared-server key, depend on pool state at the
moment the turn starts. Everything else is stable until someone edits a config.
The document is a forecast, not a contract — a mid-turn near-limit steer or the
model fallback graph can still move a run.

## Sections

| Section | Answers |
| --- | --- |
| `execution` | Host, sandbox or Runner. Working directory, branch, mode, and what the mode costs you. |
| `gate` | Whether the engine will run this kind of turn at all (`piGateReason`, deny by default). |
| `model` | Requested id → engine → dispatch id, which config chose the engine, the preset behind a `dial/…` id, effort, fallback. |
| `account` | Bridge mode, pinned/sticky/predicted account and why, every model the pick has to satisfy, and the pool-dry circuit. |
| `mcp` | The allowlist and where it came from, then every configured server with `included` and the gate that decided it. Plus the in-process `opensession-*` set. |
| `tools` | The unattended policy flag, and every tool stripped from the model's list with the catalog it came from. |
| `agents` | The oracle and orchestrator-worker subagents, resolved for this run's bridge. |
| `memory` | The `~/.opensession-memory` scopes injected into the system prompt, or why none are. |
| `placement` | Shared always-warm engine server vs per-session, the reason, and the pool key. |
| `identity` | The run user, the OAuth grant user, the GitHub login whose token rides along, the commit author. |
| `instructions` | Which sources compose the system prompt. Contents are never returned: `AGENTS.local.md` is instance-private. |

## Two rows worth knowing about

**`mcp.scope` vs `placement.externalMcpAtConfigLevel`.** A run on a shared
engine server gets `"all"` in its server config and is narrowed per prompt
instead, so those two rows legitimately disagree. A per-session server enforces
the allowlist in its own config and they match.

**`gate.unattendedKind` vs `tools.unattended`.** An interactive resume of an
automation-owned session is run kind `prompt` (so the first is false) while
still carrying that automation's denials (so the second is true). That is the
rule that keeps a resume from handing an automation session every MCP server.

## How it stays honest

The endpoint composes the real resolvers rather than restating them:
`routeModel` for the engine, `filterMcpServers` for MCP visibility,
`runToolPolicy` for tool stripping, the detached-host resolver for placement,
`sessionMemoryScopes` for memory, `pickMeridianAccount` for the account.

The one decision that used to live inline in `run-session.ts` — the
automation / session / feed branch that picks the MCP allowlist, the denials
and the run user — was extracted to `packages/core/opensession-server/src/server/session-run-inputs.ts`, which
`runSessionPromptInner` now calls. One decision, two readers, so the dump
cannot drift from the turn.

The two things this file computes itself are attributions, not decisions:
`explainMcpServers` is handed `filterMcpServers`' output and only says why each
server is in or out, and `describeStrippedTools` is handed
`runToolPolicy`'s disable list and only says which catalog each entry came
from. Both are pure and tested (`packages/core/opensession-server/src/server/effective-config.test.ts`).

## Calling it from a script

`interactive-mcp.ts` binds the run-rpc socket as a module side effect, so
`effective-config.ts` imports it lazily. Importing the module is safe, but
*calling* `buildSessionEffectiveConfig` outside the server process would take
the live socket. Run standalone probes with `NODE_ENV=test`, which makes that
bind a no-op, or just call the endpoint over HTTP.
