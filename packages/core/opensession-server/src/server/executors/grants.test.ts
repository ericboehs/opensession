import { describe, expect, test } from "bun:test";
import type { ExecutorOperation } from "@tellahq/opensession-protocol/executor";
import {
  ExecutorGrantAuthority,
  executorOperationDigest,
  type ExecutorGrantScope,
} from "./grants";

const operation: ExecutorOperation = { kind: "fs.stat", path: "one" };
const scope: ExecutorGrantScope = {
  source: "runner",
  executorId: "runner-1",
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 4,
  deadlineMs: 2_000,
  action: {
    purpose: "operation",
    requestId: "request-1",
    operationDigest: executorOperationDigest(operation),
  },
};

function changed(overrides: Partial<ExecutorGrantScope>): ExecutorGrantScope {
  return { ...scope, ...overrides } as ExecutorGrantScope;
}

describe("ExecutorGrantAuthority", () => {
  test("issues opaque fresh grants bound to target, exact fence, and operation", () => {
    const authority = new ExecutorGrantAuthority({ now: () => 1_000 });
    const first = authority.issue(scope);
    const second = authority.issue(scope);
    expect(first).not.toBe(second);
    expect(first).not.toContain(scope.executorId);
    expect(authority.validate(first, scope)).toEqual(scope);

    for (const expected of [
      changed({ executorId: "runner-2" }),
      changed({ source: "managed" }),
      changed({ rootId: "root-2" }),
      changed({ sessionId: "session-2" }),
      changed({ runId: "run-2" }),
      changed({ deadlineMs: 2_001 }),
      changed({
        action: {
          purpose: "operation",
          requestId: "request-1",
          operationDigest: executorOperationDigest({
            kind: "fs.stat",
            path: "two",
          }),
        },
      }),
    ])
      expect(() => authority.validate(first, expected)).toThrow(
        "exact target and action",
      );
    expect(() => authority.validate(first, changed({ generation: 5 }))).toThrow(
      "exact target and action",
    );
  });

  test("separates execution from cleanup and binds the exact cleanup target", () => {
    const authority = new ExecutorGrantAuthority({ now: () => 1_000 });
    const cleanup: ExecutorGrantScope = changed({
      deadlineMs: 1_500,
      action: {
        purpose: "cleanup",
        requestId: "cleanup-1",
        targetRequestId: "request-1",
        streamId: "stream-1",
      },
    });
    const operationGrant = authority.issue(scope);
    const cleanupGrant = authority.issue(cleanup);
    expect(() => authority.validate(operationGrant, cleanup)).toThrow();
    expect(() => authority.validate(cleanupGrant, scope)).toThrow();
    expect(() =>
      authority.validate(cleanupGrant, {
        ...cleanup,
        action: {
          purpose: "cleanup",
          requestId: "cleanup-1",
          targetRequestId: "request-2",
          streamId: "stream-1",
        },
      }),
    ).toThrow();
    expect(() =>
      authority.validate(cleanupGrant, {
        ...cleanup,
        action: {
          purpose: "cleanup",
          requestId: "cleanup-1",
          targetRequestId: "request-1",
          streamId: "stream-2",
        },
      }),
    ).toThrow();
    expect(authority.validate(cleanupGrant, cleanup)).toEqual(cleanup);
  });

  test("expires, revokes by target, and bounds live grants", () => {
    let now = 1_000;
    const authority = new ExecutorGrantAuthority({
      now: () => now,
      maxGrants: 1,
    });
    const grant = authority.issue(scope);
    expect(() => authority.issue(scope)).toThrow("capacity");
    expect(authority.revokeExecutor("managed", "runner-1")).toBe(0);
    expect(authority.revokeExecutor("runner", "runner-1")).toBe(1);
    expect(() => authority.validate(grant, scope)).toThrow(
      "invalid or revoked",
    );

    const expiring = authority.issue(scope);
    now = 2_000;
    expect(() => authority.validate(expiring, scope)).toThrow("expired");
    expect(authority.issue(changed({ deadlineMs: 3_000 }))).toBeString();
  });
});
