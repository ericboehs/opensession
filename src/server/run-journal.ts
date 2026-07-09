/**
 * Crash/restart run journal — engine-neutral import surface.
 *
 * Every in-flight run is recorded on disk (active-runs.json); entries that
 * survive a process restart are interrupted runs, resumed on boot by
 * agent-runner.resumeInterruptedRuns. All engines journal through these
 * functions.
 *
 * The implementation still lives in claude-runner.ts until the legacy engines
 * are deleted; import from here so no surviving file depends on a doomed one.
 */
export {
  journalSet,
  journalClear,
  activeRunRecords,
  takeInterruptedRuns,
  type ActiveRunRecord,
} from "./claude-runner";
