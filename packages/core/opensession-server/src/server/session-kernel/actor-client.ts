import type { SessionActorReducerCommand } from "./lifecycle-protocol";
import type {
  AgentHostPlanRegistration,
  AgentHostPlanRegistrationResult,
  AgentHostSupervisionRequest,
  AgentHostSupervisionResult,
} from "./agent-host-supervision-protocol";
import {
  SessionKernelStore,
  type CreationEventDecision,
  type CreationEventDecisionResult,
  type DurableCommandRecord,
  type DurableCreationState,
  type DurableDeliveryState,
  type DurableSessionQuarantine,
  type DurableOutboxItem,
  type DeliverySlot,
  type DurableRunState,
  type DurableSteerTarget,
  type DurableTimer,
  type RunEventDecision,
  type RunEventDecisionResult,
  type SessionKernelStoreApi,
} from "./store";
import type {
  DeliveryActorRequest,
  DeliveryActorResult,
  DeliveryMutationReply,
} from "./delivery-protocol";
import type { AskActorRequest, AskActorResult } from "./ask-protocol";
import type { AgentOperationRequest, AgentOperationResult } from "./agent-operation-protocol";
import type { TurnActorRequest, TurnActorResult } from "./turn-protocol";
import type { TimerActorRequest, TimerActorResult } from "./timer-protocol";
import type { GatewayCommandRequest, GatewayCommandResult } from "./gateway-command-protocol";
import type { CoreActorRequest, CoreActorResult } from "./core-protocol";
import {
  SESSION_KERNEL_ACTOR_VERSION,
  type KernelActorClientRequest,
  type KernelActorClientResponse,
} from "./actor-protocol";
import { sessionActorReducerRoute } from "./actor-routing";
import { sessionKernelStoreRoute } from "./store-routing";

const SMALL_OUTPUT_BYTES = 256 * 1024;
const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DYNAMIC_OUTPUT_BYTES = 128 * 1024 * 1024;
const LARGE_STORE_RESPONSES = new Set([
  "askEntries",
  "askSnapshot",
  "changesSince",
  "creationState",
  "deliveryEntries",
  "deliverySnapshot",
  "pendingOutbox",
  "dueTimers",
  "runStates",
  "turnSnapshot",
]);

export class SessionKernelActorError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SessionKernelActorError";
  }
}

export class SessionKernelQuarantinedError extends SessionKernelActorError {
  constructor(
    readonly sessionId: string,
    message: string,
  ) {
    super(message, false);
    this.name = "SessionKernelQuarantinedError";
  }
}

export function isFatalSessionKernelAsyncTimeout(
  request: KernelActorClientRequest,
): boolean {
  return request.t === "hello" || request.t === "acknowledge";
}

// The synchronous bridge blocks the gateway event loop while it waits. A slow
// actor must therefore surface as fast failures, not stacked multi-second
// waits: every concurrent UI request otherwise serializes behind each one and
// can starve process timers past the watchdog threshold.
const SYNC_CALL_TIMEOUT_MS_FLOOR = 25;

function syncCallTimeoutMs(): number {
  return Math.max(
    SYNC_CALL_TIMEOUT_MS_FLOOR,
    Number(process.env.OPENSESSION_SYNC_KERNEL_TIMEOUT_MS ?? 500),
  );
}
const SYNC_BREAKER_AFTER_TIMEOUTS = 1;
const SYNC_BREAKER_OPEN_MS = 10_000;

type Pending = {
  resolve: (value: KernelActorClientResponse) => void;
  reject: (error: Error) => void;
};

type SyncRequest =
  | { t: "store"; method: string; args: unknown[] }
  | { t: "reduce"; command: SessionActorReducerCommand };

type SyncBreaker = {
  consecutiveTimeouts: number;
  openUntil: number;
};

function syncBreakerScope(request: SyncRequest): string {
  const route = request.t === "reduce"
    ? sessionActorReducerRoute(request.command)
    : sessionKernelStoreRoute(request.method, request.args);
  if (route.scope === "session") return `session:${route.sessionId}`;
  if (route.scope === "outbox") return `outbox:${route.id}`;
  return "global";
}

export class SessionKernelActorClient {
  private readonly pending = new Map<string, Pending>();
  private readonly syncBreakers = new Map<string, SyncBreaker>();
  private deadError?: Error;
  // Synchronous calls cannot overlap on the gateway thread: Atomics.wait
  // blocks until the actor finishes. Reuse their shared response buffers
  // instead of allocating and faulting 256 KiB for every map read. Session
  // list enrichment alone performs hundreds of small reads.
  private syncControlBuffer = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * 2,
  );
  private syncSmallOutputBuffer = new SharedArrayBuffer(
    SMALL_OUTPUT_BYTES,
  );
  private syncLargeOutputBuffer?: SharedArrayBuffer;
  readonly store: SessionKernelStoreApi;

  constructor(
    private readonly worker: Worker,
    private readonly onFatal?: (error: Error) => void,
  ) {
    worker.addEventListener("message", (event: MessageEvent) => {
      const response = event.data as KernelActorClientResponse;
      const pending = this.pending.get(response.rpcId);
      if (!pending) return;
      this.pending.delete(response.rpcId);
      if (response.t === "error")
        pending.reject(
          new SessionKernelActorError(response.error, response.retryable),
        );
      else pending.resolve(response);
    });
    worker.addEventListener("error", (event) => {
      this.markDead(new Error(`Session kernel actor failed: ${event.message}`));
    });
    worker.addEventListener("messageerror", () => {
      this.markDead(new Error("Session kernel actor sent an invalid message"));
    });
    (
      worker as Worker & {
        addEventListener(type: "close", listener: () => void): void;
      }
    ).addEventListener("close", () => {
        this.markDead(new Error("Session kernel actor exited"));
      });
    this.store = new RemoteStore(this);
  }

  async hello(): Promise<void> {
    const response = await this.request({
      t: "hello",
      rpcId: crypto.randomUUID(),
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    if (
      response.t !== "ready" ||
      response.version !== SESSION_KERNEL_ACTOR_VERSION
    )
      throw new Error("Session kernel actor handshake failed");
    (this.store as RemoteStore).openReadMirror();
    (this.store as RemoteStore).hydrateRunStates();
  }

  async acknowledgeCommand(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const response = await this.request({
      t: "acknowledge",
      rpcId: crypto.randomUUID(),
      sessionId,
      requestId,
    });
    if (response.t !== "acknowledge_result")
      throw new Error("Invalid kernel acknowledgement response");
  }

  quarantinedSession(sessionId: string): DurableSessionQuarantine | undefined {
    return this.store.quarantinedSession(sessionId);
  }

  async statsAsync(): Promise<ReturnType<SessionKernelStoreApi["stats"]>> {
    const response = await this.request({
      t: "stats",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "stats_result")
      throw new Error("Invalid kernel stats response");
    return response.stats;
  }

  async maintainAsync(): Promise<boolean> {
    const response = await this.request({
      t: "maintain",
      rpcId: crypto.randomUUID(),
    });
    if (response.t !== "maintain_result")
      throw new Error("Invalid kernel maintenance response");
    return response.pending;
  }

  async runtimeWork(
    timerKinds: string[],
    effectKinds: string[],
    now = Date.now(),
    limit = 100,
  ): Promise<{ timers: DurableTimer[]; outbox: DurableOutboxItem[] }> {
    const response = await this.request({
      t: "runtime_work",
      rpcId: crypto.randomUUID(),
      now,
      timerKinds,
      effectKinds,
      limit,
    });
    if (response.t !== "runtime_work_result")
      throw new Error("Invalid kernel runtime work response");
    return { timers: response.timers, outbox: response.outbox };
  }

  decideAsk<T extends AskActorRequest>(request: T): AskActorResult<T> {
    if (request.op === "snapshot")
      return (this.store as RemoteStore).askSnapshot(request.sessionId) as AskActorResult<T>;
    if (request.op === "entries")
      return (this.store as RemoteStore).askEntries() as AskActorResult<T>;
    return this.callSync<AskActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "ask", commandId: crypto.randomUUID(), request },
      },
      `ask ${request.op}`,
    );
  }

  decideTurn<T extends TurnActorRequest>(request: T): TurnActorResult<T> {
    if (request.op === "snapshot")
      return (this.store as RemoteStore).turnSnapshot(request.sessionId) as TurnActorResult<T>;
    const result = this.callSync<TurnActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "turn", commandId: crypto.randomUUID(), request },
      },
      `turn ${request.op}`,
    );
    if (request.op === "prepare_cancel") {
      const prepared = result as TurnActorResult<
        Extract<TurnActorRequest, { op: "prepare_cancel" }>
      >;
      (this.store as RemoteStore).noteRunState(request.sessionId, prepared.runState);
    } else if (
      request.op === "prepare_outcome_projection" ||
      request.op === "settle_outcome_projection"
    ) {
      (this.store as RemoteStore).noteChange(request.sessionId);
    }
    return result;
  }

  decideTimer<T extends TimerActorRequest>(request: T): TimerActorResult<T> {
    return this.callSync<TimerActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "timer", commandId: crypto.randomUUID(), request },
      },
      `timer ${request.op}`,
    );
  }

  decideCore<T extends CoreActorRequest>(request: T): CoreActorResult<T> {
    return this.callSync<CoreActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "core", commandId: crypto.randomUUID(), request },
      },
      `core ${request.op}`,
    );
  }

  decideGateway<T extends GatewayCommandRequest>(
    request: T,
  ): GatewayCommandResult<T> {
    return this.callSync<GatewayCommandResult<T>>(
      {
        t: "reduce",
        command: { kind: "gateway", commandId: crypto.randomUUID(), request },
      },
      `gateway ${request.operation} ${request.op}`,
    );
  }

  decideGatewayAsync<T extends GatewayCommandRequest>(
    request: T,
  ): Promise<GatewayCommandResult<T>> {
    return this.callAsync<GatewayCommandResult<T>>(
      {
        t: "reduce",
        command: { kind: "gateway", commandId: crypto.randomUUID(), request },
      },
      `gateway ${request.operation} ${request.op}`,
    );
  }

  decideDelivery<T extends DeliveryActorRequest>(
    request: T,
  ): DeliveryActorResult<T> {
    if (request.op === "snapshot")
      return (this.store as RemoteStore).deliverySnapshot(request.sessionId) as DeliveryActorResult<T>;
    if (request.op === "entries")
      return (this.store as RemoteStore).deliveryEntries(request.slot) as DeliveryActorResult<T>;
    const response = this.callSync<
      DeliveryActorResult<T> | DeliveryMutationReply<DeliveryActorResult<T>>
    >(
      {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: crypto.randomUUID(),
          request,
        },
      },
      `delivery ${request.op}`,
    );
    return (response as DeliveryMutationReply<DeliveryActorResult<T>>).result;
  }

  decideAgentOperation(request: AgentOperationRequest): AgentOperationResult {
    return this.callSync<AgentOperationResult>(
      { t: "reduce", command: { kind: "agent_operation", commandId: request.identity.operationId, request } },
      `Agent operation ${request.op}`,
    );
  }

  decideAgentHostSupervision<T extends AgentHostSupervisionRequest>(
    request: T,
  ): T extends AgentHostPlanRegistration
    ? AgentHostPlanRegistrationResult
    : AgentHostSupervisionResult {
    return this.callSync<
      AgentHostPlanRegistrationResult | AgentHostSupervisionResult
    >(
      {
        t: "reduce",
        command: {
          kind: "agent_host_supervision",
          commandId:
            request.op === "register_plan"
              ? request.registrationId
              : request.claimId,
          request,
        },
      },
      "Agent Host supervision claim",
    ) as T extends AgentHostPlanRegistration
      ? AgentHostPlanRegistrationResult
      : AgentHostSupervisionResult;
  }

  decideCreationEvent(
    decision: CreationEventDecision,
  ): CreationEventDecisionResult {
    return this.callSync<CreationEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "creation_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "creation event decision",
      true,
    );
  }

  decideRunEvent(decision: RunEventDecision): RunEventDecisionResult {
    const result = this.callSync<RunEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "run event decision",
    );
    if (result.accepted)
      (this.store as RemoteStore).noteRunState(
        decision.sessionId,
        result.state,
      );
    return result;
  }

  /**
   * Awaited store/reduce RPC over the posted-message transport. Unlike
   * callSync this never blocks the gateway event loop; callers await.
   */
  callAsync<TResult>(
    request:
      | { t: "store"; method: string; args: unknown[] }
      | { t: "reduce"; command: SessionActorReducerCommand },
    label: string,
    large = false,
  ): Promise<TResult> {
    if (this.deadError) return Promise.reject(this.deadError);
    const rpcId = crypto.randomUUID();
    return new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(
          new SessionKernelActorError(
            `Session kernel actor timed out handling ${label}`,
            true,
          ),
        );
      }, 15_000);
      const parse = (value: unknown): TResult => {
        const response = value as {
          status: number;
          body?: string;
          length?: number;
        };
        if (!response.body)
          throw new SessionKernelActorError(
            `Session kernel ${label} returned no result`,
            true,
          );
        const body = JSON.parse(response.body) as {
          ok: boolean;
          result?: TResult;
          error?: string;
          code?: string;
          sessionId?: string;
        };
        if (!body.ok) {
          const message = body.error || `Session kernel ${label} failed`;
          if (body.code === "session_quarantined" && body.sessionId)
            throw new SessionKernelQuarantinedError(body.sessionId, message);
          const error = new SessionKernelActorError(message, false);
          if (body.code === "actor_fatal") this.markDead(error);
          throw error;
        }
        return body.result as TResult;
      };
      this.pending.set(rpcId, {
        resolve: (value) => {
          clearTimeout(timeout);
          try {
            resolve(parse(value));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.worker.postMessage({ ...request, rpcId });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(rpcId);
        const failure = error instanceof Error ? error : new Error(String(error));
        this.markDead(failure);
        reject(failure);
      }
    });
  }

  async decideAskAsync<T extends AskActorRequest>(
    request: T,
  ): Promise<AskActorResult<T>> {
    return this.callAsync<AskActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "ask", commandId: crypto.randomUUID(), request },
      },
      `ask ${request.op}`,
    );
  }

  async decideTurnAsync<T extends TurnActorRequest>(
    request: T,
  ): Promise<TurnActorResult<T>> {
    const result = await this.callAsync<TurnActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "turn", commandId: crypto.randomUUID(), request },
      },
      `turn ${request.op}`,
    );
    if (request.op === "prepare_cancel")
      (this.store as RemoteStore).noteRunState(
        request.sessionId,
        (
          result as TurnActorResult<
            Extract<TurnActorRequest, { op: "prepare_cancel" }>
          >
        ).runState,
      );
    else if (
      request.op === "prepare_outcome_projection" ||
      request.op === "settle_outcome_projection"
    )
      (this.store as RemoteStore).noteChange(request.sessionId);
    return result;
  }

  decideTimerAsync<T extends TimerActorRequest>(
    request: T,
  ): Promise<TimerActorResult<T>> {
    return this.callAsync<TimerActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "timer", commandId: crypto.randomUUID(), request },
      },
      `timer ${request.op}`,
    );
  }

  decideCoreAsync<T extends CoreActorRequest>(
    request: T,
  ): Promise<CoreActorResult<T>> {
    return this.callAsync<CoreActorResult<T>>(
      {
        t: "reduce",
        command: { kind: "core", commandId: crypto.randomUUID(), request },
      },
      `core ${request.op}`,
    );
  }

  async decideDeliveryAsync<T extends DeliveryActorRequest>(
    request: T,
  ): Promise<DeliveryActorResult<T>> {
    const response = await this.callAsync<
      DeliveryActorResult<T> | DeliveryMutationReply<DeliveryActorResult<T>>
    >(
      {
        t: "reduce",
        command: {
          kind: "delivery",
          commandId: crypto.randomUUID(),
          request,
        },
      },
      `delivery ${request.op}`,
    );
    if (request.op === "snapshot" || request.op === "entries")
      return response as DeliveryActorResult<T>;
    return (response as DeliveryMutationReply<DeliveryActorResult<T>>).result;
  }

  async decideAgentHostSupervisionAsync<T extends AgentHostSupervisionRequest>(
    request: T,
  ): Promise<T extends AgentHostPlanRegistration
    ? AgentHostPlanRegistrationResult
    : AgentHostSupervisionResult> {
    return this.callAsync<
      AgentHostPlanRegistrationResult | AgentHostSupervisionResult
    >(
      {
        t: "reduce",
        command: {
          kind: "agent_host_supervision",
          commandId:
            request.op === "register_plan"
              ? request.registrationId
              : request.claimId,
          request,
        },
      },
      "Agent Host supervision claim",
    ) as Promise<T extends AgentHostPlanRegistration
      ? AgentHostPlanRegistrationResult
      : AgentHostSupervisionResult>;
  }

  async decideCreationEventAsync(
    decision: CreationEventDecision,
  ): Promise<CreationEventDecisionResult> {
    return this.callAsync<CreationEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "creation_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "creation event decision",
      true,
    );
  }

  async decideRunEventAsync(
    decision: RunEventDecision,
  ): Promise<RunEventDecisionResult> {
    const result = await this.callAsync<RunEventDecisionResult>(
      {
        t: "reduce",
        command: {
          kind: "run_event",
          commandId: crypto.randomUUID(),
          decision,
        },
      },
      "run event decision",
    );
    if (result.accepted)
      (this.store as RemoteStore).noteRunState(decision.sessionId, result.state);
    return result;
  }

  callStore<TResult>(method: string, args: unknown[]): TResult {
    return this.callSync<TResult>(
      { t: "store", method, args },
      method,
      LARGE_STORE_RESPONSES.has(method),
    );
  }

  private callSync<TResult>(
    request: SyncRequest,
    label: string,
    large = false,
    outputBytes = large ? LARGE_OUTPUT_BYTES : SMALL_OUTPUT_BYTES,
  ): TResult {
    if (this.deadError) throw this.deadError;
    const breakerScope = syncBreakerScope(request);
    const breaker = this.syncBreakers.get(breakerScope);
    if (breaker && breaker.openUntil > Date.now()) {
      throw new SessionKernelActorError(
        "Session kernel actor is unresponsive; sync call refused by breaker",
        true,
      );
    }
    if (breaker) this.syncBreakers.delete(breakerScope);
    const controlBuffer = this.syncControlBuffer;
    const outputBuffer =
      outputBytes === SMALL_OUTPUT_BYTES
        ? this.syncSmallOutputBuffer
        : outputBytes === LARGE_OUTPUT_BYTES
          ? (this.syncLargeOutputBuffer ??= new SharedArrayBuffer(
              LARGE_OUTPUT_BYTES,
            ))
          : new SharedArrayBuffer(outputBytes);
    const control = new Int32Array(controlBuffer);
    Atomics.store(control, 0, 0);
    Atomics.store(control, 1, 0);
    this.worker.postMessage({
      ...request,
      control: controlBuffer,
      output: outputBuffer,
    });
    const waited = Atomics.wait(control, 0, 0, syncCallTimeoutMs());
    if (waited === "timed-out") {
      // A slow actor is a retryable degradation, not a lost authority: the
      // actor service fail-stops itself on real ambiguity, and the worker
      // error/close listeners still mark the client dead on true failures.
      // Killing the client here would turn every slowdown into a gateway
      // restart. Abandon these handshake buffers so a late reply settles into
      // an orphan instead of being misattributed to the next call.
      this.syncControlBuffer = new SharedArrayBuffer(
        Int32Array.BYTES_PER_ELEMENT * 2,
      );
      if (outputBytes === SMALL_OUTPUT_BYTES)
        this.syncSmallOutputBuffer = new SharedArrayBuffer(SMALL_OUTPUT_BYTES);
      else if (outputBytes === LARGE_OUTPUT_BYTES)
        this.syncLargeOutputBuffer = undefined;
      const consecutiveTimeouts = (breaker?.consecutiveTimeouts ?? 0) + 1;
      this.syncBreakers.set(breakerScope, {
        consecutiveTimeouts,
        openUntil: consecutiveTimeouts >= SYNC_BREAKER_AFTER_TIMEOUTS
          ? Date.now() + SYNC_BREAKER_OPEN_MS
          : 0,
      });
      throw new SessionKernelActorError(
        `Session kernel actor timed out in ${label}`,
        true,
      );
    }
    this.syncBreakers.delete(breakerScope);
    const status = Atomics.load(control, 0);
    const length = Atomics.load(control, 1);
    if (status === 2) {
      if (!large || length <= outputBytes || length > MAX_DYNAMIC_OUTPUT_BYTES) {
        const error = new Error(
          `Session kernel ${label} response requires ${length} bytes`,
        );
        this.markDead(error);
        throw error;
      }
      return this.callSync(request, label, large, length);
    }
    const text = new TextDecoder().decode(
      new Uint8Array(outputBuffer, 0, length),
    );
    const response = JSON.parse(text) as {
      ok: boolean;
      result?: TResult;
      error?: string;
      code?: string;
      sessionId?: string;
    };
    if (!response.ok) {
      const message = response.error || `Session kernel ${label} failed`;
      if (response.code === "session_quarantined" && response.sessionId)
        throw new SessionKernelQuarantinedError(response.sessionId, message);
      const error = new Error(message);
      if (response.code === "actor_fatal") this.markDead(error);
      throw error;
    }
    return response.result as TResult;
  }

  terminate(): void {
    this.store.close();
    this.markDead(new Error("Session kernel actor stopped"), false);
    this.worker.terminate();
  }

  private request(
    request: KernelActorClientRequest,
  ): Promise<KernelActorClientResponse> {
    if (this.deadError) return Promise.reject(this.deadError);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.rpcId);
        const message = `Session kernel actor timed out handling ${request.t}`;
        if (isFatalSessionKernelAsyncTimeout(request)) {
          const error = new Error(message);
          this.markDead(error);
          reject(error);
          return;
        }
        reject(new SessionKernelActorError(message, true));
      }, 15_000);
      this.pending.set(request.rpcId, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        this.worker.postMessage(request);
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.pending.delete(request.rpcId);
        const failure =
          error instanceof Error ? error : new Error(String(error));
        this.markDead(failure);
        reject(failure);
      }
    });
  }

  private markDead(error: Error, fatal = true): void {
    if (this.deadError) return;
    this.deadError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (fatal) this.onFatal?.(error);
  }
}

class RemoteStore implements SessionKernelStoreApi {
  private readonly runStateCache = new Map<string, DurableRunState>();
  private readStore?: SessionKernelStore;
  private statsCache?: {
    at: number;
    value: ReturnType<SessionKernelStoreApi["stats"]>;
  };
  constructor(private readonly actor: SessionKernelActorClient) {}
  openReadMirror(): void {
    // Reads are routed by the actor host once sessions can live in distinct
    // databases. Opening only the legacy central WAL here would return stale
    // defaults for isolated sessions and silently violate single authority.
  }
  hydrateRunStates(): void {
    this.runStateCache.clear();
    const states = this.readStore?.runStates() ?? this.call<
      Array<DurableRunState & { sessionId: string }>
    >("runStates");
    for (const state of states) this.runStateCache.set(state.sessionId, state);
  }
  noteRunState(sessionId: string, state: DurableRunState): void {
    this.runStateCache.set(sessionId, state);
  }
  noteChange(sessionId: string): void {
    const current = this.runStateCache.get(sessionId) ?? {
      state: "idle",
      since: new Date().toISOString(),
      generation: 0,
      changeSeq: 0,
    };
    this.runStateCache.set(sessionId, {
      ...current,
      changeSeq: current.changeSeq + 1,
    });
  }
  private call<T>(method: string, ...args: unknown[]): T {
    return this.actor.callStore<T>(method, args);
  }
  close(): void {
    this.readStore?.close();
    this.readStore = undefined;
  }
  command(sessionId: string, requestId: string) {
    return this.readStore
      ? this.readStore.command(sessionId, requestId)
      : this.call<DurableCommandRecord | undefined>(
          "command",
          sessionId,
          requestId,
        );
  }
  quarantinedSession(sessionId: string) {
    return this.readStore
      ? this.readStore.quarantinedSession(sessionId)
      : this.call<DurableSessionQuarantine | undefined>("quarantinedSession", sessionId);
  }
  quarantinedSessions(limit?: number, offset?: number) {
    return this.readStore
      ? this.readStore.quarantinedSessions(limit, offset)
      : this.call<DurableSessionQuarantine[]>("quarantinedSessions", limit, offset);
  }
  quarantineSession(sessionId: string, reason: string, commandKind: string) {
    return this.call<DurableSessionQuarantine>("quarantineSession", sessionId, reason, commandKind);
  }
  releaseQuarantine(sessionId: string) {
    return this.call<boolean>("releaseQuarantine", sessionId);
  }
  decideAgentOperation(request: AgentOperationRequest): AgentOperationResult {
    return this.actor.decideAgentOperation(request);
  }
  acceptCommand(input: {
    sessionId: string;
    requestId: string;
    type: string;
    payload?: unknown;
  }) {
    return this.call<DurableCommandRecord>("acceptCommand", input);
  }
  markProcessing(sessionId: string, requestId: string) {
    this.call("markProcessing", sessionId, requestId);
  }
  completeCommand(sessionId: string, requestId: string, result: unknown) {
    this.call("completeCommand", sessionId, requestId, result);
  }
  completeCommandDecision(
    input: Parameters<SessionKernelStoreApi["completeCommandDecision"]>[0],
  ) {
    this.call("completeCommandDecision", input);
    this.noteChange(input.sessionId);
  }
  failCommand(
    sessionId: string,
    requestId: string,
    error: string,
    retryable = false,
  ) {
    this.call("failCommand", sessionId, requestId, error, retryable);
  }
  creationState(sessionId: string): DurableCreationState | undefined {
    return this.readStore
      ? this.readStore.creationState(sessionId)
      : this.call<DurableCreationState | undefined>("creationState", sessionId);
  }
  registerAgentHostPlan(
    input: Parameters<SessionKernelStoreApi["registerAgentHostPlan"]>[0],
  ) {
    return this.actor.decideAgentHostSupervision(input);
  }
  claimAgentHostSupervision(
    input: Parameters<SessionKernelStoreApi["claimAgentHostSupervision"]>[0],
  ) {
    return this.actor.decideAgentHostSupervision(input);
  }
  applyCreationEvent(input: CreationEventDecision) {
    return this.actor.decideCreationEvent(input);
  }
  runState(sessionId: string) {
    return (
      this.runStateCache.get(sessionId) ?? {
      state: "idle",
      since: new Date(0).toISOString(),
      generation: 0,
      changeSeq: 0,
      }
    );
  }
  runStates() {
    return [...this.runStateCache].map(([sessionId, state]) => ({
      sessionId,
      ...state,
    }));
  }
  appendChange(sessionId: string, kind: string, payload?: unknown) {
    const seq = this.call<number>("appendChange", sessionId, kind, payload);
    const current = this.runState(sessionId);
    this.runStateCache.set(sessionId, { ...current, changeSeq: seq });
    return seq;
  }
  changesSince(sessionId: string, after: number, limit?: number) {
    return this.readStore
      ? this.readStore.changesSince(sessionId, after, limit)
      : this.call<ReturnType<SessionKernelStoreApi["changesSince"]>>(
          "changesSince",
          sessionId,
          after,
          limit,
        );
  }
  applyRunEvent(input: RunEventDecision) {
    return this.actor.decideRunEvent(input);
  }
  setRunState(input: Parameters<SessionKernelStoreApi["setRunState"]>[0]) {
    const next = this.call<DurableRunState>("setRunState", input);
    this.runStateCache.set(input.sessionId, next);
    return next;
  }
  isTombstoned(sessionId: string, now?: number) {
    return this.readStore
      ? this.readStore.isTombstoned(sessionId, now)
      : this.call<boolean>("isTombstoned", sessionId, now);
  }
  tombstoneSession(sessionId: string) {
    this.call("tombstoneSession", sessionId);
    this.runStateCache.delete(sessionId);
  }
  clearSession(sessionId: string) {
    this.call("clearSession", sessionId);
    this.runStateCache.delete(sessionId);
  }
  askMigrationComplete() {
    return this.readStore
      ? this.readStore.askMigrationComplete()
      : this.call<boolean>("askMigrationComplete");
  }
  markAskMigrationComplete() {
    this.call("markAskMigrationComplete");
  }
  askSnapshot(sessionId: string) {
    return this.readStore
      ? this.readStore.askSnapshot(sessionId)
      : this.call<ReturnType<SessionKernelStoreApi["askSnapshot"]>>("askSnapshot", sessionId);
  }
  askEntries() {
    return this.readStore
      ? this.readStore.askEntries()
      : this.call<ReturnType<SessionKernelStoreApi["askEntries"]>>("askEntries");
  }
  setAskRecord(sessionId: string, value: unknown) {
    this.actor.decideAsk({ op: "set", sessionId, value });
  }
  answerAskRecord(
    sessionId: string,
    questionId: string | null,
    answers: Record<string, string> | null,
    answeredVia: string,
  ) {
    return this.actor.decideAsk({
      op: "answer",
      sessionId,
      questionId,
      answers,
      answeredVia,
    });
  }
  deleteAskRecord(sessionId: string) {
    return this.actor.decideAsk({ op: "delete", sessionId });
  }
  clearAskRecords() {
    this.actor.decideAsk({ op: "clear" });
  }
  deliveryMigrationComplete() {
    return this.readStore
      ? this.readStore.deliveryMigrationComplete()
      : this.call<boolean>("deliveryMigrationComplete");
  }
  markDeliveryMigrationComplete() {
    this.call("markDeliveryMigrationComplete");
  }
  turnSnapshot(sessionId: string) {
    return this.readStore
      ? this.readStore.turnSnapshot(sessionId)
      : this.call<ReturnType<SessionKernelStoreApi["turnSnapshot"]>>("turnSnapshot", sessionId);
  }
  requestTurnCancelCommand(
    input: Parameters<SessionKernelStoreApi["requestTurnCancelCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["requestTurnCancelCommand"]> {
    return this.actor.decideTurn({
      op: "request_cancel_command",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["requestTurnCancelCommand"]>;
  }
  completeTurnCancelCommand(
    input: Parameters<SessionKernelStoreApi["completeTurnCancelCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["completeTurnCancelCommand"]> {
    return this.actor.decideTurn({
      op: "complete_cancel_command",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["completeTurnCancelCommand"]>;
  }
  failTurnCancelCommand(
    input: Parameters<SessionKernelStoreApi["failTurnCancelCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["failTurnCancelCommand"]> {
    return this.actor.decideTurn({
      op: "fail_cancel_command",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["failTurnCancelCommand"]>;
  }
  prepareTurnCancel(
    input: Parameters<SessionKernelStoreApi["prepareTurnCancel"]>[0],
  ): ReturnType<SessionKernelStoreApi["prepareTurnCancel"]> {
    return this.actor.decideTurn({ op: "prepare_cancel", ...input }) as ReturnType<
      SessionKernelStoreApi["prepareTurnCancel"]
    >;
  }
  beginTurnCancelEffect(
    input: Parameters<SessionKernelStoreApi["beginTurnCancelEffect"]>[0],
  ): ReturnType<SessionKernelStoreApi["beginTurnCancelEffect"]> {
    return this.actor.decideTurn({
      op: "begin_cancel_effect",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["beginTurnCancelEffect"]>;
  }
  settleTurnCancel(
    input: Parameters<SessionKernelStoreApi["settleTurnCancel"]>[0],
  ): ReturnType<SessionKernelStoreApi["settleTurnCancel"]> {
    return this.actor.decideTurn({ op: "settle_cancel", ...input }) as ReturnType<
      SessionKernelStoreApi["settleTurnCancel"]
    >;
  }
  prepareTurnOutcomeProjection(
    input: Parameters<SessionKernelStoreApi["prepareTurnOutcomeProjection"]>[0],
  ): ReturnType<SessionKernelStoreApi["prepareTurnOutcomeProjection"]> {
    return this.actor.decideTurn({
      op: "prepare_outcome_projection",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["prepareTurnOutcomeProjection"]>;
  }
  beginTurnOutcomeProjection(
    input: Parameters<SessionKernelStoreApi["beginTurnOutcomeProjection"]>[0],
  ): ReturnType<SessionKernelStoreApi["beginTurnOutcomeProjection"]> {
    return this.actor.decideTurn({
      op: "begin_outcome_projection",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["beginTurnOutcomeProjection"]>;
  }
  settleTurnOutcomeProjection(
    input: Parameters<SessionKernelStoreApi["settleTurnOutcomeProjection"]>[0],
  ): ReturnType<SessionKernelStoreApi["settleTurnOutcomeProjection"]> {
    return this.actor.decideTurn({
      op: "settle_outcome_projection",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["settleTurnOutcomeProjection"]>;
  }
  requestGatewayCommand(
    input: Parameters<SessionKernelStoreApi["requestGatewayCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["requestGatewayCommand"]> {
    return this.actor.decideGateway({ op: "request", ...input });
  }
  completeGatewayCommand(
    input: Parameters<SessionKernelStoreApi["completeGatewayCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["completeGatewayCommand"]> {
    return this.actor.decideGateway({ op: "complete", ...input });
  }
  failGatewayCommand(
    input: Parameters<SessionKernelStoreApi["failGatewayCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["failGatewayCommand"]> {
    return this.actor.decideGateway({ op: "fail", ...input });
  }
  requestSubmitPromptCommand(
    input: Parameters<SessionKernelStoreApi["requestSubmitPromptCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["requestSubmitPromptCommand"]> {
    return this.actor.decideDelivery({ op: "request_submit_command", ...input });
  }
  completeSubmitPromptCommand(
    input: Parameters<SessionKernelStoreApi["completeSubmitPromptCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["completeSubmitPromptCommand"]> {
    return this.actor.decideDelivery({ op: "complete_submit_command", ...input });
  }
  failSubmitPromptCommand(
    input: Parameters<SessionKernelStoreApi["failSubmitPromptCommand"]>[0],
  ): ReturnType<SessionKernelStoreApi["failSubmitPromptCommand"]> {
    return this.actor.decideDelivery({ op: "fail_submit_command", ...input });
  }
  deliverySnapshot(sessionId: string) {
    return this.readStore
      ? this.readStore.deliverySnapshot(sessionId)
      : this.call<ReturnType<SessionKernelStoreApi["deliverySnapshot"]>>("deliverySnapshot", sessionId);
  }
  deliveryEntries(slot: DeliverySlot) {
    return this.readStore
      ? this.readStore.deliveryEntries(slot)
      : this.call<ReturnType<SessionKernelStoreApi["deliveryEntries"]>>("deliveryEntries", slot);
  }
  setDeliverySlot(sessionId: string, slot: DeliverySlot, value: unknown) {
    this.actor.decideDelivery({ op: "set", sessionId, slot, value });
  }
  enqueueDelivery(sessionId: string, item: unknown, front?: boolean) {
    return this.actor.decideDelivery({ op: "enqueue", sessionId, item, front });
  }
  deleteDeliverySlot(sessionId: string, slot: DeliverySlot) {
    return this.actor.decideDelivery({ op: "delete", sessionId, slot });
  }
  clearDeliverySlot(slot: DeliverySlot) {
    this.actor.decideDelivery({ op: "clear_slot", slot });
  }
  prepareSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
    item?: unknown,
  ) {
    return this.actor.decideDelivery({
      op: "prepare_steer",
      sessionId,
      itemId,
      target,
      item,
    });
  }
  acceptSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
  ) {
    return this.actor.decideDelivery({
      op: "accept_steer",
      sessionId,
      itemId,
      target,
    });
  }
  rejectSteerDelivery(
    sessionId: string,
    itemId: string,
    target: DurableSteerTarget,
  ) {
    return this.actor.decideDelivery({
      op: "reject_steer",
      sessionId,
      itemId,
      target,
    });
  }
  settlePendingSteers() {
    return this.actor.decideDelivery({ op: "settle_pending_steers" });
  }
  requeueSteerDeliveries(sessionId: string, items: unknown[]) {
    return this.actor.decideDelivery({
      op: "requeue_steers",
      sessionId,
      items,
    });
  }
  prepareDeliveryInterrupt(
    input: Parameters<SessionKernelStoreApi["prepareDeliveryInterrupt"]>[0],
  ): ReturnType<SessionKernelStoreApi["prepareDeliveryInterrupt"]> {
    return this.actor.decideDelivery({
      op: "prepare_interrupt",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["prepareDeliveryInterrupt"]>;
  }
  beginDeliveryInterruptEffect(
    input: Parameters<SessionKernelStoreApi["beginDeliveryInterruptEffect"]>[0],
  ): ReturnType<SessionKernelStoreApi["beginDeliveryInterruptEffect"]> {
    return this.actor.decideDelivery({
      op: "begin_interrupt_effect",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["beginDeliveryInterruptEffect"]>;
  }
  settleDeliveryInterrupt(
    input: Parameters<SessionKernelStoreApi["settleDeliveryInterrupt"]>[0],
  ): ReturnType<SessionKernelStoreApi["settleDeliveryInterrupt"]> {
    return this.actor.decideDelivery({
      op: "settle_interrupt",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["settleDeliveryInterrupt"]>;
  }
  claimNextDeliveryDispatch(
    input: Parameters<SessionKernelStoreApi["claimNextDeliveryDispatch"]>[0],
  ): ReturnType<SessionKernelStoreApi["claimNextDeliveryDispatch"]> {
    return this.actor.decideDelivery({
      op: "claim_next_dispatch",
      ...input,
    }) as ReturnType<SessionKernelStoreApi["claimNextDeliveryDispatch"]>;
  }
  claimDeliveryDispatch(
    input: Parameters<SessionKernelStoreApi["claimDeliveryDispatch"]>[0],
  ) {
    return this.actor.decideDelivery({ op: "claim_dispatch", ...input });
  }
  ackDeliveryDispatch(sessionId: string, promptEntryId: string) {
    return this.actor.decideDelivery({
      op: "ack_dispatch",
      sessionId,
      promptEntryId,
    });
  }
  failDeliveryDispatch(sessionId: string, promptEntryId: string) {
    return this.actor.decideDelivery({
      op: "fail_dispatch",
      sessionId,
      promptEntryId,
    });
  }
  beginTimerExecution(
    input: Parameters<SessionKernelStoreApi["beginTimerExecution"]>[0],
  ): ReturnType<SessionKernelStoreApi["beginTimerExecution"]> {
    return this.actor.decideTimer({ op: "begin", ...input });
  }
  completeTimerExecution(
    input: Parameters<SessionKernelStoreApi["completeTimerExecution"]>[0],
  ): ReturnType<SessionKernelStoreApi["completeTimerExecution"]> {
    return this.actor.decideTimer({ op: "complete", ...input });
  }
  failTimerExecution(
    input: Parameters<SessionKernelStoreApi["failTimerExecution"]>[0],
  ): ReturnType<SessionKernelStoreApi["failTimerExecution"]> {
    return this.actor.decideTimer({ op: "fail", ...input });
  }
  recordTimerRuntimeFailure(
    input: Parameters<SessionKernelStoreApi["recordTimerRuntimeFailure"]>[0],
  ): ReturnType<SessionKernelStoreApi["recordTimerRuntimeFailure"]> {
    return this.actor.decideTimer({ op: "record_runtime_failure", ...input });
  }
  scheduleTimer(timer: Parameters<SessionKernelStoreApi["scheduleTimer"]>[0]) {
    this.call("scheduleTimer", timer);
  }
  timer(sessionId: string, timerId: string) {
    return this.readStore
      ? this.readStore.timer(sessionId, timerId)
      : this.call<DurableTimer | undefined>("timer", sessionId, timerId);
  }
  cancelTimer(sessionId: string, timerId: string) {
    this.call("cancelTimer", sessionId, timerId);
  }
  settleTimerSuccess(sessionId: string, timerId: string, token: string) {
    return this.call<boolean>("settleTimerSuccess", sessionId, timerId, token);
  }
  dueTimers(now?: number, limit?: number, kinds?: readonly string[]) {
    return this.readStore
      ? this.readStore.dueTimers(now, limit, kinds)
      : this.call<DurableTimer[]>("dueTimers", now, limit, kinds);
  }
  enqueueOutbox(
    sessionId: string,
    kind: string,
    payload: unknown,
    effectKey?: string,
  ) {
    return this.call<number>(
      "enqueueOutbox",
      sessionId,
      kind,
      payload,
      effectKey,
    );
  }
  enqueueOutboxMany(
    sessionId: string,
    effects: Array<{ kind: string; payload: unknown; effectKey: string }>,
  ) {
    return this.call<number[]>("enqueueOutboxMany", sessionId, effects);
  }
  pendingOutbox(now?: number, limit?: number, kinds?: readonly string[]) {
    return this.readStore
      ? this.readStore.pendingOutbox(now, limit, kinds)
      : this.call<DurableOutboxItem[]>("pendingOutbox", now, limit, kinds);
  }
  outboxSessionId(id: number) {
    return this.readStore
      ? this.readStore.outboxSessionId(id)
      : this.call<string | undefined>("outboxSessionId", id);
  }
  stats() {
    if (this.statsCache && Date.now() - this.statsCache.at < 5_000)
      return this.statsCache.value;
    const value = this.readStore
      ? this.readStore.stats()
      : this.call<ReturnType<SessionKernelStoreApi["stats"]>>("stats");
    this.statsCache = { at: Date.now(), value };
    return value;
  }
  acknowledgeCommand(sessionId: string, requestId: string) {
    return this.call<boolean>("acknowledgeCommand", sessionId, requestId);
  }
  compact(now?: number, retention?: number, changes?: number) {
    this.call("compact", now, retention, changes);
  }
  maintain() {
    return this.call<boolean>("maintain");
  }
  deadLetters(limit?: number, offset?: number) {
    return this.readStore
      ? this.readStore.deadLetters(limit, offset)
      : this.call<ReturnType<SessionKernelStoreApi["deadLetters"]>>(
          "deadLetters",
          limit,
          offset,
        );
  }
  discardDeadTimer(sessionId: string, timerId: string) {
    return this.call<boolean>("discardDeadTimer", sessionId, timerId);
  }
  discardDeadOutbox(id: number) {
    return this.call<boolean>("discardDeadOutbox", id);
  }
  retryDeadTimer(sessionId: string, timerId: string) {
    return this.call<boolean>("retryDeadTimer", sessionId, timerId);
  }
  retryDeadOutbox(id: number) {
    return this.call<boolean>("retryDeadOutbox", id);
  }
  retryCompatibleCreationBranchDeadLetters(
    destinations: ReadonlyArray<{ project: string; worktreePath: string }>,
    now?: number,
  ) {
    return this.call<
      Array<{
        id: number;
        sessionId: string;
        reason:
          | "shared_checkout_destination_adoptable"
          | "legacy_empty_base_branch";
      }>
    >(
      "retryCompatibleCreationBranchDeadLetters",
      destinations,
      now,
    );
  }
  ackOutbox(id: number) {
    this.call("ackOutbox", id);
  }
  deferOutbox(id: number, delayMs?: number) {
    this.call("deferOutbox", id, delayMs);
  }
  noteTimerFailure(
    sessionId: string,
    timerId: string,
    error: string,
    maxAttempts?: number,
    expectedToken?: string,
  ) {
    return this.call<ReturnType<SessionKernelStoreApi["noteTimerFailure"]>>(
      "noteTimerFailure",
      sessionId,
      timerId,
      error,
      maxAttempts,
      expectedToken,
    );
  }
  noteOutboxFailure(id: number, error: string, maxAttempts?: number) {
    return this.call<ReturnType<SessionKernelStoreApi["noteOutboxFailure"]>>(
      "noteOutboxFailure",
      id,
      error,
      maxAttempts,
    );
  }
}
