import { describe, expect, test } from "bun:test";
import {
  EXECUTOR_PROTOCOL_VERSION,
  decodeExecutorGrant,
  encodeExecutorGrant,
  type ExecutorCapability,
  type ExecutorGrant,
} from "@tellahq/opensession-protocol/executor";
import { RemoteExecutorRegistry } from "./remote-registry";
import {
  EXECUTOR_GENERATION_HEADER,
  EXECUTOR_ID_HEADER,
  EXECUTOR_SOURCE_HEADER,
  ExecutorIngress,
  type ExecutorAuthority,
  type ExecutorUpgradeData,
} from "./ingress";

class Socket {
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  constructor(readonly data: ExecutorUpgradeData) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }
}

const grant = encodeExecutorGrant("e".repeat(32));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const hello = (
  executorId = "runner-1",
  generation = 1,
  instanceId = "instance-1",
  capabilities: ExecutorCapability[] = ["fs"],
) => ({
  t: "hello",
  version: EXECUTOR_PROTOCOL_VERSION,
  requestId: "hello-1",
  executorId,
  instanceId,
  generation,
  capabilities,
});

function request(
  token: string | undefined = "secret-token",
  overrides: {
    source?: "runner" | "managed";
    id?: string;
    generation?: number;
    url?: string;
    cookie?: string;
  } = {},
): Request {
  const headers = new Headers({
    connection: "Upgrade",
    upgrade: "websocket",
    [EXECUTOR_SOURCE_HEADER]: overrides.source ?? "runner",
    [EXECUTOR_ID_HEADER]: overrides.id ?? "runner-1",
    [EXECUTOR_GENERATION_HEADER]: String(overrides.generation ?? 1),
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (overrides.cookie) headers.set("cookie", overrides.cookie);
  return new Request(overrides.url ?? "http://local/executor/connect", {
    headers,
  });
}

function setup(
  options: {
    helloTimeoutMs?: number;
    claimTimeoutMs?: number;
    upgradeTimeoutMs?: number;
    maxPendingUpgrades?: number;
    createId?: () => string;
    claimInstance?: ExecutorAuthority["claimInstance"];
  } = {},
) {
  const registry = new RemoteExecutorRegistry();
  const consumed = new Set<string>();
  const claimed = new Map<string, { generation: number; instanceId: string }>();
  const authCalls: unknown[] = [];
  let nextId = 0;
  const authority = (
    executorId: string,
    generation: number,
    capabilities: ExecutorCapability[] = ["fs"],
  ): ExecutorAuthority => ({
    executorId,
    generation,
    capabilities,
    claimInstance:
      options.claimInstance ??
      ((claim) => {
        const prior = claimed.get(claim.executorId);
        if (
          prior &&
          (claim.generation < prior.generation ||
            (claim.generation === prior.generation &&
              claim.instanceId !== prior.instanceId))
        )
          return false;
        claimed.set(claim.executorId, {
          generation: claim.generation,
          instanceId: claim.instanceId,
        });
        return true;
      }),
    resolveGrant: () => grant,
    resolveCleanupGrant: () => grant,
  });
  const ingress = new ExecutorIngress({
    registry,
    createId: options.createId ?? (() => `connection-${++nextId}`),
    now: () => 1_000,
    timers: {
      setTimeout: (callback, milliseconds) =>
        setTimeout(callback, milliseconds),
      clearTimeout: (timer) =>
        clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
    rateLimit: ({ executorId }) => executorId !== "limited",
    authenticateRunner: (input) => {
      authCalls.push(input);
      if (input.remoteAddress !== "100.64.0.1")
        return { ok: false, status: 403 };
      if (input.token !== "secret-token") return { ok: false, status: 401 };
      return { ok: true, authority: authority(input.runnerId, 1) };
    },
    consumeManagedEnrollment: (token, fence) => {
      if (token === "expired") {
        consumed.add(token);
        return { ...fence, expiresAtMs: 999 };
      }
      if (token === "record-mismatch") {
        consumed.add(token);
        return { ...fence, executorId: "other", expiresAtMs: 2_000 };
      }
      if (
        token !== `enroll-${fence.executorId}-${fence.generation}` ||
        consumed.has(token)
      )
        throw new Error("invalid or expired");
      consumed.add(token);
      return { ...fence, expiresAtMs: 2_000 };
    },
    authorizeManaged: ({ executorId, generation }) =>
      executorId === "not-connectable"
        ? undefined
        : authority(executorId, generation, ["fs", "process"]),
    connectionPolicy: {
      helloTimeoutMs: options.helloTimeoutMs ?? 50,
      claimTimeoutMs: options.claimTimeoutMs,
      upgradeTimeoutMs: options.upgradeTimeoutMs,
      maxPendingUpgrades: options.maxPendingUpgrades,
    },
  });
  return { ingress, registry, authCalls, consumed };
}

async function upgrade(
  ingress: ExecutorIngress,
  req = request(),
  address = "100.64.0.1",
): Promise<{
  response?: Response;
  socket?: Socket;
  data?: ExecutorUpgradeData;
}> {
  let data: ExecutorUpgradeData | undefined;
  const response = await ingress.handleUpgrade(
    req,
    {
      upgrade: (_request, options) => {
        data = options.data;
        return true;
      },
    },
    address,
  );
  if (!data) return { response };
  const socket = new Socket(data);
  ingress.websocket.open(socket);
  return { response, socket, data };
}

async function sendHello(
  ingress: ExecutorIngress,
  socket: Socket,
  value: unknown,
): Promise<void> {
  ingress.websocket.message(socket, JSON.stringify(value));
  await tick();
  await tick();
}

describe("Executor ingress HTTP authentication", () => {
  test("requires an exact upgrade and Authorization bearer, refusing query and cookie substitutes", async () => {
    const { ingress } = setup();
    expect((await upgrade(ingress, request(""))).response?.status).toBe(401);
    expect(
      (await upgrade(ingress, request("", { cookie: "token=secret-token" })))
        .response?.status,
    ).toBe(401);
    expect(
      (
        await upgrade(
          ingress,
          request("secret-token", {
            url: "http://local/executor/connect?token=x",
          }),
        )
      ).response?.status,
    ).toBe(400);
    expect(
      (
        await ingress.handleUpgrade(
          new Request("http://local/executor/connect"),
          { upgrade: () => true },
        )
      )?.status,
    ).toBe(400);
    const lowercase = request();
    lowercase.headers.set("authorization", "bEaReR secret-token");
    expect((await upgrade(ingress, lowercase)).response).toBeUndefined();
    const multiple = request();
    multiple.headers.set("authorization", "Bearer secret-token,Basic other");
    expect((await upgrade(ingress, multiple)).response?.status).toBe(401);
  });

  test("passes exact runner identity, generation, bearer, and socket peer to injected auth", async () => {
    const { ingress, authCalls } = setup();
    expect(
      (await upgrade(ingress, request(), "203.0.113.2")).response?.status,
    ).toBe(403);
    expect((await upgrade(ingress, request("wrong"))).response?.status).toBe(
      401,
    );
    const accepted = await upgrade(ingress);
    expect(accepted.response).toBeUndefined();
    expect(authCalls.at(-1)).toEqual({
      runnerId: "runner-1",
      generation: 1,
      token: "secret-token",
      remoteAddress: "100.64.0.1",
    });
    expect(JSON.stringify(accepted.data)).not.toContain("secret-token");
    expect(Object.keys(accepted.data!).sort()).toEqual([
      "connectionId",
      "executorId",
      "generation",
      "source",
    ]);
  });

  test("rate limits without authenticating and maps failed upgrade to 400", async () => {
    const { ingress, authCalls } = setup();
    expect(
      (await upgrade(ingress, request("secret-token", { id: "limited" })))
        .response?.status,
    ).toBe(429);
    expect(authCalls).toHaveLength(0);
    const response = await ingress.handleUpgrade(
      request(),
      { upgrade: () => false },
      "100.64.0.1",
    );
    expect(response?.status).toBe(400);
  });

  test("bounds pending upgrades, expires reservations, and refuses connection ID collisions", async () => {
    const bounded = setup({ maxPendingUpgrades: 1, upgradeTimeoutMs: 50 });
    expect(
      await bounded.ingress.handleUpgrade(
        request(),
        { upgrade: () => true },
        "100.64.0.1",
      ),
    ).toBeUndefined();
    expect(
      (
        await bounded.ingress.handleUpgrade(
          request(),
          { upgrade: () => true },
          "100.64.0.1",
        )
      )?.status,
    ).toBe(429);

    const colliding = setup({
      createId: () => "same-connection",
      maxPendingUpgrades: 2,
      upgradeTimeoutMs: 5,
    });
    expect(
      await colliding.ingress.handleUpgrade(
        request(),
        { upgrade: () => true },
        "100.64.0.1",
      ),
    ).toBeUndefined();
    expect(
      (
        await colliding.ingress.handleUpgrade(
          request(),
          { upgrade: () => true },
          "100.64.0.1",
        )
      )?.status,
    ).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      await colliding.ingress.handleUpgrade(
        request(),
        { upgrade: () => true },
        "100.64.0.1",
      ),
    ).toBeUndefined();
    colliding.ingress.shutdown();
    bounded.ingress.shutdown();
  });

  test("burns managed enrollment before lifecycle checks and refuses replay, expiry, and record mismatch", async () => {
    const { ingress, consumed } = setup();
    const blocked = request("enroll-not-connectable-2", {
      source: "managed",
      id: "not-connectable",
      generation: 2,
    });
    expect((await upgrade(ingress, blocked)).response?.status).toBe(403);
    expect(consumed.has("enroll-not-connectable-2")).toBe(true);
    expect((await upgrade(ingress, blocked)).response?.status).toBe(401);
    expect(
      (await upgrade(ingress, request("expired", { source: "managed" })))
        .response?.status,
    ).toBe(401);
    expect(
      (
        await upgrade(
          ingress,
          request("record-mismatch", { source: "managed" }),
        )
      ).response?.status,
    ).toBe(403);
  });
});

describe("Executor ingress socket lifecycle", () => {
  test("burns accepted managed enrollment when hello later fails", async () => {
    const { ingress } = setup();
    const enrollment = request("enroll-managed-1-1", {
      source: "managed",
      id: "managed-1",
    });
    const accepted = await upgrade(ingress, enrollment);
    await sendHello(ingress, accepted.socket!, {
      ...hello("managed-1"),
      version: 1,
    });
    expect(accepted.socket!.closes.length).toBeGreaterThan(0);
    expect((await upgrade(ingress, enrollment)).response?.status).toBe(401);
  });

  test("replaces the hello deadline with a bounded claim reservation and fences late claims", async () => {
    const delayed = setup({
      helloTimeoutMs: 5,
      claimTimeoutMs: 40,
      claimInstance: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return true;
      },
    });
    const healthy = await upgrade(delayed.ingress);
    await sendHello(delayed.ingress, healthy.socket!, hello());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delayed.registry.get("runner-1")?.isReady).toBe(true);
    expect(healthy.socket!.closes).toHaveLength(0);

    let release!: (claimed: boolean) => void;
    const stalled = setup({
      helloTimeoutMs: 5,
      claimTimeoutMs: 5,
      claimInstance: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const late = await upgrade(stalled.ingress);
    stalled.ingress.websocket.message(late.socket!, JSON.stringify(hello()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late.socket!.closes.at(-1)?.[1]).toContain("claim timed out");
    release(true);
    await tick();
    expect(stalled.registry.get("runner-1")).toBeUndefined();
  });

  test("accepts only exact, policy-bounded hello before exposing a ready remote", async () => {
    const { ingress, registry } = setup();
    const { socket } = await upgrade(ingress);
    expect(registry.get("runner-1")).toBeUndefined();
    await sendHello(ingress, socket!, hello());
    expect(registry.get("runner-1")?.isReady).toBe(true);
    expect(JSON.parse(socket!.sent[0])).toMatchObject({
      t: "hello",
      accepted: true,
    });
    ingress.websocket.message(socket!, JSON.stringify(hello()));
    await tick();
    expect(socket!.closes.at(-1)?.[1]).toContain(
      "remote executor disconnected",
    );
  });

  test("rejects unsupported, malformed, forbidden, mismatched, escalating, oversized, and binary hello", async () => {
    const cases: unknown[] = [
      { ...hello(), version: EXECUTOR_PROTOCOL_VERSION - 1 },
      { t: "hello" },
      { ...hello(), enrollmentToken: "forbidden" },
      hello("wrong"),
      hello("runner-1", 2),
      hello("runner-1", 1, "instance-1", ["portal"]),
    ];
    for (const value of cases) {
      const { ingress, registry } = setup();
      const { socket } = await upgrade(ingress);
      await sendHello(ingress, socket!, value);
      expect(socket!.closes.length).toBeGreaterThan(0);
      expect(registry.get("runner-1")).toBeUndefined();
    }
    const binarySetup = setup();
    const binary = await upgrade(binarySetup.ingress);
    binarySetup.ingress.websocket.message(binary.socket!, new Uint8Array([1]));
    expect(binary.socket!.closes.at(-1)?.[0]).toBe(1003);

    const largeIngress = setup();
    const large = await upgrade(largeIngress.ingress);
    largeIngress.ingress.websocket.message(
      large.socket!,
      "x".repeat(1_048_577),
    );
    expect(large.socket!.closes.at(-1)?.[0]).toBe(1009);
  });

  test("rejects work racing an unresolved instance claim", async () => {
    const { ingress } = setup();
    const { socket } = await upgrade(ingress);
    ingress.websocket.message(socket!, JSON.stringify(hello()));
    ingress.websocket.message(
      socket!,
      JSON.stringify({ t: "receipt", requestId: "x" }),
    );
    await tick();
    expect(socket!.closes.length).toBeGreaterThan(0);
  });

  test("enforces hello deadline", async () => {
    const { ingress } = setup({ helloTimeoutMs: 5 });
    const { socket } = await upgrade(ingress);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(socket!.closes.at(-1)?.[1]).toContain("hello timed out");
    expect(ingress.size).toBe(0);
  });

  test("allows exact reconnect, rejects simultaneous duplicate, and fences higher generation", async () => {
    const { ingress, registry } = setup();
    const first = await upgrade(ingress);
    await sendHello(ingress, first.socket!, hello());

    const duplicate = await upgrade(ingress);
    await sendHello(ingress, duplicate.socket!, hello());
    expect(duplicate.socket!.closes.at(-1)?.[1]).toContain("duplicate");
    expect(registry.get("runner-1")?.identity.instanceId).toBe("instance-1");

    ingress.websocket.close(first.socket!, 1000, "gone");
    const reconnect = await upgrade(ingress);
    await sendHello(ingress, reconnect.socket!, hello());
    expect(registry.get("runner-1")?.identity.instanceId).toBe("instance-1");

    const managed = await upgrade(
      ingress,
      request("enroll-runner-1-2", {
        source: "managed",
        id: "runner-1",
        generation: 2,
      }),
    );
    await sendHello(
      ingress,
      managed.socket!,
      hello("runner-1", 2, "instance-2", ["fs"]),
    );
    expect(reconnect.socket!.closes.length).toBeGreaterThan(0);
    expect(registry.get("runner-1")?.identity).toMatchObject({
      generation: 2,
      instanceId: "instance-2",
    });
    ingress.websocket.close(reconnect.socket!, 1000, "stale close");
    expect(registry.get("runner-1")?.identity.generation).toBe(2);
  });

  test("ignores delayed callbacks from an old physical socket after ID reuse", async () => {
    const { ingress, registry } = setup({ createId: () => "reused-id" });
    const first = await upgrade(ingress);
    await sendHello(ingress, first.socket!, hello());
    ingress.websocket.close(first.socket!, 1000, "gone");

    const successor = await upgrade(ingress);
    await sendHello(ingress, successor.socket!, hello());
    expect(registry.get("runner-1")?.isReady).toBe(true);

    ingress.websocket.message(first.socket!, new Uint8Array([1]));
    ingress.websocket.close(first.socket!, 1000, "delayed old close");
    await tick();
    expect(successor.socket!.closes).toHaveLength(0);
    expect(registry.get("runner-1")?.isReady).toBe(true);
  });

  test("rejects a different instance at the same durable generation", async () => {
    const { ingress, registry } = setup();
    const first = await upgrade(ingress);
    await sendHello(ingress, first.socket!, hello());
    ingress.websocket.close(first.socket!, 1000, "gone");
    const other = await upgrade(ingress);
    await sendHello(ingress, other.socket!, hello("runner-1", 1, "other"));
    expect(other.socket!.closes.at(-1)?.[1]).toContain("claim");
    expect(registry.get("runner-1")).toBeUndefined();
  });

  test("shutdown closes sockets, unregisters pending work, and rejects new upgrades", async () => {
    const { ingress, registry } = setup();
    const connected = await upgrade(ingress);
    await sendHello(ingress, connected.socket!, hello());
    ingress.shutdown();
    ingress.shutdown();
    expect(connected.socket!.closes.length).toBeGreaterThan(0);
    expect(registry.get("runner-1")).toBeUndefined();
    expect((await upgrade(ingress)).response?.status).toBe(403);
  });
});
