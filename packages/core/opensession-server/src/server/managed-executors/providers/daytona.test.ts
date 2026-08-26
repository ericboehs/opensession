import { describe, expect, test } from "bun:test";
import {
  DaytonaExecutorProvider,
  type DaytonaClient,
  type DaytonaResource,
  mapDaytonaState,
} from "./daytona";
import { EXECUTOR_METADATA_KEYS, executorMetadata } from "./shared";

const identity = {
  resourceId: "daytona-1",
  executorId: "executor-1",
  sessionId: "session-1",
  generation: 3,
};

class FakeDaytonaClient implements DaytonaClient {
  resources = new Map<string, DaytonaResource>();
  createInput?: Parameters<DaytonaClient["create"]>[0];
  events: string[] = [];
  createdMetadata?: DaytonaResource["metadata"];
  failure?: Error;

  async create(input: Parameters<DaytonaClient["create"]>[0]) {
    this.throwIfFailed();
    this.createInput = input;
    return daytona("created", "started", this.createdMetadata ?? input.labels);
  }
  async get(id: string) {
    this.throwIfFailed();
    return this.resources.get(id);
  }
  async list() {
    this.throwIfFailed();
    return [...this.resources.values()];
  }
  async start(id: string) {
    this.throwIfFailed();
    this.events.push(`start:${id}`);
  }
  async stop(id: string) {
    this.throwIfFailed();
    this.events.push(`stop:${id}`);
  }
  async delete(id: string) {
    this.throwIfFailed();
    this.events.push(`delete:${id}`);
  }
  throwIfFailed() {
    if (this.failure) throw this.failure;
  }
}

function daytona(
  id = identity.resourceId,
  state = "started",
  metadata = executorMetadata("daytona", identity),
): DaytonaResource {
  return { id, workspaceId: `workspace-${id}`, state, metadata };
}

function setup(
  client = new FakeDaytonaClient(),
  installer = async (resource: DaytonaResource) => ({
    executorId: identity.executorId,
    workspaceId: resource.workspaceId,
  }),
) {
  return {
    client,
    provider: new DaytonaExecutorProvider({
      client,
      installExecutor: installer,
      autoStopIntervalMinutes: 15,
    }),
  };
}

describe("DaytonaExecutorProvider", () => {
  test("creates with exact labels and native auto-stop intent", async () => {
    const { client, provider } = setup();
    await expect(provider.create(identity)).resolves.toEqual({
      resourceId: "created",
      workspaceId: "workspace-created",
    });
    expect(client.createInput).toEqual({
      labels: executorMetadata("daytona", identity),
      autoStopIntervalMinutes: 15,
    });
    expect(client.createInput).not.toHaveProperty("env");
    expect(client.createInput).not.toHaveProperty("credentials");
  });

  test("rejects a create response that does not carry the requested identity", async () => {
    const { client, provider } = setup();
    client.createdMetadata = executorMetadata("daytona", {
      ...identity,
      sessionId: "other",
    });
    await expect(provider.create(identity)).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("maps provider states fail closed", () => {
    expect(mapDaytonaState(daytona("a", "started"))).toBe("awake");
    expect(mapDaytonaState(daytona("a", "running"))).toBe("awake");
    expect(mapDaytonaState(daytona("a", "stopped"))).toBe("sleeping");
    expect(mapDaytonaState(undefined)).toBe("missing");
    expect(mapDaytonaState(daytona("a", "starting"))).toBe("unknown");
    expect(mapDaytonaState(daytona("a", "error"))).toBe("unknown");
  });

  test("starts, stops, and hard-deletes the same resource", async () => {
    const { client, provider } = setup();
    client.resources.set(identity.resourceId, daytona());
    await provider.start(identity);
    await provider.stop(identity);
    await provider.destroy(identity);
    expect(client.events).toEqual([
      "start:daytona-1",
      "stop:daytona-1",
      "delete:daytona-1",
    ]);
  });

  test("rejects mismatched resources before lifecycle mutations", async () => {
    const { client, provider } = setup();
    client.resources.set(
      identity.resourceId,
      daytona(
        identity.resourceId,
        "started",
        executorMetadata("daytona", {
          ...identity,
          generation: identity.generation + 1,
        }),
      ),
    );
    await expect(provider.start(identity)).rejects.toThrow("identity mismatch");
    await expect(provider.stop(identity)).rejects.toThrow("identity mismatch");
    await expect(provider.destroy(identity)).rejects.toThrow(
      "identity mismatch",
    );
    expect(client.events).toEqual([]);
  });

  test("lists only complete Open Session Executor metadata", async () => {
    const { client, provider } = setup();
    client.resources.set("valid", daytona("valid"));
    client.resources.set(
      "legacy",
      daytona("legacy", "started", { sandbox: "yes" }),
    );
    client.resources.set(
      "bad-generation",
      daytona("bad-generation", "started", {
        ...executorMetadata("daytona", identity),
        [EXECUTOR_METADATA_KEYS.generation]: "NaN",
      }),
    );
    expect(await provider.listManaged()).toEqual([
      { ...identity, resourceId: "valid" },
    ]);
  });

  test("ensure delegates only after identity validation", async () => {
    const calls: string[] = [];
    const { client, provider } = setup(
      new FakeDaytonaClient(),
      async (resource) => {
        calls.push(resource.id);
        return {
          executorId: identity.executorId,
          workspaceId: resource.workspaceId,
        };
      },
    );
    client.resources.set(identity.resourceId, daytona());
    await provider.ensureExecutor(identity);
    expect(calls).toEqual([identity.resourceId]);

    client.resources.set(
      identity.resourceId,
      daytona(identity.resourceId, "started", {
        ...executorMetadata("daytona", identity),
        [EXECUTOR_METADATA_KEYS.sessionId]: "other",
      }),
    );
    await expect(provider.ensureExecutor(identity)).rejects.toThrow(
      "identity mismatch",
    );
    expect(calls).toHaveLength(1);
  });

  test("rejects installer identity mismatch and propagates API failures", async () => {
    const mismatch = setup(new FakeDaytonaClient(), async () => ({
      executorId: "wrong",
      workspaceId: "workspace",
    }));
    mismatch.client.resources.set(identity.resourceId, daytona());
    await expect(mismatch.provider.ensureExecutor(identity)).rejects.toThrow(
      "wrong Executor identity",
    );

    const failed = setup();
    failed.client.failure = new Error("Daytona unavailable");
    await expect(failed.provider.destroy(identity)).rejects.toThrow(
      "Daytona unavailable",
    );
    expect("exec" in failed.provider).toBe(false);
    expect("runCommand" in failed.provider).toBe(false);
  });
});
