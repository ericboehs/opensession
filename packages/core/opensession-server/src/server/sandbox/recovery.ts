import type { RunHostMeta } from "../../runner-host/protocol";
import type { ActiveRunRecord } from "../run-journal";

export type SandboxHostRecoveryDecision =
  | { kind: "replay" }
  | { kind: "resume"; engineSessionId: string }
  | { kind: "uncertain" };

/** Decide from execution evidence, never from a preexisting resume target alone. */
export function decideSandboxHostRecovery(input: {
  run: ActiveRunRecord;
  meta?: RunHostMeta | null;
  privateRun?: ActiveRunRecord;
  hasCompleteSpec: boolean;
}): SandboxHostRecoveryDecision {
  const { run, meta, privateRun, hasCompleteSpec } = input;
  // Private journals copy the input resume target before provider intake. Only
  // meta.engineSessionId is written from the engine's init checkpoint.
  const hostEngineSessionId = meta?.engineSessionId;
  const executionObserved =
    run.launchPhase === "launching" ||
    run.launchPhase === "started" ||
    !!meta?.pid ||
    !!privateRun;

  if (
    hasCompleteSpec &&
    run.launchPhase === "prepared" &&
    !meta?.pid &&
    !privateRun
  )
    return { kind: "replay" };

  if (executionObserved)
    return hostEngineSessionId
      ? { kind: "resume", engineSessionId: hostEngineSessionId }
      : { kind: "uncertain" };

  // Backward-compatible records predate launchPhase. Only those records may
  // use the shared preexisting engine target without a host checkpoint.
  if (run.claudeSessionId)
    return { kind: "resume", engineSessionId: run.claudeSessionId };
  return hasCompleteSpec ? { kind: "replay" } : { kind: "uncertain" };
}
