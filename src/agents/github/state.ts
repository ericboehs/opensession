/**
 * Per-PR state for the github agent, one JSON file per PR at
 * ~/.opensession-github/<prNumber>.json. Tracks the single review comment id, which
 * head SHAs we've already reviewed (dedup), the resumable review session, and the
 * auto-fix / simplify run state. Mirrors the grafana-poller dedup store.
 *
 * In-process locks coalesce rapid webhook bursts (force-push, stacked commits)
 * within one process; the on-disk state guards across restarts.
 */
import { stateDir } from "../../server/rename-compat";
import { prKey } from "./constants";
import type { HandoffState } from "./handoff-gates";
import { mkdirSync, readFileSync, existsSync, readdirSync } from "fs";
import { writeJsonAtomic } from "../../server/shared/atomic-write";

const STATE_DIR = stateDir("github");

mkdirSync(STATE_DIR, { recursive: true });

// Engine-session resume is handled via the deterministic per-PR session file
// (see run.ts `bksIdFor`), so these track only behavioral state.

export interface AutoFixState {
  active: boolean;
  iterations: number;
  worktreeDir?: string;
  lastPushedSha?: string;
  statusCommentId?: number;
  requestedBy?: string; // github login that applied the label (for commit attribution)
  steer?: string; // free-text steer from the triggering message (recovered on restart)
  startedAt: string;
}

export interface SimplifyState {
  active: boolean;
  doneSha?: string;
  requestedBy?: string;
  startedAt: string;
}

/** What the last completed review concluded, kept so the UI can show the score
 *  without re-reading the PR's comments. Written only after a successful run,
 *  so a transient model failure never blanks the previous verdict. */
export interface LastReviewState {
  /** approve | comment | request_changes (absent when the model omitted it). */
  verdict?: string;
  /** 1-5: how safe this is to merge, per the review contract. */
  confidence?: number;
  findings: number;
  /** P0/P1 findings (request_changes counts as a floor of 1). */
  blocking: number;
  /** Head SHA this verdict describes — a later head means the score is stale. */
  sha: string;
  at: string;
}

export interface GithubPrState {
  prNumber: number;
  headRef: string;
  /** owner/name when this PR lives outside the default repo (multi-repo);
   *  absent = the default repo (every pre-existing state file). */
  ghRepo?: string;
  summaryCommentId?: number;
  reviewedShas: string[];
  lastReviewedSha?: string;
  /** The last review's conclusion (verdict/confidence), for the UI. */
  lastReview?: LastReviewState;
  autoFix?: AutoFixState;
  simplify?: SimplifyState;
  /** Review → owning-session fix rounds (handoff.ts); cleared when a review
   *  comes back satisfied or the PR closes. */
  handoff?: HandoffState;
  /** Reconcile-sweep retry bookkeeping (reconcile.ts). Attempts are per-SHA:
   *  a new head resets the count, so only a *repeatedly*-failing SHA is given
   *  up on. A fresh human label re-arms autofix (webhook.ts clears the count). */
  reconcile?: {
    /** Head SHA the review attempts below refer to. */
    reviewSha?: string;
    reviewAttempts?: number;
    /** Head SHA the autofix attempts below refer to. */
    autofixSha?: string;
    autofixAttempts?: number;
  };
  /**
   * Set while a one-shot action (review/simplify/adversarial) is in flight; cleared
   * in its finally. If the process is killed mid-run, this persists so the github
   * agent re-runs it on startup. (Auto-fix uses its own `autoFix.active`.)
   */
  activeRun?: {
    kind: "review" | "simplify" | "adversarial";
    requestedBy: string;
    startedAt: string;
    /** The run's progress comment id — reused only on restart recovery, not on a fresh re-trigger. */
    progressCommentId?: number;
    /** Free-text steer from the triggering message, so a restart can re-pass it. */
    steer?: string;
  };
  /** An in-flight @mention reply (conversational), persisted so a restart can re-run it. */
  activeMention?: {
    author: string;
    body: string;
    kind: "issue" | "review";
    replyToId?: number;
    inline?: { path: string; line?: number; diffHunk?: string };
    progressCommentId?: number;
    startedAt: string;
  };
  /**
   * A just-received @mention, persisted synchronously on receipt — before the run
   * self-persists (the classify + worktree window, several seconds). If the process
   * dies in that window — e.g. a webhook that lands during shutdown drain, which we
   * still ack 200 so GitHub won't redeliver — startup recovery replays it. Cleared
   * once a run takes ownership (activeMention/activeRun) or the dispatch completes.
   */
  pendingMention?: {
    kind: "issue" | "review";
    commentId: number;
    body: string;
    author: string;
    replyToId?: number;
    inline?: { path: string; line?: number; diffHunk?: string };
    receivedAt: string;
  };
  updatedAt: string;
}

function statePath(prNumber: number, ghRepo?: string): string {
  return `${STATE_DIR}/${prKey(prNumber, ghRepo)}.json`;
}

export function readPrState(prNumber: number, ghRepo?: string): GithubPrState | null {
  const path = statePath(prNumber, ghRepo);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GithubPrState;
  } catch {
    return null;
  }
}

export function getOrInitPrState(prNumber: number, headRef: string, ghRepo?: string): GithubPrState {
  return (
    readPrState(prNumber, ghRepo) || {
      prNumber,
      headRef,
      ...(prKey(prNumber, ghRepo) !== String(prNumber) ? { ghRepo } : {}),
      reviewedShas: [],
      updatedAt: new Date().toISOString(),
    }
  );
}

export function writePrState(state: GithubPrState): void {
  state.updatedAt = new Date().toISOString();
  // Keep the reviewed-SHA list bounded.
  if (state.reviewedShas.length > 20) state.reviewedShas = state.reviewedShas.slice(-20);
  writeJsonAtomic(statePath(state.prNumber, state.ghRepo), state);
}

export function updatePrState(
  prNumber: number,
  headRef: string,
  patch: (s: GithubPrState) => void,
  ghRepo?: string
): GithubPrState {
  const s = getOrInitPrState(prNumber, headRef, ghRepo);
  patch(s);
  writePrState(s);
  return s;
}

/** Persist a just-received mention so a crash/restart before the run self-persists
 *  can still recover it. headRef may be unknown here; the run backfills the real one. */
export function setPendingMention(
  prNumber: number,
  pending: NonNullable<GithubPrState["pendingMention"]>,
  ghRepo?: string
): void {
  updatePrState(
    prNumber,
    `pr-${prNumber}`,
    (s) => {
      s.pendingMention = pending;
    },
    ghRepo,
  );
}

/** Clear the pending-mention marker once a run owns the mention or it completes. */
export function clearPendingMention(prNumber: number, ghRepo?: string): void {
  const s = readPrState(prNumber, ghRepo);
  if (!s?.pendingMention) return;
  s.pendingMention = undefined;
  writePrState(s);
}

/** Every PR state file (for the startup recovery sweep). */
export function listPrStates(): GithubPrState[] {
  const out: GithubPrState[] = [];
  for (const file of readdirSync(STATE_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(`${STATE_DIR}/${file}`, "utf-8")) as GithubPrState);
    } catch {}
  }
  return out;
}

// ── In-process locks ─────────────────────────────────────────
// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix AND simplify because they operate on the same PR-branch worktree —
// running them concurrently on one PR would corrupt that worktree.

// "review" is independent (read-only, main checkout). "code" is shared by
// auto-fix, simplify, AND mention replies — they all operate on the same
// PR-branch worktree, so they must not run concurrently on one PR.
// Keyed by prKey (bare number for the default repo, repoId-number otherwise).
const locks: Record<"review" | "code", Set<string>> = {
  review: new Set(),
  code: new Set(),
};

/** Try to claim the lock; false if already held. Release with releaseLock. */
export function claimLock(behavior: keyof typeof locks, prNumber: number, ghRepo?: string): boolean {
  const key = prKey(prNumber, ghRepo);
  if (locks[behavior].has(key)) return false;
  locks[behavior].add(key);
  return true;
}

export function releaseLock(behavior: keyof typeof locks, prNumber: number, ghRepo?: string): void {
  locks[behavior].delete(prKey(prNumber, ghRepo));
}

/** Is the lock currently held? (Read-only probe — never claims.) */
export function isLockHeld(behavior: keyof typeof locks, prNumber: number, ghRepo?: string): boolean {
  return locks[behavior].has(prKey(prNumber, ghRepo));
}

export function activeCodeLoops(): string[] {
  return locks.code.size ? [...locks.code] : [];
}
