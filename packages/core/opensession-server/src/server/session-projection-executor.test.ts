/**
 * Bounded saturation retry for session projections. The kernel actor service
 * sheds concurrent load with retryable "lane/mailbox is full" errors, and the
 * actor client deliberately retries only reads — so the projection executor
 * owns mutation-side resilience. These tests pin the retry policy: retryable
 * errors are retried with backoff up to the bound, non-retryable errors
 * propagate immediately, and the `retried` flag reports whether any retry ran.
 */
import { describe, expect, test } from "bun:test";
import {
  executeArchiveOverrideProjection,
  retryOnKernelSaturation,
} from "./session-projection-executor";
import {
  SessionKernelActorError,
  SessionKernelQuarantinedError,
} from "./session-kernel/actor-client";

const noSleep = async (_ms: number) => {};

describe("executeArchiveOverrideProjection", () => {
  test("archives through an existing quarantine without releasing it", async () => {
    let mutations = 0;
    const result = await executeArchiveOverrideProjection(
      "paused-session",
      () => {
        mutations++;
        return "archived";
      },
      async () => {
        throw new SessionKernelQuarantinedError(
          "paused-session",
          "Session is quarantined",
        );
      },
    );

    expect(result).toBe("archived");
    expect(mutations).toBe(1);
  });

  test("does not repeat an archive whose settlement hit quarantine", async () => {
    let mutations = 0;
    const result = await executeArchiveOverrideProjection(
      "paused-session",
      () => {
        mutations++;
        return "archived";
      },
      async (_sessionId, _operation, mutate) => {
        await mutate();
        throw new SessionKernelQuarantinedError(
          "paused-session",
          "Session became quarantined",
        );
      },
    );

    expect(result).toBe("archived");
    expect(mutations).toBe(1);
  });

  test("fails closed for every other projection error", async () => {
    let mutations = 0;
    await expect(
      executeArchiveOverrideProjection(
        "paused-session",
        () => {
          mutations++;
        },
        async () => {
          throw new SessionKernelActorError("Actor unavailable", false);
        },
      ),
    ).rejects.toThrow("Actor unavailable");
    expect(mutations).toBe(0);
  });

  test("does not accept another session's quarantine", async () => {
    let mutations = 0;
    await expect(
      executeArchiveOverrideProjection(
        "paused-session",
        () => {
          mutations++;
        },
        async () => {
          throw new SessionKernelQuarantinedError(
            "different-session",
            "Different session is quarantined",
          );
        },
      ),
    ).rejects.toThrow("Different session is quarantined");
    expect(mutations).toBe(0);
  });
});

describe("retryOnKernelSaturation", () => {
  test("returns first-attempt success without marking retried", async () => {
    const { result, retried } = await retryOnKernelSaturation(
      "test",
      async () => 42,
      noSleep,
    );
    expect(result).toBe(42);
    expect(retried).toBe(false);
  });

  test("retries retryable kernel errors and reports retried", async () => {
    let calls = 0;
    const { result, retried } = await retryOnKernelSaturation(
      "test",
      async () => {
        calls++;
        if (calls < 3)
          throw new SessionKernelActorError("Session actor lane is full", true);
        return "ok";
      },
      noSleep,
    );
    expect(result).toBe("ok");
    expect(retried).toBe(true);
    expect(calls).toBe(3);
  });

  test("does not retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      retryOnKernelSaturation(
        "test",
        async () => {
          calls++;
          throw new Error("Gateway command failed");
        },
        noSleep,
      ),
    ).rejects.toThrow("Gateway command failed");
    expect(calls).toBe(1);
  });

  test("gives up after the attempt bound and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      retryOnKernelSaturation(
        "test",
        async () => {
          calls++;
          throw new SessionKernelActorError("Session mailbox is full", true);
        },
        noSleep,
      ),
    ).rejects.toThrow("Session mailbox is full");
    expect(calls).toBe(6);
  });
});
