import type {
  ExecutorFence,
  ExecutorGrant,
  ExecutorOperation,
  ExecutorOperationOutcome,
  ExecutorReceipt,
  ExecutorStreamEvent,
} from "@tellahq/opensession-protocol/executor";

/** Target-neutral input passed to an Executor implementation after authorization. */
export interface ExecutorContext {
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
  requestId: string;
}

export interface ExecutorSuccess {
  outcome: ExecutorOperationOutcome;
  events?: ExecutorStreamEvent[];
}

export type ExecutorFailureCode =
  | "invalid_request"
  | "invalid_grant"
  | "stale_generation"
  | "deadline_exceeded"
  | "not_found"
  | "conflict"
  | "cancelled"
  | "operation_failed"
  | "executor_busy"
  | "unsupported";

/** A normalized failure. `ambiguous` means a mutation may have taken effect. */
export class ExecutorFailure extends Error {
  constructor(
    readonly code: ExecutorFailureCode,
    message: string,
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = "ExecutorFailure";
  }
}

/** An Executor only performs structured workspace/tool operations. */
export interface Executor {
  execute(
    context: ExecutorContext,
    operation: ExecutorOperation,
  ): Promise<ExecutorSuccess>;
  /**
   * Internal lifecycle acknowledgement for executor-owned terminal tombstones.
   * The agent calls this only after the exact fenced success is durable.
   */
  acknowledgeDurableTerminal?(
    context: ExecutorContext,
    operation: ExecutorOperation,
    outcome: ExecutorOperationOutcome,
    receipt: ExecutorReceipt,
  ): void | Promise<void>;
}

export interface ExecutorDispatchRequest {
  requestId: string;
  grant: ExecutorGrant;
  fence: ExecutorFence;
  operation: ExecutorOperation;
}

export type ExecutorDispatchResult =
  | {
      ok: true;
      outcome: ExecutorOperationOutcome;
      events?: ExecutorStreamEvent[];
      receipt?: ExecutorReceipt;
    }
  | { ok: false; error: ExecutorFailure; receipt?: ExecutorReceipt };

const mutationKinds = new Set<ExecutorOperation["kind"]>([
  "fs.write",
  "fs.mkdir",
  "fs.remove",
  "fs.move",
  "process.spawn",
  "process.signal",
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  "service.start",
  "service.stop",
  "portal.open",
  "portal.close",
]);

const readKinds = new Set<ExecutorOperation["kind"]>([
  "fs.read",
  "fs.list",
  "fs.stat",
  "process.status",
  "service.status",
  "portal.status",
]);

export function isMutation(
  operation: ExecutorOperation,
): operation is ExecutorOperation & { idempotencyKey: string } {
  return mutationKinds.has(operation.kind);
}

export function isReadOperation(operation: ExecutorOperation): boolean {
  return readKinds.has(operation.kind);
}
