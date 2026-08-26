/**
 * Bounded saturation retry for session projections. The kernel actor service
 * sheds concurrent load with retryable "lane/mailbox is full" errors, and the
 * actor client deliberately retries only reads — so the projection executor
 * owns mutation-side resilience. These tests pin the retry policy: retryable
 * errors are retried with backoff up to the bound, non-retryable errors
 * propagate immediately, and the `retried` flag reports whether any retry ran.
 */
import { describe, expect, test } from "bun:test";
import { retryOnKernelSaturation } from "./session-projection-executor";
import { SessionKernelActorError } from "./session-kernel/actor-client";

const noSleep = async (_ms: number) => {};

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
