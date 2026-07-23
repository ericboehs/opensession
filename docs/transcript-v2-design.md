# Transcript v2 — owned event-log store, seq protocol, engine adapter

Status: implementation in progress (2026-07-23). Owner: Michael session, approved by Michiel
("fully rewrite it", "migrate the old sessions if possible"). This doc is the contract for the
implementation work packages. Revision 2 — incorporates the 4-lens code-grounded critique
(15 agents, 11 confirmed serious findings folded in below).

## Why

Today the transcript source of truth is split between opencode's SQLite (event-sourced blobs;
observed: a 129 MB shard DB holding 16 messages / 0.5 MB of content, one 46 MB `event` row) and
a claude-shape mirror jsonl written by the runner's SSE pump, reconciled by
`backfillOpencodeTranscriptGap` when they drift. Live updates reach the UI through a 1 s polling
file-watcher even though the writer is our own process. Session metadata json is written from
~7 call sites with no versioning (last-writer-wins full-object). ~2/3 of opencode-runner.ts is
process-boundary tax around a ~10-call engine API.

v2 inverts ownership: **OpenSession owns the transcript as a per-session sequence-numbered event
log in one SQLite (WAL) DB; appends broadcast in-process (no polling for sessions we own); the
engine becomes a replaceable adapter.**

## Non-negotiable live-safety invariants

1. **New logic lives in NEW files.** New files not imported by the live graph are inert under
   `bun --hot`.
2. **Every edit to ANY file in the hot import graph must leave the file parse-valid and
   behavior-identical with the flag off.** This includes `opencode-transcript.ts` — it is NOT
   restart-only: it's imported by ws-handlers.ts:23, sessions.ts:20, routes/workflows.ts:20,
   routes/session-transfer.ts:9 and re-evaluates live on every save (only in-flight runner
   closures keep old refs until restart — a MIXED graph). Same bar for jsonl-parser.ts,
   ws-handlers.ts, sessions.ts, session-cache.ts, run-session.ts. Consequence: **signature
   changes to exported functions in mixed-graph files must be backward-compatible** (optional
   trailing params / options-bag fields only) — hot callers rebind seconds after a save while
   runner closures keep the old arity until restart.
3. **Flag:** `OPENSESSION_TRANSCRIPT_V2` via `envAlias` (rename-compat.ts:55; reads process.env
   at call time). Code default OFF (`=== "1"` enables). We set it in
   `/home/ubuntu/.opensession.env` (EnvironmentFile; the running process never re-reads it), so
   the single final restart is the activation event. Keep the window between editing that file
   and restarting short (anything else launched with that EnvironmentFile would see the flag).
   Kill switch after activation: `=0` + restart.
4. **Dual-write, never cut-over-and-delete.** The mirror jsonl keeps being written exactly as
   today, by every current writer. Every legacy read path stays functional. v2 is an additional,
   preferred path.
5. **No `git reset/checkout/add -A`** in this shared checkout; stage specific files; commit+push
   per milestone. Other sessions may have uncommitted files — never touch them.
6. **Tests must not transitively import `run-rpc.ts`** (bun test steals the live rpc socket).
   Test only pure new modules; probe `~/.opensession-chats/backstage-rpc.sock` after test runs.
7. **One restart, at the very end.** After each wiring WP: `bunx tsc --noEmit` (baseline is
   clean) + live health probe (`curl -sf http://127.0.0.1:3850/` or an API route).
8. **transcripts.db has exactly ONE writer: the live server process.** No standalone scripts
   write it. Backfill runs in-process (admin route / boot task). The bus is in-process only; if
   sandbox run-hosts ever appear, they must proxy appends like the run-rpc MCP proxies do.

## 1. Transcript store — `src/server/transcript-store.ts` (new)

DB: `<OPENSESSION_CHATS_DIR>/transcripts.db` (path helpers from paths.ts). `bun:sqlite`, WAL,
`synchronous=NORMAL`, `busy_timeout=5000`. Handle + prepared statements parked on
`globalThis.__osTranscriptStore` (pattern: session-index.ts:58).

```sql
CREATE TABLE IF NOT EXISTS transcript_events (
  session_id TEXT NOT NULL,          -- UNIFIED session id (bks-*/slack-*/…), never engine id
  seq        INTEGER NOT NULL,       -- 1-based, dense per session
  uuid       TEXT NOT NULL,          -- parsed TranscriptEntry.id (see §1a — NOT mirror line uuid)
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  data       TEXT NOT NULL,          -- wire-ready entry JSON, HARD-BOUNDED <= 32KB (bytes)
  full_ref   INTEGER,                -- transcript_blobs.id when data is a stripped form
  PRIMARY KEY (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_te_uuid ON transcript_events(session_id, uuid);
CREATE TABLE IF NOT EXISTS transcript_blobs (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uuid TEXT NOT NULL, data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_uuid ON transcript_blobs(session_id, uuid);
CREATE TABLE IF NOT EXISTS transcript_sessions (
  session_id  TEXT PRIMARY KEY,
  next_seq    INTEGER NOT NULL DEFAULT 1,
  last_ts     INTEGER,
  imported_at INTEGER,
  import_src  TEXT,                  -- 'mirror'|'merged'|'live-only'
  import_watermark INTEGER           -- mirror file size at import time (drift detection, §8)
);
```

Transaction rules (from critique): every append/import transaction is **BEGIN IMMEDIATE** with
the `next_seq` read+bump inside it. Dedup/update ONLY via the (session_id, uuid) unique index;
a (session_id, seq) conflict is a bug — surface it, never blanket OR IGNORE. seq is assigned only
to rows actually inserted (pre-check the uuid index inside the transaction).

**Upsert semantics (decided now, not during WP):** `ON CONFLICT(session_id, uuid) DO UPDATE SET
data/full_ref/ts` keeping the ORIGINAL seq, and republish on the bus with the same seq — this
preserves the legacy parser's "same-requestId assistant entry: last wins" streamed-rewrite
semantics. The client already upserts by entry id.

**Write-time bounding (byte-based — clampEntriesForWire alone is NOT enough; it only clamps
`content`):** decide on `Buffer.byteLength(JSON.stringify(entry))`. If > 32 KB: store the full
entry in transcript_blobs (full_ref), and in `data` a stripped wire form — content truncated by
bytes with the existing contentClamped/contentLength markers, toolInput replaced by a small
summary `{toolName, byteSize, keys}`, each images[] data-URL replaced by `"os-blob:<uuid>/<i>"`
markers the UI resolves via the /entry route. `clampEntriesForWire` stays as wire-level defense
for legacy paths only.

API (sync, prepared): `appendTranscriptEvents(sessionId, entries) -> {firstSeq,lastSeq}|null`
(post-commit: bus publish + steer-receipt hook, §4a), `readTail(sessionId, limit=50)`,
`readSince(sessionId, sinceSeq, limit)`, `readBefore(sessionId, beforeSeq, limit)` (all return
`{entries(each with seq), firstSeq, lastSeq}`), `getFullEntry(sessionId, uuid)`,
`hasImported(sessionId)`, `markImported(sessionId, src, watermark)`, `getLastSeq(sessionId)`,
`importLegacyTranscript(sessionId, entries, src, watermark)` (chunked transactions ≤ 500 rows).
Delete hook: `deleteSessionTranscript(sessionId)` (rows + blobs) wired into session delete later;
growth metric line into the audit log daily.

### 1a. Identity scheme — parsed entries, deterministic ids (critical from critique)

The store row unit is the **parsed TranscriptEntry** and `uuid` = `entry.id`. Mirror line uuids
(`{id}-use`, `{id}-result`) are NOT the store scheme — one mirror line can fan out to N entries.
W1 therefore parses appended JsonlLines into entries via a new exported
`parseJsonlLines(lines)` helper in jsonl-parser.ts (current exports are file-path-based).
This unifies import ids (mergedSessionTranscript), live ids, wire ids (client merges by
entry.id), and getFullEntry ids.

Prerequisite fix (W0): system/harness entries currently mint `crypto.randomUUID()` per parse —
no stable dedup key. `harnessEntryFor` must derive ids deterministically from the raw line uuid
(`sys-${raw.uuid}`, `-b<i>` suffix for multi-block lines; fallback content+ts hash, never
randomUUID when re-parse is possible). Both call sites (array + string branches). Safe on the
wire (client uses ids as upsert/React keys) and fixes a preexisting duplicate-system-chip
papercut on watcher restarts.

## 2. Bus — `src/server/transcript-bus.ts` (new)

In-process pub/sub on `globalThis.__osTranscriptBus`: `subscribe(sessionId, fn): unsub`,
`publish(sessionId, {entries, firstSeq, lastSeq})`. queueMicrotask fan-out; subscriber throws
never break appends. No imports from engine/run-rpc modules.

## 3. Runner write path (W1 — LIVE-HOT mixed graph, tread carefully)

**No signature changes at call sites.** Instead, opencode-transcript.ts gains a module-local
ocSessionId→unifiedSessionId map (parked on globalThis + persisted JSON beside db-map.json, same
pattern as recordOpencodeDbFor at :89, rotation-safe: many oc ids → one session id). Export
`recordBksSessionFor(ocSessionId, unifiedId)`; resolution happens INSIDE
`appendOpencodeTranscript` / `ensureOpencodeTranscriptFile` / `backfillOpencodeTranscriptGap`
when the flag is on — so ALL mirror-writer families (opencode-runner SSE pump, run-session.ts
:1643/:1702 stop/fail notices, ws-handlers.ts:725 turn-stopped notice, sandbox bootstrap) are
covered with zero call-site churn. Unresolvable oc id → mirror-only write + once-per-session
warn; NEVER throw from the append path.

Recording call sites: opencode-runner.ts wherever it calls recordOpencodeDbFor (run start,
rotation — journal.bksSessionId is in scope), and the sandbox host path in
sandbox/adapters/bootstrap.ts (ActiveRunRecord carries both ids). Slack loop already journals
`bksSessionId = slack-<key>` — covered. **Linear/Plain loop runs do NOT journal a session id in
v1: their sessions are REFUSED v2 serve (gate on `linear-`/`plain-` id prefixes) so they stay on
the fully-working legacy path; follow-up threads a transcriptSessionId through those loops.**

**Import-first invariant (critical):** before assigning the first live seq for a session, the
store append path checks transcript_sessions; if never imported, it synchronously runs the
legacy import (mergedSessionTranscript → importLegacyTranscript → markImported) inside the same
locked scope — live appends may NEVER precede history import, else seq order is permanently
inverted. Fresh sessions with no legacy transcript → markImported('live-only'). This check is a
one-time PK lookup, cached in an in-memory Set. Applies to all three store-writing entry points
(append/ensure/backfill-gap) — the restart-reattach path is the first writer for every in-flight
run at activation.

## 4. WS protocol v2 (ws-handlers.ts — hot-applies, strictly flag-gated)

Client capability: `watch` gains optional `supportsSeq: true` + `sinceSeq`. Server picks v2 iff
**flag && supportsSeq && session id is v2-eligible (not `linear-`/`plain-` prefixed, not an
externally-owned/observe-only run per session-control's external-PID signal) && (store has the
session or lazy import succeeds)**. Otherwise byte-identical legacy path. Externally-written
sessions (CLI/tmux) stay legacy — the bus only fires on in-process appends (watcher-as-bus-feeder
is a documented follow-up, not v1).

v2 serve path:
1. Lazy import if needed (same routine as §3; import failure OR timeout → legacy path for this
   watch + queue a background import).
2. Valid `sinceSeq` → `readSince`, send as `transcript_append` with seq fields; no snapshot.
3. Else two-stage init: `transcript_init {entries(last 12), firstSeq, lastSeq, v2:true}` +
   `transcript_history` (~120) 80 ms later. Same message names; seq fields added — old bundles
   ignore unknown fields, new bundles detect v2 by presence.
4. Register bus subscription; store the unsubscribe handle per-socket (ws.data or a
   globalThis-parked Map) and release it in ONE helper called from all three teardown paths:
   watch-switch (re-watch of a different session on the same socket — the common one), unwatch,
   and close (mirroring stopAllWatchesForClient's contract). Do NOT startWatching the mirror for
   v2 viewers (polling retirement). Mark the socket v2 (ws.data.transcriptV2) so
   run-session.ts:591's rotation re-watch skips it (legacy full-file replay would double-feed).
5. `load_history {beforeSeq}` → `readBefore` (~40/page). Legacy offset paging untouched.

### 4a. Steer receipts

Delivered-steer reconciliation currently rides the file-watcher append listener — watcher-less
v2 sessions would never clear receipts. `appendTranscriptEvents`' post-commit hook invokes the
same reconcile with appended user entries (same contract as setTranscriptAppendListener).

## 5. Frontend (bundle rebuild goes live pre-restart → dual-protocol, capability-detected)

Client sends `supportsSeq: true`, keeps full offset/rev support. Init carrying seq fields → seq
mode (resume `sinceSeq`, page `beforeSeq`, ignore offset/rev cursor frames while in seq mode);
else legacy mode. No flag in frontend. New bundle + old server = legacy; old bundle + new server
= legacy. After edits: force rebuild + verify hash changed.

## 6. Metadata write serialization (hot-applies, behavior-preserving, no flag)

Reframed per critique: the six persist() sites (session-control-wiring.ts:303, actions.ts:365,
automations.ts:909, goal-runner.ts:154, desk.ts:86, ws-handlers.ts:1193) are **blind full-object
rebuilds from closure state** — the fix is converting each to a field-scoped mutator, which is a
per-site semantics change (each site overlays ONLY the fields it owns; create-if-absent where
needed), not a mechanical wrap. session-cache.ts exports
`updateSessionFile(sessionId, mutator)`: per-session promise-chain mutex
(`globalThis.__osSessionFileLocks`), fresh read → mutator → writeJsonAtomic, bumping `rev`
(readers ignore it). `touchBackstageSession` becomes a wrapper. **run-journal.ts stays sync and
unlocked** (its callers are runner-internal; async-mutexing it would regress crash durability).

## 7. Engine adapter — `src/server/engine/` (new package)

Shaped on the REAL consumed surface (per critique of runAgent/run-session):
- `adapter-types.ts`: `EngineAdapter` = `startTurn(opts, model): AsyncIterable<StreamEvent>`
  (keeping init-with-sessionId, terminal done+TurnUsage, usageLimitExhausted, model_switch,
  runner_notice, noticePersisted — these drive the fallback walk and resume); id-keyed control
  ops `steer(id, text, images)`, `cancel(id)`, `isBusy(id)`, `reattach(runRecord)`,
  `activeDetachedRunCount()`; permission asks remain a blocking `onAskUser` callback in opts
  (never a stream event). No 'idle' event.
- `opencode-adapter.ts`: typed facade re-exporting/delegating the existing registry surface —
  documents conformance; does NOT refactor opencode-runner.ts internals.
- `claude-direct-adapter.ts` (experimental, `OPENSESSION_ENGINE_CLAUDE_DIRECT=1`): pattern on
  **anthropic-bridge.ts's existing in-process Agent SDK `query()` usage** (it is a live SDK turn
  implementation — inherit its audit discipline, avoid its env gap). Auth: NO base-URL bridge —
  set `CLAUDE_CODE_OAUTH_TOKEN` from claude-accounts.ts pickAccount/markExhausted AND an
  isolated per-account `CLAUDE_CONFIG_DIR` (never inherit host ~/.claude creds — the silent
  host-credential fallback is live-verified). Emits normalized events into transcript store +
  bus AND dual-writes the mirror (invariant 4 — keeps /entry, FTS, HTTP paths working).
  **Scope: scripted throwaway test sessions ONLY, never wired into the picker/defaults.**
  Acceptance: one scripted session — SDK turn → rows in transcripts.db → bus → v2 WS viewer.
  If parity blockers appear, land types+facade and document the gap.

## 8. Read-path consumers (flag-gated)

- `mergedSessionTranscript` (sessions.ts): flag on + hasImported + **mirror file size ≤
  import_watermark + stored appends account for the rest (i.e. no unexplained mirror growth;
  on drift → re-import, which the upsert semantics make safe)** → serve from store. Else legacy.
  HTTP /transcript route + FTS sweep get fast automatically. /entry/:entryId consults
  getFullEntry first when flag on.
- Backfill/migration: `src/server/transcript-backfill.ts` (new) — in-process, paced (chunked
  imports, await/yield between sessions), newest-first over ALL ~3,100 existing sessions,
  idempotent, summary to log + audit. Triggered post-restart via an admin route
  (`POST /backstage/api/admin/transcript-backfill`, team-gated like other admin routes) and
  auto-kicked once on boot when the flag is on (guarded by a marker file so it runs once).
  NO standalone script writes transcripts.db (invariant 8).

## 9. Work packages & file ownership (disjoint)

| WP | Files (owner) | Type |
|----|---------------|------|
| A | transcript-store.ts, transcript-bus.ts, transcript-store.test.ts | new, parallel |
| B | engine/adapter-types.ts, engine/opencode-adapter.ts, engine/claude-direct-adapter.ts | new, parallel |
| C | transcript-backfill.ts | new, parallel |
| W0 | jsonl-parser.ts: parseJsonlLines export + deterministic harness ids | wiring, LIVE-HOT |
| W1 | opencode-transcript.ts (map + resolution + flag-gated store writes + import-first), opencode-runner.ts + sandbox bootstrap recording sites | wiring, MIXED live-hot |
| W2 | ws-handlers.ts (v2 serve + subscription lifecycle), run-session.ts:591 skip | wiring, hot |
| W3 | session-cache.ts updateSessionFile + 6 persist() call-site conversions | wiring, hot |
| W4 | frontend transcript client + rebuild | wiring, live bundle |
| W5 | sessions.ts store-serve + /entry route + admin backfill route + boot kick | wiring, hot |

A/B/C parallel (disjoint new files). W0→W5 strictly serial, each: tsc clean vs baseline → health
probe → commit specific files.

## 10. Activation sequence

1. All WPs landed, tsc clean, tests green (socket probed after), review workflow passed,
   committed+pushed.
2. Add `OPENSESSION_TRANSCRIPT_V2=1` to `/home/ubuntu/.opensession.env` (keep window short).
3. Announce + `sudo systemctl restart opensession` (graceful; detached servers keep turns).
4. Verify: health; reattach/`[runner] Resumed` lines; probe turn writes rows to transcripts.db;
   UI watch gets `v2:true`; a legacy (linear) session still loads via old path; steer receipt
   clears on a v2 session.
5. Kick the full backfill; watch its summary + transcripts.db growth metric.
