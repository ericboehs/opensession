---
name: simplify
description: Clean up the changed code without changing behavior — review the diff for reuse, simplification, efficiency, and altitude cleanups via 4 parallel agents, then apply the fixes
argument-hint: "[<target>] (defaults to the current diff)"
---

# Simplify

`/simplify → 4 cleanup agents in parallel → apply the fixes`

You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs — that is what a code review is for.

## Phase 0 — Establish the diff

If `$ARGUMENTS` names a target (a path, a commit, a ref range, a PR number),
treat it as scope guidance and establish the diff from it. Otherwise review the
current change:

- Working-tree changes: `git diff HEAD` (plus `git status --short` for new files).
- If the working tree is clean, the branch's committed diff:
  `git diff @{upstream}...HEAD`, falling back to `git diff origin/main...HEAD`
  when there is no upstream.

Read the diff, and read enough of each enclosing function or file to judge the
change in context. If the diff is empty, say so and stop.

## Phase 1 — Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the `task` tool (`subagent_type:
"explore"`), all in a **single message** so they run concurrently. Pass each
agent the diff, the files it touches, and exactly one of the four angles below.
Each returns its findings with `file`, `line`, a one-line `summary`, and the
concrete cost (what is duplicated, wasted, or harder to maintain).

### Reuse

Flag places the diff re-implements something the codebase already has — grep
shared/utility modules and files adjacent to the change, and name the existing
helper to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state,
copy-paste with slight variation, deep nesting, dead code left behind. Name
the simpler form that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or
hot paths. Also flag long-lived objects built from closures or captured
environments — they keep the entire enclosing scope alive for the object's
lifetime (a memory leak when that scope holds large values); prefer a
class/struct that copies only the fields it needs. Name the cheaper
alternative.

### Altitude

Check that each change is implemented at the right depth, not as a fragile
bandaid. Special cases layered on shared infrastructure are a sign the fix
isn't deep enough — prefer generalizing the underlying mechanism over adding
special cases.

## Phase 2 — Apply the fixes

Wait for all four agents to complete, dedup findings that point at the same
line or mechanism, and fix each remaining one directly. Skip any finding whose
fix would change intended behavior, require changes well outside the reviewed
diff, or that you judge to be a false positive — note the skip rather than
arguing with it. Finish with a brief summary of what was fixed and what was
skipped (or confirm the code was already clean).

Behavior must not change. If a cleanup is only safe alongside a behavior
change, don't make it — report it as a suggestion instead.
