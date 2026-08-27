import { describe, expect, test } from "bun:test";
import { desiredLifecycleEffect } from "./lifecycle";
import { InMemoryExecutorStateStore } from "./state";

const record = {
  executorId: "executor-1",
  sessionId: "session-1",
  provider: "box" as const,
  instanceGeneration: 1,
  lifecycle: "preparing" as const,
  project: {
    revision: "revision-1",
    baseCommit: "abc123",
    durableDelta: "delta-1",
  },
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
};

describe("Managed Executor state", () => {
  test("indexes deterministic records by Executor and session and enforces CAS", async () => {
    const store = new InMemoryExecutorStateStore();
    await store.insertIntent(record);
    expect(await store.getByExecutorId("executor-1")).toEqual(record);
    expect(await store.getBySessionId("session-1")).toEqual(record);

    await expect(
      store.compareAndSwap("executor-1", 2, {
        ...record,
        instanceGeneration: 3,
      }),
    ).rejects.toThrow("generation is stale");
  });

  test("projects desired lifecycle without I/O", () => {
    expect(desiredLifecycleEffect("sleeping", "awake")).toBe("wake");
    expect(desiredLifecycleEffect("awake", "sleeping")).toBe("pause");
    expect(desiredLifecycleEffect("waking", "awake")).toBe("wait");
    expect(desiredLifecycleEffect("needs_attention", "awake")).toBe("repair");
    expect(desiredLifecycleEffect("awake", "destroyed")).toBe("destroy");
  });
});
