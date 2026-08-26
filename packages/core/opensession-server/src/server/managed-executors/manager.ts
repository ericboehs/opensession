import { beginTransition, settleTransition } from "./lifecycle";
import type {
  CreatedExecutorResource,
  ExecutorProvider,
  ExecutorProviderId,
  ExecutorResourceRef,
} from "./provider";
import { ExecutorProviderRegistry } from "./registry";
import {
  type ExecutorProjectState,
  type ExecutorRecord,
  type ExecutorStateStore,
} from "./state";

export interface RevokeExecutorAuthorityInput {
  executorId: string;
  throughGeneration: number;
}

export interface DurableWorkspaceCheckpoint extends ExecutorProjectState {
  durable: true;
}

export interface ExecutorManagerDependencies {
  store: ExecutorStateStore;
  providers: ExecutorProviderRegistry;
  revokeExecutionAuthority(input: RevokeExecutorAuthorityInput): Promise<void>;
  checkpointWorkspace(
    record: ExecutorRecord,
  ): Promise<DurableWorkspaceCheckpoint>;
  now?: () => number;
}

export interface CreateExecutorInput {
  executorId: string;
  sessionId: string;
  provider: ExecutorProviderId;
  project: ExecutorProjectState;
}

export interface ExecutorTransitionInput {
  executorId: string;
  expectedGeneration: number;
}

export interface RebuildExecutorInput extends ExecutorTransitionInput {
  provider?: ExecutorProviderId;
}

export interface ForceDestroyExecutorInput extends ExecutorTransitionInput {
  operatorId: string;
  reason: string;
}

export class UnknownExecutorResourceError extends Error {
  constructor(resourceId: string) {
    super(`refusing to adopt unknown managed resource: ${resourceId}`);
    this.name = "UnknownExecutorResourceError";
  }
}

/** Provider-neutral lifecycle coordinator. It is inert until constructed and called. */
export class ExecutorManager {
  readonly #store: ExecutorStateStore;
  readonly #providers: ExecutorProviderRegistry;
  readonly #revokeExecutionAuthority: ExecutorManagerDependencies["revokeExecutionAuthority"];
  readonly #checkpointWorkspace: ExecutorManagerDependencies["checkpointWorkspace"];
  readonly #now: () => number;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #admitted = new Set<Promise<void>>();
  #draining = false;
  #drainPromise?: Promise<void>;

  constructor(dependencies: ExecutorManagerDependencies) {
    this.#store = dependencies.store;
    this.#providers = dependencies.providers;
    this.#revokeExecutionAuthority = dependencies.revokeExecutionAuthority;
    this.#checkpointWorkspace = dependencies.checkpointWorkspace;
    this.#now = dependencies.now ?? Date.now;
  }

  create(input: CreateExecutorInput): Promise<ExecutorRecord> {
    this.#assertAdmitting();
    return this.#serialized(input.executorId, async () => {
      assertIdentity(input.executorId, "executorId");
      assertIdentity(input.sessionId, "sessionId");
      const provider = this.#providers.get(input.provider);
      const now = this.#now();
      const intent: ExecutorRecord = {
        executorId: input.executorId,
        sessionId: input.sessionId,
        provider: input.provider,
        instanceGeneration: 1,
        lifecycle: "preparing",
        project: { ...input.project },
        createdAtMs: now,
        updatedAtMs: now,
      };
      // This durable write is intentionally before the provider call.
      await this.#store.insertIntent(intent);
      try {
        const created = await provider.create({
          executorId: intent.executorId,
          sessionId: intent.sessionId,
          generation: intent.instanceGeneration,
        });
        const attached = await this.#recordCreatedResource(intent, created);
        return await this.#ensureAndSettle(provider, attached);
      } catch (error) {
        await this.#recordFailureIfCurrent(
          intent.executorId,
          intent.instanceGeneration,
          error,
        );
        throw error;
      }
    });
  }

  wake(input: ExecutorTransitionInput): Promise<ExecutorRecord> {
    this.#assertAdmitting();
    return this.#serialized(input.executorId, async () => {
      const current = await this.#expect(input);
      if (current.lifecycle !== "sleeping" || !current.resourceId) {
        throw new Error("only a sleeping Executor with a resource can wake");
      }
      const provider = this.#providers.get(current.provider);
      const transition = beginTransition(current, "waking", this.#now());
      await this.#store.compareAndSwap(
        current.executorId,
        current.instanceGeneration,
        transition,
      );
      try {
        const started = await provider.start(
          resourceRef(current),
          transition.instanceGeneration,
        );
        let active = transition;
        if (started) {
          active = {
            ...transition,
            resourceId: started.resourceId,
            workspaceId: started.workspaceId,
            resourceGeneration: transition.instanceGeneration,
            updatedAtMs: this.#now(),
          };
          await this.#store.compareAndSwap(
            transition.executorId,
            transition.instanceGeneration,
            active,
          );
        }
        return await this.#ensureAndSettle(provider, active);
      } catch (error) {
        await this.#recordFailureIfCurrent(
          transition.executorId,
          transition.instanceGeneration,
          error,
        );
        throw error;
      }
    });
  }

  pause(input: ExecutorTransitionInput): Promise<ExecutorRecord> {
    this.#assertAdmitting();
    return this.#serialized(input.executorId, async () => {
      const current = await this.#expect(input);
      if (current.lifecycle !== "awake" || !current.resourceId) {
        throw new Error("only an awake Executor with a resource can pause");
      }
      const provider = this.#providers.get(current.provider);
      const transition = beginTransition(current, "preparing", this.#now());
      await this.#store.compareAndSwap(
        current.executorId,
        current.instanceGeneration,
        transition,
      );
      try {
        await this.#revoke(transition);
        await provider.stop(resourceRef(current));
        const sleeping = settleTransition(transition, "sleeping", this.#now());
        await this.#store.compareAndSwap(
          transition.executorId,
          transition.instanceGeneration,
          sleeping,
        );
        return sleeping;
      } catch (error) {
        await this.#recordFailureIfCurrent(
          transition.executorId,
          transition.instanceGeneration,
          error,
        );
        throw error;
      }
    });
  }

  destroy(input: ExecutorTransitionInput): Promise<void> {
    this.#assertAdmitting();
    return this.#destroy(input, undefined);
  }

  forceDestroy(input: ForceDestroyExecutorInput): Promise<void> {
    this.#assertAdmitting();
    if (!input.operatorId.trim() || !input.reason.trim()) {
      return Promise.reject(
        new Error("forceDestroy requires an operator and reason"),
      );
    }
    return this.#destroy(input, {
      operatorId: input.operatorId,
      reason: input.reason,
    });
  }

  rebuild(input: RebuildExecutorInput): Promise<ExecutorRecord> {
    this.#assertAdmitting();
    return this.#serialized(input.executorId, async () => {
      const current = await this.#expect(input);
      const replacement = this.#providers.get(
        input.provider ?? current.provider,
      );
      const checkpoint = await this.#checkpointWorkspace(current);
      assertDurableCheckpoint(checkpoint);

      const transition: ExecutorRecord = {
        ...beginTransition(current, "preparing", this.#now()),
        provider: replacement.id,
        project: {
          revision: checkpoint.revision,
          baseCommit: checkpoint.baseCommit,
          durableDelta: checkpoint.durableDelta,
        },
      };
      await this.#store.compareAndSwap(
        current.executorId,
        current.instanceGeneration,
        transition,
      );
      try {
        await this.#revoke(transition);
        if (current.resourceId) {
          const oldProvider = this.#providers.get(current.provider);
          await oldProvider.destroy(resourceRef(current));
        }
        // Persist the replacement intent with no old provider resource before create.
        const replacementIntent: ExecutorRecord = {
          ...transition,
          resourceId: undefined,
          workspaceId: undefined,
          resourceGeneration: undefined,
          updatedAtMs: this.#now(),
        };
        await this.#store.compareAndSwap(
          transition.executorId,
          transition.instanceGeneration,
          replacementIntent,
        );
        const created = await replacement.create({
          executorId: replacementIntent.executorId,
          sessionId: replacementIntent.sessionId,
          generation: replacementIntent.instanceGeneration,
        });
        const attached = await this.#recordCreatedResource(
          replacementIntent,
          created,
        );
        return await this.#ensureAndSettle(replacement, attached);
      } catch (error) {
        await this.#recordFailureIfCurrent(
          transition.executorId,
          transition.instanceGeneration,
          error,
        );
        throw error;
      }
    });
  }

  assertNoUnknownManagedResources(
    providerId: ExecutorProviderId,
  ): Promise<void> {
    this.#assertAdmitting();
    const provider = this.#providers.get(providerId);
    return this.#trackAdmitted(async () => {
      for (const resource of await provider.listManaged()) {
        const record = await this.#store.getByExecutorId(resource.executorId);
        if (
          !record ||
          record.provider !== providerId ||
          record.resourceId !== resource.resourceId ||
          record.sessionId !== resource.sessionId ||
          record.resourceGeneration !== resource.generation
        ) {
          throw new UnknownExecutorResourceError(resource.resourceId);
        }
      }
    });
  }

  /** Serializes a synchronous authority issuance against lifecycle transitions. */
  withAwakeExecutor<T>(
    executorId: string,
    authorize: (record: ExecutorRecord) => T,
  ): Promise<T> {
    this.#assertAdmitting();
    return this.#serialized(executorId, async () => {
      const record = await this.#store.getByExecutorId(executorId);
      if (!record || record.lifecycle !== "awake")
        throw new Error("managed Executor is not connectable");
      return authorize(record);
    });
  }

  /** Stops lifecycle admission and waits for every admitted provider effect to settle. */
  drain(): Promise<void> {
    if (!this.#drainPromise) {
      this.#draining = true;
      this.#drainPromise = Promise.allSettled([
        ...this.#queues.values(),
        ...this.#admitted,
      ]).then(() => undefined);
    }
    return this.#drainPromise;
  }

  #assertAdmitting(): void {
    if (this.#draining) throw new Error("Executor manager is draining");
  }

  #destroy(
    input: ExecutorTransitionInput,
    force: { operatorId: string; reason: string } | undefined,
  ): Promise<void> {
    return this.#serialized(input.executorId, async () => {
      const current = await this.#expect(input);
      const provider = this.#providers.get(current.provider);
      const transition = beginTransition(current, "preparing", this.#now());
      await this.#store.compareAndSwap(
        current.executorId,
        current.instanceGeneration,
        transition,
      );
      if (force) {
        await this.#store.appendAudit({
          executorId: transition.executorId,
          generation: transition.instanceGeneration,
          action: "force_destroy",
          operatorId: force.operatorId,
          reason: force.reason,
          atMs: this.#now(),
        });
      }
      try {
        await this.#revoke(transition);
        if (current.resourceId) {
          await provider.destroy(resourceRef(current));
        }
        await this.#store.delete(
          transition.executorId,
          transition.instanceGeneration,
        );
      } catch (error) {
        await this.#recordFailureIfCurrent(
          transition.executorId,
          transition.instanceGeneration,
          error,
        );
        throw error;
      }
    });
  }

  async #expect(input: ExecutorTransitionInput): Promise<ExecutorRecord> {
    const record = await this.#store.getByExecutorId(input.executorId);
    if (!record) throw new Error(`Executor ${input.executorId} does not exist`);
    if (record.instanceGeneration !== input.expectedGeneration) {
      throw new Error(
        `stale Executor generation: expected ${input.expectedGeneration}, current ${record.instanceGeneration}`,
      );
    }
    return record;
  }

  async #recordCreatedResource(
    record: ExecutorRecord,
    created: CreatedExecutorResource,
  ): Promise<ExecutorRecord> {
    if (!created.resourceId || !created.workspaceId) {
      throw new Error("provider returned an invalid Executor resource");
    }
    const attached: ExecutorRecord = {
      ...record,
      resourceId: created.resourceId,
      workspaceId: created.workspaceId,
      resourceGeneration: record.instanceGeneration,
      updatedAtMs: this.#now(),
    };
    await this.#store.compareAndSwap(
      record.executorId,
      record.instanceGeneration,
      attached,
    );
    return attached;
  }

  async #ensureAndSettle(
    provider: ExecutorProvider,
    record: ExecutorRecord,
  ): Promise<ExecutorRecord> {
    const executor = await provider.ensureExecutor(resourceRef(record));
    if (executor.executorId !== record.executorId) {
      throw new Error("provider enrolled the wrong Executor identity");
    }
    const awake = settleTransition(
      {
        ...record,
        workspaceId: executor.workspaceId,
      },
      "awake",
      this.#now(),
    );
    await this.#store.compareAndSwap(
      record.executorId,
      record.instanceGeneration,
      awake,
    );
    return awake;
  }

  async #revoke(record: ExecutorRecord): Promise<void> {
    await this.#revokeExecutionAuthority({
      executorId: record.executorId,
      throughGeneration: record.instanceGeneration,
    });
  }

  async #recordFailureIfCurrent(
    executorId: string,
    generation: number,
    error: unknown,
  ): Promise<void> {
    const current = await this.#store.getByExecutorId(executorId);
    if (!current || current.instanceGeneration !== generation) return;
    const failed = settleTransition(
      current,
      "needs_attention",
      this.#now(),
      errorMessage(error),
    );
    await this.#store.compareAndSwap(executorId, generation, failed);
  }

  #trackAdmitted(operation: () => Promise<void>): Promise<void> {
    const result = operation();
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#admitted.add(settled);
    void settled.finally(() => this.#admitted.delete(settled));
    return result;
  }

  #serialized<T>(executorId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(executorId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(executorId, tail);
    void tail.finally(() => {
      if (this.#queues.get(executorId) === tail)
        this.#queues.delete(executorId);
    });
    return result;
  }
}

function resourceRef(record: ExecutorRecord): ExecutorResourceRef {
  if (!record.resourceId || !record.resourceGeneration) {
    throw new Error("Executor has no provider resource identity");
  }
  return {
    resourceId: record.resourceId,
    executorId: record.executorId,
    sessionId: record.sessionId,
    generation: record.resourceGeneration,
  };
}

function assertDurableCheckpoint(checkpoint: DurableWorkspaceCheckpoint): void {
  if (
    checkpoint?.durable !== true ||
    !checkpoint.revision ||
    !checkpoint.baseCommit ||
    !checkpoint.durableDelta
  ) {
    throw new Error(
      "destructive rebuild requires a durable workspace checkpoint",
    );
  }
}

function assertIdentity(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} is required`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
