import type {
  CreateExecutorResourceInput,
  CreatedExecutorResource,
  EnsuredExecutor,
  ExecutorProvider,
  ExecutorResourceInspection,
  ExecutorResourceRef,
} from "../provider";
import {
  assertCreatedResource,
  assertInstalledIdentity,
  assertResourceIdentity,
  executorMetadata,
  type InstallExecutor,
  managedResourceRef,
  type ProviderResource,
} from "./shared";

export interface ModalResource extends ProviderResource {
  state: string;
}

export interface ModalLifetimePolicy {
  maximumLifetimeMs: number;
  replacementRunwayMs: number;
}

export interface ModalLifetimeMetadata extends ModalLifetimePolicy {
  createdAtMs: number;
  terminateAtMs: number;
  replacementDeadlineMs: number;
}

export interface ModalClient {
  create(input: {
    tags: Readonly<Record<string, string>>;
    lifetime: ModalLifetimeMetadata;
  }): Promise<ModalResource>;
  get(resourceId: string): Promise<ModalResource | undefined>;
  list(): Promise<readonly ModalResource[]>;
  terminate(resourceId: string): Promise<void>;
}

/** Pure policy projection used by client implementations to enforce TTLs. */
export function modalLifetimeMetadata(
  nowMs: number,
  policy: ModalLifetimePolicy,
): ModalLifetimeMetadata {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  if (
    !Number.isSafeInteger(policy.maximumLifetimeMs) ||
    policy.maximumLifetimeMs < 1
  ) {
    throw new TypeError("Modal maximum lifetime must be a positive integer");
  }
  if (
    !Number.isSafeInteger(policy.replacementRunwayMs) ||
    policy.replacementRunwayMs < 0 ||
    policy.replacementRunwayMs >= policy.maximumLifetimeMs
  ) {
    throw new TypeError(
      "Modal replacement runway must be shorter than maximum lifetime",
    );
  }
  const terminateAtMs = nowMs + policy.maximumLifetimeMs;
  if (!Number.isSafeInteger(terminateAtMs)) {
    throw new TypeError("Modal lifetime exceeds the safe timestamp range");
  }
  return {
    ...policy,
    createdAtMs: nowMs,
    terminateAtMs,
    replacementDeadlineMs: terminateAtMs - policy.replacementRunwayMs,
  };
}

export function mapModalState(
  resource: Pick<ModalResource, "state"> | undefined,
): ExecutorResourceInspection["state"] {
  if (!resource) return "missing";
  switch (resource.state.toLowerCase()) {
    case "running":
    case "active":
      return "awake";
    case "terminated":
      return "missing";
    default:
      return "unknown";
  }
}

export class ModalExecutorProvider implements ExecutorProvider {
  readonly id = "modal" as const;
  readonly #client: ModalClient;
  readonly #installExecutor: InstallExecutor<ModalResource>;
  readonly #lifetimePolicy: ModalLifetimePolicy;
  readonly #now: () => number;

  constructor(dependencies: {
    client: ModalClient;
    installExecutor: InstallExecutor<ModalResource>;
    lifetimePolicy: ModalLifetimePolicy;
    now: () => number;
  }) {
    // Validate policy before retaining dependencies. This is computation only.
    modalLifetimeMetadata(0, dependencies.lifetimePolicy);
    this.#client = dependencies.client;
    this.#installExecutor = dependencies.installExecutor;
    this.#lifetimePolicy = { ...dependencies.lifetimePolicy };
    this.#now = dependencies.now;
  }

  create(input: CreateExecutorResourceInput): Promise<CreatedExecutorResource> {
    return this.#createReplacement(input);
  }

  async inspect(
    resource: ExecutorResourceRef,
  ): Promise<ExecutorResourceInspection> {
    const found = await this.#client.get(resource.resourceId);
    if (found) assertResourceIdentity(this.id, found, resource);
    return { state: mapModalState(found) };
  }

  async start(
    resource: ExecutorResourceRef,
    nextGeneration: number,
  ): Promise<CreatedExecutorResource> {
    const found = await this.#client.get(resource.resourceId);
    if (found) {
      assertResourceIdentity(this.id, found, resource);
      if (mapModalState(found) !== "missing") {
        throw new Error(
          `Modal resource ${resource.resourceId} is not terminated`,
        );
      }
    }
    // A stopped Modal resource is terminated. Workspace portability is owned by
    // the manager's durable delta, never by a provider checkpoint.
    return this.#createReplacement({
      executorId: resource.executorId,
      sessionId: resource.sessionId,
      generation: nextGeneration,
    });
  }

  async stop(resource: ExecutorResourceRef): Promise<void> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) return;
    assertResourceIdentity(this.id, found, resource);
    await this.#client.terminate(resource.resourceId);
  }

  async destroy(resource: ExecutorResourceRef): Promise<void> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) return;
    assertResourceIdentity(this.id, found, resource);
    await this.#client.terminate(resource.resourceId);
  }

  async ensureExecutor(
    resource: ExecutorResourceRef,
  ): Promise<EnsuredExecutor> {
    const found = await this.#client.get(resource.resourceId);
    if (!found)
      throw new Error(`Modal resource ${resource.resourceId} is missing`);
    assertResourceIdentity(this.id, found, resource);
    return assertInstalledIdentity(
      await this.#installExecutor(found, resource),
      resource.executorId,
    );
  }

  async listManaged(): Promise<readonly ExecutorResourceRef[]> {
    const resources = await this.#client.list();
    return resources.flatMap((resource) => {
      const ref = managedResourceRef(this.id, resource);
      return ref && mapModalState(resource) !== "missing" ? [ref] : [];
    });
  }

  async #createReplacement(
    identity: CreateExecutorResourceInput,
  ): Promise<CreatedExecutorResource> {
    const resource = await this.#client.create({
      tags: executorMetadata(this.id, identity),
      lifetime: modalLifetimeMetadata(this.#now(), this.#lifetimePolicy),
    });
    assertCreatedResource(this.id, resource, identity);
    return { resourceId: resource.id, workspaceId: resource.workspaceId };
  }
}
