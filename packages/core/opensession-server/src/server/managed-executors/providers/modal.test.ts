import { describe, expect, test } from "bun:test";
import {
  mapModalState,
  type ModalClient,
  ModalExecutorProvider,
  modalLifetimeMetadata,
  type ModalResource,
} from "./modal";
import { EXECUTOR_METADATA_KEYS, executorMetadata } from "./shared";

const identity = {
  resourceId: "modal-old",
  executorId: "executor-1",
  sessionId: "session-1",
  generation: 4,
};

class FakeModalClient implements ModalClient {
  resources = new Map<string, ModalResource>();
  creates: Parameters<ModalClient["create"]>[0][] = [];
  terminated: string[] = [];
  createdMetadata?: ModalResource["metadata"];
  failure?: Error;

  async create(input: Parameters<ModalClient["create"]>[0]) {
    this.throwIfFailed();
    this.creates.push(input);
    return modal(
      `modal-${this.creates.length}`,
      "running",
      this.createdMetadata ?? input.tags,
    );
  }
  async get(id: string) {
    this.throwIfFailed();
    return this.resources.get(id);
  }
  async list() {
    this.throwIfFailed();
    return [...this.resources.values()];
  }
  async terminate(id: string) {
    this.throwIfFailed();
    this.terminated.push(id);
    this.resources.delete(id);
  }
  throwIfFailed() {
    if (this.failure) throw this.failure;
  }
}

function modal(
  id = identity.resourceId,
  state = "running",
  metadata = executorMetadata("modal", identity),
): ModalResource {
  return { id, workspaceId: `workspace-${id}`, state, metadata };
}

function setup(
  client = new FakeModalClient(),
  installer = async (resource: ModalResource) => ({
    executorId: identity.executorId,
    workspaceId: resource.workspaceId,
  }),
) {
  return {
    client,
    provider: new ModalExecutorProvider({
      client,
      installExecutor: installer,
      lifetimePolicy: {
        maximumLifetimeMs: 60_000,
        replacementRunwayMs: 10_000,
      },
      now: () => 1_000,
    }),
  };
}

describe("ModalExecutorProvider", () => {
  test("projects bounded lifetime and replacement runway as pure metadata", () => {
    expect(
      modalLifetimeMetadata(1_000, {
        maximumLifetimeMs: 60_000,
        replacementRunwayMs: 10_000,
      }),
    ).toEqual({
      maximumLifetimeMs: 60_000,
      replacementRunwayMs: 10_000,
      createdAtMs: 1_000,
      terminateAtMs: 61_000,
      replacementDeadlineMs: 51_000,
    });
    expect(() =>
      modalLifetimeMetadata(0, {
        maximumLifetimeMs: 10,
        replacementRunwayMs: 10,
      }),
    ).toThrow("shorter than maximum lifetime");
  });

  test("creates with stable tags, no credentials, and provider TTL metadata", async () => {
    const { client, provider } = setup();
    await provider.create(identity);
    expect(client.creates[0]).toEqual({
      tags: executorMetadata("modal", identity),
      lifetime: {
        maximumLifetimeMs: 60_000,
        replacementRunwayMs: 10_000,
        createdAtMs: 1_000,
        terminateAtMs: 61_000,
        replacementDeadlineMs: 51_000,
      },
    });
    expect(client.creates[0]).not.toHaveProperty("checkpoint");
    expect(client.creates[0]).not.toHaveProperty("credentials");
  });

  test("rejects a create response that does not carry the requested identity", async () => {
    const { client, provider } = setup();
    client.createdMetadata = executorMetadata("modal", {
      ...identity,
      executorId: "other",
    });
    await expect(provider.create(identity)).rejects.toThrow(
      "identity mismatch",
    );
  });

  test("stop terminates and start returns a fresh replacement identity", async () => {
    const { client, provider } = setup();
    client.resources.set(identity.resourceId, modal());
    await provider.stop(identity);
    await expect(provider.inspect(identity)).resolves.toEqual({
      state: "missing",
    });
    await expect(provider.start(identity, 5)).resolves.toEqual({
      resourceId: "modal-1",
      workspaceId: "workspace-modal-1",
    });
    expect(client.creates[0]?.tags).toEqual(
      executorMetadata("modal", { ...identity, generation: 5 }),
    );
  });

  test("destroy terminates rather than checkpointing provider state", async () => {
    const { client, provider } = setup();
    client.resources.set(identity.resourceId, modal());
    await provider.destroy(identity);
    expect(client.terminated).toEqual([identity.resourceId]);
  });

  test("rejects mismatched resources before lifecycle mutations", async () => {
    const { client, provider } = setup();
    client.resources.set(
      identity.resourceId,
      modal(
        identity.resourceId,
        "terminated",
        executorMetadata("modal", {
          ...identity,
          sessionId: "other",
        }),
      ),
    );
    await expect(provider.start(identity, 5)).rejects.toThrow(
      "identity mismatch",
    );
    await expect(provider.stop(identity)).rejects.toThrow("identity mismatch");
    await expect(provider.destroy(identity)).rejects.toThrow(
      "identity mismatch",
    );
    expect(client.terminated).toEqual([]);
    expect(client.creates).toEqual([]);
  });

  test("maps terminated and absent resources to missing and fails closed otherwise", () => {
    expect(mapModalState(modal("a", "running"))).toBe("awake");
    expect(mapModalState(modal("a", "terminated"))).toBe("missing");
    expect(mapModalState(undefined)).toBe("missing");
    expect(mapModalState(modal("a", "starting"))).toBe("unknown");
    expect(mapModalState(modal("a", "paused"))).toBe("unknown");
  });

  test("filters malformed and legacy tags", async () => {
    const { client, provider } = setup();
    client.resources.set("valid", modal("valid"));
    client.resources.set(
      "legacy",
      modal("legacy", "running", { sandboxId: "old" }),
    );
    client.resources.set(
      "bad",
      modal("bad", "running", {
        ...executorMetadata("modal", identity),
        [EXECUTOR_METADATA_KEYS.executorId]: " ",
      }),
    );
    expect(await provider.listManaged()).toEqual([
      { ...identity, resourceId: "valid" },
    ]);
  });

  test("validates identity before fixed installation", async () => {
    let calls = 0;
    const { client, provider } = setup(
      new FakeModalClient(),
      async (resource) => {
        calls += 1;
        return {
          executorId: identity.executorId,
          workspaceId: resource.workspaceId,
        };
      },
    );
    client.resources.set(identity.resourceId, modal());
    await provider.ensureExecutor(identity);
    expect(calls).toBe(1);

    client.resources.set(
      identity.resourceId,
      modal(identity.resourceId, "running", {
        ...executorMetadata("modal", identity),
        [EXECUTOR_METADATA_KEYS.generation]: "5",
      }),
    );
    await expect(provider.ensureExecutor(identity)).rejects.toThrow(
      "identity mismatch",
    );
    expect(calls).toBe(1);
  });

  test("propagates API failures and exposes no arbitrary command API", async () => {
    const { client, provider } = setup();
    client.failure = new Error("Modal unavailable");
    await expect(provider.listManaged()).rejects.toThrow("Modal unavailable");
    expect("exec" in provider).toBe(false);
    expect("runCommand" in provider).toBe(false);
  });
});
