import { afterEach, describe, expect, test } from "bun:test";
import {
  BOOT_RECOVERY_QUEUE_WAIT_MS,
} from "./agent-runner";
import {
  DETACHED_RECOVERY_GRACE_MS,
  DETACHED_RECOVERY_MAX_MS,
  __claimDetachedRecoveryForTest,
  __reserveDetachedRecoveryForTest,
  __setDetachedRecoveryTimingForTest,
  abortDetachedOpencodeTurn,
  registerPendingRecoveryProbe,
  type OpencodeServerEntry,
} from "./opencode-runner";
import type { ActiveRunRecord } from "./run-journal";

/**
 * The reaper vs boot recovery. A restart leaves each in-flight turn executing
 * on a detached `opencode serve`; boot adoption reserves that survivor until
 * restart recovery reattaches. Until 2026-08-16 the reservation expired on a
 * fixed 5-minute clock while the recovery queue's own wait was 10 minutes, so
 * a recovery that was merely QUEUED had its engine released — and a draining
 * survivor SIGTERMed — five minutes before it was even promoted to start.
 * Observed live: "released 2 unclaimed recovery reservation(s)" at 08:37:16,
 * and those same two runs reattached to that key at 08:37:38 and 08:37:40.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function makeEntry(
  key: string,
  opts: { draining?: boolean } = {},
): OpencodeServerEntry & { killed: () => boolean } {
  let killed = false;
  const proc = {
    kill: () => {
      killed = true;
    },
    exitCode: null,
    killed: false,
    exited: Promise.resolve(0),
    // Detached without a unit: detachedTurnCandidates accepts it, and
    // killServerProc takes the escalation branch instead of writing the
    // machine's real detached-server registry.
    detached: true,
    unit: undefined,
    pid: 4242,
  };
  const entry: OpencodeServerEntry = {
    proc: proc as unknown as OpencodeServerEntry["proc"],
    url: "http://127.0.0.1:1",
    password: "test",
    cwd: "/tmp",
    configHash: "hash",
    key,
    shared: true,
    draining: opts.draining ?? true,
    rpcToken: "token",
    lastUsed: Date.now(),
    activeRuns: 0,
  };
  return Object.assign(entry, { killed: () => killed });
}

function reserve(entry: OpencodeServerEntry, ids: string[]): void {
  cleanups.push(__reserveDetachedRecoveryForTest(entry, ids));
}

function probe(fn: (ocSessionId: string) => boolean): void {
  cleanups.push(registerPendingRecoveryProbe(fn));
}

function timing(graceMs: number, maxMs: number): void {
  const prev = __setDetachedRecoveryTimingForTest({ graceMs, maxMs });
  cleanups.push(() => __setDetachedRecoveryTimingForTest(prev));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll instead of sleeping a fixed budget: these assertions ride real timers
 *  on a shared box, so a fixed sleep is a flake waiting to happen. */
async function eventually(
  predicate: () => boolean,
  budgetMs = 4_000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

describe("detached recovery reservations", () => {
  test("a queued recovery's engine survives the grace window", async () => {
    timing(30, 60_000);
    const entry = makeEntry("key-queued");
    // The recovery is tracked at boot but still waiting for a queue slot.
    probe((id) => id === "oc-queued");
    reserve(entry, ["oc-queued"]);

    await sleep(200);

    expect(entry.killed()).toBe(false);
    expect([...(entry.recoveringSessionIds ?? [])]).toEqual(["oc-queued"]);
  });

  test("an unclaimable reservation is still released and the server reaped", async () => {
    timing(30, 60_000);
    const entry = makeEntry("key-orphan");
    // Nothing intends to claim it: no probe reports this session.
    probe(() => false);
    reserve(entry, ["oc-orphan"]);

    expect(await eventually(() => entry.killed())).toBe(true);
    expect(entry.recoveringSessionIds?.size ?? 0).toBe(0);
  });

  test("reaps on the tick after the recovery lets go, not on a fixed clock", async () => {
    timing(30, 60_000);
    const entry = makeEntry("key-late");
    let pending = true;
    probe((id) => pending && id === "oc-late");
    reserve(entry, ["oc-late"]);

    await sleep(200);
    expect(entry.killed()).toBe(false);

    pending = false;
    expect(await eventually(() => entry.killed())).toBe(true);
  });

  test("only the sessions nothing will claim are released", async () => {
    timing(30, 60_000);
    const entry = makeEntry("key-mixed");
    probe((id) => id === "oc-live");
    reserve(entry, ["oc-live", "oc-gone"]);

    expect(
      await eventually(() => !entry.recoveringSessionIds?.has("oc-gone")),
    ).toBe(true);
    expect(entry.recoveringSessionIds?.has("oc-live")).toBe(true);
    expect(entry.killed()).toBe(false);
  });

  test("a probe that never goes false cannot hold the engine forever", async () => {
    timing(20, 120);
    const entry = makeEntry("key-stuck");
    probe(() => true);
    reserve(entry, ["oc-stuck"]);

    expect(await eventually(() => entry.killed())).toBe(true);
  });

  test("a pooled survivor keeps its reservation while a recovery is queued", async () => {
    timing(30, 60_000);
    const entry = makeEntry("key-pooled", { draining: false });
    probe((id) => id === "oc-pooled");
    reserve(entry, ["oc-pooled"]);

    await sleep(200);

    // Nothing reaps a pooled entry, but the reservation is what keeps the
    // idle sweep and a config-change kill off it, and what makes the
    // reattach probe attach conservatively when its own probe is unclear.
    expect(entry.recoveringSessionIds?.has("oc-pooled")).toBe(true);
  });

  test("the grace ceiling stays clear of the recovery queue's own wait", () => {
    expect(DETACHED_RECOVERY_GRACE_MS).toBeGreaterThan(0);
    expect(DETACHED_RECOVERY_MAX_MS).toBeGreaterThanOrEqual(
      3 * BOOT_RECOVERY_QUEUE_WAIT_MS,
    );
  });

  test("the probe agent-runner registers is the one that answers", async () => {
    // No test probe here on purpose: this drives the REAL wiring, so a fix
    // that works in isolation but is never registered in production fails.
    // `activeRecoveryRuns` is the map trackRecovery fills at boot, keyed by
    // both session ids; reservations hold engine session ids.
    const tracked = (globalThis as { __activeRecoveryRuns?: Map<string, unknown> })
      .__activeRecoveryRuns;
    expect(tracked).toBeInstanceOf(Map);
    tracked!.set("oc-tracked", { runKey: "run-tracked" });
    cleanups.push(() => tracked!.delete("oc-tracked"));

    timing(30, 60_000);
    const entry = makeEntry("key-tracked");
    reserve(entry, ["oc-tracked"]);

    await sleep(200);
    expect(entry.killed()).toBe(false);

    tracked!.delete("oc-tracked");
    expect(await eventually(() => entry.killed())).toBe(true);
  });

  test("abandoning a recovery releases its reservation", async () => {
    timing(60_000, 120_000);
    const entry = makeEntry("key-abandoned");
    probe(() => true);
    reserve(entry, ["oc-abandoned"]);

    // Stop / quarantine aborts the detached turn. The server is unreachable
    // here, so the abort itself fails — the reservation must go regardless,
    // or a probe that stays true pins the survivor until the ceiling.
    const run = {
      runKey: "run-abandoned",
      osSessionId: "os-abandoned",
      claudeSessionId: "oc-abandoned",
      serverKey: "key-abandoned",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    } as ActiveRunRecord;
    await abortDetachedOpencodeTurn(run, AbortSignal.timeout(20));

    expect(entry.recoveringSessionIds?.has("oc-abandoned")).toBe(false);
  });

  test("claiming an idle completion releases its adoption reservation", () => {
    timing(60_000, 120_000);
    const entry = makeEntry("key-idle-complete");
    reserve(entry, ["oc-idle-complete"]);

    __claimDetachedRecoveryForTest(entry, "oc-idle-complete");

    expect(entry.recoveringSessionIds?.has("oc-idle-complete")).toBe(false);
    expect(entry.recoveryReservedAt).toBeUndefined();
    // Claiming must not reap before attach() increments activeRuns.
    expect(entry.killed()).toBe(false);
  });
});
