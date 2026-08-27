import { describe, expect, test } from "bun:test";
import {
  EXECUTOR_PROTOCOL_VERSION,
  decodeExecutorGrant,
  encodeExecutorGrant,
  type ExecutorGrant,
} from "@tellahq/opensession-protocol/executor";
import type {
  Executor,
  ExecutorContext,
  ExecutorSuccess,
} from "../server/executors/contract";
import { RemoteExecutorConnection } from "../server/executors/remote";
import {
  RunnerExecutorAgent,
  type DuplexJsonTransport,
  type RunnerExecutorAgentOptions,
} from "./agent";
import {
  InMemoryCommandLedger,
  operationDigest,
  type DurableCommandLedger,
} from "./ledger";

class FakeEnd implements DuplexJsonTransport {
  peer?: FakeEnd;
  constructor(readonly macrotask = false) {}
  messages: unknown[] = [];
  #message = new Set<(message: unknown) => void | Promise<void>>();
  #close = new Set<(reason?: unknown) => void>();
  send(message: unknown): void {
    this.messages.push(structuredClone(message));
    const deliver = () => {
      if (!this.peer) return;
      for (const handler of this.peer.#message)
        void Promise.resolve(handler(structuredClone(message))).catch(() => {});
    };
    if (this.macrotask) setTimeout(deliver, 0);
    else queueMicrotask(deliver);
  }
  onMessage(handler: (message: unknown) => void | Promise<void>): () => void {
    this.#message.add(handler);
    return () => this.#message.delete(handler);
  }
  onClose(handler: (reason?: unknown) => void): () => void {
    this.#close.add(handler);
    return () => this.#close.delete(handler);
  }
  close(reason?: unknown): void {
    for (const handler of this.#close) handler(reason);
    if (this.peer) for (const handler of this.peer.#close) handler(reason);
  }
}
function pair(macrotask = false): [FakeEnd, FakeEnd] {
  const a = new FakeEnd(macrotask);
  const b = new FakeEnd(macrotask);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
const grant = encodeExecutorGrant("e".repeat(32));
const identity = {
  executorId: "executor-1",
  instanceId: "instance-1",
  generation: 2,
  capabilities: ["fs"] as const,
};
const context: ExecutorContext = {
  rootId: "root-1",
  sessionId: "session-1",
  runId: "run-1",
  generation: 2,
  requestId: "request-1",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class RecordingExecutor implements Executor {
  calls = 0;
  async execute(): Promise<ExecutorSuccess> {
    this.calls++;
    return {
      outcome: {
        kind: "fs.read",
        streamId: "stream-1",
        size: 5,
        binary: false,
      },
      events: [
        {
          kind: "text",
          streamId: "stream-1",
          sequence: 0,
          channel: "file",
          data: "hello",
          eof: true,
        },
      ],
    };
  }
}

describe("runner Executor agent", () => {
  test("handshakes, roundtrips reads, and enforces stream credit", async () => {
    const [control, daemon] = pair();
    const backend = new RecordingExecutor();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
      createId: () => "hello-1",
    });
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: control,
      grant,
      initialStreamCreditBytes: 5,
    });
    await agent.start();
    await remote.ready();
    const result = await remote.execute(context, {
      kind: "fs.read",
      path: "file.txt",
    });
    expect(result.events?.[0]).toMatchObject({ data: "hello", eof: true });
    expect(backend.calls).toBe(1);
    const eventIndex = daemon.messages.findIndex(
      (message: any) => message.t === "event",
    );
    const creditIndex = control.messages.findIndex(
      (message: any) => message.t === "stream_credit",
    );
    expect(creditIndex).toBeGreaterThan(-1);
    expect(eventIndex).toBeGreaterThan(-1);
  });

  test("waits for credit-gated macrotask event delivery before eventsComplete", async () => {
    const [control, daemon] = pair(true);
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: {
        execute: async () => ({
          outcome: {
            kind: "fs.read",
            streamId: "stream-1",
            size: 6,
            binary: false,
          },
          events: [
            {
              kind: "text",
              streamId: "stream-1",
              sequence: 0,
              channel: "file",
              data: "abc",
            },
            {
              kind: "text",
              streamId: "stream-1",
              sequence: 1,
              channel: "file",
              data: "def",
              eof: true,
            },
          ],
        }),
      },
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: control,
      grant,
      initialStreamCreditBytes: 1,
    });
    await agent.start();
    await remote.ready();
    await expect(
      remote.execute(context, { kind: "fs.read", path: "x" }),
    ).resolves.toMatchObject({
      events: [{ data: "abc" }, { data: "def" }],
    });
    const terminal = daemon.messages.findIndex(
      (message: any) =>
        message.t === "receipt_status" && message.eventsComplete,
    );
    const lastEvent = daemon.messages.findLastIndex(
      (message: any) => message.t === "event",
    );
    expect(lastEvent).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(lastEvent);
    const executeFrame = control.messages.find(
      (message: any) => message.t === "execute",
    ) as any;
    const credits = control.messages.filter(
      (message: any) => message.t === "stream_credit",
    ) as any[];
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.at(-1).fence.deadlineMs).toBe(executeFrame.fence.deadlineMs);
  });

  test("scopes same-named stream queues and credits by request", async () => {
    const [control, daemon] = pair();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: {
        execute: async (executionContext) => ({
          outcome: {
            kind: "fs.read",
            streamId: "shared-stream",
            size: 1,
            binary: false,
          },
          events: [
            {
              kind: "text",
              streamId: "shared-stream",
              sequence: 10,
              channel: "file",
              data: executionContext.requestId,
              eof: true,
            },
          ],
        }),
      },
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    const fence = {
      rootId: context.rootId,
      sessionId: context.sessionId,
      runId: context.runId,
      generation: context.generation,
      deadlineMs: Date.now() + 10_000,
    };
    for (const requestId of ["stream-request-a", "stream-request-b"])
      control.send({
        t: "execute",
        version: EXECUTOR_PROTOCOL_VERSION,
        requestId,
        grant,
        fence,
        operation: { kind: "fs.read", path: requestId },
      });
    await tick();
    await tick();
    control.send({
      t: "stream_credit",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "stream-request-a",
      grant,
      fence,
      streamId: "shared-stream",
      bytes: 100,
    });
    await tick();
    expect(
      daemon.messages.filter((message: any) => message.t === "event"),
    ).toEqual([
      expect.objectContaining({
        requestId: "stream-request-a",
        event: expect.objectContaining({ data: "stream-request-a" }),
      }),
    ]);
    control.send({
      t: "stream_credit",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "stream-request-b",
      grant,
      fence,
      streamId: "shared-stream",
      bytes: 100,
    });
    await tick();
    expect(
      daemon.messages.filter((message: any) => message.t === "event"),
    ).toHaveLength(2);
  });

  test("passes the complete exact target and operation scope to grant validation", async () => {
    const [control, daemon] = pair();
    const backend = new RecordingExecutor();
    let validated: unknown;
    const options: RunnerExecutorAgentOptions = {
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger: new InMemoryCommandLedger(),
      validateGrant: (_grant, expected) => {
        validated = expected;
        throw new Error("validator unavailable");
      },
    };
    const agent = new RunnerExecutorAgent(options);
    (options as { source: "runner" | "managed" }).source = "managed";
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: control,
      grant,
    });
    await agent.start();
    await remote.ready();
    await expect(
      remote.execute(context, { kind: "fs.read", path: "x" }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    expect(backend.calls).toBe(0);
    expect(validated).toMatchObject({
      source: "runner",
      executorId: identity.executorId,
      rootId: context.rootId,
      sessionId: context.sessionId,
      runId: context.runId,
      generation: context.generation,
      action: {
        purpose: "operation",
        requestId: context.requestId,
        operationDigest: operationDigest({ kind: "fs.read", path: "x" }),
      },
    });
  });

  test("rejects operations outside its advertised capability before execution", async () => {
    const [control, daemon] = pair();
    const backend = new RecordingExecutor();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "unsupported-operation",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: Date.now() + 10_000,
      },
      operation: {
        kind: "process.status",
        processId: "process-1",
      },
    });
    await tick();
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "error" &&
          message.requestId === "unsupported-operation" &&
          message.code === "unsupported",
      ),
    ).toBe(true);
    expect(backend.calls).toBe(0);
  });

  test("rechecks the deadline after asynchronous grant validation", async () => {
    const [control, daemon] = pair();
    const backend = new RecordingExecutor();
    let now = 1_000;
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger: new InMemoryCommandLedger(),
      now: () => now,
      validateGrant: async () => {
        now = 2_000;
        return true;
      },
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "expired-after-grant",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: 2_000,
      },
      operation: { kind: "fs.read", path: "x" },
    });
    await tick();
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "error" &&
          message.requestId === "expired-after-grant" &&
          message.code === "deadline_exceeded",
      ),
    ).toBe(true);
    expect(backend.calls).toBe(0);
  });

  test("rechecks the deadline after the durable claim", async () => {
    const [control, daemon] = pair();
    const backend = new RecordingExecutor();
    const base = new InMemoryCommandLedger();
    let now = 1_000;
    const ledger: DurableCommandLedger = {
      claim: async (...args) => {
        const claimed = await base.claim(...args);
        now = 2_000;
        return claimed;
      },
      transition: (...args) => base.transition(...args),
      get: (...args) => base.get(...args),
      recover: () => base.recover(),
      retireScope: (...args) => base.retireScope(...args),
      purgeRetiredScope: (...args) => base.purgeRetiredScope(...args),
    };
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger,
      now: () => now,
      validateGrant: () => true,
      createId: (() => {
        const ids = ["deadline-hello", "deadline-receipt"];
        return () => ids.shift()!;
      })(),
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "expired-after-claim",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: 2_000,
      },
      operation: { kind: "fs.read", path: "x" },
    });
    await tick();
    expect(backend.calls).toBe(0);
    expect(
      (
        await base.get(
          { executorId: identity.executorId, ...context },
          "deadline-receipt",
        )
      )?.receipt.state,
    ).toBe("failed");
  });

  test("deduplicates accepted mutations by stable idempotency key", async () => {
    const [control, daemon] = pair();
    const backend: Executor = {
      execute: async () => ({ outcome: { kind: "fs.changed", path: "x" } }),
    };
    let calls = 0;
    const counted: Executor = {
      execute: async (ctx, op) => {
        calls++;
        return backend.execute(ctx, op);
      },
    };
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: counted,
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: control,
      grant,
    });
    await agent.start();
    await remote.ready();
    await remote.execute(context, {
      kind: "fs.write",
      path: "x",
      data: "a",
      encoding: "utf8",
      idempotencyKey: "stable-1",
    });
    await remote.execute(
      { ...context, requestId: "request-2" },
      {
        kind: "fs.write",
        path: "x",
        data: "a",
        encoding: "utf8",
        idempotencyKey: "stable-1",
      },
    );
    expect(calls).toBe(1);
  });

  test("acknowledges executor terminal persistence only after ledger commit", async () => {
    const [control, daemon] = pair();
    const ledger = new InMemoryCommandLedger();
    let acknowledgedState: string | undefined;
    const backend: Executor = {
      execute: async () => ({
        outcome: {
          kind: "fs.read",
          streamId: "ack-stream",
          size: 0,
          binary: false,
        },
      }),
      acknowledgeDurableTerminal: async (
        executionContext,
        _operation,
        _outcome,
        receipt,
      ) => {
        acknowledgedState = (
          await ledger.get(
            { executorId: identity.executorId, ...executionContext },
            receipt.receiptId,
          )
        )?.receipt.state;
      },
    };
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: backend,
      ledger,
      validateGrant: () => true,
    });
    const remote = new RemoteExecutorConnection({
      ...identity,
      capabilities: [...identity.capabilities],
      transport: control,
      grant,
    });
    await agent.start();
    await remote.ready();
    await remote.execute(context, { kind: "fs.read", path: "x" });
    expect(acknowledgedState).toBe("succeeded");
  });

  test("does not acknowledge executor persistence when terminal ledger commit fails", async () => {
    const [control, daemon] = pair();
    const base = new InMemoryCommandLedger();
    let acknowledgements = 0;
    const ledger: DurableCommandLedger = {
      claim: (...args) => base.claim(...args),
      transition: async (...args) => {
        if (args[3].state === "succeeded")
          throw new Error("ledger unavailable");
        return base.transition(...args);
      },
      get: (...args) => base.get(...args),
      recover: () => base.recover(),
      retireScope: (...args) => base.retireScope(...args),
      purgeRetiredScope: (...args) => base.purgeRetiredScope(...args),
    };
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: {
        execute: async () => ({
          outcome: {
            kind: "fs.read",
            streamId: "failed-ack-stream",
            size: 0,
            binary: false,
          },
        }),
        acknowledgeDurableTerminal: () => {
          acknowledgements++;
        },
      },
      ledger,
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "failed-terminal-commit",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: Date.now() + 10_000,
      },
      operation: { kind: "fs.read", path: "x" },
    });
    await tick();
    await tick();
    expect(acknowledgements).toBe(0);
  });

  test("preserves committed success when sending the terminal status fails", async () => {
    const [control, daemon] = pair();
    const ledger = new InMemoryCommandLedger();
    const originalSend = daemon.send.bind(daemon);
    daemon.send = (message: unknown) => {
      originalSend(message);
      if (
        (message as any)?.t === "receipt_status" &&
        (message as any)?.receipt?.state === "succeeded"
      )
        throw new Error("transport failed after commit");
    };
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: {
        execute: async () => ({ outcome: { kind: "fs.changed", path: "x" } }),
      },
      ledger,
      validateGrant: () => true,
      createId: (() => {
        const ids = ["hello-send-failure", "receipt-send-failure"];
        return () => ids.shift()!;
      })(),
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "send-failure-request",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: Date.now() + 10_000,
      },
      operation: {
        kind: "fs.write",
        path: "x",
        data: "a",
        encoding: "utf8",
        idempotencyKey: "send-failure-key",
      },
    });
    await tick();
    await tick();
    expect(
      (
        await ledger.get(
          { executorId: identity.executorId, ...context },
          "receipt-send-failure",
        )
      )?.receipt.state,
    ).toBe("succeeded");
  });

  test("supports reconnect hello and receipt query without replay", async () => {
    const ledger = new InMemoryCommandLedger();
    const receipt = {
      receiptId: "receipt-1",
      requestId: "old-request",
      state: "succeeded" as const,
      acceptedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      idempotencyKey: "stable",
    };
    const operation = {
      kind: "fs.write" as const,
      path: "x",
      data: "a",
      encoding: "utf8" as const,
      idempotencyKey: "stable",
    };
    await ledger.claim(
      {
        executorId: identity.executorId,
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        requestId: "old-request",
        idempotencyKey: "stable",
        operation,
        operationDigest: operationDigest(operation),
      },
      { ...receipt, state: "queued", completedAt: undefined },
    );
    await ledger.transition(
      {
        executorId: identity.executorId,
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
      },
      receipt.receiptId,
      "queued",
      { state: "running" },
    );
    await ledger.transition(
      {
        executorId: identity.executorId,
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
      },
      receipt.receiptId,
      "running",
      {
        state: "succeeded",
        completedAt: receipt.completedAt,
        outcome: { kind: "fs.changed", path: "x" },
      },
    );
    const [control, daemon] = pair();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: {
        execute: async () => {
          throw new Error("must not replay");
        },
      },
      ledger,
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "receipt_status",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "query",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: Date.now() + 10_000,
      },
      receiptId: "receipt-1",
    });
    await tick();
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "receipt_status" &&
          message.receipt.receiptId === "receipt-1",
      ),
    ).toBe(true);
  });

  test("keeps cancellation advisory when physical execution later succeeds", async () => {
    const [control, daemon] = pair();
    let finish!: () => void;
    const execution = new Promise<ExecutorSuccess>((resolve) => {
      finish = () => resolve({ outcome: { kind: "fs.changed", path: "x" } });
    });
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: { execute: async () => execution },
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    const fence = {
      rootId: context.rootId,
      sessionId: context.sessionId,
      runId: context.runId,
      generation: context.generation,
      deadlineMs: Date.now() + 10_000,
    };
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "physical-operation",
      grant,
      fence,
      operation: {
        kind: "fs.write",
        path: "x",
        data: "a",
        encoding: "utf8",
        idempotencyKey: "physical-key",
      },
    });
    await tick();
    control.send({
      t: "cancel",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "cancel-advisory",
      grant,
      fence,
      target: { requestId: "physical-operation" },
      idempotencyKey: "cancel-key",
    });
    await tick();
    finish();
    await tick();
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "error" &&
          message.requestId === "cancel-advisory" &&
          message.code === "unsupported" &&
          message.message.includes("operation continues"),
      ),
    ).toBe(true);
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "receipt_status" &&
          message.requestId === "physical-operation" &&
          message.receipt.state === "succeeded",
      ),
    ).toBe(true);
  });

  test("records cancellation without replaying a mutation", async () => {
    const [control, daemon] = pair();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: new RecordingExecutor(),
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "cancel",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "cancel-1",
      grant,
      fence: {
        rootId: context.rootId,
        sessionId: context.sessionId,
        runId: context.runId,
        generation: context.generation,
        deadlineMs: Date.now() + 10_000,
      },
      target: { requestId: "mutation-1" },
      idempotencyKey: "cancel-stable-1",
    });
    await tick();
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "error" &&
          message.requestId === "cancel-1" &&
          message.code === "unsupported",
      ),
    ).toBe(true);
  });

  test("rejects stale, malformed, and forbidden frames", async () => {
    const [control, daemon] = pair();
    const agent = new RunnerExecutorAgent({
      source: "runner",
      ...identity,
      capabilities: [...identity.capabilities],
      rootId: "root-1",
      transport: daemon,
      executor: new RecordingExecutor(),
      ledger: new InMemoryCommandLedger(),
      validateGrant: () => true,
    });
    await agent.start();
    control.send({
      ...identity,
      capabilities: [...identity.capabilities],
      t: "hello",
      accepted: true,
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "accept",
    });
    await tick();
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "bad",
      grant,
      fence: {
        rootId: "root-1",
        sessionId: "session-1",
        runId: "run-1",
        generation: 1,
        deadlineMs: Date.now() + 10_000,
      },
      operation: { kind: "fs.read", path: "x", prompt: "forbidden" },
    });
    control.send({
      t: "execute",
      version: EXECUTOR_PROTOCOL_VERSION,
      requestId: "missing-key",
      grant,
      fence: {
        rootId: "root-1",
        sessionId: "session-1",
        runId: "run-1",
        generation: 1,
        deadlineMs: Date.now() + 10_000,
      },
      operation: {
        kind: "fs.write",
        path: "x",
        data: "x",
        encoding: "utf8",
      },
    });
    await tick();
    expect(
      daemon.messages.some(
        (message: any) => message.t === "error" && message.requestId === "bad",
      ),
    ).toBe(true);
    expect(
      daemon.messages.some(
        (message: any) =>
          message.t === "error" && message.requestId === "missing-key",
      ),
    ).toBe(true);
  });
});
