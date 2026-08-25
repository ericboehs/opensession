import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionKernelStoreHost } from "./store-host";
import { SessionKernelStore, sessionKernelSessionDbPath } from "./store";

const roots: string[] = [];
function paths() {
  const root = mkdtempSync(join(tmpdir(), "session-kernel-host-"));
  roots.push(root);
  return {
    root,
    central: join(root, "session-kernel.sqlite"),
    isolated: join(root, "sessions"),
  };
}

function failWithSqliteIo(store: SessionKernelStore, method: string): void {
  Object.defineProperty(store, method, {
    configurable: true,
    value: () => {
      const error = new Error("disk I/O error");
      Object.assign(error, { code: "SQLITE_IOERR" });
      throw error;
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("per-session session kernel storage", () => {
  test("claims an unseen mutation route before opening its session database", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);

    expect(host.routeSession("routed-session", false)).toBe("legacy");
    expect(host.central.sessionPlacement("routed-session")).toBeUndefined();
    expect(host.routeSession("routed-session", true)).toBe("isolated");
    expect(host.central.sessionPlacement("routed-session")).toMatchObject({
      placement: "isolated",
      needsScan: true,
    });
    expect(existsSync(sessionKernelSessionDbPath("routed-session", path.isolated)))
      .toBe(false);

    host.call("setRunState", [{
      sessionId: "routed-session",
      state: "running",
      event: "first-turn",
    }]);
    expect(existsSync(sessionKernelSessionDbPath("routed-session", path.isolated)))
      .toBe(true);
    host.close();
  });

  test("claims a new session before writing only its isolated database", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const state = host.call("setRunState", [{
      sessionId: "new-session",
      state: "running",
      event: "prompt",
      currentRunId: "run-one",
    }]);

    expect(state).toMatchObject({ state: "running", currentRunId: "run-one" });
    expect(host.central.hasSessionDurableState("new-session")).toBe(false);
    expect(host.central.sessionPlacement("new-session")).toMatchObject({
      placement: "isolated",
      needsScan: true,
    });
    expect(host.storeForSession("new-session").runState("new-session")).toMatchObject({
      state: "running",
      currentRunId: "run-one",
    });
    host.close();

    const isolated = new SessionKernelStore(
      sessionKernelSessionDbPath("new-session", path.isolated),
    );
    expect(isolated.runState("new-session").state).toBe("running");
    isolated.close();
  });

  test("keeps a legacy session on the central database without dual writing", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId: "legacy-session",
      state: "idle",
      event: "seed",
    });
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "legacy-session",
      state: "running",
      event: "prompt",
      currentRunId: "legacy-run",
    }]);

    expect(host.central.sessionPlacement("legacy-session")).toBeUndefined();
    expect(host.central.runState("legacy-session")).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    host.close();
  });

  test("migrates a legacy session without dual writes or duplicate wake work", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId: "migrated-session",
      state: "running",
      event: "legacy",
      currentRunId: "legacy-run",
    });
    seed.setAskRecord("migrated-session", {
      questionId: "question-one",
      text: "Keep this receipt",
    });
    seed.setDeliverySlot("migrated-session", "queued", [{ id: "prompt-one" }]);
    seed.scheduleTimer({
      sessionId: "migrated-session",
      timerId: "timer-one",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    });
    const outboxId = seed.enqueueOutbox(
      "migrated-session",
      "known_effect",
      { stable: true },
      "legacy-effect",
    );
    const fixture = new Database(path.central);
    const now = Date.now();
    fixture.run(`
      INSERT INTO session_kernel_creation
        (session_id, identity, state, generation, completed_effects, change_seq, updated_at)
      VALUES (?, ?, 'planned', 1, '[]', 1, ?)
    `, ["migrated-session", "creation-one", now]);
    fixture.run(`
      INSERT INTO session_kernel_turn (session_id, revision, cancel, updated_at)
      VALUES (?, 1, NULL, ?)
    `, ["migrated-session", now]);
    fixture.run(`
      INSERT INTO session_kernel_turn_projections
        (session_id, projection_id, generation, phase, payload, updated_at)
      VALUES (?, 'projection-one', 1, 'prepared', '{}', ?)
    `, ["migrated-session", now]);
    fixture.run(`
      INSERT INTO session_kernel_commands
        (session_id, request_id, type, payload, payload_hash, status,
         replay_safe, result, result_hash, result_released, terminal_failure,
         created_at, updated_at)
      VALUES (?, 'request-one', 'fixture', '{}', 'payload-hash', 'completed',
              1, '{}', 'result-hash', 0, 0, ?, ?)
    `, ["migrated-session", now, now]);
    fixture.close();
    const source = seed.sessionSnapshotDigest("migrated-session");
    for (const table of [
      "session_kernel_state",
      "session_kernel_creation",
      "session_kernel_asks",
      "session_kernel_delivery",
      "session_kernel_turn",
      "session_kernel_turn_projections",
      "session_kernel_commands",
      "session_kernel_changes",
      "session_kernel_timers",
      "session_kernel_outbox",
    ]) expect(source.tables[table]?.count).toBeGreaterThan(0);
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.routeSession("migrated-session", true)).toBe("legacy");
    expect(host.sessionMigrationPending("migrated-session", true)).toBe(true);
    expect(host.migrateLegacySession("migrated-session")).toBe("isolated");
    expect(host.central.sessionPlacement("migrated-session")).toMatchObject({
      placement: "isolated",
      needsScan: true,
    });
    expect(host.central.sessionMigration("migrated-session")).toMatchObject({
      phase: "verified",
      sourceDigest: source.digest,
      targetDigest: source.digest,
    });
    const target = host.storeForSession("migrated-session");
    expect(target.sessionSnapshotDigest("migrated-session")).toEqual(source);
    expect(host.central.sessionSnapshotDigest("migrated-session")).toEqual(source);

    const work = host.runtimeWork(
      Date.now(),
      ["known_timer"],
      ["known_effect"],
      10,
    );
    expect(work.timers).toHaveLength(1);
    expect(work.outbox).toHaveLength(1);
    expect(work.outbox[0]?.id).toBe(outboxId);

    host.call("setRunState", [{
      sessionId: "migrated-session",
      state: "stopped",
      event: "isolated-only",
    }]);
    expect(host.central.runState("migrated-session")).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    expect(target.runState("migrated-session").state).toBe("stopped");

    host.call("ackOutbox", [outboxId]);
    expect(target.outboxSessionId(outboxId)).toBeUndefined();
    expect(host.central.outboxSessionId(outboxId)).toBe("migrated-session");
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBe("migrated-session");
    host.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    expect(recovered.routeSession("migrated-session", true)).toBe("isolated");
    expect(recovered.central.sessionSnapshotDigest("migrated-session")).toEqual(source);
    expect(recovered.storeForSession("migrated-session").runState("migrated-session").state)
      .toBe("stopped");
    recovered.close();
  });

  test("preserves tombstone-only and quarantine-only legacy evidence", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    seed.tombstoneSession("legacy-tombstone");
    seed.quarantineSession(
      "legacy-quarantine",
      "ambiguous settlement",
      "gateway:complete",
    );
    const tombstoneSource = seed.sessionSnapshotDigest("legacy-tombstone");
    const quarantineSource = seed.sessionSnapshotDigest("legacy-quarantine");
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySession("legacy-tombstone")).toBe("isolated");
    expect(host.migrateLegacySession("legacy-quarantine")).toBe("isolated");
    expect(host.storeForSession("legacy-tombstone").sessionSnapshotDigest(
      "legacy-tombstone",
    )).toEqual(tombstoneSource);
    expect(host.storeForSession("legacy-quarantine").sessionSnapshotDigest(
      "legacy-quarantine",
    )).toEqual(quarantineSource);
    expect(host.central.sessionSnapshotDigest("legacy-tombstone"))
      .toEqual(tombstoneSource);
    expect(host.central.sessionSnapshotDigest("legacy-quarantine"))
      .toEqual(quarantineSource);
    expect(host.storeForSession("legacy-tombstone").isTombstoned(
      "legacy-tombstone",
    )).toBe(true);
    expect(host.quarantinedSession("legacy-quarantine")).toMatchObject({
      reason: "ambiguous settlement",
      scope: "session",
    });
    host.close();
  });

  test("recovers migration after publish and cutover crash points", () => {
    const path = paths();
    const seed = new SessionKernelStore(path.central);
    for (const sessionId of ["publish-crash", "cutover-crash"]) {
      seed.setRunState({
        sessionId,
        state: "running",
        event: "legacy",
        currentRunId: `${sessionId}-run`,
      });
      seed.scheduleTimer({
        sessionId,
        timerId: "wake",
        kind: "known_timer",
        dueAt: Date.now() - 1,
        payload: null,
      });
    }
    seed.close();

    const preparePublishedFile = (
      host: SessionKernelStoreHost,
      sessionId: string,
    ) => {
      const targetPath = sessionKernelSessionDbPath(sessionId, path.isolated);
      const migration = host.central.beginSessionMigration(sessionId, targetPath);
      const source = host.central.sessionSnapshotDigest(sessionId);
      const temporaryPath = `${targetPath}.migrating-${migration.routeEpoch}`;
      const target = new SessionKernelStore(temporaryPath, {
        recoverInterruptedCommands: false,
      });
      expect(target.importSessionSnapshotFrom(
        path.central,
        sessionId,
        migration.routeEpoch,
        source.digest,
      )).toEqual(source);
      target.checkpointForPublish();
      target.close();
      renameSync(temporaryPath, targetPath);
      return { migration, source, targetPath };
    };

    const beforePublish = new SessionKernelStoreHost(path.central, path.isolated);
    preparePublishedFile(beforePublish, "publish-crash");
    expect(beforePublish.central.sessionMigration("publish-crash")?.phase)
      .toBe("copying");
    beforePublish.close();

    const recoverPublish = new SessionKernelStoreHost(path.central, path.isolated);
    expect(recoverPublish.migrateLegacySession("publish-crash")).toBe("isolated");
    expect(recoverPublish.central.sessionMigration("publish-crash")?.phase)
      .toBe("verified");

    const cutover = preparePublishedFile(recoverPublish, "cutover-crash");
    recoverPublish.central.markSessionMigrationPublished(
      "cutover-crash",
      cutover.source.digest,
      cutover.source.digest,
    );
    const target = new SessionKernelStore(cutover.targetPath, { readonly: true });
    recoverPublish.central.cutoverSessionMigration(
      "cutover-crash",
      cutover.source.digest,
      target.sessionOutboxIds("cutover-crash"),
      target.nextTimerWakeAt(),
      target.nextOutboxWakeAt(),
    );
    target.close();
    expect(recoverPublish.central.sessionMigration("cutover-crash")?.phase)
      .toBe("cutover");
    recoverPublish.close();

    const recoverCutover = new SessionKernelStoreHost(path.central, path.isolated);
    expect(recoverCutover.migrateLegacySession("cutover-crash")).toBe("isolated");
    expect(recoverCutover.central.sessionMigration("cutover-crash")?.phase)
      .toBe("verified");
    expect(recoverCutover.runtimeWork(
      Date.now(),
      ["known_timer"],
      [],
      10,
    ).timers.map((timer) => timer.sessionId).sort()).toEqual([
      "cutover-crash",
      "publish-crash",
    ]);
    recoverCutover.close();
  });

  test("quarantines one unreadable session database without blocking global stats", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("setRunState", [{
      sessionId: "broken-session",
      state: "running",
      event: "prompt",
    }]);
    first.call("setRunState", [{
      sessionId: "healthy-session",
      state: "running",
      event: "prompt",
    }]);
    first.close();
    writeFileSync(
      sessionKernelSessionDbPath("broken-session", path.isolated),
      "not a sqlite database",
    );

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    expect(recovered.stats()).toMatchObject({
      sessions: 1,
      quarantinedSessions: 1,
    });
    expect(recovered.quarantinedSession("broken-session")).toMatchObject({
      commandKind: "storage:open",
    });
    expect(recovered.storeForSession("healthy-session").runState("healthy-session").state)
      .toBe("running");
    recovered.close();
  });

  test("releases the catalog quarantine while an isolated store still fails", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "repair-session",
      state: "running",
      event: "prompt",
    }]);
    failWithSqliteIo(host.storeForSession("repair-session"), "releaseQuarantine");
    host.central.quarantineSession(
      "repair-session",
      "disk I/O error",
      "runtime:scan",
      "storage",
    );

    expect(host.call("releaseQuarantine", ["repair-session"])).toBe(true);
    expect(host.central.quarantinedSession("repair-session")).toBeUndefined();
    expect(host.storeForSession("repair-session").runState("repair-session").state)
      .toBe("running");
    host.close();
  });

  test("contains failures from already-open isolated databases per session", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (const sessionId of [
      "runtime-broken",
      "stats-broken",
      "maintenance-broken",
      "fanout-broken",
      "healthy-session",
    ]) {
      host.call("setRunState", [{ sessionId, state: "running", event: "prompt" }]);
    }

    failWithSqliteIo(host.storeForSession("runtime-broken"), "dueTimers");
    failWithSqliteIo(host.storeForSession("stats-broken"), "stats");
    failWithSqliteIo(host.storeForSession("maintenance-broken"), "maintain");
    failWithSqliteIo(host.storeForSession("fanout-broken"), "runStates");

    expect(() => host.runtimeWork(Date.now(), [], [], 100)).not.toThrow();
    expect(host.quarantinedSession("runtime-broken")).toMatchObject({
      commandKind: "runtime:scan",
    });
    expect(host.stats()).toMatchObject({ sessions: 3, quarantinedSessions: 2 });
    expect(host.quarantinedSession("stats-broken")).toMatchObject({
      commandKind: "global:stats",
    });
    expect(() => host.maintain()).not.toThrow();
    expect(host.quarantinedSession("maintenance-broken")).toMatchObject({
      commandKind: "maintenance:store",
    });
    expect(host.allRunStates()).toEqual([
      expect.objectContaining({ sessionId: "healthy-session", state: "running" }),
    ]);
    expect(host.quarantinedSession("fanout-broken")).toMatchObject({
      commandKind: "global:run-states",
    });
    expect(host.storeForSession("healthy-session").runState("healthy-session").state)
      .toBe("running");

    // A failure in the central identity allocator is not misattributed to the
    // isolated session. It must escape so the actor can fail-stop globally.
    failWithSqliteIo(host.central, "allocateIsolatedOutboxId");
    expect(() => host.call("enqueueOutbox", [
      "healthy-session",
      "known_effect",
      null,
      "central-failure",
    ])).toThrow("disk I/O error");
    expect(host.quarantinedSession("healthy-session")).toBeUndefined();
    host.close();
  });

  test("lazily reactivates a passivated session store", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated, 1);
    host.call("setRunState", [{
      sessionId: "first-session",
      state: "running",
      event: "first",
      currentRunId: "first-run",
    }]);
    const firstActivation = host.storeForSession("first-session");

    host.call("setRunState", [{
      sessionId: "second-session",
      state: "running",
      event: "second",
      currentRunId: "second-run",
    }]);
    expect(() => firstActivation.command("first-session", "missing")).toThrow();

    expect(host.storeForSession("first-session").runState("first-session"))
      .toMatchObject({ state: "running", currentRunId: "first-run" });
    host.close();
  });

  test("pages wake candidates in the catalog instead of rotating a fixed prefix", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (let index = 0; index < 250; index += 1) {
      const sessionId = `due-${String(index).padStart(3, "0")}`;
      host.central.claimIsolatedSession(sessionId);
      host.central.settleIsolatedSessionWake(sessionId, 0, undefined);
    }
    const first = host.central.isolatedWakeCandidates(Date.now(), 100);
    const second = host.central.isolatedWakeCandidates(
      Date.now(),
      100,
      first.at(-1),
    );
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    expect(new Set([...first, ...second]).size).toBe(200);
    expect(second[0]).toBe("due-100");
    host.close();
  });

  test("recovers isolated wake work from the durable dirty placement", () => {
    const path = paths();
    const first = new SessionKernelStoreHost(path.central, path.isolated);
    first.call("scheduleTimer", [{
      sessionId: "wake-session",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    }]);
    const outboxId = first.call("enqueueOutbox", [
      "wake-session",
      "known_effect",
      { stable: true },
      "effect-one",
    ]) as number;
    expect(outboxId).toBeGreaterThanOrEqual(4_000_000_000_000_000);
    expect(first.call("enqueueOutbox", [
      "wake-session",
      "known_effect",
      { stable: true },
      "effect-one",
    ])).toBe(outboxId);
    expect(first.central.isolatedOutboxRoutes()).toEqual([
      { id: outboxId, sessionId: "wake-session" },
    ]);
    expect(first.central.isolatedOutboxSessionId(outboxId)).toBe("wake-session");
    first.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    const work = recovered.runtimeWork(
      Date.now(),
      ["known_timer"],
      ["known_effect"],
      10,
    );
    expect(work.timers).toEqual([
      expect.objectContaining({ sessionId: "wake-session", timerId: "wake" }),
    ]);
    expect(work.outbox).toEqual([
      expect.objectContaining({
        id: outboxId,
        sessionId: "wake-session",
        effectKey: "effect-one",
      }),
    ]);

    recovered.call("ackOutbox", [outboxId]);
    expect(recovered.central.isolatedOutboxSessionId(outboxId)).toBe("wake-session");
    expect(recovered.storeForSession("wake-session").pendingOutbox()).toEqual([]);
    const successorId = recovered.call("enqueueOutbox", [
      "successor-session",
      "known_effect",
      null,
      "effect-two",
    ]) as number;
    expect(successorId).toBeGreaterThan(outboxId);
    expect(recovered.central.isolatedOutboxSessionId(successorId))
      .toBe("successor-session");
    recovered.close();
  });
});
