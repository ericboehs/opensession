#!/usr/bin/env bun
import { dirname } from "node:path";
import { OPENSESSION_SESSIONS_DIR } from "../packages/core/opensession-server/src/server/paths";
import { sessionKernelDbPath } from "../packages/core/opensession-server/src/server/session-kernel/store";
import {
  migrateActorTranscriptsOffline,
  rollbackActorTranscriptsOffline,
} from "../packages/core/opensession-server/src/server/session-kernel/transcript-offline-migration";

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertServicesStopped(): void {
  for (const service of [
    "opensession.service",
    "opensession-executor.service",
    "opensession-session-kernel.service",
  ]) {
    const check = Bun.spawnSync(["systemctl", "is-active", service], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (check.exitCode === 0 && check.stdout.toString().trim() === "active")
      throw new Error(`${service} is active; stop gateway and actor services first`);
  }
}

assertServicesStopped();
const centralPath = value("--central") ?? sessionKernelDbPath();
const rollback = process.argv.includes("--rollback");
const dryRun = process.argv.includes("--dry-run") || process.argv.includes("--audit");
if (rollback && dryRun) throw new Error("Choose either --rollback or --dry-run");
const startedAt = performance.now();
if (rollback) {
  console.log(JSON.stringify({
    rolledBack: rollbackActorTranscriptsOffline(centralPath),
    centralPath,
    elapsedMs: Math.round(performance.now() - startedAt),
  }, null, 2));
} else {
  const sourceTranscriptPath = value("--source") ??
    `${OPENSESSION_SESSIONS_DIR}/transcripts.db`;
  const isolatedRoot = value("--isolated-root") ??
    `${dirname(centralPath)}/session-kernel-sessions`;
  const result = migrateActorTranscriptsOffline({
    centralPath,
    sourceTranscriptPath,
    isolatedRoot,
    dryRun,
  });
  console.log(JSON.stringify({
    ...result,
    sourceUntouched: sourceTranscriptPath,
    elapsedMs: Math.round(performance.now() - startedAt),
  }, null, 2));
}
