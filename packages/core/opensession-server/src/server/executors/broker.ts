import {
  decodeExecutorFence,
  decodeExecutorGrant,
  decodeExecutorOperation,
  type ExecutorOperation,
  type ExecutorReceipt,
} from "@tellahq/opensession-protocol/executor";
import {
  ExecutorFailure,
  isMutation,
  isReadOperation,
  type Executor,
  type ExecutorDispatchRequest,
  type ExecutorDispatchResult,
} from "./contract";
import { ExecutorGrantAuthority, executorOperationDigest } from "./grants";

interface StoredReceipt {
  operation: string;
  result: ExecutorDispatchResult;
}

export interface ExecutorBrokerOptions {
  now?: () => number;
  readAttempts?: number;
  maxReceipts?: number;
}

/** Authorizes and dispatches operations without owning managed Executor lifecycle. */
export class ExecutorBroker {
  readonly #implementations = new Map<string, Executor>();
  readonly #roots = new Map<string, string>();
  readonly #receipts = new Map<string, StoredReceipt>();
  readonly #now: () => number;
  readonly #readAttempts: number;
  readonly #maxReceipts: number;

  constructor(
    readonly grants: ExecutorGrantAuthority,
    options: ExecutorBrokerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#readAttempts = options.readAttempts ?? 2;
    this.#maxReceipts = options.maxReceipts ?? 10_000;
    if (!Number.isSafeInteger(this.#readAttempts) || this.#readAttempts < 1)
      throw new Error("readAttempts must be positive");
    if (!Number.isSafeInteger(this.#maxReceipts) || this.#maxReceipts < 1)
      throw new Error("maxReceipts must be positive");
  }

  registerImplementation(id: string, implementation: Executor): void {
    if (!id || this.#implementations.has(id))
      throw new Error(`executor implementation is already registered: ${id}`);
    this.#implementations.set(id, implementation);
  }

  bindRoot(rootId: string, implementationId: string): void {
    if (!rootId) throw new Error("rootId is required");
    if (!this.#implementations.has(implementationId))
      throw new Error(`unknown executor implementation: ${implementationId}`);
    const current = this.#roots.get(rootId);
    if (current && current !== implementationId)
      throw new Error(`executor root is already bound: ${rootId}`);
    this.#roots.set(rootId, implementationId);
  }

  async dispatch(
    request: ExecutorDispatchRequest,
  ): Promise<ExecutorDispatchResult> {
    try {
      const operation = this.#validateRequest(request);
      const validatedRequest = { ...request, operation };
      const implementationId = this.#roots.get(request.fence.rootId);
      if (!implementationId)
        throw new ExecutorFailure(
          "invalid_grant",
          "executor root is not bound",
        );
      this.grants.validate(request.grant, {
        source: "broker",
        executorId: implementationId,
        rootId: request.fence.rootId,
        sessionId: request.fence.sessionId,
        runId: request.fence.runId,
        generation: request.fence.generation,
        deadlineMs: request.fence.deadlineMs,
        action: {
          purpose: "operation",
          requestId: request.requestId,
          operationDigest: executorOperationDigest(operation),
        },
      });
      const implementation = this.#implementations.get(implementationId);
      if (!implementation)
        throw new ExecutorFailure(
          "operation_failed",
          "bound executor implementation is unavailable",
        );

      if (isMutation(operation)) {
        return await this.#dispatchMutation(
          implementation,
          validatedRequest,
          operation,
        );
      }
      if (isReadOperation(operation)) {
        return await this.#dispatchRead(implementation, validatedRequest);
      }
      throw new ExecutorFailure(
        "invalid_request",
        "executor operation kind is unknown",
      );
    } catch (cause) {
      return { ok: false, error: normalizeFailure(cause) };
    }
  }

  #validateRequest(request: ExecutorDispatchRequest): ExecutorOperation {
    if (typeof request.requestId !== "string" || !request.requestId) {
      throw new ExecutorFailure("invalid_request", "requestId is required");
    }
    if (
      request.fence &&
      Number.isSafeInteger(request.fence.deadlineMs) &&
      request.fence.deadlineMs <= this.#now()
    ) {
      throw new ExecutorFailure(
        "deadline_exceeded",
        "executor request deadline has passed",
      );
    }
    if (!decodeExecutorFence(request.fence, this.#now())) {
      throw new ExecutorFailure("invalid_request", "executor fence is invalid");
    }
    if (!decodeExecutorGrant(request.grant)) {
      throw new ExecutorFailure("invalid_grant", "executor grant is invalid");
    }
    const operation = decodeExecutorOperation(request.operation);
    if (!operation) {
      throw new ExecutorFailure(
        "invalid_request",
        "executor operation is invalid",
      );
    }
    return operation;
  }

  async #dispatchRead(
    implementation: Executor,
    request: ExecutorDispatchRequest,
  ): Promise<ExecutorDispatchResult> {
    let lastFailure: ExecutorFailure | undefined;
    for (let attempt = 0; attempt < this.#readAttempts; attempt++) {
      try {
        const success = await implementation.execute(
          contextFor(request),
          request.operation,
        );
        return { ok: true, ...success };
      } catch (cause) {
        lastFailure = normalizeFailure(cause);
        if (!isRetryableReadFailure(lastFailure)) break;
      }
    }
    return {
      ok: false,
      error:
        lastFailure ??
        new ExecutorFailure("operation_failed", "executor read failed"),
    };
  }

  async #dispatchMutation(
    implementation: Executor,
    request: ExecutorDispatchRequest,
    operation: ExecutorOperation & { idempotencyKey: string },
  ): Promise<ExecutorDispatchResult> {
    if (
      typeof operation.idempotencyKey !== "string" ||
      !operation.idempotencyKey
    )
      return {
        ok: false,
        error: new ExecutorFailure(
          "invalid_request",
          "idempotencyKey is required",
        ),
      };
    const key = receiptKey(request, operation.idempotencyKey);
    const signature = JSON.stringify(operation);
    const stored = this.#receipts.get(key);
    if (stored) {
      if (stored.operation !== signature) {
        return {
          ok: false,
          error: new ExecutorFailure(
            "conflict",
            "idempotency key was used for another operation",
          ),
        };
      }
      return stored.result;
    }
    if (this.#receipts.size >= this.#maxReceipts) {
      return {
        ok: false,
        error: new ExecutorFailure(
          "executor_busy",
          "mutation receipt capacity is exhausted",
        ),
      };
    }

    const acceptedAt = new Date(this.#now()).toISOString();
    const base: ExecutorReceipt = {
      receiptId: crypto.randomUUID(),
      requestId: request.requestId,
      state: "running",
      acceptedAt,
      idempotencyKey: operation.idempotencyKey,
    };
    let result: ExecutorDispatchResult;
    try {
      const success = await implementation.execute(
        contextFor(request),
        operation,
      );
      const receipt = {
        ...base,
        state: "succeeded",
        completedAt: new Date(this.#now()).toISOString(),
      } satisfies ExecutorReceipt;
      result = { ok: true, ...success, receipt };
    } catch (cause) {
      const error = normalizeFailure(cause, true);
      const receipt = {
        ...base,
        state: "failed",
        completedAt: new Date(this.#now()).toISOString(),
      } satisfies ExecutorReceipt;
      result = { ok: false, error, receipt };
    }
    this.#receipts.set(key, { operation: signature, result });
    return result;
  }
}

function contextFor(request: ExecutorDispatchRequest) {
  return {
    rootId: request.fence.rootId,
    sessionId: request.fence.sessionId,
    runId: request.fence.runId,
    generation: request.fence.generation,
    requestId: request.requestId,
  };
}

function receiptKey(
  request: ExecutorDispatchRequest,
  idempotencyKey: string,
): string {
  const fence = request.fence;
  return JSON.stringify([
    fence.rootId,
    fence.sessionId,
    fence.runId,
    fence.generation,
    idempotencyKey,
  ]);
}

function isRetryableReadFailure(error: ExecutorFailure): boolean {
  return error.code === "executor_busy" || error.code === "operation_failed";
}

function normalizeFailure(
  cause: unknown,
  ambiguousUnknown = false,
): ExecutorFailure {
  if (cause instanceof ExecutorFailure) {
    if (!ambiguousUnknown || cause.ambiguous) return cause;
    return new ExecutorFailure(cause.code, cause.message, true);
  }
  return new ExecutorFailure(
    "operation_failed",
    cause instanceof Error ? cause.message : String(cause),
    ambiguousUnknown,
  );
}
