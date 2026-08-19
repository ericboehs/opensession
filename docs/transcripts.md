# Transcripts

How session transcripts are stored and served. Contributor doc — nothing here
is operator configuration.

## The store

Open Session owns every transcript as a per-session, sequence-numbered event
log in one SQLite database (WAL): `<sessions dir>/transcripts.db`, managed by
`packages/core/opensession-server/src/server/transcript-store.ts`.

- A row is one parsed `TranscriptEntry`: `(session_id, seq)` primary key,
  dense 1-based `seq` per session, unique `(session_id, uuid)` for dedup —
  re-appending an entry id updates the row in place but keeps its original
  `seq`, which is what makes streamed assistant rewrites ("same id, last
  wins") work.
- Session ids are **unified** ids (`bks-…`, `slack-…`, `linear-…`), never
  engine session ids; `packages/core/opensession-server/src/server/opencode-transcript.ts` keeps the
  engine-id → unified-id map, so engine account rotation (many engine ids,
  one session) doesn't fragment a transcript.
- Entries over 32 KB are stored twice: the full entry in a blob table, and a
  stripped wire form in the event row (content clamped, tool input
  summarized, images replaced by `os-blob:` markers). The UI resolves
  `os-blob:` markers and full entries through the `/entry` route.
- **Exactly one writer: the live server process.** No standalone script
  writes `transcripts.db`; backfills run in-process, and sandbox run-hosts
  proxy their appends through the server.

Appends publish on an in-process bus (`packages/core/opensession-server/src/server/transcript-bus.ts`), so
live viewers of server-owned sessions get pushes, not polling.

## Serving to the UI

The client advertises `supportsSeq` on `watch`; the server serves seq-mode
when it owns the session and the store has it:

- init: a small `transcript_init` tail plus a `transcript_history` page
  moments later; older pages via `load_history {beforeSeq}`; reconnects
  resume with `sinceSeq` — no snapshot re-send.
- live: bus-driven `transcript_append` frames carrying `seq`.

Sessions the server does *not* own — CLI/tmux runs writing their own
transcript files — are served by the legacy file-watcher + byte-offset
protocol instead, and any seq-mode failure degrades to that same path. The
client keeps both modes and picks by what the init frame carries.

## Model-visible means logged

A turn's model input is more than the message a human typed: an engine handoff
transcript, the per-turn repos/memory note, an attached session's excerpt, a
ticket's context. `packages/core/opensession-server/src/server/prompt-context.ts` fences those payloads so the
rendered conversation stays the human's own words — which used to mean they
were written down nowhere, so a stored session could not reproduce the request
that produced its answers.

`packages/core/opensession-server/src/server/context-log.ts` records each one as an ordinary entry: a `system`
entry tagged `noticeKind: "context-injection"`, carrying the payload verbatim
plus its `contextInjection` metadata (`source` — handoff, repos-note, memory,
attached-session-excerpt, preamble… — and the `turnId` it rode with). Riding
the normal entry path is the point: blob-splitting bounds a 180KB handoff like
any other oversized entry, and the ws protocol needs no new frame.

- **Choke point**: `runOnModel` (`packages/core/opensession-server/src/server/agent-runner.ts`) — the single
  dispatch for every engine (opencode, pi, claude-direct, codex-direct, the
  test fake) and every model of a fallback walk. The opencode runner calls in
  as well for the same-engine-restart handoff it prepends *below* that point;
  entry ids are content-derived, so overlapping calls upsert one row.
- **Attribution rides the fence**, not the call site: `wrapContext(body,
  source)` writes `<opensession:context source="…">`, so a new injection site
  is logged whether or not its author remembers this file (untagged blocks log
  as `unknown`).
- **Not conversation**: every client-bound projection drops them
  (`dropContextInjections`), as do the handoff builders and transcript
  excerpts — an injection record must never be folded back into the next
  prompt, or into a recap.

### Standing context

Some model-visible input does not ride a turn. The run's tool surface and the
engine's standing instructions are properties of the checkout and the run
config: the model sees them on every turn, identical, for the life of the
session. `logStandingContext` records each source **once**, and again only when
its content hash moves — a near-identical multi-KB blob per turn would bloat
every session to say the same thing a hundred times. A reader reconstructs a
turn's standing input by taking the newest record of each source at or before
it.

The record is an ordinary entry again: a `system` entry tagged `noticeKind:
"standing-context"`, carrying the content verbatim plus `contextInjection`
metadata (`source`, `turnId`, `hash`, `bytes`). The same predicate
(`isContextInjection`) covers both kinds, so a standing record inherits every
exclusion an injection record has rather than needing to be added to each one.
The hash rides as metadata and as the entry id instead of keying a separate
content-addressed table: the store already dedupes by entry id, so one version
of one source is one row however often it is re-asserted, and a parallel store
is what this design exists to avoid. That matters because the in-process
"already recorded" map dies with the server, and a restart would otherwise
append another copy of a 273KB instructions record for every live session. The
one thing it costs: a source that goes A to B and back to A upserts A's
original row rather than earning a later one.

Three sources today:

| source | written at | content |
| --- | --- | --- |
| `tools` | `runOnModel` (every engine) | the run's tool scoping: MCP allowlist, in-process servers, tool denials, mode |
| `mcp-servers` | the opencode runner | the servers that config actually mounts, the strips that narrow them, the subagents `task` can reach |
| `instructions` | each engine runner or adapter at its final-text point | the standing instruction text, which already folds in `AGENTS.local.md` / `CLAUDE.local.md` |

**The tool schemas themselves are not recordable.** Every mounted tool's name,
description and JSON schema is the largest single model input (roughly 104k
tokens a run), and OpenCode neither persists nor exposes it: `/experimental/tool`
returns only its own built-ins and `/mcp` returns a connection status per
server. Capturing the schemas would mean connecting to every configured MCP
server ourselves, per session. So what is recorded is the tool *surface* —
which servers were mounted and which tools were taken away — not the wording of
each schema.

The direct engines have no runner to log their `instructions` from — claude-direct
and codex-direct assemble their own system prompt and never reach the opencode
runner — so each adapter logs at the point its text is final: the append to the
`claude_code` preset, and the thread's `developerInstructions`. Pi likewise logs
beside its finalized `buildRunInstructions` result before that text joins the
resource loader's system prompt. The vendor preset each direct adapter appends
stays outside the record; that text is the engine's own.

## Imports and drift

Legacy/external transcript files are imported into the store on first touch
(import happens *before* the first live append, so history always precedes
live rows in `seq`), and a session whose external file grows past its import
watermark is re-imported — the uuid upsert makes re-import idempotent. The
legacy parsers exist for exactly this: import sources and external-session
serving, not as an alternate store.

## Adjacent pieces

- **Session metadata** (the session JSON files) is written through
  `updateSessionFile(sessionId, mutator)` in `packages/core/opensession-server/src/server/session-cache.ts` —
  a per-session mutex where each caller overlays only the fields it owns.
- **Engine boundary**: `packages/core/opensession-server/src/server/engine/` defines the `EngineAdapter`
  surface (`startTurn` as an event stream, plus steer/cancel/reattach) that
  the transcript pipeline consumes; OpenCode is the production adapter.
- **Snapshot fixtures**: scripted sessions run through the real pipeline on a
  fake engine, freezing both the entries written here and the prompt/config
  the engine received. See [transcript-snapshots.md](transcript-snapshots.md);
  a change to context fencing, MCP scoping or handoff notes shows up there as
  a fixture diff.
- Deleting a session purges its transcript rows and blobs.
