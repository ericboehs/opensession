import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
  AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
  encodeAgentExecutorAccessGrant,
  hashAgentTurnSpecV1,
  serializeAgentHostSupervisionAuthorityV2,
  type AgentHostChallengeDescriptorV3,
  type AgentHostSignedAttachReceiptV3,
  type AgentHostSupervisionPublicKeyringV2,
  type AgentTurnFence,
  type AgentTurnSpec,
} from "@tellahq/opensession-protocol";
import { AgentHostClient } from "../server/agent-host-client";
import { createAgentHostSupervisionSigner } from "../server/session-kernel/agent-host-supervision-signer";
import type {
  AgentTurnDriver,
  AgentTurnOutput,
  AgentTurnResult,
} from "./driver";
import { createAgentHost, type AgentHost } from "./host";
import { BoundedNdjsonDecoder, encodeNdjsonFrame } from "./socket-framing";

const hostId = "agent-host-1";
const hostGeneration = 7;
const hostIncarnation = `incarnation-${crypto.randomUUID()}`;
const fence: AgentTurnFence = {
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generation: 3,
};
const accessGrant = encodeAgentExecutorAccessGrant("a".repeat(32));
const spec: AgentTurnSpec = {
  fence,
  input: { prompt: "Build it" },
  mode: "code",
  modelPolicy: { model: "test-model" },
  enginePolicy: {},
  mcpPolicy: { servers: [] },
  transcriptPolicy: { maxAppendBytes: 4096, requireAck: true },
  runPolicy: { classification: "interactive_prompt" },
  identityPolicy: {},
  environmentPolicy: {},
  workspacePolicy: { rootId: "root-1" },
  executorPolicy: {
    executorId: "executor-1",
    rootId: "root-1",
    generation: fence.generation,
    accessGrant,
    deadlineMs: Date.now() + 60 * 60_000,
  },
};
const planHash = await hashAgentTurnSpecV1(spec);

class FakeDriver implements AgentTurnDriver {
  output?: AgentTurnOutput;
  launches = 0;
  steers: string[] = [];
  cancelled = 0;
  private resolve!: (result: AgentTurnResult) => void;
  readonly completion = new Promise<AgentTurnResult>((resolve) => {
    this.resolve = resolve;
  });
  run(_spec: AgentTurnSpec, output: AgentTurnOutput) {
    this.launches++;
    this.output = output;
    return this.completion;
  }
  steer(input: { text: string }) {
    this.steers.push(input.text);
  }
  answer() {}
  transcriptAck() {}
  cancel() {
    this.cancelled++;
  }
  shutdown() {}
  finish(result: AgentTurnResult = { status: "completed" }) {
    this.resolve(result);
  }
}

function signingFixture(keyId = "supervision-key-01") {
  const now = Date.now();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const signingNotBeforeMs = now - 60_000;
  const signingNotAfterMs = now + 60 * 60_000;
  const verifyUntilMs = now + 2 * 60 * 60_000;
  const signer = createAgentHostSupervisionSigner({
    keyId,
    privateKeyPkcs8: Uint8Array.from(pkcs8),
    publicKeySpki: Uint8Array.from(spki),
    signingNotBeforeMs,
    signingNotAfterMs,
    verifyUntilMs,
    status: "active",
  });
  const keyring: AgentHostSupervisionPublicKeyringV2 = Object.freeze({
    version: 2,
    algorithm: AGENT_HOST_SUPERVISION_SIGNATURE_ALGORITHM,
    domain: AGENT_HOST_SUPERVISION_SIGNATURE_DOMAIN,
    keys: Object.freeze([
      Object.freeze({
        keyId,
        status: "active" as const,
        publicKeySpki: spki.toString("base64url"),
        signingNotBeforeMs,
        signingNotAfterMs,
        verifyUntilMs,
      }),
    ]),
  });
  let epoch = 0;
  const obtain = async (
    challenge: Readonly<AgentHostChallengeDescriptorV3>,
    requested: Readonly<{ fence: AgentTurnFence; planHash: string }>,
    mutate?: (
      receipt: AgentHostSignedAttachReceiptV3,
    ) => AgentHostSignedAttachReceiptV3,
  ) => {
    epoch++;
    const issuedAtMs = Date.now();
    const expiresAtMs = issuedAtMs + 60_000;
    const expected = Object.freeze({
      fence: Object.freeze({ ...requested.fence }),
      planHash: requested.planHash,
      ...challenge,
      supervisorEpoch: epoch,
      kernelServiceEpoch: `kernel-${epoch}`,
      nonce: `nonce-${crypto.randomUUID()}`,
      audience: AGENT_HOST_SUPERVISION_AUDIENCE,
      purpose: AGENT_HOST_SUPERVISION_PURPOSE,
      keyId,
      issuedAtMs,
      expiresAtMs,
    });
    const envelope = signer.sign(
      serializeAgentHostSupervisionAuthorityV2({
        version: 2,
        ...expected,
      }),
      issuedAtMs,
    );
    const receipt = Object.freeze({ expected, envelope });
    return mutate ? mutate(receipt) : receipt;
  };
  return { keyring, obtain };
}

const resources: Array<{ host: AgentHost; dir: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.host.stop();
    await rm(resource.dir, { recursive: true, force: true });
  }
});

async function setup(
  override: Partial<Parameters<typeof createAgentHost>[0]> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "agent-host-v3-test-"));
  const socketPath = join(dir, "host.sock");
  const driver = new FakeDriver();
  const signing = signingFixture();
  const host = createAgentHost({
    socketPath,
    createDriver: () => driver,
    hostId,
    hostGeneration,
    hostIncarnation,
    supervisionKeyring: signing.keyring,
    ...override,
  });
  resources.push({ host, dir });
  await host.start();
  return { host, driver, socketPath, ...signing };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function raw(
  socketPath: string,
): Promise<{ socket: Socket; messages: unknown[] }> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const messages: unknown[] = [];
    const decoder = new BoundedNdjsonDecoder();
    socket.on("data", (chunk) =>
      messages.push(...decoder.push(Buffer.from(chunk))),
    );
    socket.once("connect", () => resolve({ socket, messages }));
  });
}

function send(socket: Socket, value: unknown) {
  socket.write(encodeNdjsonFrame(value));
}

describe("Agent Host protocol v3 signed attach", () => {
  test("performs exact hello, real signed attach, start, control, and finish", async () => {
    const { socketPath, driver, obtain } = await setup();
    const seen: string[] = [];
    const client = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
      onMessage: (message) => seen.push(message.t),
    });
    await client.connect(fence, planHash);
    await client.startTurn(spec);
    client.steer("continue", "steer-1");
    await tick();
    expect(driver.launches).toBe(1);
    expect(driver.steers).toEqual(["continue"]);
    driver.output!.event({ type: "text_chunk", text: "ok" });
    driver.finish();
    await tick();
    expect(seen).toEqual(["event", "turn_finished"]);
    client.close();
  });

  test("v2, malformed frames, and start/control before attach close the socket", async () => {
    const { socketPath } = await setup();
    for (const frame of [
      { t: "hello", version: 2, requestId: "old-request" },
      {
        t: "start_turn",
        version: 3,
        requestId: "start-request",
        planHash,
        spec,
      },
      { t: "cancel", version: 3, requestId: "cancel-request", fence },
      { nope: true },
    ]) {
      const connection = await raw(socketPath);
      send(connection.socket, frame);
      await new Promise<void>((resolve) =>
        connection.socket.once("close", resolve),
      );
    }
  });

  test("resets the start deadline after a slow successful verification", async () => {
    const delayed = signingFixture();
    const { socketPath, driver } = await setup({
      supervisionKeyring: delayed.keyring,
      attachDeadlineMs: 80,
    });
    const client = new AgentHostClient({
      socketPath,
      obtainSignedAttach: async (challenge, requested) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return delayed.obtain(challenge, requested);
      },
    });
    await client.connect(fence, planHash);
    await client.startTurn(spec);
    expect(driver.launches).toBe(1);
    driver.finish();
    client.close();
  });

  test("returns a fresh socket-bound challenge and rejects envelope replay", async () => {
    const { socketPath, obtain } = await setup();
    let firstReceipt: AgentHostSignedAttachReceiptV3 | undefined;
    let firstChallenge = "";
    const first = new AgentHostClient({
      socketPath,
      obtainSignedAttach: async (challenge, requested) => {
        firstChallenge = challenge.hostChallenge;
        firstReceipt = await obtain(challenge, requested);
        return firstReceipt;
      },
    });
    await first.connect(fence, planHash);
    first.close();
    await tick();
    let secondChallenge = "";
    const second = new AgentHostClient({
      socketPath,
      obtainSignedAttach: async (challenge) => {
        secondChallenge = challenge.hostChallenge;
        return firstReceipt!;
      },
    });
    await expect(second.connect(fence, planHash)).rejects.toThrow();
    expect(secondChallenge).not.toBe(firstChallenge);
  });

  test("consumes a challenge on every failed attach and never launches a driver", async () => {
    const { socketPath, obtain, driver } = await setup();
    const mutations: Array<
      (r: AgentHostSignedAttachReceiptV3) => AgentHostSignedAttachReceiptV3
    > = [
      ...(["sessionId", "runId", "turnId"] as const).map(
        (field) => (r: AgentHostSignedAttachReceiptV3) => ({
          ...r,
          expected: {
            ...r.expected,
            fence: { ...r.expected.fence, [field]: `other-${field}` },
          },
        }),
      ),
      (r) => ({
        ...r,
        expected: {
          ...r.expected,
          fence: {
            ...r.expected.fence,
            generation: r.expected.fence.generation + 1,
          },
        },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, planHash: `sha256:${"c".repeat(64)}` },
      }),
      (r) => ({ ...r, expected: { ...r.expected, hostId: "other-host" } }),
      (r) => ({
        ...r,
        expected: { ...r.expected, hostGeneration: hostGeneration + 1 },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, hostIncarnation: "other-incarnation" },
      }),
      (r) => ({
        ...r,
        expected: {
          ...r.expected,
          hostChallenge: `challenge-${crypto.randomUUID()}`,
        },
      }),
      (r) => ({
        ...r,
        expected: {
          ...r.expected,
          supervisorEpoch: r.expected.supervisorEpoch + 1,
        },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, kernelServiceEpoch: "other-kernel" },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, nonce: `other-${crypto.randomUUID()}` },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, audience: "other-audience" as never },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, purpose: "other-purpose" as never },
      }),
      (r) => ({ ...r, expected: { ...r.expected, keyId: "unknown-key-0001" } }),
      (r) => ({
        ...r,
        expected: { ...r.expected, issuedAtMs: r.expected.issuedAtMs + 1 },
      }),
      (r) => ({
        ...r,
        expected: { ...r.expected, expiresAtMs: r.expected.expiresAtMs + 1 },
      }),
      (r) => ({
        ...r,
        envelope: { ...r.envelope, signature: `${"A".repeat(85)}A` },
      }),
      (r) => ({
        ...r,
        envelope: { ...r.envelope, domain: "wrong-domain" as never },
      }),
      (r) => ({
        ...r,
        envelope: { ...r.envelope, algorithm: "wrong" as never },
      }),
    ];
    for (const mutate of mutations) {
      const client = new AgentHostClient({
        socketPath,
        obtainSignedAttach: (challenge, requested) =>
          obtain(challenge, requested, mutate),
      });
      await expect(client.connect(fence, planHash)).rejects.toThrow();
    }
    expect(driver.launches).toBe(0);
  }, 15_000);

  test("rejects a changed execution spec after signed attach", async () => {
    const { socketPath, obtain, driver } = await setup();
    const client = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
    });
    await client.connect(fence, planHash);
    await expect(
      client.startTurn({
        ...spec,
        input: { ...spec.input, prompt: "Changed after authorization" },
      }),
    ).rejects.toThrow();
    expect(driver.launches).toBe(0);
  });

  test("rejects an older per-session supervisor epoch across turn lineages", async () => {
    const drivers = [new FakeDriver(), new FakeDriver()];
    let created = 0;
    const { socketPath, obtain } = await setup({
      createDriver: () => drivers[created++]!,
    });
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let oldReceiptReady!: () => void;
    const receiptReady = new Promise<void>((resolve) => {
      oldReceiptReady = resolve;
    });
    const oldClient = new AgentHostClient({
      socketPath,
      obtainSignedAttach: async (challenge, requested) => {
        const receipt = await obtain(challenge, requested);
        oldReceiptReady();
        await oldGate;
        return receipt;
      },
    });
    const oldConnect = oldClient.connect(fence, planHash);
    await receiptReady;

    const newerFence = { ...fence, turnId: "turn-2" };
    const newerSpec: AgentTurnSpec = {
      ...spec,
      fence: newerFence,
      executorPolicy: { ...spec.executorPolicy },
    };
    const newerPlanHash = await hashAgentTurnSpecV1(newerSpec);
    const newerClient = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
    });
    await newerClient.connect(newerFence, newerPlanHash);
    await newerClient.startTurn(newerSpec);
    drivers[0]!.finish();
    await tick();
    newerClient.close();

    releaseOld();
    await expect(oldConnect).rejects.toThrow();
    expect(created).toBe(1);
  });

  test("rejects unknown, expired, and retired public verification keys", async () => {
    const unknown = signingFixture();
    const unknownRing = {
      ...unknown.keyring,
      keys: [{ ...unknown.keyring.keys[0]!, keyId: "different-key-001" }],
    } as AgentHostSupervisionPublicKeyringV2;
    const unknownHost = await setup({ supervisionKeyring: unknownRing });
    await expect(
      new AgentHostClient({
        socketPath: unknownHost.socketPath,
        obtainSignedAttach: unknown.obtain,
      }).connect(fence, planHash),
    ).rejects.toThrow();

    const expired = signingFixture();
    const expiredHost = await setup({
      supervisionKeyring: expired.keyring,
      now: () => Date.now() + 2 * 60_000,
    });
    await expect(
      new AgentHostClient({
        socketPath: expiredHost.socketPath,
        obtainSignedAttach: expired.obtain,
      }).connect(fence, planHash),
    ).rejects.toThrow();

    const retired = signingFixture();
    const active = signingFixture("supervision-key-02");
    const retiredKey = retired.keyring.keys[0]!;
    const retiredRing = {
      ...retired.keyring,
      keys: [
        { ...retiredKey, status: "retiring" as const },
        active.keyring.keys[0]!,
      ],
    } as AgentHostSupervisionPublicKeyringV2;
    const retiredHost = await setup({
      supervisionKeyring: retiredRing,
      now: () => retiredKey.verifyUntilMs + 1,
    });
    await expect(
      new AgentHostClient({
        socketPath: retiredHost.socketPath,
        obtainSignedAttach: retired.obtain,
      }).connect(fence, planHash),
    ).rejects.toThrow();
  });

  test("forbids active-owner overlap and permits takeover only after release with fresh authority", async () => {
    const drivers = [new FakeDriver(), new FakeDriver()];
    let created = 0;
    const { socketPath, obtain } = await setup({
      createDriver: () => drivers[created++]!,
    });
    const first = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
    });
    await first.connect(fence, planHash);
    await first.startTurn(spec);
    const contender = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
    });
    await expect(contender.connect(fence, planHash)).rejects.toThrow();
    expect(drivers[0]!.launches).toBe(1);
    first.close();
    drivers[0]!.finish({ status: "cancelled" });
    await tick();

    const successor = new AgentHostClient({
      socketPath,
      obtainSignedAttach: obtain,
    });
    await successor.connect(fence, planHash);
    await successor.startTurn(spec);
    expect(drivers[1]!.launches).toBe(1);
    drivers[1]!.finish();
    successor.close();
  });

  test("a new Host incarnation requires fresh signed authority", async () => {
    const first = await setup();
    let staleReceipt: AgentHostSignedAttachReceiptV3 | undefined;
    const client = new AgentHostClient({
      socketPath: first.socketPath,
      obtainSignedAttach: async (challenge, requested) => {
        staleReceipt = await first.obtain(challenge, requested);
        return staleReceipt;
      },
    });
    await client.connect(fence, planHash);
    client.close();

    const second = await setup({
      hostIncarnation: `incarnation-${crypto.randomUUID()}`,
    });
    await expect(
      new AgentHostClient({
        socketPath: second.socketPath,
        obtainSignedAttach: async () => staleReceipt!,
      }).connect(fence, planHash),
    ).rejects.toThrow();
    const fresh = new AgentHostClient({
      socketPath: second.socketPath,
      obtainSignedAttach: second.obtain,
    });
    await fresh.connect(fence, planHash);
    fresh.close();
  });

  test("shares one concurrent connect and attach promise", async () => {
    const { socketPath, obtain } = await setup();
    let calls = 0;
    const client = new AgentHostClient({
      socketPath,
      obtainSignedAttach: async (...args) => {
        calls++;
        return obtain(...args);
      },
    });
    const a = client.connect(fence, planHash);
    const b = client.connect(fence, planHash);
    expect(a).toBe(b);
    await a;
    expect(calls).toBe(1);
    client.close();
  });

  test("start timeout poisons the connection and ignores a late acknowledgement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-host-client-timeout-"));
    const socketPath = join(dir, "host.sock");
    const sockets = new Set<Socket>();
    let connectionNumber = 0;
    const server = createServer((socket) => {
      sockets.add(socket);
      connectionNumber += 1;
      const thisConnection = connectionNumber;
      const decoder = new BoundedNdjsonDecoder();
      socket.on("data", (chunk) => {
        for (const value of decoder.push(Buffer.from(chunk))) {
          const message = value as { t: string; requestId: string };
          if (message.t === "hello")
            send(socket, {
              t: "hello",
              version: 3,
              requestId: message.requestId,
              accepted: true,
              hostId,
              hostGeneration,
              hostIncarnation,
              hostChallenge: `challenge-${crypto.randomUUID()}`,
            });
          else if (message.t === "attach")
            send(socket, {
              t: "attached",
              version: 3,
              requestId: message.requestId,
              fence,
              planHash,
              supervisorEpoch: thisConnection === 1 ? 2 : 1,
            });
          else if (message.t === "start_turn")
            setTimeout(
              () =>
                send(socket, {
                  t: "turn_started",
                  version: 3,
                  requestId: message.requestId,
                  fence,
                }),
              100,
            );
        }
      });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const options = {
        socketPath,
        timeoutMs: 20,
        obtainSignedAttach: async () => ({
          expected: { supervisorEpoch: 1 } as never,
          envelope: {} as never,
        }),
      };
      await expect(
        new AgentHostClient(options).connect(fence, planHash),
      ).rejects.toThrow("mismatched attach acknowledgement");
      const client = new AgentHostClient(options);
      await client.connect(fence, planHash);
      await expect(client.startTurn(spec)).rejects.toThrow("timed out");
      await tick();
      expect(() => client.steer("late", "late-steer")).toThrow();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps private credentials and kernel stores outside Host and client source", async () => {
    const hostSource = await readFile(
      new URL("./host.ts", import.meta.url),
      "utf8",
    );
    const clientSource = await readFile(
      new URL("../server/agent-host-client.ts", import.meta.url),
      "utf8",
    );
    expect(hostSource).not.toMatch(
      /supervision-signer|session-kernel\/store|privateKey/,
    );
    expect(clientSource).not.toMatch(
      /privateKey|providerConfig|mcpConfig|session-kernel\/store/,
    );
  });

  test("attach timeout closes the unused challenge", async () => {
    const { socketPath } = await setup({ attachDeadlineMs: 20 });
    const connection = await raw(socketPath);
    send(connection.socket, {
      t: "hello",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: "hello-timeout",
    });
    await new Promise<void>((resolve) =>
      connection.socket.once("close", resolve),
    );
  });
});
