import { afterEach, describe, expect, test } from "bun:test";
import {
  SessionKernelActorClient,
  SessionKernelActorError,
  SessionKernelQuarantinedError,
  isFatalSessionKernelAsyncTimeout,
} from "./actor-client";
import { SESSION_KERNEL_ACTOR_VERSION } from "./actor-protocol";
import {
  __setSessionKernelStoreForTest,
  installSessionKernelActor,
  sessionDelivery,
  sessionIsQuarantined,
  sessionKernel,
  sessionProjectionOr,
} from "./kernel";

let client: SessionKernelActorClient | undefined;
afterEach(() => {
  installSessionKernelActor(undefined);
  __setSessionKernelStoreForTest(undefined);
  client?.terminate();
  client = undefined;
});

async function actor(): Promise<SessionKernelActorClient> {
  const worker = new Worker(
    new URL("../../session-kernel-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  client = new SessionKernelActorClient(worker);
  await client.hello();
  return client;
}

describe("session kernel actor boundary", () => {
	test("degrades optional projections only for retryable kernel failures", () => {
		expect(
			sessionProjectionOr(() => {
				throw new SessionKernelActorError("temporarily slow", true);
			}, "fallback"),
		).toBe("fallback");
		expect(() =>
			sessionProjectionOr(() => {
				throw new SessionKernelActorError("authority lost", false);
			}, "fallback")
		).toThrow("authority lost");
	});

  test("keeps polling timeouts retryable while fencing handshake ambiguity", () => {
    expect(isFatalSessionKernelAsyncTimeout({
      t: "runtime_work",
      rpcId: "runtime",
      now: 0,
      timerKinds: [],
      effectKinds: [],
      limit: 1,
    })).toBe(false);
    expect(isFatalSessionKernelAsyncTimeout({ t: "stats", rpcId: "stats" }))
      .toBe(false);
    expect(isFatalSessionKernelAsyncTimeout({ t: "maintain", rpcId: "maintain" }))
      .toBe(false);
    expect(isFatalSessionKernelAsyncTimeout({
      t: "hello",
      rpcId: "hello",
      version: SESSION_KERNEL_ACTOR_VERSION,
    })).toBe(true);
    expect(isFatalSessionKernelAsyncTimeout({
      t: "acknowledge",
      rpcId: "ack",
      sessionId: "session",
      requestId: "request",
    })).toBe(true);
  });

  test("reads per-session quarantine state through the actor", async () => {
    const host = await actor();
    installSessionKernelActor(host);

    expect(sessionIsQuarantined("quarantine-read")).toBe(false);
    host.store.quarantineSession("quarantine-read", "ambiguous", "test");
    expect(sessionIsQuarantined("quarantine-read")).toBe(true);
  });

  test("reconciles compatible branch dead letters inside the actor store", async () => {
    const host = await actor();
    const id = host.store.enqueueOutbox(
      "shared-session",
      "creation_branch_prepare",
      {
        creationIdentity: "creation-one",
        creationGeneration: 1,
        project: "opensession",
        branch: "feature",
        worktreePath: "/srv/opensession",
        isolated: false,
        mode: "adopt_or_create",
      },
      "shared-branch",
    );
    host.store.applyCreationEvent({
      sessionId: "shared-session",
      identity: "creation-one",
      event: "plan",
    });
    host.store.applyCreationEvent({
      sessionId: "shared-session",
      identity: "creation-one",
      event: "preparation_started",
      nextEffectId: "shared-branch",
      effect: {
        kind: "creation_branch_prepare",
        effectKey: "shared-branch",
        payload: {
          creationIdentity: "creation-one",
          creationGeneration: 1,
          project: "opensession",
          branch: "feature",
          worktreePath: "/srv/opensession",
          isolated: false,
          mode: "adopt_or_create",
        },
      },
    });
    host.store.noteOutboxFailure(
      id,
      "Worktree destination /srv/opensession exists without a registered branch",
      1,
    );

    expect(
      host.store.retryCompatibleCreationBranchDeadLetters([
        { project: "opensession", worktreePath: "/srv/opensession" },
      ]),
    ).toEqual([
      {
        id,
        sessionId: "shared-session",
        reason: "shared_checkout_destination_adoptable",
      },
    ]);
    expect(host.store.pendingOutbox(Date.now() + 1_000)).toHaveLength(1);
  });

  test("owns turn cancellation and its physical effect while gateway work is active", async () => {
    const host = await actor();
    host.decideRunEvent({ sessionId: "turn-cancel", event: "prompt" });
    host.decideRunEvent({
      sessionId: "turn-cancel",
      event: "run_registered",
      runKey: "run-one",
    });
    host.decideDelivery({
      op: "set",
      sessionId: "turn-cancel",
      slot: "steered",
      value: [{ id: "steer-one", content: "return me" }],
    });
    expect(host.decideTurn({
      op: "prepare_cancel",
      sessionId: "turn-cancel",
      cancelId: "cancel-one",
      expectedRunId: "run-one",
      expectedGeneration: 1,
      dispatchId: "run-one",
      requeueIds: ["steer-one"],
      source: "test",
    })).toMatchObject({
      cancel: { phase: "prepared", runId: "run-one" },
      runState: { state: "stopped" },
    });
    expect(host.store.runState("turn-cancel")).toMatchObject({
      state: "stopped",
    });
    expect(host.store.runState("turn-cancel").currentRunId).toBeUndefined();
    expect(host.store.pendingOutbox(Date.now(), 10, ["turn_cancel"])).toEqual([
      expect.objectContaining({ kind: "turn_cancel", effectKey: "cancel-one" }),
    ]);
  });

  test("owns cancel command retry identity before gateway continuation", async () => {
    const host = await actor();
    host.decideRunEvent({
      sessionId: "typed-cancel",
      event: "prompt",
      runKey: "run-one",
    });
    expect(host.decideTurn({
      op: "request_cancel_command",
      sessionId: "typed-cancel",
      requestId: "request-one",
      fallbackRunId: null,
    })).toEqual({
      status: "execute",
      targetRunId: "run-one",
      targetRunGeneration: 1,
    });
    expect(host.decideTurn({
      op: "request_cancel_command",
      sessionId: "typed-cancel",
      requestId: "request-one",
      fallbackRunId: "run-two",
    })).toMatchObject({ status: "execute", targetRunId: "run-one" });
  });

  test("owns submit-prompt command receipts through the delivery actor", async () => {
    const host = await actor();
    const input = {
      op: "request_submit_command" as const,
      sessionId: "typed-submit",
      requestId: "delivery-one",
      identity: { content: "hello", attachmentsHash: "none" },
    };
    expect(host.decideDelivery(input)).toEqual({ status: "execute" });
    const result = {
      status: "queued",
      message: "Queued behind the current run.",
      deliveryId: input.requestId,
    };
    expect(host.decideDelivery({
      op: "complete_submit_command",
      sessionId: input.sessionId,
      requestId: input.requestId,
      result,
    })).toEqual(result);
    expect(host.decideDelivery(input)).toEqual({
      status: "completed",
      result,
      duplicate: true,
    });
  });

  test("owns timer execution receipts through the actor protocol", async () => {
    const host = await actor();
    host.store.scheduleTimer({
      sessionId: "typed-timer",
      timerId: "wake",
      kind: "test_timer",
      dueAt: Date.now() - 1,
      payload: { value: 1 },
    });
    const timer = host.store.timer("typed-timer", "wake")!;
    expect(host.decideTimer({
      op: "begin",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    })).toBe("execute");
    expect(host.decideTimer({
      op: "complete",
      sessionId: timer.sessionId,
      timerId: timer.timerId,
      token: timer.token,
    })).toBe(true);
    expect(host.store.timer(timer.sessionId, timer.timerId)).toBeUndefined();
  });

  test("owns terminal outcome projection and settlement while gateway work is active", async () => {
    const host = await actor();
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "prompt",
      runKey: "run-one",
    });
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "run_registered",
      runKey: "run-one",
    });
    host.decideRunEvent({
      sessionId: "turn-outcome",
      event: "run_failed",
      runKey: "run-one",
    });
    expect(
      host.decideTurn({
        op: "prepare_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runId: "run-one",
        runGeneration: 1,
        errorMessage: "failed",
        noticePersisted: false,
        projectedAt: "2026-08-24T18:00:00.000Z",
      }),
    ).toMatchObject({ phase: "pending", runGeneration: 1 });
    expect(
      host.store.pendingOutbox(Date.now(), 10, ["turn_outcome_project"]),
    ).toEqual([
      expect.objectContaining({
        kind: "turn_outcome_project",
        effectKey: "outcome:run-one",
      }),
    ]);
    expect(
      host.decideTurn({
        op: "begin_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe("execute");
    expect(
      host.decideTurn({
        op: "settle_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe(true);
    expect(
      host.decideTurn({
        op: "begin_outcome_projection",
        sessionId: "turn-outcome",
        projectionId: "outcome:run-one",
        runGeneration: 1,
      }),
    ).toBe("completed");
  });

  test("reduces creation events atomically", async () => {
    const host = await actor();
    expect(host.decideCreationEvent({
      sessionId: "creating",
      identity: "create-request",
      event: "plan",
    })).toMatchObject({ accepted: true, to: "planned" });
    expect(host.decideCreationEvent({
      sessionId: "creating",
      identity: "create-request",
      event: "preparation_started",
      nextEffectId: "prepare-effect",
      effect: {
        kind: "creation_workspace_prepare",
        effectKey: "prepare-effect",
        payload: {
          creationIdentity: "create-request",
          creationGeneration: 1,
          workspaceId: "workspace-one",
          dedupeKey: "creation:workspace-one",
          name: "Workspace one",
          createdBy: "Alice",
          mode: "adopt_or_create",
        },
      },
    })).toMatchObject({
      accepted: true,
      to: "preparing",
      state: { currentEffectId: "prepare-effect" },
    });
    expect(host.store.creationState("creating")).toMatchObject({
      state: "preparing",
      identity: "create-request",
    });
  });

  test("resizes creation decisions and snapshots for bounded opening plans", async () => {
    const host = await actor();
    const sessionId = "large-opening-plan";
    const identity = "large-opening-request";
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "plan",
    }).accepted).toBe(true);
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "preparation_started",
    }).accepted).toBe(true);
    const openingPrompt = "x".repeat(300 * 1024);
    const effectId = "opening:large-opening-entry";
    expect(host.decideCreationEvent({
      sessionId,
      identity,
      event: "opening_dispatched",
      openingPlan: {
        id: sessionId,
        openingPrompt,
        openingPromptEntryId: "large-opening-entry",
      },
      nextEffectId: effectId,
      effect: {
        kind: "creation_opening_turn",
        effectKey: effectId,
        payload: {
          creationIdentity: identity,
          creationGeneration: 1,
          openingPromptEntryId: "large-opening-entry",
          runId: `opening:${sessionId}:large-opening-entry`,
          runGeneration: 1,
          mode: "adopt_or_launch",
        },
      },
    })).toMatchObject({
      accepted: true,
      state: { openingPlan: { openingPrompt } },
    });
    expect(host.store.creationState(sessionId)?.openingPlan).toMatchObject({
      openingPrompt,
    });
  });

  test("hydrates persisted run state into the gateway projection", async () => {
    const host = await actor();
    host.callStore("setRunState", [
      {
      sessionId: "persisted",
      state: "running",
      event: "run_registered",
      generation: 4,
      currentRunId: "run-4",
      },
    ]);
    await host.hello();
    expect(host.store.runState("persisted")).toMatchObject({
      state: "running",
      generation: 4,
      currentRunId: "run-4",
    });
  });

  test("isolates an unresponsive session behind its own sync breaker", () => {
    class SelectivelyRespondingWorker {
      listeners = new Map<string, (event: never) => void>();
      postCount = 0;
      addEventListener(type: string, listener: (event: never) => void) {
        this.listeners.set(type, listener);
      }
      removeEventListener() {}
      postMessage(message: {
        t: string;
        command?: { request?: { sessionId?: string } };
        args?: unknown[];
        control: SharedArrayBuffer;
        output: SharedArrayBuffer;
      }) {
        this.postCount += 1;
        const sessionId = message.t === "reduce"
          ? message.command?.request?.sessionId
          : message.args?.[0];
        if (sessionId === "slow-actor") return;
        const response = new TextEncoder().encode(JSON.stringify({ ok: true }));
        new Uint8Array(message.output, 0, response.length).set(response);
        const control = new Int32Array(message.control);
        Atomics.store(control, 1, response.length);
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
      }
      terminate() {}
    }
    const worker = new SelectivelyRespondingWorker();
    const onFatal: Array<Error> = [];
    const previousTimeout = process.env.OPENSESSION_SYNC_KERNEL_TIMEOUT_MS;
    process.env.OPENSESSION_SYNC_KERNEL_TIMEOUT_MS = "50";
    try {
      const host = new SessionKernelActorClient(
        worker as unknown as Worker,
        (error) => onFatal.push(error),
      );
      client = host;

      const first = (() => {
        try {
          host.decideGateway({
            op: "request",
            sessionId: "slow-actor",
            requestId: "one",
            operation: "websocket_command",
          });
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(first).toBeInstanceOf(SessionKernelActorError);
      expect((first as SessionKernelActorError).retryable).toBe(true);
      expect(worker.postCount).toBe(1);

      // One event-loop-blocking timeout opens the breaker. The refused call
      // must never add more work to the already degraded actor lane.
      const startedAt = Date.now();
      expect(() =>
        host.decideGateway({
          op: "request",
          sessionId: "slow-actor",
          requestId: "two",
          operation: "websocket_command",
        }),
      ).toThrow("breaker");
      expect(Date.now() - startedAt).toBeLessThan(40);
      expect(worker.postCount).toBe(1);

      // The kernel service has independent session lanes. A timeout in one
      // lane must not refuse work for an unrelated healthy session.
      expect(host.store.creationState("healthy-session")).toBeUndefined();
      expect(worker.postCount).toBe(2);

      // A slow actor is degradation, not a lost authority: the client stays
      // alive and no fatal handler fired.
      expect(onFatal).toEqual([]);
    } finally {
      if (previousTimeout === undefined)
        delete process.env.OPENSESSION_SYNC_KERNEL_TIMEOUT_MS;
      else process.env.OPENSESSION_SYNC_KERNEL_TIMEOUT_MS = previousTimeout;
    }
  });

  test("fails new requests immediately after the actor stops", async () => {
    const host = await actor();
    host.terminate();
    client = undefined;
    expect(() => host.decideGateway({
      op: "request",
      sessionId: "s1",
      requestId: "after-stop",
      operation: "websocket_command",
    })).toThrow("actor stopped");
  });

  test("quarantines one session after ambiguous typed settlement", async () => {
    const host = await actor();
    host.decideGateway({
      op: "request",
      sessionId: "ambiguous-settlement",
      requestId: "one",
      operation: "websocket_command",
    });
    host.callStore("failCommand", [
      "ambiguous-settlement",
      "one",
      "receipt changed",
      false,
    ]);
    let settlementError: unknown;
    try {
      host.decideGateway({
        op: "complete",
        sessionId: "ambiguous-settlement",
        requestId: "one",
        operation: "websocket_command",
        result: "done",
      });
    } catch (error) {
      settlementError = error;
    }
    expect(settlementError).toBeInstanceOf(SessionKernelQuarantinedError);
    expect(host.store.quarantinedSession("ambiguous-settlement")).toMatchObject({
      reason: "receipt changed",
      commandKind: "gateway:complete",
    });

    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "ambiguous-settlement",
    })).toMatchObject({ revision: 0, queued: [] });
    expect(() => host.decideDelivery({
      op: "set",
      sessionId: "ambiguous-settlement",
      slot: "queued",
      value: [],
    })).toThrow(SessionKernelQuarantinedError);

    expect(host.decideDelivery({
      op: "set",
      sessionId: "other-session",
      slot: "queued",
      value: [{ id: "still-live" }],
    })).toBeUndefined();
    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "other-session",
    })).toMatchObject({ queued: [{ id: "still-live" }] });
  });

  test("returns a terminal failure instead of re-executing it", async () => {
    const host = await actor();
    const input = {
      op: "request" as const,
      sessionId: "sticky",
      requestId: "same",
      operation: "websocket_command" as const,
      identity: { n: 1 },
    };
    expect(host.decideGateway(input)).toEqual({ status: "execute" });
    host.decideGateway({
      op: "fail",
      sessionId: input.sessionId,
      requestId: input.requestId,
      operation: input.operation,
      error: "not allowed",
      retryable: false,
    });
    expect(() => host.decideGateway(input)).toThrow("not allowed");
  });

  test("admits gateway and delivery commands without blocking the gateway thread", async () => {
    const messageListeners: Array<(event: MessageEvent) => void> = [];
    const worker = {
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        if (type === "message") messageListeners.push(listener);
      },
      postMessage(request: {
        t: string;
        rpcId?: string;
        command?: { kind?: string; request?: { op?: string } };
      }) {
        const result = request.command?.request?.op === "request" ||
          request.command?.request?.op === "request_submit_command"
          ? { status: "execute" }
          : { status: "completed" };
        setTimeout(() => {
          const body = JSON.stringify({
            ok: true,
            result: request.command?.kind === "delivery"
              ? { result, revision: 1 }
              : result,
          });
          for (const listener of messageListeners)
            listener({
              data: {
                t: "call_result",
                rpcId: request.rpcId,
                status: 1,
                length: body.length,
                body,
              },
            } as MessageEvent);
        }, 0);
      },
      terminate() {},
    };
    const host = new SessionKernelActorClient(worker as unknown as Worker);
    client = host;
    const input = {
      op: "request" as const,
      sessionId: "async-gateway",
      requestId: "one",
      operation: "session_file_updated" as const,
    };
    let timerFired = false;
    const admission = host.decideGatewayAsync(input);
    setTimeout(() => {
      timerFired = true;
    }, 0);

    expect(await admission).toEqual({ status: "execute" });
    await Bun.sleep(0);
    expect(timerFired).toBe(true);
    expect(await host.decideGatewayAsync({
      op: "complete",
      sessionId: input.sessionId,
      requestId: input.requestId,
      operation: input.operation,
      result: null,
    })).toEqual({ status: "completed" });
    expect(await host.decideDeliveryAsync({
      op: "request_submit_command",
      sessionId: "async-delivery",
      requestId: "one",
      identity: { prompt: "hello" },
    })).toEqual({ status: "execute" });
  });

  test("acknowledges replay results through async IPC", async () => {
    const host = await actor();
    host.decideGateway({
      op: "request",
      sessionId: "ack",
      requestId: "one",
      operation: "websocket_command",
    });
    host.decideGateway({
      op: "complete",
      sessionId: "ack",
      requestId: "one",
      operation: "websocket_command",
      result: { item: "kept" },
    });
    await host.acknowledgeCommand("ack", "one");
    expect(host.store.command("ack", "one")?.acknowledgedAt).toBeNumber();
  });

  test("does not dispatch runtime work for a quarantined session", async () => {
    const host = await actor();
    host.store.scheduleTimer({
      sessionId: "quarantined-work",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: null,
    });
    host.store.enqueueOutbox("quarantined-work", "known_effect", null, "known");
    host.store.quarantineSession("quarantined-work", "settlement failed", "timer:complete");

    const work = await host.runtimeWork(["known_timer"], ["known_effect"]);
    expect(work).toEqual({ timers: [], outbox: [] });
    expect(host.store.stats().quarantinedSessions).toBe(1);
    expect(host.store.deadLetters().quarantines).toHaveLength(1);

    expect(host.store.releaseQuarantine("quarantined-work")).toBe(true);
    const released = await host.runtimeWork(["known_timer"], ["known_effect"]);
    expect(released.timers).toHaveLength(1);
    expect(released.outbox).toHaveLength(1);
  });

  test("loads registered runtime work through async IPC", async () => {
    const host = await actor();
    host.callStore("scheduleTimer", [
      {
      sessionId: "known",
      timerId: "wake",
      kind: "known_timer",
      dueAt: Date.now() - 1,
      payload: null,
      },
    ]);
    host.callStore("scheduleTimer", [
      {
      sessionId: "future",
      timerId: "wake",
      kind: "future_timer",
      dueAt: Date.now() - 1,
      payload: null,
      },
    ]);
    host.callStore("enqueueOutbox", ["known", "known_effect", null, "known"]);
    host.callStore("enqueueOutbox", [
      "future",
      "future_effect",
      null,
      "future",
    ]);
    const work = await host.runtimeWork(["known_timer"], ["known_effect"]);
    expect(work.timers.map((timer) => timer.kind)).toEqual(["known_timer"]);
    expect(work.outbox.map((item) => item.kind)).toEqual(["known_effect"]);
  });

  test("returns a committed result after an uncertain reply", async () => {
    const host = await actor();
    const input = {
      op: "request" as const,
      sessionId: "s1",
      requestId: "same",
      operation: "websocket_command" as const,
      identity: { n: 1 },
    };
    expect(host.decideGateway(input)).toEqual({ status: "execute" });
    host.decideGateway({
      op: "complete",
      sessionId: input.sessionId,
      requestId: input.requestId,
      operation: input.operation,
      result: { accepted: true },
    });
    expect(host.decideGateway(input)).toEqual({
      status: "completed",
      result: { accepted: true },
      duplicate: true,
    });
  });

  test("resizes read-only delivery snapshots beyond the initial buffer", async () => {
    const host = await actor();
    const content = "x".repeat(9 * 1024 * 1024);
    host.decideDelivery({
      op: "set",
      sessionId: "large-delivery",
      slot: "queued",
      value: [{ id: "large", content }],
    });
    const snapshot = host.decideDelivery({
      op: "snapshot",
      sessionId: "large-delivery",
    });
    expect((snapshot.queued as Array<{ content: string }>)[0]?.content.length).toBe(
      content.length,
    );
  });

  test("delivery mutations invalidate projections without fetching a snapshot", async () => {
    const host = await actor();
    const original = host.decideDeliveryAsync.bind(host);
    let snapshotCalls = 0;
    host.decideDeliveryAsync = (async (request) => {
      if (request.op === "snapshot") snapshotCalls += 1;
      return original(request);
    }) as typeof host.decideDeliveryAsync;
    installSessionKernelActor(host);

    await sessionDelivery({
      op: "set",
      sessionId: "small-mutation-reply",
      slot: "queued",
      value: [{ id: "queued", content: "hello" }],
    });
    expect(snapshotCalls).toBe(0);
    expect(
      (await sessionDelivery({ op: "snapshot", sessionId: "small-mutation-reply" }))
        .revision,
    ).toBe(1);
    expect(snapshotCalls).toBe(1);
  });

  test("selects and claims a queue batch through the actor protocol", async () => {
    const host = await actor();
    host.decideDelivery({
      op: "set",
      sessionId: "actor-next-dispatch",
      slot: "queued",
      value: [
        { id: "held", content: "later", hold: true },
        { id: "solo", promptEntryId: "stable-entry", content: "now", hold: true },
      ],
    });
    host.decideDelivery({
      op: "prepare_interrupt",
      sessionId: "actor-next-dispatch",
      interruptId: "interrupt-one",
      anchorId: "solo",
      dispatchId: "run-owner",
      soloId: "solo",
    });
    host.decideDelivery({
      op: "settle_interrupt",
      sessionId: "actor-next-dispatch",
      interruptId: "interrupt-one",
      outcome: "confirmed",
    });
    expect(host.decideDelivery({
      op: "claim_next_dispatch",
      sessionId: "actor-next-dispatch",
      promptEntryId: "candidate-entry",
      stillWorking: true,
    })).toMatchObject({
      kind: "deliver",
      promptEntryId: "stable-entry",
      items: [{ id: "solo", promptEntryId: "stable-entry" }],
      interrupted: true,
    });
    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "actor-next-dispatch",
    })).toMatchObject({
      queued: [{ id: "held" }],
      dispatch: { promptEntryId: "stable-entry" },
    });
  });

  test("keeps reducers responsive while physical gateway work is blocked", async () => {
    const host = await actor();
    const first = {
      op: "request" as const,
      sessionId: "responsive",
      requestId: "first-effect",
      operation: "websocket_command" as const,
    };
    expect(host.decideGateway(first)).toEqual({ status: "execute" });
    let release!: () => void;
    const physical = new Promise<void>((resolve) => { release = resolve; });

    // A second command and unrelated reducers are decided immediately. The actor
    // never waits for the first command's physical continuation.
    expect(host.decideGateway({
      ...first,
      requestId: "second-effect",
    })).toEqual({ status: "execute" });
    host.decideDelivery({
      op: "set",
      sessionId: "responsive",
      slot: "queued",
      value: [{ id: "q1", content: "still responsive" }],
    });
    host.decideAsk({
      op: "set",
      sessionId: "responsive",
      value: { questionId: "ask-1", questions: [] },
    });
    expect(host.decideDelivery({
      op: "snapshot",
      sessionId: "responsive",
    }).queued).toHaveLength(1);
    expect(host.decideAsk({
      op: "snapshot",
      sessionId: "responsive",
    })).toMatchObject({ questionId: "ask-1" });

    release();
    await physical;
    host.decideGateway({
      op: "complete",
      sessionId: first.sessionId,
      requestId: first.requestId,
      operation: first.operation,
      result: "first",
    });
  });

});
