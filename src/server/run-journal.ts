/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 */
import { existsSync, readFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { envAlias } from "./rename-compat";
import { writeJsonAtomic } from "./shared/atomic-write";

// Overridable so a detached run host (src/runner-host/host.ts) journals to its
// own per-host file instead of read-modify-writing the shared journal from
// multiple processes concurrently.
const ACTIVE_RUNS_PATH =
  envAlias("OPENSESSION_RUN_JOURNAL", "BACKSTAGE_RUN_JOURNAL") ||
  `${OPENSESSION_CHATS_DIR}/active-runs.json`;

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
  accountId?: string; // pinned Claude subscription, preserved across resume
  accountStrict?: boolean; // hard pin: never rotate into the pool (automation cost cap)
  usageCredits?: boolean; // may run on accounts spending usage-credits past their limits
  fallbackModel?: string; // usage-limit fallback policy, preserved across resume
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
  journal[record.runKey] = record;
  writeRunJournal(journal);
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
  return entries;
}
