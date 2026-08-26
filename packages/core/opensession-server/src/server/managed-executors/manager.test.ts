import { describe, expect, test } from "bun:test";
import { ExecutorManager } from "./manager";
import type {
  CreateExecutorResourceInput,
  CreatedExecutorResource,
  EnsuredExecutor,
  ExecutorProvider,
  ExecutorProviderId,
  ExecutorResourceRef,
} from "./provider";
import { ExecutorProviderRegistry } from "./registry";
import {
  InMemoryExecutorStateStore,
  type ExecutorRecord,
  type ExecutorStateStore,
} from "./state";

class FakeProvider implements ExecutorProvider {
  readonly id: ExecutorProviderId;
  readonly events: string[];
  managed: ExecutorResourceRef[] = [];
  starts: Array<{ resource: ExecutorResourceRef; nextGeneration: number }> = [];
  stops: ExecutorResourceRef[] = [];
  destroys: ExecutorResourceRef[] = [];
  ensures: ExecutorResourceRef[] = [];
  createError?: Error;
  beforeCreate?: () => Promise<void> | void;
  beforeEnsure?: () => Promise<void> | void;
  beforeStart?: () => Promise<void> | void;
  beforeListManaged?: () => Promise<void> | void;
  startReplacement?: CreatedExecutorResource;

  constructor(id: ExecutorProviderId = "box", events: string[] = []) {
    this.id = id;
    this.events = events;
  }

  async create(
    input: CreateExecutorResourceInput,
  ): Promise<CreatedExecutorResource> {
    this.events.push(`create:${input.generation}`);
    await this.beforeCreate?.();
    if (this.createError) throw this.createError;
    return { resourceId: `resource-${this.id}`, workspaceId: "workspace-1" };
  }

  async inspect(): Promise<{ state: "awake" }> {
    return { state: "awake" };
  }

  async start(
    resource: ExecutorResourceRef,
    nextGeneration: number,
  ): Promise<CreatedExecutorResource | void> {
    this.events.push("start");
    this.starts.push({ resource, nextGeneration });
    await this.beforeStart?.();
    return this.startReplacement;
  }

  async stop(resource: ExecutorResourceRef): Promise<void> {
    this.events.push("stop");
    this.stops.push(resource);
  }

  async destroy(resource: ExecutorResourceRef): Promise<void> {
    this.events.push("destroy");
    this.destroys.push(resource);
  }

  async ensureExecutor(
    resource: ExecutorResourceRef,
  ): Promise<EnsuredExecutor> {
    this.events.push("ensure");
    this.ensures.push(resource);
    await this.beforeEnsure?.();
    return {
      executorId: "executor-1",
      workspaceId: this.startReplacement?.workspaceId ?? "workspace-1",
    };
  }

  async listManaged(): Promise<readonly ExecutorResourceRef[]> {
    await this.beforeListManaged?.();
    return this.managed;
  }
}

const project = {
  revision: "revision-1",
  baseCommit: "abc123",
  durableDelta: "delta-1",
};

function setup(
  options: {
    provider?: FakeProvider;
    store?: ExecutorStateStore;
    events?: string[];
    checkpoint?: () => Promise<any>;
  } = {},
) {
  const events = options.events ?? [];
  const provider = options.provider ?? new FakeProvider("box", events);
  const store = options.store ?? new InMemoryExecutorStateStore();
  const registry = new ExecutorProviderRegistry();
  registry.register(provider);
  const manager = new ExecutorManager({
    store,
    providers: registry,
    now: () => 1_000,
    revokeExecutionAuthority: async () => {
      events.push("revoke");
    },
    checkpointWorkspace:
      options.checkpoint ??
      (async () => ({ ...project, revision: "revision-2", durable: true })),
  });
  return { events, manager, provider, registry, store };
}

async function create(
  manager: ExecutorManager,
  provider: ExecutorProviderId = "box",
): Promise<ExecutorRecord> {
  return manager.create({
    executorId: "executor-1",
    sessionId: "session-1",
    provider,
    project,
  });
}

describe("ExecutorManager", () => {
  test("writes durable intent before create and records the resource before executor setup", async () => {
    const backing = new InMemoryExecutorStateStore();
    const events: string[] = [];
    const store: ExecutorStateStore = {
      getByExecutorId: (id) => backing.getByExecutorId(id),
      getBySessionId: (id) => backing.getBySessionId(id),
      insertIntent: async (record) => {
        events.push("intent");
        await backing.insertIntent(record);
      },
      compareAndSwap: async (...args) => {
        events.push(args[2].resourceId ? "resource-recorded" : "cas");
        await backing.compareAndSwap(...args);
      },
      delete: (...args) => backing.delete(...args),
      appendAudit: (entry) => backing.appendAudit(entry),
    };
    const provider = new FakeProvider("box", events);
    provider.beforeCreate = async () => {
      expect((await backing.getByExecutorId("executor-1"))?.lifecycle).toBe(
        "preparing",
      );
    };
    provider.beforeEnsure = async () => {
      expect((await backing.getByExecutorId("executor-1"))?.resourceId).toBe(
        "resource-box",
      );
    };
    const { manager } = setup({ events, provider, store });

    const record = await create(manager);
    expect(record.lifecycle).toBe("awake");
    expect(events.slice(0, 5)).toEqual([
      "intent",
      "create:1",
      "resource-recorded",
      "ensure",
      "resource-recorded",
    ]);
  });

  test("retains a failed durable intent without inventing a resource", async () => {
    const provider = new FakeProvider();
    provider.createError = new Error("provider unavailable");
    const { manager, store } = setup({ provider });

    await expect(create(manager)).rejects.toThrow("provider unavailable");
    expect(await store.getByExecutorId("executor-1")).toMatchObject({
      lifecycle: "needs_attention",
      error: "provider unavailable",
      instanceGeneration: 1,
    });
    expect(
      (await store.getByExecutorId("executor-1"))?.resourceId,
    ).toBeUndefined();
  });

  test("serializes concurrent wake and destroy and fences the stale request", async () => {
    let releaseStart!: () => void;
    let started!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const provider = new FakeProvider();
    provider.beforeStart = async () => {
      started();
      await startGate;
    };
    const { manager, events } = setup({ provider });
    const awake = await create(manager);
    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });

    const wake = manager.wake({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });
    await startEntered;
    const destroy = manager.destroy({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });
    releaseStart();

    expect((await wake).lifecycle).toBe("awake");
    await expect(destroy).rejects.toThrow("stale Executor generation");
    expect(events.filter((event) => event === "destroy")).toHaveLength(0);
  });

  test("drain stops admission and waits for admitted provider work", async () => {
    let releaseCreate!: () => void;
    let createEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      createEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const provider = new FakeProvider();
    provider.beforeCreate = async () => {
      createEntered();
      await gate;
    };
    const { manager } = setup({ provider });
    const creating = create(manager);
    await entered;
    let drained = false;
    const drain = manager.drain().then(() => {
      drained = true;
    });
    expect(() =>
      manager.create({
        executorId: "executor-2",
        sessionId: "session-2",
        provider: "box",
        project,
      }),
    ).toThrow("draining");
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseCreate();
    await expect(creating).resolves.toMatchObject({ lifecycle: "awake" });
    await drain;
    expect(drained).toBe(true);
    expect(manager.drain()).toBe(manager.drain());
  });

  test("drain waits for an admitted managed-resource scan and its store checks", async () => {
    let releaseList!: () => void;
    let listEntered!: () => void;
    let releaseStore!: () => void;
    let storeEntered!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const listed = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    const storeGate = new Promise<void>((resolve) => {
      releaseStore = resolve;
    });
    const storeChecked = new Promise<void>((resolve) => {
      storeEntered = resolve;
    });
    const backing = new InMemoryExecutorStateStore();
    const store: ExecutorStateStore = {
      getByExecutorId: async (id) => {
        storeEntered();
        await storeGate;
        return backing.getByExecutorId(id);
      },
      getBySessionId: (id) => backing.getBySessionId(id),
      insertIntent: (record) => backing.insertIntent(record),
      compareAndSwap: (...args) => backing.compareAndSwap(...args),
      delete: (...args) => backing.delete(...args),
      appendAudit: (entry) => backing.appendAudit(entry),
    };
    const provider = new FakeProvider();
    provider.managed = [
      {
        executorId: "unknown",
        sessionId: "unknown-session",
        resourceId: "unknown-resource",
        generation: 1,
      },
    ];
    provider.beforeListManaged = async () => {
      listEntered();
      await listGate;
    };
    const { manager } = setup({ provider, store });

    const scan = manager.assertNoUnknownManagedResources("box");
    await listed;
    let drained = false;
    const drain = manager.drain().then(() => {
      drained = true;
    });
    expect(() => manager.assertNoUnknownManagedResources("box")).toThrow(
      "draining",
    );
    releaseList();
    await storeChecked;
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseStore();
    await expect(scan).rejects.toThrow("unknown managed resource");
    await drain;
    expect(drained).toBe(true);
  });

  test("keeps persistent resource identity separate from lifecycle generations", async () => {
    const provider = new FakeProvider();
    const { manager } = setup({ provider });
    const awake = await create(manager);
    expect(awake).toMatchObject({
      instanceGeneration: 1,
      resourceGeneration: 1,
    });

    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });
    expect(sleeping).toMatchObject({
      instanceGeneration: 2,
      resourceGeneration: 1,
    });
    expect(provider.stops.at(-1)?.generation).toBe(1);

    const rewoken = await manager.wake({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });
    expect(rewoken).toMatchObject({
      instanceGeneration: 3,
      resourceGeneration: 1,
    });
    expect(provider.starts.at(-1)).toMatchObject({
      resource: { generation: 1 },
      nextGeneration: 3,
    });
    expect(provider.ensures.at(-1)?.generation).toBe(1);

    await manager.destroy({
      executorId: rewoken.executorId,
      expectedGeneration: rewoken.instanceGeneration,
    });
    expect(provider.destroys.at(-1)?.generation).toBe(1);
  });

  test("records a replacement resource when an ephemeral provider wakes", async () => {
    const provider = new FakeProvider("modal");
    const { manager } = setup({ provider });
    const awake = await create(manager, "modal");
    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });
    provider.startReplacement = {
      resourceId: "resource-modal-replacement",
      workspaceId: "workspace-replacement",
    };
    const replaced = await manager.wake({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });
    expect(replaced).toMatchObject({
      resourceId: "resource-modal-replacement",
      workspaceId: "workspace-replacement",
      lifecycle: "awake",
      instanceGeneration: 3,
      resourceGeneration: 3,
    });
  });

  test("rejects stale generations before provider effects", async () => {
    const { manager, events } = setup();
    const awake = await create(manager);
    const before = [...events];
    await expect(
      manager.pause({ executorId: awake.executorId, expectedGeneration: 99 }),
    ).rejects.toThrow("stale Executor generation");
    expect(events).toEqual(before);
  });

  test("revokes execution authority before stop and destroy", async () => {
    const { manager, events } = setup();
    const awake = await create(manager);
    const sleeping = await manager.pause({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
    });
    expect(events.indexOf("revoke")).toBeLessThan(events.indexOf("stop"));

    events.length = 0;
    await manager.destroy({
      executorId: sleeping.executorId,
      expectedGeneration: sleeping.instanceGeneration,
    });
    expect(events).toEqual(["revoke", "destroy"]);
  });

  test("destroys the old resource identity before a cross-provider rebuild", async () => {
    const box = new FakeProvider("box");
    const { manager, registry } = setup({ provider: box });
    const daytona = new FakeProvider("daytona");
    registry.register(daytona);
    const awake = await create(manager);

    const rebuilt = await manager.rebuild({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
      provider: "daytona",
    });

    expect(box.destroys.at(-1)).toMatchObject({
      resourceId: "resource-box",
      generation: 1,
    });
    expect(rebuilt).toMatchObject({
      provider: "daytona",
      resourceId: "resource-daytona",
      instanceGeneration: 2,
      resourceGeneration: 2,
      lifecycle: "awake",
    });
  });

  test("blocks destructive rebuild without a durable checkpoint", async () => {
    const { manager, events } = setup({
      checkpoint: async () => ({ ...project, durable: false }),
    });
    const awake = await create(manager);
    events.length = 0;

    await expect(
      manager.rebuild({
        executorId: awake.executorId,
        expectedGeneration: awake.instanceGeneration,
      }),
    ).rejects.toThrow("durable workspace checkpoint");
    expect(events).toEqual([]);
  });

  test("records an operator audit marker for force destroy", async () => {
    const store = new InMemoryExecutorStateStore();
    const { manager } = setup({ store });
    const awake = await create(manager);

    await manager.forceDestroy({
      executorId: awake.executorId,
      expectedGeneration: awake.instanceGeneration,
      operatorId: "operator-1",
      reason: "remove orphaned billing resource",
    });
    expect(store.auditEntries()).toEqual([
      {
        executorId: "executor-1",
        generation: 2,
        action: "force_destroy",
        operatorId: "operator-1",
        reason: "remove orphaned billing resource",
        atMs: 1_000,
      },
    ]);
  });

  test("rejects unknown providers and never adopts legacy resources", async () => {
    const { manager, provider, registry } = setup();
    expect(() => registry.get("local-microvm")).toThrow("unknown");
    expect(() => registry.get("modal")).toThrow("unconfigured");

    provider.managed = [
      {
        executorId: "legacy",
        sessionId: "legacy-session",
        resourceId: "legacy-resource",
        generation: 1,
      },
    ];
    await expect(
      manager.assertNoUnknownManagedResources("box"),
    ).rejects.toThrow("refusing to adopt unknown managed resource");
  });
});
