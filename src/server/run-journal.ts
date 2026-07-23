/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { envAlias } from "./rename-compat";
import { transitionRunState } from "./run-state";
import { writeJsonAtomic } from "./shared/atomic-write";

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
let ACTIVE_RUNS_PATH =
  envAlias("OPENSESSION_RUN_JOURNAL", "BACKSTAGE_RUN_JOURNAL") ||
  `${OPENSESSION_CHATS_DIR}/active-runs.json`;

/**
 * Test seam (bun tests only): repoint the journal file AFTER this module has
 * been evaluated — mirrors paths.ts's __setChatsDirForTest. ES module
 * bindings are live, so callers that reach this module's functions through
 * ANOTHER already-cached module (e.g. agent-runner.ts's bare import of this
 * file) pick the new value up regardless of which file imported it first.
 * Returns the previous value so afterAll can restore it.
 */
export function __setActiveRunsPathForTest(path: string): string {
  const prev = ACTIVE_RUNS_PATH;
  ACTIVE_RUNS_PATH = path;
  return prev;
}

export interface ActiveRunRecord {
  runKey: string;
  bksSessionId?: string;
  claudeSessionId?: string; // engine session id (name kept for on-disk compat)
  prompt?: string; // original prompt — lets a run interrupted before it got an engine session be re-run from scratch (safe: no session id ⇒ no model output ⇒ no side effects yet)
  cwd: string;
  mode?: "ask" | "code";
  mcpServers?: string[]; // per-run MCP allowlist, preserved across resume
  user?: string; // per-run user, preserved across resume (gates per-user MCP servers)
  deniedTools?: Record<string, string>; // per-run tool denials, preserved across resume
  confirmTools?: Record<string, string>; // per-run human-confirmed tools, preserved across resume
  aws?: boolean; // whether to inject AWS creds, preserved across resume
  model?: string; // per-session model, preserved across resume (decides the provider)
  effort?: string; // reasoning effort, preserved across resume
  fastMode?: boolean; // OpenAI priority service tier, preserved across resume
  accountId?: string; // pinned provider account, preserved across resume
  accountStrict?: boolean; // hard pin: never rotate into the pool (automation cost cap)
  usageCredits?: boolean; // may run on accounts spending usage-credits past their limits
  fallbackModel?: string; // usage-limit fallback policy, preserved across resume
  /** Pool key of the opencode server hosting this run — lets resume-after-
   *  restart REATTACH to a detached server that survived (adoption via the
   *  opencode-detach registry) instead of re-prompting a fresh one. */
  serverKey?: string;
  /** Sandbox the run executes in (docs/sandboxes-plan.md Phase 1+); absent = host process */
  sandboxId?: string;
  /** Provider owning sandboxId, so resume-after-restart can reattach via provider.get() */
  sandboxProvider?: string;
  kind?: string;
  startedAt: string;
}

function readRunJournal(): Record<string, ActiveRunRecord> {
  try {
    return existsSync(ACTIVE_RUNS_PATH)
      ? JSON.parse(readFileSync(ACTIVE_RUNS_PATH, "utf-8"))
      : {};
  } catch {
    return {};
  }
}

function writeRunJournal(journal: Record<string, ActiveRunRecord>): void {
  try {
    writeJsonAtomic(ACTIVE_RUNS_PATH, journal);
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
  }
}

export function journalSet(record: ActiveRunRecord): void {
  const journal = readRunJournal();
  const rejournal = record.runKey in journal;
  journal[record.runKey] = record;
  writeRunJournal(journal);
  // A fallback hop re-journals the same runKey mid-run — that's the running
  // self-edge, not a new registration, so keep the event but tag it.
  if (record.bksSessionId)
    transitionRunState(record.bksSessionId, "run_registered", {
      run_key: record.runKey,
      kind: record.kind,
      rejournal: rejournal || undefined,
    });
}

export function journalClear(runKey: string): void {
  const journal = readRunJournal();
  if (runKey in journal) {
    delete journal[runKey];
    writeRunJournal(journal);
  }
}

/** Snapshot of the runs currently journaled as in-flight (does not clear). */
export function activeRunRecords(): ActiveRunRecord[] {
  return Object.values(readRunJournal());
}

// Engines register a probe so takeInterruptedRuns can tell "journaled but
// still actively driven by THIS process" (a hot reload re-runs boot-ish code
// while old runs keep executing off their old closures) apart from genuinely
// interrupted runs. Parked on globalThis so a reload keeps live probes.
const activeRunProbes: Set<(runKey: string) => boolean> = ((globalThis as any)
  .__runJournalActiveProbes ??= new Set());

export function registerActiveRunProbe(probe: (runKey: string) => boolean): void {
  activeRunProbes.add(probe);
}

function isRunActiveInProcess(runKey: string): boolean {
  for (const probe of activeRunProbes) {
    try {
      if (probe(runKey)) return true;
    } catch {}
  }
  return false;
}

/** Drain interrupted runs left by a previous process (clears the journal). */
export function takeInterruptedRuns(): ActiveRunRecord[] {
  const journal = readRunJournal();
  const entries = Object.values(journal).filter(
    (r) => !isRunActiveInProcess(r.runKey)
  );
  if (entries.length > 0) writeRunJournal({});
  for (const r of entries) {
    if (r.bksSessionId)
      transitionRunState(r.bksSessionId, "boot_journal_found", {
        run_key: r.runKey,
        kind: r.kind,
      });
  }
  return entries;
}
