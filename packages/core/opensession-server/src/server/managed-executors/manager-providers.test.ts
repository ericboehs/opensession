import { describe, expect, test } from "bun:test";
import { ExecutorManager } from "./manager";
import { ExecutorProviderRegistry } from "./registry";
import { InMemoryExecutorStateStore } from "./state";
import {
  type BoxClient,
  BoxExecutorProvider,
  type BoxResource,
} from "./providers/box";
import {
  type ModalClient,
  ModalExecutorProvider,
  type ModalResource,
} from "./providers/modal";

const project = {
  revision: "revision-1",
  baseCommit: "abc123",
  durableDelta: "delta-1",
};

function managerWith(provider: BoxExecutorProvider | ModalExecutorProvider) {
  const providers = new ExecutorProviderRegistry();
  providers.register(provider);
  return new ExecutorManager({
    store: new InMemoryExecutorStateStore(),
    providers,
    now: () => 1_000,
    revokeExecutionAuthority: async () => {},
    checkpointWorkspace: async () => ({ ...project, durable: true }),
  });
}

class IntegrationBoxClient implements BoxClient {
  resource?: BoxResource;

  async create(input: Parameters<BoxClient["create"]>[0]) {
    this.resource = {
      id: "box-1",
      workspaceId: "workspace-box-1",
      name: input.name,
      state: "live",
      metadata: input.labels,
    };
    return this.resource;
  }

  async get(resourceId: string) {
    return this.resource?.id === resourceId ? this.resource : undefined;
  }

  async list() {
    return this.resource ? [this.resource] : [];
  }

  async resume(resourceId: string) {
    if (this.resource?.id === resourceId) this.resource.state = "live";
  }

  async archive(
    resourceId: string,
    options?: { forgetManagedMetadata?: boolean },
  ) {
    if (this.resource?.id !== resourceId) return;
    this.resource.state = "archived";
    if (options?.forgetManagedMetadata) this.resource.metadata = {};
  }
}

class IntegrationModalClient implements ModalClient {
  resources = new Map<string, ModalResource>();
  created: ModalResource[] = [];

  async create(input: Parameters<ModalClient["create"]>[0]) {
    const sequence = this.created.length + 1;
    const resource: ModalResource = {
      id: `modal-${sequence}`,
      workspaceId: `workspace-modal-${sequence}`,
      state: "running",
      metadata: input.tags,
    };
    this.resources.set(resource.id, resource);
    this.created.push(resource);
    return resource;
  }

  async get(resourceId: string) {
    return this.resources.get(resourceId);
  }

  async list() {
    return [...this.resources.values()];
  }

  async terminate(resourceId: string) {
    this.resources.delete(resourceId);
  }
}

describe("ExecutorManager provider generation integration", () => {
  test("keeps a persistent Box resource on its creation generation", async () => {
    const client = new IntegrationBoxClient();
    const provider = new BoxExecutorProvider({
      client,
      installExecutor: async (resource, identity) => ({
        executorId: identity.executorId,
        workspaceId: resource.workspaceId,
      }),
      poll: {
        now: () => 0,
        sleep: async () => {},
        withTimeout: async (operation) => operation,
        timeoutMs: 10,
        intervalMs: 1,
      },
    });
    const manager = managerWith(provider);
    const awake = await manager.create({
      executorId: "executor-box",
      sessionId: "session-box",
      provider: "box",
      project,
    });
    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });
    const rewoken = await manager.wake({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });

    expect(rewoken).toMatchObject({
      instanceGeneration: 3,
      resourceGeneration: 1,
      lifecycle: "awake",
    });
    await expect(
      manager.destroy({
        executorId: rewoken.executorId,
        expectedGeneration: rewoken.instanceGeneration,
      }),
    ).resolves.toBeUndefined();
  });

  test("moves an ephemeral Modal replacement to the wake generation", async () => {
    const client = new IntegrationModalClient();
    const provider = new ModalExecutorProvider({
      client,
      installExecutor: async (resource, identity) => ({
        executorId: identity.executorId,
        workspaceId: resource.workspaceId,
      }),
      lifetimePolicy: {
        maximumLifetimeMs: 60_000,
        replacementRunwayMs: 10_000,
      },
      now: () => 1_000,
    });
    const manager = managerWith(provider);
    const awake = await manager.create({
      executorId: "executor-modal",
      sessionId: "session-modal",
      provider: "modal",
      project,
    });
    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });
    const replaced = await manager.wake({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });

    expect(replaced).toMatchObject({
      resourceId: "modal-2",
      instanceGeneration: 3,
      resourceGeneration: 3,
      lifecycle: "awake",
    });
    expect(client.created[0]?.metadata["opensession.executor-generation"]).toBe(
      "1",
    );
    expect(client.created[1]?.metadata["opensession.executor-generation"]).toBe(
      "3",
    );
    await expect(
      manager.destroy({
        executorId: replaced.executorId,
        expectedGeneration: replaced.instanceGeneration,
      }),
    ).resolves.toBeUndefined();
  });
});
