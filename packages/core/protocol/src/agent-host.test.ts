import { describe, expect, test } from "bun:test";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  MAX_AGENT_TRANSCRIPT_APPEND_BYTES,
  MAX_AGENT_TURN_DURATION_MS,
  decodeAgentExecutorAccessGrant,
  encodeAgentExecutorAccessGrant,
  hashAgentHostSupervisionAuthorityV2,
  hashAgentTurnSpecV1,
  decodeAgentHostHello,
  decodeAgentHostSupervisionAuthorityV2,
  decodeAgentHostStartTurn,
  decodeAgentTurnSpec,
  isAgentTurnFence,
  serializeAgentHostSupervisionAuthorityV2,
  type AgentTurnSpec,
} from "./agent-host";
import { decodeExecutorGrant, encodeExecutorGrant } from "./executor";

const now = 1_000;
const accessGrant = encodeAgentExecutorAccessGrant("a".repeat(32));
const spec: AgentTurnSpec = {
  fence: {
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generation: 1,
  },
  input: { prompt: "Run the tests" },
  mode: "code",
  modelPolicy: { model: "example-model" },
  enginePolicy: { engineSessionId: "engine-session-1" },
  mcpPolicy: { servers: [] },
  transcriptPolicy: { maxAppendBytes: 64_000, requireAck: true },
  runPolicy: { classification: "interactive_prompt" },
  identityPolicy: { user: "Ada", mcpGrantUser: "Ada" },
  environmentPolicy: {
    author: { name: "Ada", email: "ada@example.test" },
  },
  workspacePolicy: {
    rootId: "root-1",
    repositoriesNote: "Primary repository: opensession",
  },
  executorPolicy: {
    executorId: "executor-1",
    rootId: "root-1",
    generation: 1,
    accessGrant,
    deadlineMs: now + 60_000,
  },
};

describe("Agent Host protocol", () => {
  test("uses an exact-version handshake", () => {
    const hello = {
      t: "hello" as const,
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: "request-1",
    };
    expect(decodeAgentHostHello(hello)).toEqual(hello);
    expect(decodeAgentHostHello({ ...hello, version: 1 })).toBeUndefined();
    expect(decodeAgentHostHello({ ...hello, extra: true })).toBeUndefined();
  });

  test("fences a turn by exact session, run, turn, and generation", () => {
    const fence = spec.fence;
    expect(isAgentTurnFence(fence)).toBe(true);
    expect(isAgentTurnFence({ ...fence, turnId: "" })).toBe(false);
    expect(isAgentTurnFence({ ...fence, generation: -1 })).toBe(false);
    expect(isAgentTurnFence({ ...fence, model: "forbidden" })).toBe(false);
  });

  test("brands a bounded Agent Host access grant separately", () => {
    const executorGrant = encodeExecutorGrant("e".repeat(32));
    expect(decodeAgentExecutorAccessGrant(accessGrant)).toBe(accessGrant);
    expect(decodeAgentExecutorAccessGrant(executorGrant)).toBeUndefined();
    expect(decodeExecutorGrant(accessGrant)).toBeUndefined();
    expect(decodeExecutorGrant(executorGrant)).toBe(executorGrant);
    expect(decodeAgentExecutorAccessGrant("")).toBeUndefined();
    expect(
      decodeAgentExecutorAccessGrant("x".repeat(16 * 1024 + 1)),
    ).toBeUndefined();
  });

  test("strictly decodes a complete start_turn", () => {
    const message = {
      t: "start_turn" as const,
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: "request-1",
      planHash: `sha256:${"b".repeat(64)}`,
      spec,
    };
    expect(decodeAgentTurnSpec(spec, now)).toEqual(spec);
    expect(decodeAgentHostStartTurn(message, now)).toEqual(message);
    expect(
      decodeAgentHostStartTurn({ ...message, prompt: "forbidden" }, now),
    ).toBeUndefined();
    expect(
      decodeAgentHostStartTurn(
        { ...message, spec: { ...spec, model: "forbidden" } },
        now,
      ),
    ).toBeUndefined();
  });

  test("canonically hashes every execution-relevant turn field", async () => {
    const hash = await hashAgentTurnSpecV1(spec, now);
    expect(await hashAgentTurnSpecV1({ ...spec }, now)).toBe(hash);
    const variants: AgentTurnSpec[] = [
      { ...spec, input: { ...spec.input, prompt: "changed" } },
      { ...spec, modelPolicy: { ...spec.modelPolicy, model: "other-model" } },
      { ...spec, mcpPolicy: { servers: ["other-server"] } },
      {
        ...spec,
        runPolicy: { ...spec.runPolicy, deniedTools: { bash: "no" } },
      },
      { ...spec, environmentPolicy: { ...spec.environmentPolicy, aws: true } },
      {
        ...spec,
        workspacePolicy: { ...spec.workspacePolicy, rootId: "root-2" },
        executorPolicy: { ...spec.executorPolicy, rootId: "root-2" },
      },
      {
        ...spec,
        executorPolicy: {
          ...spec.executorPolicy,
          accessGrant: encodeAgentExecutorAccessGrant("z".repeat(32)),
        },
      },
    ];
    for (const variant of variants)
      expect(await hashAgentTurnSpecV1(variant, now)).not.toBe(hash);
  });

  test("rejects stale, mismatched, malformed, and operation-grant-shaped bindings", () => {
    const replaceExecutorPolicy = (
      executorPolicy: Record<string, unknown>,
    ) => ({
      ...spec,
      executorPolicy,
    });
    expect(
      decodeAgentTurnSpec(
        replaceExecutorPolicy({ ...spec.executorPolicy, deadlineMs: now }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        replaceExecutorPolicy({
          ...spec.executorPolicy,
          deadlineMs: now + MAX_AGENT_TURN_DURATION_MS + 1,
        }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        replaceExecutorPolicy({ ...spec.executorPolicy, generation: 2 }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        replaceExecutorPolicy({ ...spec.executorPolicy, executorId: "bad id" }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        replaceExecutorPolicy({
          ...spec.executorPolicy,
          grant: accessGrant,
          fence: spec.fence,
        }),
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec({ ...spec, executorGrant: accessGrant }, now),
    ).toBeUndefined();
  });

  test("strictly canonicalizes the bounded supervision v2 payload", async () => {
    const authority = decodeAgentHostSupervisionAuthorityV2(
      {
        version: 2,
        fence: spec.fence,
        planHash: `sha256:${"a".repeat(64)}`,
        hostId: "host-1",
        hostGeneration: 1,
        hostIncarnation: "incarnation-00000001",
        supervisorEpoch: 1,
        kernelServiceEpoch: "kernel-service-epoch-1",
        hostChallenge: "challenge-000000000001",
        audience: "opensession-agent-host",
        purpose: "agent-host-supervision",
        issuedAtMs: now,
        expiresAtMs: now + 60_000,
        nonce: "nonce-000000000000001",
        keyId: "future-ed25519-key-1",
      },
      now,
    );
    expect(authority).toBeDefined();
    const bytes = serializeAgentHostSupervisionAuthorityV2(authority!);
    expect(new TextDecoder().decode(bytes)).toContain(
      '"purpose":"agent-host-supervision"',
    );
    expect(await hashAgentHostSupervisionAuthorityV2(authority!)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(
      decodeAgentHostSupervisionAuthorityV2({ ...authority, credential: "no" }),
    ).toBeUndefined();
    expect(
      decodeAgentHostSupervisionAuthorityV2({
        ...authority,
        expiresAtMs: now + MAX_AGENT_TURN_DURATION_MS,
      }),
    ).toBeUndefined();
  });

  test("validates image MIME, canonical base64, and aggregate bytes", () => {
    const image = { mediaType: "image/png", data: btoa("image") };
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          input: { ...spec.input, images: [image] },
        },
        now,
      ),
    ).toBeDefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          input: {
            ...spec.input,
            images: [{ ...image, mediaType: "text/plain" }],
          },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          input: { ...spec.input, images: [{ ...image, data: "aGVsbG8" }] },
        },
        now,
      ),
    ).toBeUndefined();
  });

  test("rejects credential and provider nesting outside named policies", () => {
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          input: { ...spec.input, providerConfig: { apiKey: "secret" } },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          modelPolicy: { ...spec.modelPolicy, accessGrant: "persist-me" },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          mcpPolicy: { ...spec.mcpPolicy, credentials: { token: "secret" } },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          transcriptPolicy: {
            ...spec.transcriptPolicy,
            maxAppendBytes: MAX_AGENT_TRANSCRIPT_APPEND_BYTES + 1,
          },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          workspacePolicy: { rootId: "root-1\u0000escape" },
        },
        now,
      ),
    ).toBeUndefined();
    expect(
      decodeAgentTurnSpec(
        {
          ...spec,
          fence: { ...spec.fence, runId: "run-1\nforged" },
        },
        now,
      ),
    ).toBeUndefined();
  });
});
