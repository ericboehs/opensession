import { randomBytes } from "node:crypto";

export interface ExecutorEnrollmentScope {
  executorId: string;
  generation: number;
  expiresAtMs: number;
}

export interface ExecutorEnrollmentFence {
  executorId: string;
  generation: number;
}

export interface ExecutorEnrollmentAuthorityOptions {
  now?: () => number;
  maxGrants?: number;
  maxTtlMs?: number;
}

const DEFAULT_MAX_GRANTS = 1_000;
const DEFAULT_MAX_TTL_MS = 5 * 60_000;

/** One-use outbound enrollment grants. Tokens are opaque lookup keys, not claims. */
export class ExecutorEnrollmentAuthority {
  readonly #grants = new Map<string, ExecutorEnrollmentScope>();
  readonly #now: () => number;
  readonly #maxGrants: number;
  readonly #maxTtlMs: number;

  constructor(options: ExecutorEnrollmentAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS;
    this.#maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    if (!Number.isSafeInteger(this.#maxGrants) || this.#maxGrants < 1) {
      throw new TypeError("maxGrants must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#maxTtlMs) || this.#maxTtlMs < 1) {
      throw new TypeError("maxTtlMs must be a positive safe integer");
    }
  }

  issue(scope: ExecutorEnrollmentScope): string {
    assertScope(scope);
    const now = this.#now();
    if (scope.expiresAtMs <= now || scope.expiresAtMs - now > this.#maxTtlMs) {
      throw new Error(
        "enrollment grant must be short-lived and expire in the future",
      );
    }
    this.#pruneExpired(now);
    if (this.#grants.size >= this.#maxGrants) {
      throw new Error("enrollment grant capacity is exhausted");
    }
    let token: string;
    do {
      token = randomBytes(32).toString("base64url");
    } while (this.#grants.has(token));
    this.#grants.set(token, { ...scope });
    return token;
  }

  consume(
    token: string,
    fence: ExecutorEnrollmentFence,
  ): ExecutorEnrollmentScope {
    const scope = this.#grants.get(token);
    if (!scope)
      throw new Error("enrollment grant is invalid, consumed, or revoked");
    if (scope.expiresAtMs <= this.#now()) {
      this.#grants.delete(token);
      throw new Error("enrollment grant has expired");
    }
    if (scope.executorId !== fence.executorId) {
      throw new Error("enrollment grant does not authorize this Executor");
    }
    if (scope.generation !== fence.generation) {
      throw new Error("enrollment grant generation is stale");
    }
    this.#grants.delete(token);
    return { ...scope };
  }

  revoke(token: string): boolean {
    return this.#grants.delete(token);
  }

  revokeGeneration(executorId: string, generation: number): number {
    return this.revokeThrough(executorId, generation, generation);
  }

  revokeThrough(
    executorId: string,
    throughGeneration: number,
    fromGeneration = 1,
  ): number {
    let revoked = 0;
    for (const [token, scope] of this.#grants) {
      if (
        scope.executorId === executorId &&
        scope.generation >= fromGeneration &&
        scope.generation <= throughGeneration
      ) {
        this.#grants.delete(token);
        revoked++;
      }
    }
    return revoked;
  }

  get size(): number {
    return this.#grants.size;
  }

  #pruneExpired(now: number): void {
    for (const [token, scope] of this.#grants) {
      if (scope.expiresAtMs <= now) this.#grants.delete(token);
    }
  }
}

function assertScope(scope: ExecutorEnrollmentScope): void {
  if (
    !scope.executorId ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 1 ||
    !Number.isSafeInteger(scope.expiresAtMs)
  ) {
    throw new TypeError("invalid enrollment scope");
  }
}
