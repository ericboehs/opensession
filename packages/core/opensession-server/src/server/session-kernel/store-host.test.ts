import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      transcriptAuthority: "actor",
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

  test("rejects an oversized transcript before claiming placement", () => {
    const path = paths();
    const sessionId = "oversized-transcript";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(() => host.transcript({
      op: "append",
      sessionId,
      requestId: "oversized",
      entries: Array.from({ length: 10_001 }, (_, index) => ({
        id: String(index),
        type: "user" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "x",
      })),
    })).toThrow("too many entries");
    expect(host.central.sessionPlacement(sessionId)).toBeUndefined();
    host.close();
  });

  test("publishes isolated placement before a new session's first transcript write", () => {
    const path = paths();
    const sessionId = "transcript-first-session";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.transcript({
      op: "append",
      sessionId,
      requestId: "append-first",
      entries: [{
        id: "first",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "hello",
      }],
    })).toMatchObject({ result: { inserted: 1 } });
    expect(host.central.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "actor",
    });
    expect(host.central.hasSessionDurableState(sessionId)).toBe(false);
    host.close();
  });

  test("stores kernel and transcript tables in the same actor database", () => {
    const path = paths();
    const sessionId = "co-located-transcript";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);

    const appended = host.transcript({
      op: "append",
      sessionId,
      requestId: "append-one",
      entries: [{
        id: "entry-one",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "hello",
      }],
    });
    expect(appended).toMatchObject({
      replay: false,
      result: { firstSeq: 1, lastSeq: 1, inserted: 1, updated: 0 },
    });
    expect(host.transcript({ op: "tail", sessionId, limit: 10 })).toMatchObject({
      firstSeq: 1,
      lastSeq: 1,
      entries: [{ id: "entry-one", seq: 1 }],
    });
    expect(host.transcript({
      op: "append",
      sessionId,
      requestId: "append-one",
      entries: [{
        id: "entry-one",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "hello",
      }],
    })).toMatchObject({ replay: true });
    host.close();

    const actorDb = new Database(
      sessionKernelSessionDbPath(sessionId, path.isolated),
      { readonly: true },
    );
    const tables = (actorDb.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map(({ name }) => name);
    expect(tables).toContain("session_kernel_state");
    expect(tables).toContain("transcript_events");
    expect(actorDb.query(
      "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
    ).get(sessionId)).toEqual({ count: 1 });
    actorDb.close();

    const catalog = new Database(path.central, { readonly: true });
    expect(catalog.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'",
    ).get()).toBeNull();
    catalog.close();
  });

  test("fences destination appends to the current run and Agent Host turn", () => {
    const path = paths();
    const sessionId = "destination-fence";
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const kernel = host.storeForSession(sessionId, true);
    expect(kernel.applyRunEvent({
      sessionId,
      event: "prompt",
      runKey: "run-current",
    }).accepted).toBe(true);
    expect(kernel.registerAgentHostPlan({
      op: "register_plan",
      registrationId: "registration-current",
      sessionId,
      runId: "run-current",
      turnId: "turn-current",
      generation: 1,
      planHash: `sha256:${"a".repeat(64)}`,
    }).accepted).toBe(true);
    const request = {
      op: "append_destination" as const,
      sessionId,
      requestId: "transcript-destination:append-current",
      appendId: "append-current",
      runId: "run-current",
      turnId: "turn-current",
      generation: 1,
      entries: [{
        id: "destination-entry",
        type: "assistant" as const,
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "current",
      }],
    };
    expect(host.transcript(request)).toMatchObject({
      result: { firstSeq: 1, lastSeq: 1 },
    });
    expect(kernel.applyRunEvent({
      sessionId,
      event: "run_failed",
      runKey: "run-current",
    }).accepted).toBe(true);
    expect(host.transcript(request)).toMatchObject({ replay: true });
    for (const stale of [
      { ...request, requestId: "stale-run", appendId: "stale-run", runId: "run-old" },
      { ...request, requestId: "stale-turn", appendId: "stale-turn", turnId: "turn-old" },
      { ...request, requestId: "stale-generation", appendId: "stale-generation", generation: 2 },
    ]) expect(() => host.transcript(stale)).toThrow("fence rejected");
    expect(host.transcript({ op: "count", sessionId })).toBe(1);
    host.close();
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

  test("cuts a legacy session over without dual authority", () => {
    const path = paths();
    const sessionId = "legacy-cutover";
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({
      sessionId,
      state: "running",
      event: "prompt",
      currentRunId: "legacy-run",
    });
    seed.setDeliverySlot(sessionId, "queued", [{ id: "queued", content: "later" }]);
    seed.scheduleTimer({
      sessionId,
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: { stable: true },
    });
    const outboxId = seed.enqueueOutbox(
      sessionId,
      "known_effect",
      { stable: true },
      "legacy-effect",
    );
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySessions(1)).toBe(1);
    expect(host.central.sessionPlacement(sessionId)).toMatchObject({
      placement: "isolated",
      transcriptAuthority: "shared",
      needsScan: true,
    });
    expect(() => host.transcript({
      op: "append",
      sessionId,
      requestId: "not-authoritative",
      entries: [{
        id: "blocked",
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: "blocked",
      }],
    })).toThrow("no isolated actor transcript placement");
    expect(host.central.hasSessionDurableState(sessionId)).toBe(false);
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBe(sessionId);
    expect(host.storeForSession(sessionId).runState(sessionId)).toMatchObject({
      state: "running",
      currentRunId: "legacy-run",
    });
    expect(host.storeForSession(sessionId).deliverySnapshot(sessionId).queued)
      .toEqual([{ id: "queued", content: "later" }]);
    expect(host.storeForSession(sessionId).timer(sessionId, "wake")).toBeTruthy();
    expect(host.storeForOutbox(outboxId).outboxSessionId(outboxId)).toBe(sessionId);
    expect(host.call("ackOutbox", [outboxId])).toBeUndefined();
    expect(host.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
    host.close();

    const reopened = new SessionKernelStoreHost(path.central, path.isolated);
    expect(reopened.storeForSession(sessionId).runState(sessionId).state).toBe("running");
    expect(reopened.central.hasSessionDurableState(sessionId)).toBe(false);
    reopened.close();
  });

  test("publishes transcript authority last with an immutable migration receipt", () => {
    const path = paths();
    const sessionId = "transcript-cutover";
    const seed = new SessionKernelStore(path.central);
    seed.setRunState({ sessionId, state: "idle", event: "seed" });
    seed.close();

    const host = new SessionKernelStoreHost(path.central, path.isolated);
    expect(host.migrateLegacySessions(1)).toBe(1);
    expect(host.central.sessionPlacement(sessionId)?.transcriptAuthority).toBe("shared");

    const published = host.central.publishActorTranscriptAuthority(
      sessionId,
      "sha256:verified-target",
    );
    expect(published).toMatchObject({
      transcriptAuthority: "actor",
      transcriptMigrationReceipt: "sha256:verified-target",
    });
    expect(host.central.actorTranscriptSessionIds()).toEqual([sessionId]);
    expect(() => host.central.publishActorTranscriptAuthority(
      sessionId,
      "sha256:other-target",
    )).toThrow("receipt conflict");

    expect(host.central.rollbackActorTranscriptAuthority(sessionId)).toMatchObject({
      transcriptAuthority: "shared",
      transcriptMigrationReceipt: "sha256:verified-target",
    });
    expect(host.central.actorTranscriptSessionIds()).toEqual([]);
    host.close();
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
      commandKind: "global:stats",
    });
    expect(recovered.storeForSession("healthy-session").runState("healthy-session").state)
      .toBe("running");
    recovered.close();
  });

  test("refuses repair while isolated durable state still has a live run", () => {
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
    );

    expect(host.quarantinedSession("repair-session")).toMatchObject({
      repairable: false,
    });
    expect(host.call("releaseQuarantine", ["repair-session"])).toBe(false);
    expect(host.central.quarantinedSession("repair-session")).toBeDefined();
    expect(host.storeForSession("repair-session").runState("repair-session").state)
      .toBe("running");
    host.close();
  });

  test("repairs only a settled session with no unfinished durable effects", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.central.quarantineSession(
      "settled-repair-session",
      "verified storage interruption",
      "runtime:scan",
    );

    expect(host.quarantinedSession("settled-repair-session")).toMatchObject({
      repairable: true,
    });
    expect(host.call("releaseQuarantine", ["settled-repair-session"])).toBe(true);
    expect(host.quarantinedSession("settled-repair-session")).toBeUndefined();
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
    for (let pass = 0; pass < 8 && !host.quarantinedSession("maintenance-broken"); pass += 1)
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
    expect(host.stats()).toMatchObject({ sessions: 2, quarantinedSessions: 0 });
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

  test("fails closed on conflicting central and isolated outbox routes", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const id = host.call("enqueueOutbox", [
      "isolated-route-session",
      "known_effect",
      null,
      "isolated-effect",
    ]) as number;
    const central = new Database(path.central);
    central.run(`
      INSERT INTO session_kernel_outbox
        (id, effect_id, effect_key, session_id, kind, payload, attempts,
         next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'null', 0, 0, ?)
    `, [
      id,
      "central-conflict:known_effect:central-effect",
      "central-effect",
      "central-conflict",
      "known_effect",
      Date.now(),
    ]);
    central.close();

    expect(() => host.outboxSessionId(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    expect(() => host.storeForOutbox(id)).toThrow(
      "conflicting central and isolated route evidence",
    );
    host.close();
  });

  test("keeps sparse global projections current after mutations", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setAskRecord", ["cache-session", {
      questionId: "ask-one",
      questions: [{ question: "First?" }],
    }]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-one", content: "First" }],
    ]);

    const asks = host.allAskEntries();
    const deliveries = host.allDeliveryEntries("queued");
    (asks[0]![1] as { questionId: string }).questionId = "caller-mutated";
    (deliveries[0]![1] as Array<{ content: string }>)[0]!.content = "caller-mutated";
    expect(host.allAskEntries()[0]![1]).toMatchObject({ questionId: "ask-one" });
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-one", content: "First" },
    ]);

    Object.defineProperty(host.storeForSession("cache-session"), "askEntries", {
      configurable: true,
      value: () => {
        throw new Error("cached ask entries must not rescan isolated stores");
      },
    });
    Object.defineProperty(host.storeForSession("cache-session"), "deliveryEntries", {
      configurable: true,
      value: () => {
        throw new Error("cached delivery entries must not rescan isolated stores");
      },
    });
    host.call("setRunState", [{
      sessionId: "cache-session",
      state: "running",
      event: "cache-test",
    }]);
    expect(host.allAskEntries()[0]![1]).toMatchObject({ questionId: "ask-one" });
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-one", content: "First" },
    ]);

    host.call("deleteAskRecord", ["cache-session"]);
    host.call("setDeliverySlot", [
      "cache-session",
      "queued",
      [{ id: "queue-two", content: "Second" }],
    ]);
    expect(host.allAskEntries()).toEqual([]);
    expect(host.allDeliveryEntries("queued")[0]![1]).toMatchObject([
      { id: "queue-two", content: "Second" },
    ]);
    host.close();
  });

  test("persists sparse projections across a catalog actor restart", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setAskRecord", ["durable-projection", {
      questionId: "ask-durable",
      questions: [{ question: "Still there?" }],
    }]);
    host.call("setDeliverySlot", [
      "durable-projection",
      "queued",
      [{ id: "queue-durable", content: "Keep me" }],
    ]);
    expect(host.allAskEntries()).toHaveLength(1);
    host.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    Object.defineProperty(
      recovered.storeForSession("durable-projection"),
      "askEntries",
      {
        configurable: true,
        value: () => {
          throw new Error("restart must not scan isolated ask tables");
        },
      },
    );
    Object.defineProperty(
      recovered.storeForSession("durable-projection"),
      "deliveryEntries",
      {
        configurable: true,
        value: () => {
          throw new Error("restart must not scan isolated delivery tables");
        },
      },
    );
    expect(recovered.allAskEntries()[0]).toMatchObject([
      "durable-projection",
      { questionId: "ask-durable" },
    ]);
    expect(recovered.allDeliveryEntries("queued")[0]).toMatchObject([
      "durable-projection",
      [{ id: "queue-durable", content: "Keep me" }],
    ]);
    recovered.close();
  });

  test("lists quarantines from durable projections without scanning isolated stores", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (const sessionId of ["quarantine-projection", "unrelated-session"])
      host.call("setRunState", [{ sessionId, state: "idle", event: "seed" }]);
    host.quarantineSession(
      "quarantine-projection",
      "execution ownership became ambiguous",
      "run",
    );
    expect(host.allQuarantinedSessions()).toHaveLength(1);
    host.close();

    const recovered = new SessionKernelStoreHost(path.central, path.isolated);
    Object.defineProperty(
      recovered.storeForSession("unrelated-session"),
      "quarantinedSessions",
      {
        configurable: true,
        value: () => {
          throw new Error("quarantine listing must not scan unrelated stores");
        },
      },
    );
    expect(recovered.allQuarantinedSessions()).toMatchObject([
      {
        sessionId: "quarantine-projection",
        commandKind: "run",
      },
    ]);
    recovered.close();
  });

  test("backfills old sparse projections in bounded retryable batches", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    for (let index = 0; index < 5; index += 1)
      host.call("setRunState", [{
        sessionId: `projection-backfill-${String(index).padStart(2, "0")}`,
        state: "idle",
        event: "seed",
      }]);

    expect((host as any).repairSparseProjections(4)).toBe(true);
    expect(host.allAskEntries()).toEqual([]);
    expect(host.central.sparseProjectionMigrationComplete()).toBe(true);
    host.close();
  }, 10_000);

  test("settles only isolated stores that contain pending steers", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "empty-session",
      state: "idle",
      event: "seed",
    }]);
    host.call("setRunState", [{
      sessionId: "pending-session",
      state: "running",
      event: "run_registered",
      currentRunId: "run-one",
      generation: 1,
    }]);
    host.call("prepareSteerDelivery", [
      "pending-session",
      "steer-one",
      { token: "token-one", runId: "run-one", generation: 1 },
      { id: "steer-one", content: "recover me" },
    ]);
    Object.defineProperty(host.storeForSession("empty-session"), "settlePendingSteers", {
      configurable: true,
      value: () => {
        throw new Error("empty stores must not enter the mutation sweep");
      },
    });

    expect(host.call("settlePendingSteers", [])).toBe(1);
    expect(host.storeForSession("pending-session").deliverySnapshot("pending-session"))
      .toMatchObject({
        pendingSteers: [],
        steered: [{ id: "steer-one", content: "recover me" }],
      });
    host.close();
  });

  test("skips empty stores when retrying compatible creation dead letters", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    host.call("setRunState", [{
      sessionId: "empty-creation-session",
      state: "idle",
      event: "seed",
    }]);
    Object.defineProperty(
      host.storeForSession("empty-creation-session"),
      "retryCompatibleCreationBranchDeadLetters",
      {
        configurable: true,
        value: () => {
          throw new Error("empty stores must not enter the mutation sweep");
        },
      },
    );

    expect(host.call("retryCompatibleCreationBranchDeadLetters", [[], Date.now()]))
      .toEqual([]);
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
    expect(recovered.central.isolatedOutboxSessionId(outboxId)).toBeUndefined();
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

  // Explicit budget: this test creates 24 per-session isolated databases,
  // which is real synchronous disk work (~4s warm locally, ~9s on GitHub's
  // 2-core runner) — the default 5s timeout flags slow hardware, not a hang.
  test("rotates through due isolated work in bounded runtime batches", () => {
    const path = paths();
    const host = new SessionKernelStoreHost(path.central, path.isolated);
    const dueAt = Date.now() - 1;
    for (let index = 0; index < 24; index += 1) {
      host.call("scheduleTimer", [{
        sessionId: `bounded-runtime-${index.toString().padStart(2, "0")}`,
        timerId: "wake",
        kind: "known_timer",
        dueAt,
        payload: null,
      }]);
    }

    const first = host.runtimeWork(Date.now(), ["known_timer"], [], 100);
    const second = host.runtimeWork(Date.now(), ["known_timer"], [], 100);

    expect(first.timers).toHaveLength(16);
    expect(second.timers).toHaveLength(16);
    expect(new Set([
      ...first.timers.map((timer) => timer.sessionId),
      ...second.timers.map((timer) => timer.sessionId),
    ]).size).toBe(24);
    host.close();
  }, 30_000);
});
