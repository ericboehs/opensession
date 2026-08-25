# Transcript snapshots

Keyless regression fixtures for the run pipeline. A scenario drives a scripted
session through the real pipeline (`run-session` → `agent-runner` → the event
loop → the transcript store) with a fake engine at the seam, then freezes two
things as JSON:

- **what the run wrote**: the unified transcript entries in the owned store;
- **what the run sent**: the prompt bodies and config the engine received, plus
  the MCP servers and tool strips the pi adapter's own policy resolves
  from them.

No API key, no network, no engine subprocess. The point is that the highest
risk plumbing (context fencing, MCP filtering, engine handoff notes, memory
injection) changes visibly, as a fixture diff in a pull request, instead of
silently.

Contributor doc. Nothing here is operator configuration.

## Running

```sh
bun run test:snapshots                                             # compare
OPENSESSION_SNAPSHOT=record bun test packages/core/opensession-server/src/server/zz-snapshot-runs.test.ts   # re-record
```

Run the file **directly**. Like `zz-fake-run.test.ts`, it redirects module
state (sessions dir, transcript store, MCP config, memory store) that an
earlier file in a full `bun test` may already have frozen; when that happens
the harness says so and every scenario skips rather than snapshotting this
machine's real sessions, memories and MCP servers.

That skip is why the suite has its own command and its own CI step: inside the
sweep these scenarios protect nothing. The script sets
`OPENSESSION_SNAPSHOT_STRICT=1`, which turns an unready harness into a failure
rather than a silent pass, so the step cannot go green by skipping everything.

Fixtures live in `packages/core/opensession-server/src/server/testing/snapshots/`.

## The scenarios

| Fixture | What it pins |
| --- | --- |
| `plain-turn-context-fencing` | A teammate's prompt with a sibling session attached as context. The store keeps the human's message; the model gets the `<opensession:context>` block and the `[Name]` attribution. |
| `mcp-allowlist-filtering` | An automation-owned session prompted by a human. The allowlist drops one server, the per-user `allowedUsers` gate drops another, and the automation's denied tools are stripped from the model's tool list. |
| `session-stamped-mcp-allowlist` | An ordinary session created with a picked set of servers. The stamp on the session file survives the read back, so the scope holds on every turn and not just the first. |
| `engine-switch-handoff` | Two turns with a model change in between. Turn two starts a fresh engine session and carries the handoff note built from the stored transcript. |
| `memory-scope-injection` | Repo, user and team memory rendered into the run's session note, and logged into the transcript as a context-injection entry. |

## When a change requires re-recording

A snapshot failure is a report, not a verdict. Read the diff and decide which
of these it is:

**Re-record.** The change intends to alter what the model sees or what the
transcript holds, and the diff shows exactly that intent and nothing else:

- new or reworded injected context (a note's copy, a new fenced block);
- a deliberate change to what the session note carries;
- a new transcript entry kind, or a changed entry shape;
- a tool added to (or removed from) a deny/confirm list;
- a new field on the recorded engine options.

**Do not re-record; you found a bug.** The diff shows something the change was
not about:

- injected context appearing in `transcript` (the fence stopped hiding it) or
  disappearing from `injectedContext` (the model stopped getting it);
- `mountedMcpServers` gaining a server (a filter stopped filtering) or the
  `unattended` flag flipping to false on an automation-owned run;
- `strippedTools` losing an entry, especially a money-moving one;
- `resumesEngineSession` becoming true across an engine switch, or the handoff
  note going missing;
- entries changing `seq` order, or one entry's content replacing another's
  (an id collision upserting the wrong row).

Re-recording is one command, so the safeguard is entirely in reading the diff
before you commit it. A fixture whose diff nobody read is worth nothing.

## Adding a scenario

1. Add a `test(...)` to `packages/core/opensession-server/src/server/zz-snapshot-runs.test.ts`. Start it with
   `if (!h.ready) return;` so it skips with the rest when module state is warm.
2. Build the session with `h.writeSession(id, {...})`. Prefer `mode: "scratch"`
   plus an explicit `repo` id: a scratch session's working directory is created
   under the harness temp dir, and an explicit repo id keeps the memory scopes
   off whatever repo this machine calls its default. Do not set `worktreeDir`
   to a path no registered repo owns; the repos note throws on it.
3. Drive turns with `h.prompt({ sessionId, content, user, turns, collect })`.
   `turns` is the fake engine's script (see `testing/fake-engine.ts`): text,
   tool calls, errors, usage exhaustion, and the `provider` a turn claims.
   Every engine invocation lands in `collect`.
4. Assert the one or two invariants the scenario exists for, so a reader of the
   test knows what it is about without opening the fixture.
5. Freeze it with `h.snapshot("<fixture-name>", { sessionId, calls })`, then
   record and **read the fixture** before committing.

Useful helpers on the harness:

- `h.patchSession(id, {...})` merges fields into an existing session file,
  which is how a scenario models a mid-session model or engine change.
- `h.writeEngineTranscript(engineSessionId, lines)` gives a sibling session a
  transcript file. A session's `transcriptPath` is derived, never read off its
  file, so this is the way to get a session with history.
- `h.withMemory({ scope: entries }, fn)` runs `fn` against its own memory
  store, so a memory scenario cannot leak into another one.

## What is real and what is projected

Everything up to the engine seam is production code: the prompt assembly, the
context fences, the session note, the queue and run-state machinery, and the
transcript writes.

Two deliberate exceptions, both because the pi adapter spawns
the Pi runtime and cannot run hermetically:

1. **The MCP mount and tool strip are projected, not observed.**
   `enginePolicyView` (`testing/snapshot-views.ts`) calls the adapter's own
   policy functions from `run-policy.ts` (`piGateReason`,
   `runGateReason`, `filterMcpServers`, and `runToolPolicy`) on
   the recorded options, with the same arguments Pi dispatch passes them. The
   decision is real production code; only the caller is the harness. If that
   call site in `pi-runner.ts` changes, change this one with it.

2. **The fake engine persists its own turn.** Writing assistant text and tool
   calls into the store is the engine adapter's job, not `run-session`'s, which
   only broadcasts those events. So the fake engine does it too, through the
   same `appendTranscriptEntries` path and the same `transcriptLine*` builders
   the pi adapter uses. The adapter's streaming bookkeeping (rewrites of
   a part mid-stream, compaction, blob splitting of oversized entries) is
   outside the harness.

Volatile values are scrubbed by `Normalizer` in `testing/snapshot.ts`:
timestamps, uuids, engine session ids, loopback ports, and the harness temp
paths. If a fixture ever shows a value from the machine that recorded it, add
the pattern there rather than editing the fixture.
