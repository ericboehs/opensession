/**
 * Crash/restart run journal — every in-flight run is recorded on disk;
 * entries that survive a process restart are interrupted runs, which
 * agent-runner.resumeInterruptedRuns resumes on boot. All engines journal
 * through these functions.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { dirname } from "path";
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
  accountId?: string; // pinned Claude subscription, preserved across resume
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

function writeRunJournal(journal: Record<string, ActiveRunRecord>): boolean {
  try {
    writeJsonAtomic(ACTIVE_RUNS_PATH, journal);
    return true;
  } catch (e) {
    console.error("[runner] Failed to write run journal:", e);
    return false;
  }
}

const journalLockWait = new Int32Array(new SharedArrayBuffer(4));

function withRunJournalLock<T>(action: () => T): T {
  const lockPath = `${ACTIVE_RUNS_PATH}.lock`;
  const ownerPath = `${lockPath}/owner`;
  const owner = `${process.pid}-${randomUUID()}`;
  mkdirSync(dirname(ACTIVE_RUNS_PATH), { recursive: true });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(ownerPath, owner, { flag: "wx" });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          const stalePath = `${lockPath}.stale-${owner}`;
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error("timed out acquiring run journal lock");
      Atomics.wait(journalLockWait, 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    releaseRunJournalLock(lockPath, owner);
  }
}

function releaseRunJournalLock(lockPath: string, owner: string): void {
  try {
    if (readFileSync(`${lockPath}/owner`, "utf8") === owner) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch {}
}

export const __releaseRunJournalLockForTest = releaseRunJournalLock;

export function journalSet(record: ActiveRunRecord): void {
  const rejournal = withRunJournalLock(() => {
    const journal = readRunJournal();
    const replacing = record.runKey in journal;
    journal[record.runKey] = record;
    if (!writeRunJournal(journal)) throw new Error(`failed to journal run ${record.runKey}`);
    return replacing;
  });
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
  withRunJournalLock(() => {
    const journal = readRunJournal();
    if (!(runKey in journal)) return;
    delete journal[runKey];
    if (!writeRunJournal(journal)) throw new Error(`failed to clear journaled run ${runKey}`);
  });
}

/** Atomically hand recovery ownership from an interrupted run to its
 * replacement, so a crash can never leave both records recoverable. */
export function journalReplace(oldRunKey: string, record: ActiveRunRecord): void {
  withRunJournalLock(() => {
    const journal = readRunJournal();
    delete journal[oldRunKey];
    journal[record.runKey] = record;
    if (!writeRunJournal(journal)) {
      throw new Error(`failed to journal replacement run ${record.runKey}`);
    }
  });
  if (record.bksSessionId)
    transitionRunState(record.bksSessionId, "run_registered", {
      run_key: record.runKey,
      kind: record.kind,
      rejournal: true,
    });
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

/** Drain interrupted runs left by a previous process. Records selected by
 * retain stay journaled until their asynchronous recovery explicitly clears
 * them, so a transient recovery failure remains retryable after restart. */
export function takeInterruptedRuns(
  retain?: (record: ActiveRunRecord) => boolean,
): ActiveRunRecord[] {
  const entries = withRunJournalLock(() => {
    const journal = readRunJournal();
    const candidates = Object.values(journal).filter(
      (r) => !isRunActiveInProcess(r.runKey)
    );
    const retained = new Set(
      candidates.filter((record) => retain?.(record)).map((record) => record.runKey),
    );
    // Older builds could crash between journaling a macOS replacement and
    // clearing its predecessor. A fixed node permits only one foreground run
    // per session, so recover only the newest record from such a legacy pair.
    const newestMacRun = new Map<string, ActiveRunRecord>();
    for (const record of candidates) {
      if (
        !retained.has(record.runKey) ||
        record.sandboxProvider !== "macos" ||
        !record.sandboxId ||
        !record.bksSessionId
      ) continue;
      const key = `${record.sandboxId}\0${record.bksSessionId}`;
      const current = newestMacRun.get(key);
      if (!current || record.startedAt >= current.startedAt) newestMacRun.set(key, record);
    }
    const superseded = new Set<string>();
    for (const record of candidates) {
      if (record.sandboxProvider !== "macos" || !record.sandboxId || !record.bksSessionId) continue;
      const newest = newestMacRun.get(`${record.sandboxId}\0${record.bksSessionId}`);
      if (newest && newest.runKey !== record.runKey) superseded.add(record.runKey);
    }
    const recoverable = candidates.filter((record) => !superseded.has(record.runKey));
    if (recoverable.length > 0) {
      for (const record of candidates) {
        if (superseded.has(record.runKey) || !retained.has(record.runKey)) {
          delete journal[record.runKey];
        }
      }
      if (!writeRunJournal(journal)) throw new Error("failed to drain interrupted run journal");
    }
    return recoverable;
  });
  for (const r of entries) {
    if (r.bksSessionId)
      transitionRunState(r.bksSessionId, "boot_journal_found", {
        run_key: r.runKey,
        kind: r.kind,
      });
  }
  return entries;
}
