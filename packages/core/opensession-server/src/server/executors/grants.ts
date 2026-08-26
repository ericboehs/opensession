import { randomBytes } from "node:crypto";
import {
  encodeExecutorGrant,
  type ExecutorGrant,
  type ExecutorOperation,
} from "@tellahq/opensession-protocol/executor";
import { ExecutorFailure } from "./contract";

export type ExecutorGrantTarget = "runner" | "managed" | "broker";

export type ExecutorGrantAction =
  | {
      purpose: "operation";
      requestId: string;
      operationDigest: string;
    }
  | {
      purpose: "cleanup";
      requestId: string;
      targetRequestId: string;
      streamId: string;
    }
  | {
      purpose: "receipt_status";
      requestId: string;
      receiptId: string;
    }
  | {
      purpose: "cancel_receipt";
      requestId: string;
      receiptId: string;
    }
  | {
      purpose: "cancel_request";
      requestId: string;
      targetRequestId: string;
    };

export interface ExecutorGrantScope {
  source: ExecutorGrantTarget;
  executorId: string;
  rootId: string;
  sessionId: string;
  runId: string;
  generation: number;
  /** Must exactly equal the deadline carried by the authorized wire fence. */
  deadlineMs: number;
  action: ExecutorGrantAction;
}

export interface ExecutorGrantAuthorityOptions {
  now?: () => number;
  maxGrants?: number;
}

const DEFAULT_MAX_GRANTS = 10_000;
const DIGEST_RE = /^[a-f0-9]{64}$/;

/** In-memory capability authority. Tokens are opaque keys to immutable exact scopes. */
export class ExecutorGrantAuthority {
  readonly #grants = new Map<ExecutorGrant, ExecutorGrantScope>();
  readonly #now: () => number;
  readonly #maxGrants: number;

  constructor(options: ExecutorGrantAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS;
    if (!Number.isSafeInteger(this.#maxGrants) || this.#maxGrants < 1)
      throw new Error("maxGrants must be a positive safe integer");
  }

  issue(scope: ExecutorGrantScope): ExecutorGrant {
    assertScope(scope);
    if (scope.deadlineMs <= this.#now())
      throw new ExecutorFailure(
        "deadline_exceeded",
        "grant deadline must be in the future",
      );
    this.#pruneExpired();
    if (this.#grants.size >= this.#maxGrants)
      throw new ExecutorFailure("executor_busy", "grant capacity is exhausted");
    let grant: ExecutorGrant;
    do {
      grant = encodeExecutorGrant(randomBytes(32).toString("base64url"));
    } while (this.#grants.has(grant));
    this.#grants.set(grant, structuredClone(scope));
    return grant;
  }

  /** Validation requires the caller's complete expected target and action. */
  validate(
    grant: ExecutorGrant,
    expected: ExecutorGrantScope,
  ): ExecutorGrantScope {
    assertScope(expected);
    const scope = this.#grants.get(grant);
    if (!scope)
      throw new ExecutorFailure(
        "invalid_grant",
        "executor grant is invalid or revoked",
      );
    if (scope.deadlineMs <= this.#now()) {
      this.#grants.delete(grant);
      throw new ExecutorFailure(
        "deadline_exceeded",
        "executor grant has expired",
      );
    }
    if (!sameScope(scope, expected))
      throw new ExecutorFailure(
        scope.generation !== expected.generation
          ? "stale_generation"
          : "invalid_grant",
        "executor grant does not authorize this exact target and action",
      );
    return structuredClone(scope);
  }

  revoke(grant: ExecutorGrant): boolean {
    return this.#grants.delete(grant);
  }

  revokeAll(): number {
    const revoked = this.#grants.size;
    this.#grants.clear();
    return revoked;
  }

  revokeExecutor(source: ExecutorGrantTarget, executorId: string): number {
    let revoked = 0;
    for (const [grant, scope] of this.#grants) {
      if (scope.source === source && scope.executorId === executorId) {
        this.#grants.delete(grant);
        revoked++;
      }
    }
    return revoked;
  }

  get size(): number {
    return this.#grants.size;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [grant, scope] of this.#grants)
      if (scope.deadlineMs <= now) this.#grants.delete(grant);
  }
}

export function executorOperationDigest(operation: ExecutorOperation): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonical(operation)))
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  return value;
}

function sameScope(
  left: ExecutorGrantScope,
  right: ExecutorGrantScope,
): boolean {
  return (
    left.source === right.source &&
    left.executorId === right.executorId &&
    left.rootId === right.rootId &&
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.deadlineMs === right.deadlineMs &&
    JSON.stringify(left.action) === JSON.stringify(right.action)
  );
}

function assertScope(scope: ExecutorGrantScope): void {
  if (
    !scope ||
    !["runner", "managed", "broker"].includes(scope.source) ||
    !identity(scope.executorId) ||
    !identity(scope.rootId) ||
    !identity(scope.sessionId) ||
    !identity(scope.runId) ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 0 ||
    !Number.isSafeInteger(scope.deadlineMs) ||
    !validAction(scope.action)
  )
    throw new ExecutorFailure(
      "invalid_request",
      "invalid executor grant scope",
    );
}

function validAction(action: ExecutorGrantAction | undefined): boolean {
  if (!action || !identity(action.requestId)) return false;
  if (action.purpose === "operation")
    return DIGEST_RE.test(action.operationDigest);
  if (action.purpose === "cleanup")
    return identity(action.targetRequestId) && identity(action.streamId);
  if (action.purpose === "cancel_request")
    return identity(action.targetRequestId);
  return identity(action.receiptId);
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}
