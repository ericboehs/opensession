import { describe, expect, test } from "bun:test";
import {
  BoxExecutorProvider,
  type BoxClient,
  type BoxResource,
  mapBoxState,
  pollBoxResource,
} from "./box";
import { EXECUTOR_METADATA_KEYS, executorMetadata } from "./shared";

const identity = {
  resourceId: "box-1",
  executorId: "executor-1",
  sessionId: "session-1",
  generation: 2,
};

class FakeBoxClient implements BoxClient {
  resources = new Map<string, BoxResource>();
  createInput?: Parameters<BoxClient["create"]>[0];
  archives: Parameters<BoxClient["archive"]>[] = [];
  resumes: string[] = [];
  createdMetadata?: BoxResource["metadata"];
  failure?: Error;

  async create(input: Parameters<BoxClient["create"]>[0]) {
    if (this.failure) throw this.failure;
    this.createInput = input;
    const resource = box(
      "box-new",
      "live",
      this.createdMetadata ?? input.labels,
    );
    this.resources.set(resource.id, resource);
    return resource;
  }
  async get(id: string) {
    if (this.failure) throw this.failure;
    return this.resources.get(id);
  }
  async list() {
    if (this.failure) throw this.failure;
    return [...this.resources.values()];
  }
  async resume(id: string) {
    if (this.failure) throw this.failure;
    this.resumes.push(id);
    const resource = this.resources.get(id);
    if (resource) resource.state = "live";
  }
  async archive(id: string, options?: { forgetManagedMetadata?: boolean }) {
    if (this.failure) throw this.failure;
    this.archives.push([id, options]);
    const resource = this.resources.get(id);
    if (!resource) return;
    resource.state = "archived";
    if (options?.forgetManagedMetadata) resource.metadata = {};
  }
}

function box(
  id = identity.resourceId,
  state = "live",
  metadata = executorMetadata("box", identity),
): BoxResource {
  return { id, workspaceId: `workspace-${id}`, name: "box", state, metadata };
}

function setup(client = new FakeBoxClient()) {
  const installs: BoxResource[] = [];
  const provider = new BoxExecutorProvider({
    client,
    installExecutor: async (resource) => {
      installs.push(resource);
      return {
        executorId: identity.executorId,
        workspaceId: resource.workspaceId,
      };
    },
    poll: {
      now: () => 0,
      sleep: async () => {},
      withTimeout: async (operation) => operation,
      timeoutMs: 10,
      intervalMs: 1,
    },
  });
  return { client, installs, provider };
}

describe("BoxExecutorProvider", () => {
  test("creates a durably named resource with complete Executor labels", async () => {
    const { client, provider } = setup();
    await expect(provider.create(identity)).resolves.toEqual({
      resourceId: "box-new",
      workspaceId: "workspace-box-new",
    });
    expect(client.createInput).toEqual({
      name: "opensession-executor-executor-1-g2",
      labels: executorMetadata("box", identity),
    });
  });

  test("rejects a create response that does not carry the requested identity", async () => {
    const { client, provider } = setup();
    client.createdMetadata = executorMetadata("box", {
      ...identity,
      executorId: "other",
    });
    await expect(provider.create(identity)).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("maps live, archive, missing, and unknown states", () => {
    expect(mapBoxState(box("a", "live"))).toBe("awake");
    expect(mapBoxState(box("a", "archived"))).toBe("sleeping");
    expect(mapBoxState(undefined)).toBe("missing");
    expect(mapBoxState(box("a", "provisioning"))).toBe("unknown");
  });

  test("resumes and archives the same persistent resource", async () => {
    const { client, provider } = setup();
    client.resources.set(
      identity.resourceId,
      box(identity.resourceId, "archived"),
    );
    await provider.start(identity);
    await provider.stop(identity);
    expect(client.resumes).toEqual([identity.resourceId]);
    expect(client.archives).toEqual([[identity.resourceId, undefined]]);
  });

  test("destroy archives and forgets metadata because Box cannot hard delete", async () => {
    const { client, provider } = setup();
    client.resources.set(identity.resourceId, box());
    await provider.destroy(identity);
    expect(client.archives).toEqual([
      [identity.resourceId, { forgetManagedMetadata: true }],
    ]);
    expect(await provider.listManaged()).toEqual([]);
  });

  test("rejects mismatched resources before lifecycle mutations", async () => {
    const { client, provider } = setup();
    client.resources.set(
      identity.resourceId,
      box(
        identity.resourceId,
        "archived",
        executorMetadata("box", {
          ...identity,
          executorId: "other",
        }),
      ),
    );
    await expect(provider.start(identity)).rejects.toThrow("identity mismatch");
    await expect(provider.stop(identity)).rejects.toThrow("identity mismatch");
    await expect(provider.destroy(identity)).rejects.toThrow(
      "identity mismatch",
    );
    expect(client.resumes).toEqual([]);
    expect(client.archives).toEqual([]);
  });

  test("bounded polling uses the injected clock and sleep", async () => {
    let now = 0;
    let sleeps = 0;
    await expect(
      pollBoxResource({ get: async () => box("a", "archived") }, "a", "awake", {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          sleeps += 1;
        },
        withTimeout: async (operation) => operation,
        timeoutMs: 2,
        intervalMs: 1,
      }),
    ).rejects.toThrow("timed out");
    expect(sleeps).toBe(2);

    let reads = 0;
    await expect(
      pollBoxResource(
        {
          get: async () => {
            reads += 1;
            return box("a", "archived");
          },
        },
        "a",
        "awake",
        {
          now: () => 0,
          sleep: async () => {},
          withTimeout: async (operation) => operation,
          timeoutMs: 2,
          intervalMs: 1,
        },
      ),
    ).rejects.toThrow("timed out");
    expect(reads).toBe(3);
  });

  test("bounds a provider read that never settles", async () => {
    let appliedTimeoutMs = 0;
    await expect(
      pollBoxResource({ get: () => new Promise(() => {}) }, "a", "awake", {
        now: () => 0,
        sleep: async () => {},
        withTimeout: async (_operation, timeoutMs) => {
          appliedTimeoutMs = timeoutMs;
          throw new Error("overall deadline exceeded");
        },
        timeoutMs: 25,
        intervalMs: 5,
      }),
    ).rejects.toThrow("overall deadline exceeded");
    expect(appliedTimeoutMs).toBe(25);
  });

  test("filters malformed, incomplete, legacy, and wrong-provider labels", async () => {
    const { client, provider } = setup();
    client.resources.set("valid", box("valid"));
    client.resources.set("legacy", box("legacy", "live", { sandboxId: "old" }));
    client.resources.set(
      "missing",
      box("missing", "live", {
        ...executorMetadata("box", identity),
        [EXECUTOR_METADATA_KEYS.sessionId]: "",
      }),
    );
    client.resources.set(
      "wrong",
      box("wrong", "live", executorMetadata("modal", identity)),
    );
    expect(await provider.listManaged()).toEqual([
      { ...identity, resourceId: "valid" },
    ]);
  });

  test("validates resource and installed identity before returning", async () => {
    const { client, provider, installs } = setup();
    client.resources.set(identity.resourceId, box());
    await expect(provider.ensureExecutor(identity)).resolves.toEqual({
      executorId: identity.executorId,
      workspaceId: "workspace-box-1",
    });
    expect(installs).toHaveLength(1);

    client.resources.set(
      identity.resourceId,
      box(identity.resourceId, "live", {
        ...executorMetadata("box", identity),
        [EXECUTOR_METADATA_KEYS.executorId]: "other",
      }),
    );
    await expect(provider.ensureExecutor(identity)).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("propagates provider API failures and exposes no arbitrary command API", async () => {
    const { client, provider } = setup();
    client.failure = new Error("Box unavailable");
    await expect(provider.inspect(identity)).rejects.toThrow("Box unavailable");
    expect("exec" in provider).toBe(false);
    expect("runCommand" in provider).toBe(false);
  });
});
