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

export interface DaytonaResource extends ProviderResource {
  state: string;
}

export interface DaytonaClient {
  create(input: {
    labels: Readonly<Record<string, string>>;
    autoStopIntervalMinutes: number;
  }): Promise<DaytonaResource>;
  get(resourceId: string): Promise<DaytonaResource | undefined>;
  list(): Promise<readonly DaytonaResource[]>;
  start(resourceId: string): Promise<void>;
  stop(resourceId: string): Promise<void>;
  delete(resourceId: string): Promise<void>;
}

export function mapDaytonaState(
  resource: Pick<DaytonaResource, "state"> | undefined,
): ExecutorResourceInspection["state"] {
  if (!resource) return "missing";
  switch (resource.state.toLowerCase()) {
    case "started":
    case "running":
      return "awake";
    case "stopped":
    case "archived":
      return "sleeping";
    default:
      return "unknown";
  }
}

export class DaytonaExecutorProvider implements ExecutorProvider {
  readonly id = "daytona" as const;
  readonly #client: DaytonaClient;
  readonly #installExecutor: InstallExecutor<DaytonaResource>;
  readonly #autoStopIntervalMinutes: number;

  constructor(dependencies: {
    client: DaytonaClient;
    installExecutor: InstallExecutor<DaytonaResource>;
    autoStopIntervalMinutes: number;
  }) {
    if (
      !Number.isSafeInteger(dependencies.autoStopIntervalMinutes) ||
      dependencies.autoStopIntervalMinutes < 1
    ) {
      throw new TypeError(
        "Daytona auto-stop interval must be a positive integer",
      );
    }
    this.#client = dependencies.client;
    this.#installExecutor = dependencies.installExecutor;
    this.#autoStopIntervalMinutes = dependencies.autoStopIntervalMinutes;
  }

  async create(
    input: CreateExecutorResourceInput,
  ): Promise<CreatedExecutorResource> {
    const resource = await this.#client.create({
      labels: executorMetadata(this.id, input),
      autoStopIntervalMinutes: this.#autoStopIntervalMinutes,
    });
    assertCreatedResource(this.id, resource, input);
    return { resourceId: resource.id, workspaceId: resource.workspaceId };
  }

  async inspect(
    resource: ExecutorResourceRef,
  ): Promise<ExecutorResourceInspection> {
    const found = await this.#client.get(resource.resourceId);
    if (found) assertResourceIdentity(this.id, found, resource);
    return { state: mapDaytonaState(found) };
  }

  async start(resource: ExecutorResourceRef): Promise<void> {
    await this.#requireResource(resource);
    await this.#client.start(resource.resourceId);
  }

  async stop(resource: ExecutorResourceRef): Promise<void> {
    await this.#requireResource(resource);
    await this.#client.stop(resource.resourceId);
  }

  async destroy(resource: ExecutorResourceRef): Promise<void> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) return;
    assertResourceIdentity(this.id, found, resource);
    await this.#client.delete(resource.resourceId);
  }

  async ensureExecutor(
    resource: ExecutorResourceRef,
  ): Promise<EnsuredExecutor> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) {
      throw new Error(`Daytona resource ${resource.resourceId} is missing`);
    }
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
      return ref ? [ref] : [];
    });
  }

  async #requireResource(
    resource: ExecutorResourceRef,
  ): Promise<DaytonaResource> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) {
      throw new Error(`Daytona resource ${resource.resourceId} is missing`);
    }
    assertResourceIdentity(this.id, found, resource);
    return found;
  }
}
