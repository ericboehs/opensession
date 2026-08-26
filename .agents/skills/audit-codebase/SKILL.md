---
name: audit-codebase
description: Audit a whole codebase for materially useful simplifications in its data structures, state representation, control flow, algorithms and ownership, using bounded waves of read-only review agents. Produces a report and changes nothing.
argument-hint: "[<scope>] (defaults to the whole repository)"
---

# Audit codebase

`/audit-codebase → inventory every subsystem → bounded waves of read-only reviewers → validate each finding → audit the audit`

You are the coordinator of a read-only audit. The question is not "are there
bugs" and not "is this pretty". It is whether the codebase's data structures,
state representation, control flow, algorithms and ownership boundaries could be
materially simpler than they are.

Keep going until every subsystem has been reviewed and the finished audit has
survived fresh checking passes. Adapted from Aaron Francis's audit prompt:
https://gist.github.com/aarondfrancis/8735edbe48532f97ee5ea818db4dbd47

## The read-only contract

Do not edit files, run tests, implement a recommendation, commit, or push.
Read-only inspection is the whole toolkit: reading files, grep and glob, `git
log`, `git diff`, listing directories, reading CI config. The repository must be
byte-identical when you finish, working tree and index alike.

Everything you want changed goes into the report as a recommendation. Someone
else decides whether to do it, and when.

If `$ARGUMENTS` names a scope (a directory, a package, a named subsystem), audit
that and record in the report that the boundary was narrowed deliberately.
Otherwise audit the whole repository.

## Phase 0 — The report is the state

One canonical report accumulates everything and you update it as you go. Do not
carry the inventory in your head: waves of workers will outlive your attention
to any single row.

Write it outside the checkout, or you break the read-only contract:

- With Open Session's assets tools, `write_asset` to `audit/report.md`. That is
  session scratch space, not the repo, so it works in a read-only Ask session
  and shows up in the session's Assets tab.
- Otherwise a file under `/tmp`.

The report holds:

1. **Subsystem inventory** (the coverage contract)
2. **Confirmed opportunities** (validated findings, one row each)
3. **Explicit skips** (a subsystem reviewed and found already clear)
4. **Cross-cutting patterns** (the same shape in three places)
5. **Duplicates and superseded findings** (what you merged, and into what)
6. **Final priorities and dependencies**
7. **Audit log** (which wave covered which rows, and when)

## Phase 1 — Establish the coverage contract

Inventory every identifiable subsystem before reviewing any of them. Read the
build files, the directory tree, the entry points, the docs, and enough code to
tell a real boundary from a folder name.

Each row gets:

- a stable ID and a descriptive name
- an exact ownership boundary, in paths
- key implementation files
- public interfaces, major call sites, tests
- a status: `queued`, `in review`, `recommend`, or `skip`

Cover frontend, backend, shared infrastructure, platform bridges, generated or
otherwise externally owned contracts, and test and tooling infrastructure where
they materially matter.

A broad catch-all row is not coverage. "Utilities" or "the server" is a place to
hide four unreviewed subsystems, so split until every row names a boundary a
single worker can hold.

## Phase 2 — Bounded review waves

Give each worker exactly one subsystem, with a non-overlapping boundary.

Launch them with the `task` tool using a read-only subagent (`subagent_type:
"explore"`), putting every call for a wave in a **single message** so they run
concurrently and you wait once. Four to six per wave: bounded by the number of
lanes you can genuinely coordinate, not by how many rows are queued. Do not
interrupt a worker merely for being slow. Harvest results, update the report,
mark the rows, then open the next wave.

A worker sees none of your conversation. Give it the subsystem ID, the exact
boundary, the key files you already found, and this brief:

> Review the assigned subsystem for at most two materially useful
> simplifications in its data structures, state representation, or organizing
> model. Inspect its implementation, public interfaces, major call sites and
> existing tests. Stay inside the assigned boundary. Name a cross-subsystem
> concern if you see one, but do not widen your scope to solve it.
>
> Look for:
>
> - scattered booleans or nullable fields that permit invalid combinations, and
>   want to be a state machine or a discriminated union
> - repeated assumptions about an object's shape that want one shared typed model
> - duplicated branching a small map, registry, reducer or command model removes
> - unclear ownership of state or behaviour that a small module boundary clarifies
> - repeated scans, transformations or lookups where the right collection or
>   index would materially simplify the behaviour, not merely speed it up
> - lifecycle, concurrency or async states whose representation permits stale or
>   contradictory state
>
> Do not force an abstraction. Boring local code that is already clear stays.
>
> Do not recommend a change for stylistic consistency, hypothetical
> extensibility, minor line-count reduction, or to move existing branching
> behind a new type.
>
> Return at most two opportunities, and return `skip` if nothing clears the bar.
> For each one give: (1) verdict, recommend or skip; (2) evidence, with exact
> file and line references; (3) the current complexity or the invalid states it
> permits; (4) the proposed representation and why it is simpler; (5) the
> smallest credible implementation scope, naming affected files and interfaces;
> (6) regression risks and migration concerns; (7) existing and additional
> validation required; (8) confidence: high, medium or low.

## Phase 3 — Validate and synthesize

Verify every finding against the repository yourself before it enters the
report. A worker's confidence is not evidence: open the cited lines.

Reject, narrow, or demote a finding that is vague, duplicates another,
misreads intentional semantics, or only relocates the complexity somewhere else.
Say so in the report rather than deleting it silently, so the next audit does not
rediscover it.

A skip is completed coverage, not a gap. Record it with a sentence on why the
subsystem is already clear.

Deduplicate overlapping findings and assign each accepted one to a single
authoritative subsystem. Keep opening waves until every inventory row is done.

## Phase 4 — Audit the audit

Before you finish, run fresh independent passes for:

- **repository coverage** — what has no subsystem row at all
- **duplication and ownership overlap** — one finding wearing three IDs
- **materiality and over-abstraction** — findings that add a concept to save a
  little typing
- **schema completeness** — every finding carries all eight fields
- **priority ranking** — dependency-aware, not vibes

If the coverage pass finds a real omission, add an explicit subsystem row and
audit it. Do not absorb it by widening a boundary that is already marked done.

Then rank the accepted recommendations by concrete impact, confidence,
implementation effort, blast radius and prerequisites, and name the best first
slices: the ones that unlock others, or stand alone with a small blast radius.

## Done

The audit is complete when every identifiable subsystem has been reviewed, every
subsystem carries a recommendation or an explicit skip, every finding has
complete evidence, scope, risk and validation, duplicates and weak abstractions
are gone, priorities and dependencies are internally consistent, and the
repository is unchanged.

Finish with a short summary in the session: how many subsystems, how many
findings survived validation, the top few slices, and the report's path.
