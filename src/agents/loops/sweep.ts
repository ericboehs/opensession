/**
 * Sweep loops — cron-scheduled backstage automations that periodically look for a
 * class of problem, fix it, and open a PR, WITHOUT opening duplicate PRs across runs.
 *
 * Idempotency is by convention, reusable for any sweep:
 *   1. Every PR a sweep opens carries the sweep's label and a "<titlePrefix>: …" title.
 *   2. Before fixing anything, the run lists the open PRs with that label and skips
 *      any issue already covered — so a sweep that runs daily won't re-open a PR for
 *      the same unmerged issue.
 *
 * Adding a new sweep = adding a config to SWEEP_LOOPS (and creating its label in the
 * repo). Seeded create-if-absent on startup so your UI edits (prompt/schedule/enabled)
 * are preserved.
 */
import { listAutomations, createAutomation } from "../../server/automations";

export interface SweepConfig {
  /** Stable seed key (so we don't re-create it every startup). */
  eventKey: string;
  name: string;
  /** GitHub label applied to every PR this sweep opens — the dedup key. */
  label: string;
  /** PR title prefix, e.g. "Production Error Sweep". */
  titlePrefix: string;
  /** 5-field UTC cron (server is UTC). */
  schedule: string;
  mcpServers: string[];
  model: string;
  /** The task: what to look for, what to protect, and how to approach it. */
  task: string;
}

const REPO = "tellahq/tella-fusion";

export function buildSweepPrompt(cfg: SweepConfig): string {
  return `You are Michael, running the "${cfg.name}" sweep on ${REPO}.

Goal: find genuinely NEW, actionable issues, fix each at the root, verify the fix, and open one PR per issue — and crucially, never open a PR that duplicates one a previous run already opened.

## 1. Find work to do
${cfg.task}

## 2. Avoid duplicate PRs (do this BEFORE fixing or opening anything)
Run:
\`gh pr list --repo ${REPO} --label ${cfg.label} --state open --json number,title,body,headRefName\`
These are still-open PRs from previous "${cfg.name}" runs. For each candidate, check whether an open PR already addresses the same thing (same root cause / file / component). If it does, DO NOT open another PR for it — skip it. (You may add a brief comment to the existing PR only if you have genuinely new, useful information.) Only continue with work that is NOT already covered.

## 3. Fix + verify each new issue
For each genuinely new, actionable issue:
- Start a dedicated branch off the latest main: \`git fetch origin main --quiet && git checkout -B sweep-<short-slug> origin/main\`.
- Trace it to the root cause (read the code, logs, traces — don't guess).
- Make the smallest correct fix.
- VERIFY it — this is a REAL, dependency-installed checkout (node_modules present, \`cargo\` on PATH), so you CAN and MUST build/verify, not just eyeball it. Follow the repo's own AGENTS.md / CLAUDE.md verify steps for whatever you touched:
  - ReScript (\`.res\` files): run \`bun rescript-check\` in \`packages/core/webapp\` and resolve every error/warning your change introduced (it parses + compiles all modules, ~30-60s).
  - Rust: run the narrowest \`cargo check\` / \`cargo test\` for the touched crate — per AGENTS.md, some crates under \`packages/core/\` aren't root workspace members, so run cargo from the crate dir or with \`--manifest-path\`. Don't run the broad root \`just build\` for webapp/WASM-only work.
  - Anything else: the relevant tests / typecheck / build, or a targeted repro.
  If you cannot confidently fix AND verify an issue, do NOT open a PR for it — leave your analysis in this session and move on. A wrong "fix" is worse than none. NEVER open a PR for a code change you have not actually built and verified.

## 4. Open one PR per fixed issue
\`gh pr create --repo ${REPO} --label ${cfg.label} --head sweep-<short-slug> --title "${cfg.titlePrefix}: <short issue name>" --body "<root cause · the fix · how you verified it · the log/source evidence>"\`
Keep each PR scoped to a single issue. NEVER run \`gh pr merge\`.

## 5. If there's nothing new
If you find nothing actionable, or everything you found is already covered by an open "${cfg.name}" PR, STOP and make no changes and no PRs. Do not open empty or speculative PRs.

## 6. Wrap up
End with a brief summary: what you changed and the evidence it's verified, plus any candidates you deliberately deferred and why (uncertain, needs human approval, or couldn't be verified). Defer rather than force anything you can't confidently verify.`;
}

export const SWEEP_LOOPS: SweepConfig[] = [
  {
    eventKey: "loop:production-error-sweep",
    name: "Production Error Sweep",
    label: "production-error-sweep",
    titlePrefix: "Production Error Sweep",
    schedule: "0 16 * * 1-5", // ~9am PT, weekday mornings (server is UTC)
    mcpServers: ["grafana", "sentry"],
    model: "claude-opus-4-8",
    task:
      "Use the Grafana MCP to review production logs for errors — the high-volume targets first (`vercel` especially), plus `instant` and `temporal`. The Sentry MCP is also available for error context. Focus on real, recurring, actionable errors — not one-offs, known-flaky noise, or things outside our control; prioritize by impact and frequency, and trace each to its root cause before fixing.",
  },
  {
    eventKey: "loop:code-cleanup-sweep",
    name: "Code Cleanup Sweep",
    label: "code-cleanup-sweep",
    titlePrefix: "Code Cleanup Sweep",
    schedule: "0 17 * * 1", // ~10am PT, Mondays (weekly; cleanup is low-urgency)
    mcpServers: [],
    model: "claude-opus-4-8",
    task:
      "Review the tella-fusion codebase for cleanup opportunities: dead code (unreachable or unused), stale files or comments, unused dependencies, duplication, broken links, inconsistent names, and confusing structure.\n\n" +
      "Protect active and uncertain work: do NOT touch unrelated changes, uncommitted/work-in-progress, generated files, or anything you're not confident is safe to remove — when in doubt, leave it and defer it.\n\n" +
      "Be conservative and incremental: prove ONE low-risk cleanup at a time and make the smallest coherent change rather than a sweeping refactor; a few clearly-safe cleanups per run is plenty. If the build/tests aren't available to verify a change, defer it rather than guessing. Stop when no clearly-safe cleanups remain or progress stalls.",
  },
];

/** Seed the sweep loops as automations (create-if-absent; preserves UI edits). */
export function ensureSweepLoops(): void {
  for (const loop of SWEEP_LOOPS) {
    if (listAutomations().some((a) => a.eventKey === loop.eventKey)) continue;
    const created = createAutomation({
      name: loop.name,
      prompt: buildSweepPrompt(loop),
      schedule: loop.schedule,
      mode: "code",
      createdBy: "Michael (loops)",
      eventKey: loop.eventKey,
      mcpServers: loop.mcpServers,
      model: loop.model,
    });
    if ("error" in created) {
      console.error(`[loops] Failed to seed "${loop.name}":`, created.error);
    } else {
      console.log(`[loops] Seeded sweep loop "${loop.name}" (${created.id})`);
    }
  }
}
