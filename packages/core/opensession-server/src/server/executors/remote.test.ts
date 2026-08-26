import { describe, expect, test } from "bun:test";
import {
  EXECUTOR_PROTOCOL_VERSION,
  decodeExecutorGrant,
  encodeExecutorGrant,
  type ExecutorGrant,
} from "@tellahq/opensession-protocol/executor";
import type { DuplexJsonTransport } from "../../runner-executor/agent";
import type { ExecutorFailure } from "./contract";
import {
  RemoteExecutorConnection,
  type RemoteExecutorConnectionOptions,
} from "./remote";
import {
  RemoteExecutorRegistrationError,
  RemoteExecutorRegistry,
} from "./remote-registry";

class ManualTransport implements DuplexJsonTransport {
  sent: any[] = [];
  closeReasons: string[] = [];
  sendError?: Error;
  message?: (message: unknown) => void | Promise<void>;
  closed?: (reason?: unknown) => void;
  send(message: unknown): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(message);
  }
  onMessage(handler: (message: unknown) => void | Promise<void>): () => void {
    this.message = handler;
    return () => {
      this.message = undefined;
    };
  }
  onClose(handler: (reason?: unknown) => void): () => void {
    this.closed = handler;
    return () => {
      this.closed = undefined;
    };
  }
  receive(message: unknown): void {
    void this.message?.(message);
  }
  drop(reason?: unknown): void {
    this.closed?.(reason);
  }
  close(reason?: string): void {
    this.closeReasons.push(reason ?? "");
  }
}
const identity = {
  executorId: "executor-1",
  instanceId: "instance-1",
  generation: 3,
  capabilities: ["fs"] as const,
};
const grant = encodeExecutorGrant("e".repeat(32));
const context = {
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 3,
  requestId: "request-1",
};
const hello = {
  ...identity,
  capabilities: [...identity.capabilities],
  t: "hello",
  version: EXECUTOR_PROTOCOL_VERSION,
  requestId: "hello-1",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const successWithStream = (eventsComplete: boolean) => ({
  t: "receipt_status",
  version: EXECUTOR_PROTOCOL_VERSION,
  requestId: context.requestId,
  receipt: {
    receiptId: "stream-receipt",
    requestId: context.requestId,
    state: "succeeded",
    acceptedAt: "2026-08-22T12:00:00.000Z",
    completedAt: "2026-08-22T12:00:01.000Z",
  },
  outcome: { kind: "fs.read", streamId: "stream-1", size: 2, binary: false },
  eventsComplete,
});
const streamEvent = (sequence: number, data: string) => ({
  t: "event",
  version: EXECUTOR_PROTOCOL_VERSION,
  requestId: context.requestId,
  event: {
    kind: "text",
    streamId: "stream-1",
    sequence,
    channel: "file",
    data,
  },
});
const unknownReceipt = (requestId: string) => ({
  t: "receipt",
  version: EXECUTOR_PROTOCOL_VERSION,
  requestId,
  receipt: {
    receiptId: `receipt-${requestId}`,
    requestId,
    state: "queued",
    acceptedAt: "2026-08-22T12:00:00.000Z",
  },
});

describe("remote Executor connection", () => {
  test("fences exact incarnation and bounds pending requests", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
      maxPending: 1,
    });
    transport.receive(hello);
    await remote.ready();
    expect(transport.sent[0]).toMatchObject({
      t: "hello",
      accepted: true,
      generation: 3,
    });
    const first = remote.execute(context, { kind: "fs.stat", path: "x" });
    await expect(
      remote.execute(
        { ...context, requestId: "request-2" },
        { kind: "fs.read", path: "y" },
      ),
    ).rejects.toMatchObject({ code: "executor_busy" });
    transport.receive({
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "request-1",
      receipt: {
        receiptId: "r",
        requestId: "request-1",
        state: "succeeded",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        completedAt: "2026-08-22T12:00:01.000Z",
      },
      outcome: { kind: "fs.stat", entry: { path: "x", type: "file", size: 1 } },
    });
    await expect(first).resolves.toMatchObject({
      outcome: { kind: "fs.stat" },
    });
    await expect(
      remote.execute(
        { ...context, generation: 2 },
        { kind: "fs.read", path: "x" },
      ),
    ).rejects.toMatchObject({ code: "stale_generation" });
  });

  test("distinguishes disconnect before and after mutation acceptance", async () => {
    const beforeTransport = new ManualTransport();
    const before = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: beforeTransport,
      grant,
    });
    beforeTransport.receive(hello);
    await before.ready();
    const beforeResult = before.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "k1",
    });
    beforeTransport.drop();
    await expect(beforeResult).rejects.toMatchObject({ ambiguous: false });

    const afterTransport = new ManualTransport();
    const after = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: afterTransport,
      grant,
    });
    afterTransport.receive(hello);
    await after.ready();
    const afterResult = after.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "k2",
    });
    await tick();
    afterTransport.receive({
      t: "receipt",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "request-1",
      receipt: {
        receiptId: "r",
        requestId: "request-1",
        state: "queued",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        idempotencyKey: "k2",
      },
    });
    afterTransport.drop();
    await expect(afterResult).rejects.toMatchObject({ ambiguous: true });
  });

  test("times out stalled accepted mutations as ambiguous and clears pending", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
      deadlineMs: () => Date.now() + 10,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "timeout-key",
    });
    await tick();
    transport.receive({
      t: "receipt",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      receipt: {
        receiptId: "timeout-receipt",
        requestId: context.requestId,
        state: "queued",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        idempotencyKey: "timeout-key",
      },
    });
    await expect(result).rejects.toMatchObject({
      code: "deadline_exceeded",
      ambiguous: true,
    });
    expect(remote.pendingCount).toBe(0);
  });

  test("rejects terminal failed receipt status instead of hanging", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, { kind: "fs.read", path: "x" });
    await tick();
    transport.receive({
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      receipt: {
        receiptId: "failed-receipt",
        requestId: context.requestId,
        state: "failed",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        completedAt: "2026-08-22T12:00:01.000Z",
      },
      error: { code: "operation_failed", message: "recovered uncertainty" },
      eventsComplete: true,
    });
    await expect(result).rejects.toMatchObject({
      code: "operation_failed",
      ambiguous: false,
    });
    expect(remote.pendingCount).toBe(0);
  });

  test("disconnects on hostile malformed receipt payloads", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, { kind: "fs.read", path: "x" });
    await tick();
    transport.receive({
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      receipt: {
        receiptId: "bad-receipt",
        requestId: context.requestId,
        state: "succeeded",
        acceptedAt: "not-a-date",
      },
      outcome: { kind: "fs.read", streamId: {}, size: -1, binary: false },
    });
    await expect(result).rejects.toMatchObject({ code: "operation_failed" });
    expect(remote.connected).toBe(false);
  });

  test("times out physical readiness when hello never arrives", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
      helloTimeoutMs: 5,
    });
    await expect(remote.ready()).rejects.toThrow("hello timed out");
    expect(remote.connected).toBe(false);
  });

  test("treats a matching top-level error receipt as accepted mutation ambiguity", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "error-key",
    });
    await tick();
    transport.receive({
      t: "error",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      code: "deadline_exceeded",
      message: "expired after claim",
      receipt: {
        receiptId: "error-receipt",
        requestId: context.requestId,
        state: "failed",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        completedAt: "2026-08-22T12:00:01.000Z",
        idempotencyKey: "error-key",
      },
    });
    await expect(result).rejects.toMatchObject({
      code: "deadline_exceeded",
      ambiguous: true,
    });
  });

  test("disconnects when an error receipt changes accepted identity", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "identity-key",
    });
    await tick();
    transport.receive({
      t: "receipt",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      receipt: {
        receiptId: "original-receipt",
        requestId: context.requestId,
        state: "queued",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        idempotencyKey: "identity-key",
      },
    });
    transport.receive({
      t: "error",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      code: "operation_failed",
      message: "mismatched",
      receipt: {
        receiptId: "different-receipt",
        requestId: context.requestId,
        state: "failed",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        completedAt: "2026-08-22T12:00:01.000Z",
        idempotencyKey: "identity-key",
      },
    });
    await expect(result).rejects.toMatchObject({
      code: "operation_failed",
      ambiguous: true,
    });
    expect(remote.connected).toBe(false);
  });

  test("disconnects on a wrong-target same-family outcome", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, {
      kind: "fs.move",
      from: "from",
      to: "to",
      idempotencyKey: "move-key",
    });
    await tick();
    transport.receive({
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      receipt: {
        receiptId: "incompatible-receipt",
        requestId: context.requestId,
        state: "succeeded",
        acceptedAt: "2026-08-22T12:00:00.000Z",
        completedAt: "2026-08-22T12:00:01.000Z",
        idempotencyKey: "move-key",
      },
      outcome: { kind: "fs.changed", path: "from" },
    });
    await expect(result).rejects.toMatchObject({ code: "operation_failed" });
    expect(remote.connected).toBe(false);
  });

  test("sends scoped stream cleanup with fresh grants on repeated timeouts", async () => {
    const transport = new ManualTransport();
    let cleanupGrants = 0;
    const cleanupInputs: Array<
      Parameters<
        NonNullable<RemoteExecutorConnectionOptions["cleanupGrant"]>
      >[0]
    > = [];
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
      deadlineMs: () => Date.now() + 8,
      cleanupGrant: (input) => {
        cleanupInputs.push(input);
        cleanupGrants++;
        return encodeExecutorGrant(`cleanup-${cleanupGrants}`.padEnd(32, "x"));
      },
    });
    transport.receive(hello);
    await remote.ready();
    for (let index = 0; index < 2; index++) {
      const requestId = `cleanup-request-${index}`;
      const result = remote.execute(
        { ...context, requestId },
        { kind: "fs.read", path: "x" },
      );
      await tick();
      transport.receive({
        t: "receipt_status",
        version: EXECUTOR_PROTOCOL_VERSION,
        requestId,
        receipt: {
          receiptId: `cleanup-receipt-${index}`,
          requestId,
          state: "succeeded",
          acceptedAt: "2026-08-22T12:00:00.000Z",
          completedAt: "2026-08-22T12:00:01.000Z",
        },
        outcome: {
          kind: "fs.read",
          streamId: "shared-stream",
          size: 10,
          binary: false,
        },
      });
      await expect(result).rejects.toMatchObject({ code: "deadline_exceeded" });
    }
    const cleanups = transport.sent.filter((message) => message.t === "cancel");
    expect(cleanups).toHaveLength(2);
    expect(cleanups.map((message) => message.grant as string)).toEqual([
      encodeExecutorGrant("cleanup-1".padEnd(32, "x")),
      encodeExecutorGrant("cleanup-2".padEnd(32, "x")),
    ]);
    expect(cleanupInputs).toHaveLength(2);
    for (const [index, input] of cleanupInputs.entries()) {
      expect(input).toMatchObject({
        context: { requestId: `cleanup-request-${index}` },
        requestId: cleanups[index]?.requestId,
        targetRequestId: `cleanup-request-${index}`,
        streamId: "shared-stream",
        deadlineMs: cleanups[index]?.fence.deadlineMs,
      });
    }
    expect(cleanups.map((message) => message.target.requestId)).toEqual([
      "cleanup-request-0",
      "cleanup-request-1",
    ]);
    expect(remote.pendingCount).toBe(0);
  });

  test("rejects repeated hello after readiness", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    transport.receive(hello);
    await tick();
    expect(remote.connected).toBe(false);
    expect(transport.closeReasons).toContain("remote executor disconnected");
  });

  test("fences pre-outcome events, retained floods, credit overruns, and unknown request floods", async () => {
    const make = (options: Record<string, number> = {}) => {
      const transport = new ManualTransport();
      const remote = new RemoteExecutorConnection({
        ...identity,
        ...options,
        capabilities: [...identity.capabilities],
        transport,
        grant,
      });
      transport.receive(hello);
      return { transport, remote };
    };
    const before = make();
    await before.remote.ready();
    const beforeResult = before.remote.execute(context, {
      kind: "fs.read",
      path: "x",
    });
    void beforeResult.catch(() => {});
    await tick();
    expect(before.remote.pendingCount).toBe(1);
    before.transport.receive({
      t: "event",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: context.requestId,
      event: {
        kind: "text",
        streamId: "stream-1",
        sequence: 0,
        channel: "file",
        data: "x",
      },
    });
    await tick();
    expect(before.remote.connected).toBe(false);
    expect(before.remote.pendingCount).toBe(0);

    const retained = make({ maxRetainedEvents: 1 });
    await retained.remote.ready();
    const retainedResult = retained.remote.execute(context, {
      kind: "fs.read",
      path: "x",
    });
    void retainedResult.catch(() => {});
    await tick();
    retained.transport.receive(successWithStream(false));
    await tick();
    retained.transport.receive(streamEvent(0, ""));
    retained.transport.receive(streamEvent(1, ""));
    await tick();
    expect(retained.remote.connected).toBe(false);

    const credit = make({ maxRetainedEventBytes: 64 });
    await credit.remote.ready();
    const creditResult = credit.remote.execute(context, {
      kind: "fs.read",
      path: "x",
    });
    void creditResult.catch(() => {});
    await tick();
    credit.transport.receive(successWithStream(false));
    await tick();
    credit.transport.receive(streamEvent(0, "x"));
    await tick();
    expect(credit.remote.connected).toBe(false);

    const unknown = make({ maxUnknownMessages: 1 });
    await unknown.remote.ready();
    unknown.transport.receive(unknownReceipt("unknown-1"));
    unknown.transport.receive(unknownReceipt("unknown-2"));
    await tick();
    expect(unknown.remote.connected).toBe(false);
  });

  test("bounds disconnect cleanup and fences a late fresh-grant result", async () => {
    const transport = new ManualTransport();
    let release!: (grant: ExecutorGrant) => void;
    const cleanupGrant = new Promise<ExecutorGrant>((resolve) => {
      release = resolve;
    });
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
      cleanupGrant: () => cleanupGrant,
      cleanupTimeoutMs: 5,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, { kind: "fs.read", path: "x" });
    void result.catch(() => {});
    await tick();
    transport.receive(successWithStream(false));
    await tick();
    remote.disconnect("replaced");
    expect(remote.pendingCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transport.closeReasons).toContain("remote executor disconnected");
    release(grant);
    await tick();
    expect(
      transport.sent.filter((message) => message.t === "cancel"),
    ).toHaveLength(0);
  });

  test("poisons the incarnation when required cleanup rejects, send fails, or times out", async () => {
    const exercise = async (
      cleanupGrant: () => ExecutorGrant | Promise<ExecutorGrant>,
      failSend = false,
    ) => {
      const transport = new ManualTransport();
      const remote = new RemoteExecutorConnection({
        ...identity,
        capabilities: [...identity.capabilities],
        transport,
        grant,
        cleanupGrant,
        cleanupTimeoutMs: 5,
        deadlineMs: () => Date.now() + 8,
      });
      transport.receive(hello);
      await remote.ready();
      let failure: ExecutorFailure | undefined;
      const settled = remote
        .execute(context, { kind: "fs.read", path: "x" })
        .catch((error: ExecutorFailure) => {
          failure = error;
        });
      await tick();
      transport.receive(successWithStream(false));
      await tick();
      if (failSend) transport.sendError = new Error("send failed");
      await settled;
      expect(failure).toMatchObject({ ambiguous: false });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(remote.connected).toBe(false);
      expect(transport.closeReasons).toEqual(["remote executor disconnected"]);
    };

    await exercise(() => Promise.reject(new Error("grant failed")));
    await exercise(() => grant, true);
    await exercise(() => new Promise<ExecutorGrant>(() => {}));
  });

  test("treats read disconnects as retryable uncertainty", async () => {
    const transport = new ManualTransport();
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport,
      grant,
    });
    transport.receive(hello);
    await remote.ready();
    const result = remote.execute(context, { kind: "fs.read", path: "x" });
    transport.receive({
      t: "receipt",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "request-1",
      receipt: {
        receiptId: "r",
        requestId: "request-1",
        state: "queued",
        acceptedAt: "2026-08-22T12:00:00.000Z",
      },
    });
    transport.drop();
    await expect(result).rejects.toMatchObject({ ambiguous: false });
  });
});

describe("remote Executor registry", () => {
  test("rejects duplicates, reconnects exact incarnations, and fences generations", () => {
    const registry = new RemoteExecutorRegistry();
    const first = registry.register({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: new ManualTransport(),
      grant,
      cleanupGrant: () => grant,
    });
    expect(() =>
      registry.register({
        ...identity,
        capabilities: [...identity.capabilities],
        instanceId: "instance-2",
        transport: new ManualTransport(),
        grant,
        cleanupGrant: () => grant,
      }),
    ).toThrow(RemoteExecutorRegistrationError);
    registry.disconnect(identity.executorId);
    const reconnect = registry.register({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: new ManualTransport(),
      grant,
      cleanupGrant: () => grant,
    });
    expect(registry.unregisterConnection(first)).toBe(false);
    expect(() =>
      registry.register({
        ...identity,
        capabilities: [...identity.capabilities],
        generation: 2,
        instanceId: "old",
        transport: new ManualTransport(),
        grant,
        cleanupGrant: () => grant,
      }),
    ).toThrowError(/stale/);
    const next = registry.register({
      ...identity,
      capabilities: [...identity.capabilities],
      generation: 4,
      instanceId: "next",
      transport: new ManualTransport(),
      grant,
      cleanupGrant: () => grant,
    });
    expect(reconnect.connected).toBe(false);
    expect(registry.unregisterConnection(reconnect)).toBe(false);
    expect(registry.unregister(identity.executorId, "next", 4)).toBe(true);
    expect(next.connected).toBe(false);
  });
});
