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

export interface BoxResource extends ProviderResource {
  name: string;
  state: "live" | "archived" | (string & {});
}

export interface BoxClient {
  create(input: {
    name: string;
    labels: Readonly<Record<string, string>>;
  }): Promise<BoxResource>;
  get(resourceId: string): Promise<BoxResource | undefined>;
  list(): Promise<readonly BoxResource[]>;
  resume(resourceId: string): Promise<void>;
  archive(
    resourceId: string,
    options?: { forgetManagedMetadata?: boolean },
  ): Promise<void>;
}

export interface BoxPollOptions {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T>;
  timeoutMs: number;
  intervalMs: number;
}

export type BoxInspectedState = "awake" | "sleeping" | "missing" | "unknown";

export function boxResourceName(input: CreateExecutorResourceInput): string {
  return `opensession-executor-${input.executorId}-g${input.generation}`;
}

export function mapBoxState(
  resource: Pick<BoxResource, "state"> | undefined,
): BoxInspectedState {
  if (!resource) return "missing";
  if (resource.state === "live") return "awake";
  if (resource.state === "archived") return "sleeping";
  return "unknown";
}

/** Polls a Box transition without owning a timer or clock. */
export function pollBoxResource(
  client: Pick<BoxClient, "get">,
  resourceId: string,
  expected: "awake" | "sleeping",
  options: BoxPollOptions,
): Promise<BoxResource> {
  assertPollOptions(options);
  return options.withTimeout(
    pollBoxResourceUntilSettled(client, resourceId, expected, options),
    options.timeoutMs,
  );
}

async function pollBoxResourceUntilSettled(
  client: Pick<BoxClient, "get">,
  resourceId: string,
  expected: "awake" | "sleeping",
  options: BoxPollOptions,
): Promise<BoxResource> {
  const deadline = options.now() + options.timeoutMs;
  const maxAttempts = Math.ceil(options.timeoutMs / options.intervalMs) + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resource = await client.get(resourceId);
    const state = mapBoxState(resource);
    if (state === expected && resource) return resource;
    if (state === "missing" || state === "unknown") {
      throw new Error(`Box transition entered ${state} state`);
    }
    if (options.now() >= deadline || attempt === maxAttempts - 1) {
      throw new Error(`Box transition timed out waiting for ${expected}`);
    }
    await options.sleep(options.intervalMs);
  }
  throw new Error(`Box transition timed out waiting for ${expected}`);
}

export class BoxExecutorProvider implements ExecutorProvider {
  readonly id = "box" as const;
  readonly #client: BoxClient;
  readonly #installExecutor: InstallExecutor<BoxResource>;
  readonly #poll: BoxPollOptions;

  constructor(dependencies: {
    client: BoxClient;
    installExecutor: InstallExecutor<BoxResource>;
    poll: BoxPollOptions;
  }) {
    assertPollOptions(dependencies.poll);
    this.#client = dependencies.client;
    this.#installExecutor = dependencies.installExecutor;
    this.#poll = dependencies.poll;
  }

  async create(
    input: CreateExecutorResourceInput,
  ): Promise<CreatedExecutorResource> {
    const resource = await this.#client.create({
      name: boxResourceName(input),
      labels: executorMetadata(this.id, input),
    });
    assertCreatedResource(this.id, resource, input);
    return { resourceId: resource.id, workspaceId: resource.workspaceId };
  }

  async inspect(
    resource: ExecutorResourceRef,
  ): Promise<ExecutorResourceInspection> {
    const found = await this.#client.get(resource.resourceId);
    if (found) assertResourceIdentity(this.id, found, resource);
    return { state: mapBoxState(found) };
  }

  async start(resource: ExecutorResourceRef): Promise<void> {
    await this.#requireResource(resource);
    await this.#client.resume(resource.resourceId);
    const started = await pollBoxResource(
      this.#client,
      resource.resourceId,
      "awake",
      this.#poll,
    );
    assertResourceIdentity(this.id, started, resource);
  }

  async stop(resource: ExecutorResourceRef): Promise<void> {
    await this.#requireResource(resource);
    await this.#client.archive(resource.resourceId);
    const stopped = await pollBoxResource(
      this.#client,
      resource.resourceId,
      "sleeping",
      this.#poll,
    );
    assertResourceIdentity(this.id, stopped, resource);
  }

  async destroy(resource: ExecutorResourceRef): Promise<void> {
    const found = await this.#client.get(resource.resourceId);
    if (!found) return;
    assertResourceIdentity(this.id, found, resource);
    // Box has no hard delete. Archiving and removing the managed labels makes
    // the resource inert and prevents a later reconciliation from adopting it.
    await this.#client.archive(resource.resourceId, {
      forgetManagedMetadata: true,
    });
  }

  async ensureExecutor(
    resource: ExecutorResourceRef,
  ): Promise<EnsuredExecutor> {
    const found = await this.#client.get(resource.resourceId);
    if (!found)
      throw new Error(`Box resource ${resource.resourceId} is missing`);
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

  async #requireResource(resource: ExecutorResourceRef): Promise<BoxResource> {
    const found = await this.#client.get(resource.resourceId);
    if (!found)
      throw new Error(`Box resource ${resource.resourceId} is missing`);
    assertResourceIdentity(this.id, found, resource);
    return found;
  }
}

function assertPollOptions(options: BoxPollOptions): void {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    !Number.isSafeInteger(options.intervalMs) ||
    options.intervalMs < 1
  ) {
    throw new TypeError("Box polling intervals must be positive safe integers");
  }
}
