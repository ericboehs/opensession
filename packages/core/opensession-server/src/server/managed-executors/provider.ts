export const EXECUTOR_PROVIDER_IDS = ["box", "daytona", "modal"] as const;

export type ExecutorProviderId = (typeof EXECUTOR_PROVIDER_IDS)[number];

export interface ExecutorResourceRef {
  resourceId: string;
  executorId: string;
  sessionId: string;
  generation: number;
}

export interface CreateExecutorResourceInput {
  executorId: string;
  sessionId: string;
  generation: number;
}

export interface CreatedExecutorResource {
  resourceId: string;
  workspaceId: string;
}

export interface ExecutorResourceInspection {
  state: "awake" | "sleeping" | "missing" | "unknown";
}

export interface EnsuredExecutor {
  executorId: string;
  workspaceId: string;
}

/** Provider boundary for resource lifecycle and fixed executor installation only. */
export interface ExecutorProvider {
  readonly id: ExecutorProviderId;
  create(input: CreateExecutorResourceInput): Promise<CreatedExecutorResource>;
  inspect(resource: ExecutorResourceRef): Promise<ExecutorResourceInspection>;
  /** Persistent providers return void. Ephemeral providers may replace the
   * stopped resource and return its new durable identity. */
  start(
    resource: ExecutorResourceRef,
    nextGeneration: number,
  ): Promise<CreatedExecutorResource | void>;
  stop(resource: ExecutorResourceRef): Promise<void>;
  destroy(resource: ExecutorResourceRef): Promise<void>;
  ensureExecutor(resource: ExecutorResourceRef): Promise<EnsuredExecutor>;
  listManaged(): Promise<readonly ExecutorResourceRef[]>;
}
