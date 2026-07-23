# Transcript v2 — owned event-log store, seq protocol, engine adapter

Status: implementation in progress (2026-07-23). Owner: Michael session, approved by Michiel
("fully rewrite it"). This doc is the contract for the implementation work packages.

## Why

Today the transcript source of truth is split between opencode's SQLite (event-sourced blobs;
observed: a 129 MB shard DB holding 16 messages / 0.5 MB of content, one 46 MB `event` row) and
a claude-shape mirror jsonl written by the runner's SSE pump, reconciled by
`backfillOpencodeTranscriptGap` when they drift. Live updates reach the UI through a 1 s polling
file-watcher even though the writer is our own process. Session metadata json is read-modify-write
from ~7 call sites with no versioning (last-writer-wins). ~2/3 of opencode-runner.ts is
process-boundary tax around a ~10-call engine API.

v2 inverts ownership: **OpenSession owns the transcript as a per-session sequence-numbered event
log in one SQLite (WAL) DB; appends broadcast in-process (no polling); the engine becomes a
replaceable adapter.**

## Non-negotiable live-safety invariants (the app keeps running while we build this)

1. **New logic lives in NEW files.** New files not imported by the live graph are inert under
   `bun --hot`.
2. **Every edit to a live-imported file must be behavior-identical with the flag off.** Edits to
   route/WS files hot-apply within seconds; each individual Edit must leave the file valid
   (parse + type). Runner-adjacent files (opencode-runner.ts, opencode-transcript.ts,
   run-session.ts) do NOT hot-apply — but must be correct at restart time.
3. **Flag:** `OPENSESSION_TRANSCRIPT_V2` (read via `envAlias`, checked at call time). Code default
   is OFF (`=== "1"` to enable). We set `OPENSESSION_TRANSCRIPT_V2=1` in
   `/home/ubuntu/.opensession.env` (EnvironmentFile — the running process never re-reads it), so
   the single final restart is the activation event. Kill switch after activation: set `=0` +
   restart.
4. **Dual-write, never cut-over-and-delete.** The mirror jsonl keeps being written exactly as
   today. Every legacy read path (offset/rev WS resume, file-watcher, transcript index, HTTP
   routes, FTS sweep) stays functional. v2 is an additional, preferred path.
5. **No `git reset/checkout/add -A`** in this shared checkout; stage specific files; commit+push
   per milestone. Other sessions may have uncommitted files — never touch them.
6. **Tests must not transitively import `run-rpc.ts`** (bun test steals the live rpc socket).
   Test only pure new modules; probe `~/.opensession-chats/backstage-rpc.sock` liveness after any
   test run.
7. **One restart, at the very end,** after typecheck + tests + review pass. Restarts are graceful
   (detached engine servers survive).

## 1. Transcript store — `src/server/transcript-store.ts` (new)

DB: `~/.opensession-chats/transcripts.db` (path helper from `paths.ts`; respect
OPENSESSION_CHATS_DIR). `bun:sqlite`, WAL, `synchronous=NORMAL`, `busy_timeout=5000`. Single
writer = this process. DB handle parked on `globalThis.__osTranscriptStore` (hot-reload safe,
same pattern as ws-hub/queue-state).

```sql
CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,          -- bks session id (NOT engine id; survives engine rotation)
  seq        INTEGER NOT NULL,       -- 1-based, dense per session
  uuid       TEXT NOT NULL,          -- entry uuid (claude-shape); dedup key
  ts         INTEGER NOT NULL,       -- epoch ms
  kind       TEXT NOT NULL,          -- 'user'|'assistant'|'tool_use'|'tool_result'|'system'|...
  data       TEXT NOT NULL,          -- wire-ready claude-shape entry JSON, clamped to <=32KB
  full_ref   INTEGER,                -- transcript_blobs.id when data was clamped
  PRIMARY KEY (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_te_uuid ON transcript_events(session_id, uuid);
CREATE TABLE IF NOT EXISTS transcript_blobs (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcript_sessions (
  session_id  TEXT PRIMARY KEY,
  next_seq    INTEGER NOT NULL DEFAULT 1,
  last_ts     INTEGER,
  imported_at INTEGER,               -- non-null once legacy import ran
  import_src  TEXT                   -- 'mirror'|'merged'|'live-only'
);
```

API (all sync, prepared statements, single transaction per append):
- `appendTranscriptEvents(sessionId, entries: TranscriptEntry[]): {firstSeq,lastSeq}|null` —
  INSERT OR IGNORE by (session_id, uuid) — absorbs today's uuid-dedup complexity (gap backfill,
  rotation retries) structurally. Clamps `data` at 32 KB (reuse/extract the clamp logic from
  jsonl-parser's `clampEntriesForWire`; store full entry in `transcript_blobs` when clamped).
  Emits to the bus AFTER commit. Returns null if all duped.
- `readTail(sessionId, limit=50)`, `readSince(sessionId, sinceSeq, limit)`,
  `readBefore(sessionId, beforeSeq, limit)` → `{entries, firstSeq, lastSeq}` with each entry
  carrying `seq`.
- `getFullEntry(sessionId, uuid)` → unclamped entry (blob or data).
- `hasImported(sessionId)`, `markImported(...)`, `getLastSeq(sessionId)`.
- `importLegacyTranscript(sessionId, entries)` — bulk insert used by lazy import + backfill.

Clamp choice: store the **clamped** wire form in `data` so reads never re-clamp; full form in
blobs. UI "Show full message" (existing `/entry/:entryId` route) is later served from
`getFullEntry` when flag on, falling back to today's path.

## 2. Bus — `src/server/transcript-bus.ts` (new)

Tiny in-process pub/sub parked on `globalThis.__osTranscriptBus`:
`subscribe(sessionId, fn): () => void`, `publish(sessionId, {entries, firstSeq, lastSeq})`.
Fan-out via `queueMicrotask`; a throwing subscriber never breaks the append path. No engine or
run-rpc imports — importable from anywhere.

## 3. Runner write path (restart-only files)

In `opencode-transcript.ts` `appendOpencodeTranscript(...)`: after the existing mirror
`appendFileSync`, when flag on ALSO `appendTranscriptEvents(bksSessionId, [entry])`. The
function currently keys on engine session id — thread the bks session id through from the
runner call sites (opencode-runner.ts already knows it; the ocSession→bks mapping exists for
run-rpc). `ensureOpencodeTranscriptFile` / `backfillOpencodeTranscriptGap` likewise mirror their
appends into the store (INSERT OR IGNORE makes this idempotent). User prompt lines flow the same
way (they already go through the mirror append).

## 4. WS protocol v2 (hot-applies — strictly flag-gated)

Client capability: `watch` message gains optional `supportsSeq: true` + `sinceSeq`. Server picks
v2 iff `flag && supportsSeq && store has (or can lazily import) the session`. Otherwise byte-
identical legacy path.

v2 serve path in ws-handlers `watch`:
1. Lazy import: if `!hasImported(sessionId)`, run `mergedSessionTranscript(session)` ONCE, bulk
   `importLegacyTranscript`, `markImported`. (Import failure → legacy path, log once.)
2. `sinceSeq` present and valid → `readSince` and send `transcript_append` with seq fields (fast
   resume, no snapshot).
3. Else two-stage init as today: `transcript_init {entries(last 12), firstSeq, lastSeq, v2:true}`
   then `transcript_history` (up to ~120 back) 80 ms later. Reuse existing message names; add
   seq fields — old bundles ignore unknown fields, new bundles detect v2 by their presence.
4. Register a bus subscription for live appends (send `transcript_append {entries, lastSeq}`);
   unsubscribe on unwatch/close. **Do not `startWatching` the mirror for v2 viewers** — that IS
   the polling retirement. Legacy viewers of the same session still use the file-watcher.
5. `load_history {beforeSeq}` → `readBefore` (~40/page). Legacy offset paging untouched.

Presence/run-events via ws-hub are unchanged.

## 5. Frontend (bundle rebuild applies live → must be dual-protocol)

The transcript WS client sends `supportsSeq: true` and keeps full offset/rev support. If init
carries seq fields → seq mode (resume with `sinceSeq`, page with `beforeSeq`); else legacy mode.
New bundle + old server (pre-restart window) = legacy mode; old cached bundle + new server =
legacy path server-side. No flag in the frontend — capability detection only.
After edits: force rebuild + verify hash change (watcher misses frontend edits sometimes).

## 6. Metadata write serialization (hot-applies — behavior-preserving, no flag needed)

In `session-cache.ts`: add a per-session async mutex (`globalThis.__osSessionFileLocks`,
`Map<string, Promise<void>>` chain). Export `updateSessionFile(sessionId, mutator)` that
serializes read→mutate→writeJsonAtomic and bumps a `rev: number` field (readers ignore it).
`touchBackstageSession` becomes a thin wrapper. Convert the full-object `persist()` RMW call
sites (session-control-wiring.ts:303, actions.ts:365, automations.ts:909, goal-runner.ts:154,
desk.ts:86, ws-handlers.ts:1193) to `updateSessionFile`. Same for `run-journal.ts` journalSet/
journalClear (one shared mutex for active-runs.json). Pure serialization — safe to hot-apply.

## 7. Engine adapter — `src/server/engine/` (new package, flag-free scaffolding + flagged adapter)

- `adapter-types.ts`: `EngineAdapter` interface at the real dependency surface:
  `startTurn(opts): Promise<TurnHandle>` where `TurnHandle = {events: AsyncIterable<EngineEvent>,
  abort(reason), status()}`; `EngineEvent` = normalized union (text-part, tool-use, tool-result,
  usage, idle, error, permission-ask). Plus `createEngineSession`, `resolveModel`.
- `opencode-adapter.ts`: documents + types the existing runOpencode surface as the conforming
  implementation (thin — do NOT refactor opencode-runner.ts internals in this pass; adapter
  delegates).
- `claude-direct-adapter.ts` (experimental, `OPENSESSION_ENGINE_CLAUDE_DIRECT=1` gate): in-process
  turn via `@anthropic-ai/claude-agent-sdk` (already a dependency), auth via the Meridian-bridge
  account env the runner already builds (ANTHROPIC_BASE_URL + token). Emits EngineEvents straight
  into the transcript store + bus (no mirror needed — store is authoritative for this engine).
  NOT wired into the session picker/default in this pass; expose only behind the env flag via a
  narrow entry so it can be exercised by a scripted test session. If parity blockers appear,
  land interface + opencode wrapper and document the gap — do not force it.

## 8. Read-path consumers (flag-gated, low risk)

- `mergedSessionTranscript` (sessions.ts): when flag on and `hasImported`, serve from
  `readTail/readSince` instead of full parse+SQLite merge — HTTP /transcript route and FTS sweep
  both get fast automatically. Fall back on any store miss.
- Batch backfill: `scripts/backfill-transcripts.ts` — **full migration of all existing sessions**
  (~3,100), newest-first so active sessions benefit immediately, via the same lazy-import
  routine. Idempotent (INSERT OR IGNORE + `imported_at` marker), paced (small batches + sleeps,
  skip sessions with unreadable/absent transcripts, report a summary table). Runs post-restart;
  can also run standalone via `bun scripts/backfill-transcripts.ts` since it only reads legacy
  stores and writes transcripts.db. Sessions that never get read still lazy-import on first
  watch, so a partial backfill is never a correctness problem.

## 9. Work packages & file ownership (disjoint)

| WP | Files (owner) | Type |
|----|---------------|------|
| A | transcript-store.ts, transcript-bus.ts, transcript-store.test.ts | new |
| B | engine/adapter-types.ts, engine/opencode-adapter.ts, engine/claude-direct-adapter.ts | new |
| C | scripts/backfill-transcripts.ts | new |
| W1 | opencode-transcript.ts (+ its runner call sites for bks-id threading) | wiring, restart-only |
| W2 | ws-handlers.ts | wiring, hot-applies |
| W3 | session-cache.ts, run-journal.ts + persist() call sites | wiring, hot-applies |
| W4 | frontend transcript client + rebuild | wiring, live bundle |
| W5 | sessions.ts mergedSessionTranscript | wiring, hot-applies |

A/B/C run in parallel (disjoint new files). W1–W5 run serially, each followed by typecheck
(`bunx tsc --noEmit`, compare against baseline) and, for hot-applying files, a health probe of
the live server.

## 10. Activation sequence

1. All WPs land, typecheck clean vs baseline, tests green, review workflow passed, committed+pushed.
2. Add `OPENSESSION_TRANSCRIPT_V2=1` to `/home/ubuntu/.opensession.env`.
3. Announce + `sudo systemctl restart opensession` (graceful; detached servers keep turns alive).
4. Verify: service healthy, `[runner] Resumed`/reattach lines, a live probe turn produces rows in
   transcripts.db, UI watch gets `v2:true` init, legacy session still loads (fallback path).
5. Run batch backfill for recent sessions.
