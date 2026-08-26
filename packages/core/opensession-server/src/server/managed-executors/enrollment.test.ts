import { describe, expect, test } from "bun:test";
import { ExecutorEnrollmentAuthority } from "./enrollment";

const scope = {
  executorId: "executor-1",
  generation: 4,
  expiresAtMs: 2_000,
};

describe("ExecutorEnrollmentAuthority", () => {
  test("issues opaque, one-use, generation-bound grants", () => {
    const authority = new ExecutorEnrollmentAuthority({
      now: () => 1_000,
    });
    const token = authority.issue(scope);
    expect(token).not.toContain(scope.executorId);
    expect(
      authority.consume(token, {
        executorId: "executor-1",
        generation: 4,
      }),
    ).toEqual(scope);
    expect(() =>
      authority.consume(token, {
        executorId: "executor-1",
        generation: 4,
      }),
    ).toThrow("consumed");
  });

  test("rejects expiry and wrong generations", () => {
    let now = 1_000;
    const authority = new ExecutorEnrollmentAuthority({
      now: () => now,
    });
    const stale = authority.issue(scope);
    expect(() =>
      authority.consume(stale, {
        executorId: "executor-1",
        generation: 5,
      }),
    ).toThrow("generation is stale");

    const expired = authority.issue(scope);
    now = 2_000;
    expect(() =>
      authority.consume(expired, {
        executorId: "executor-1",
        generation: 4,
      }),
    ).toThrow("expired");
  });

  test("bounds storage, enforces short TTLs, and supports explicit revocation", () => {
    const authority = new ExecutorEnrollmentAuthority({
      now: () => 1_000,
      maxGrants: 1,
      maxTtlMs: 1_000,
    });
    expect(() => authority.issue({ ...scope, expiresAtMs: 2_001 })).toThrow(
      "short-lived",
    );
    const token = authority.issue(scope);
    expect(() => authority.issue(scope)).toThrow("capacity");
    expect(authority.revoke(token)).toBe(true);
    expect(authority.size).toBe(0);
  });
});
