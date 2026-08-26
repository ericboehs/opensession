/**
 * Local Unix-socket contract between the control plane and an Agent Host.
 *
 * The Agent Host owns one model turn loop. It receives bounded, serializable
 * policy and a turn-scoped control-plane dispatch capability, but never an
 * Executor operation grant and never provisions or destroys an Executor.
 */

import type { ImageInput, StreamEvent } from "./events";
import type { GitIdentity } from "./identity";
import { decodeExecutorGrant, decodeExecutorId } from "./executor";
import type { AskResult } from "./runner";
import type { TranscriptEntry } from "./session";
import type {
  ExpectedAgentHostSupervisionBindingsV3,
  SignedAgentHostSupervisionEnvelopeV1,
} from "./agent-host-supervision";

export const AGENT_HOST_PROTOCOL_VERSION = 3 as const;
/** Durable authority payload version consumed by the exact v3 attach wire. */
export const AGENT_HOST_SUPERVISION_VERSION = 2 as const;
export const AGENT_HOST_SUPERVISION_AUDIENCE =
  "opensession-agent-host" as const;
export const AGENT_HOST_SUPERVISION_PURPOSE = "agent-host-supervision" as const;
export const MAX_AGENT_HOST_SUPERVISION_LEASE_MS = 5 * 60_000;
export const MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS = 30_000;

const MAX_CAPABILITY_BYTES = 16 * 1024;
const MAX_SHORT_TEXT_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 768 * 1024;
const MAX_REPOSITORIES_NOTE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024;
const MAX_IMAGES_BYTES = 128 * 1024;
const MAX_IMAGES = 32;
const MAX_MCP_SERVERS = 1_024;
const MAX_TOOL_RULES = 4_096;
export const MAX_AGENT_TRANSCRIPT_APPEND_BYTES = 768 * 1024;
export const MAX_AGENT_TURN_DURATION_MS = 24 * 60 * 60_000;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const NUL_RE = /\u0000/;
const textEncoder = new TextEncoder();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const boundedString = (
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  (allowEmpty || value.length > 0) &&
  textEncoder.encode(value).byteLength <= maxBytes;
const boundedName = (
  value: unknown,
  maxBytes = MAX_SHORT_TEXT_BYTES,
): value is string =>
  boundedString(value, maxBytes) && !CONTROL_CHARACTER_RE.test(value);

/**
 * Opaque Agent Host capability for bounded control-plane dispatch requests.
 * It is branded separately from ExecutorGrant on purpose: it is never valid at
 * ExecutorBroker or an Executor daemon and cannot authorize an operation.
 * A future durable v2 contract must persist a descriptor and reacquire this
 * short-lived IPC capability instead of persisting the token.
 */
export const AGENT_EXECUTOR_ACCESS_GRANT_PREFIX = "osah_dispatch_v1." as const;
const CAPABILITY_BODY_RE = /^[A-Za-z0-9_-]{32,512}$/;
declare const agentExecutorAccessGrantBrand: unique symbol;
export type AgentExecutorAccessGrant = string & {
  readonly [agentExecutorAccessGrantBrand]: "AgentExecutorAccessGrant";
};

export function encodeAgentExecutorAccessGrant(
  entropy: string,
): AgentExecutorAccessGrant {
  if (!CAPABILITY_BODY_RE.test(entropy))
    throw new Error("Invalid Agent Host dispatch grant entropy");
  return `${AGENT_EXECUTOR_ACCESS_GRANT_PREFIX}${entropy}` as AgentExecutorAccessGrant;
}

export function decodeAgentExecutorAccessGrant(
  value: unknown,
): AgentExecutorAccessGrant | undefined {
  if (
    !boundedString(value, MAX_CAPABILITY_BYTES) ||
    !value.startsWith(AGENT_EXECUTOR_ACCESS_GRANT_PREFIX) ||
    !CAPABILITY_BODY_RE.test(
      value.slice(AGENT_EXECUTOR_ACCESS_GRANT_PREFIX.length),
    ) ||
    decodeExecutorGrant(value)
  )
    return undefined;
  return value as AgentExecutorAccessGrant;
}

export interface AgentTurnFence {
  sessionId: string;
  runId: string;
  turnId: string;
  generation: number;
}

/** Non-secret model selection. Access is reacquired through supervised gateway RPC. */
export interface AgentModelPolicy {
  model: string;
  effort?: string;
  fastMode?: boolean;
  fallbackModel?: string;
}

/** Non-secret MCP selection. Access is reacquired through supervised gateway RPC. */
export interface AgentMcpPolicy {
  /** Explicitly broad or explicitly enumerated. An empty list means none. */
  servers: "all" | string[];
}

export interface AgentTranscriptPolicy {
  /** Last durable mutation observed before this turn starts. */
  afterChangeSeq?: number;
  /** Maximum bytes an individual proposed append may contain. */
  maxAppendBytes: number;
  /** Host proposals require a control-plane acknowledgement before advancing. */
  requireAck: true;
}

/** Engine lineage that Pi can resume without carrying provider configuration. */
export interface AgentEnginePolicy {
  engineSessionId?: string;
}

/** Trust and tool registration policy, using the existing runner semantics. */
export interface AgentRunPolicy {
  /** Exact control-plane classification. It cannot contradict a second kind. */
  classification: "interactive_prompt" | "automation_prompt";
  deniedTools?: Record<string, string>;
  confirmTools?: Record<string, string>;
}

/** Prompt and MCP grant identities are separate existing runner identities. */
export interface AgentIdentityPolicy {
  user?: string;
  mcpGrantUser?: string;
}

/** Serializable environment choices only. No credential values belong here. */
export interface AgentEnvironmentPolicy {
  author?: GitIdentity | null;
  aws?: boolean;
  claudeCliEnv?: boolean;
  codexCliEnv?: boolean;
}

export interface AgentWorkspacePolicy {
  /** Canonical descriptor only. The Host never receives a gateway filesystem path. */
  rootId: string;
  /** Existing model-visible note for the primary and attached repositories. */
  repositoriesNote?: string;
}

/** Immutable binding for dispatch through one selected Executor incarnation. */
export interface AgentExecutorPolicy {
  readonly executorId: string;
  readonly rootId: string;
  readonly generation: number;
  /** Turn-scoped authority to request exact per-operation grants. */
  readonly accessGrant: AgentExecutorAccessGrant;
  /** Absolute epoch-ms ceiling for this turn's execution authority. */
  readonly deadlineMs: number;
}

/** Everything the local Agent Host needs for one model turn. */
export interface AgentTurnSpec {
  fence: AgentTurnFence;
  input: {
    prompt: string;
    promptEntryId?: string;
    images?: ImageInput[];
  };
  mode: "ask" | "code" | "scratch";
  modelPolicy: AgentModelPolicy;
  enginePolicy: AgentEnginePolicy;
  mcpPolicy: AgentMcpPolicy;
  transcriptPolicy: AgentTranscriptPolicy;
  runPolicy: AgentRunPolicy;
  identityPolicy: AgentIdentityPolicy;
  environmentPolicy: AgentEnvironmentPolicy;
  workspacePolicy: AgentWorkspacePolicy;
  executorPolicy: AgentExecutorPolicy;
}

interface AgentHostMessageBase {
  version: typeof AGENT_HOST_PROTOCOL_VERSION;
  requestId: string;
}

interface FencedAgentHostMessage extends AgentHostMessageBase {
  fence: AgentTurnFence;
}

export interface AgentHostChallengeDescriptorV3 {
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly hostChallenge: string;
}

/** Exact actor-issued receipt. The envelope alone is never attach authority. */
export interface AgentHostSignedAttachReceiptV3 {
  readonly expected: ExpectedAgentHostSupervisionBindingsV3;
  readonly envelope: SignedAgentHostSupervisionEnvelopeV1;
}

/** Control plane → Agent Host. */
export type AgentHostClientMessage =
  | (AgentHostMessageBase & { t: "hello" })
  | (FencedAgentHostMessage & {
      t: "attach";
      planHash: string;
      receipt: AgentHostSignedAttachReceiptV3;
    })
  | (AgentHostMessageBase & {
      t: "start_turn";
      planHash: string;
      spec: AgentTurnSpec;
    })
  | (FencedAgentHostMessage & {
      t: "steer";
      text: string;
      images?: ImageInput[];
      steerId: string;
    })
  | (FencedAgentHostMessage & { t: "answer"; askId: string; result: AskResult })
  | (FencedAgentHostMessage & { t: "cancel" })
  | (FencedAgentHostMessage & {
      t: "transcript_ack";
      appendId: string;
      changeSeq: number;
    })
  | (FencedAgentHostMessage & { t: "shutdown" });

/** Agent Host → control plane. Transcript entries are proposals; authority to
 * persist, order, rewrite, and compact them remains in the control plane. */
export type AgentHostServerMessage =
  | (AgentHostMessageBase & {
      t: "hello";
      accepted: true;
      hostId: string;
      hostGeneration: number;
      hostIncarnation: string;
      hostChallenge: string;
    })
  | (FencedAgentHostMessage & {
      t: "attached";
      planHash: string;
      supervisorEpoch: number;
    })
  | (FencedAgentHostMessage & { t: "turn_started" })
  | (FencedAgentHostMessage & { t: "event"; event: StreamEvent })
  | (FencedAgentHostMessage & {
      t: "transcript_proposal";
      appendId: string;
      entries: TranscriptEntry[];
    })
  | (FencedAgentHostMessage & {
      t: "ask";
      askId: string;
      input: Record<string, unknown>;
    })
  | (FencedAgentHostMessage & {
      t: "turn_finished";
      status: "completed" | "cancelled" | "failed";
      error?: string;
    })
  | (AgentHostMessageBase & {
      t: "error";
      code:
        | "unsupported_version"
        | "invalid_request"
        | "stale_generation"
        | "host_busy"
        | "turn_failed";
      message: string;
      fence?: AgentTurnFence;
    });

export interface AgentHostSupervisionAuthorityV2 {
  readonly version: typeof AGENT_HOST_SUPERVISION_VERSION;
  readonly fence: Readonly<AgentTurnFence>;
  readonly planHash: string;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisorEpoch: number;
  readonly kernelServiceEpoch: string;
  readonly hostChallenge: string;
  readonly audience: typeof AGENT_HOST_SUPERVISION_AUDIENCE;
  readonly purpose: typeof AGENT_HOST_SUPERVISION_PURPOSE;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly nonce: string;
  readonly keyId: string;
}

const SUPERVISION_KEYS = [
  "version",
  "fence",
  "planHash",
  "hostId",
  "hostGeneration",
  "hostIncarnation",
  "supervisorEpoch",
  "kernelServiceEpoch",
  "hostChallenge",
  "audience",
  "purpose",
  "issuedAtMs",
  "expiresAtMs",
  "nonce",
  "keyId",
] as const;
const SUPERVISION_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

/** Strict structural decode. Time admission is optional so persisted receipts
 * remain decodable after expiry. Unknown fields fail closed. */
export function decodeAgentHostSupervisionAuthorityV2(
  value: unknown,
  nowMs?: number,
): AgentHostSupervisionAuthorityV2 | undefined {
  if (
    !record(value) ||
    Object.keys(value).length !== SUPERVISION_KEYS.length ||
    !exact(value, SUPERVISION_KEYS)
  )
    return undefined;
  if (
    value.version !== AGENT_HOST_SUPERVISION_VERSION ||
    !isAgentTurnFence(value.fence) ||
    typeof value.planHash !== "string" ||
    !SHA256_RE.test(value.planHash) ||
    !decodeExecutorId(value.hostId) ||
    !Number.isSafeInteger(value.hostGeneration) ||
    (value.hostGeneration as number) < 1 ||
    !boundedName(value.hostIncarnation, 256) ||
    !Number.isSafeInteger(value.supervisorEpoch) ||
    (value.supervisorEpoch as number) < 1 ||
    !boundedName(value.kernelServiceEpoch, 256) ||
    typeof value.hostChallenge !== "string" ||
    !SUPERVISION_TOKEN_RE.test(value.hostChallenge) ||
    value.audience !== AGENT_HOST_SUPERVISION_AUDIENCE ||
    value.purpose !== AGENT_HOST_SUPERVISION_PURPOSE ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    (value.issuedAtMs as number) < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.expiresAtMs as number) <= (value.issuedAtMs as number) ||
    (value.expiresAtMs as number) - (value.issuedAtMs as number) >
      MAX_AGENT_HOST_SUPERVISION_LEASE_MS ||
    typeof value.nonce !== "string" ||
    !SUPERVISION_TOKEN_RE.test(value.nonce) ||
    !boundedName(value.keyId, 256)
  )
    return undefined;
  if (
    nowMs !== undefined &&
    ((value.issuedAtMs as number) >
      nowMs + MAX_AGENT_HOST_SUPERVISION_CLOCK_SKEW_MS ||
      (value.expiresAtMs as number) <= nowMs)
  )
    return undefined;

  return Object.freeze({
    version: AGENT_HOST_SUPERVISION_VERSION,
    fence: Object.freeze({ ...(value.fence as AgentTurnFence) }),
    planHash: value.planHash,
    hostId: value.hostId,
    hostGeneration: value.hostGeneration,
    hostIncarnation: value.hostIncarnation,
    supervisorEpoch: value.supervisorEpoch,
    kernelServiceEpoch: value.kernelServiceEpoch,
    hostChallenge: value.hostChallenge,
    audience: AGENT_HOST_SUPERVISION_AUDIENCE,
    purpose: AGENT_HOST_SUPERVISION_PURPOSE,
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    nonce: value.nonce,
    keyId: value.keyId,
  } as AgentHostSupervisionAuthorityV2);
}

/** Canonical UTF-8 JSON with a fixed field order. The bytes, not a mutable
 * object supplied by a gateway, are the future signer's input. */
export function serializeAgentHostSupervisionAuthorityV2(
  value: AgentHostSupervisionAuthorityV2,
): Uint8Array {
  const decoded = decodeAgentHostSupervisionAuthorityV2(value);
  if (!decoded) throw new Error("Invalid Agent Host supervision authority");
  return textEncoder.encode(
    JSON.stringify({
      version: decoded.version,
      fence: {
        sessionId: decoded.fence.sessionId,
        runId: decoded.fence.runId,
        turnId: decoded.fence.turnId,
        generation: decoded.fence.generation,
      },
      planHash: decoded.planHash,
      hostId: decoded.hostId,
      hostGeneration: decoded.hostGeneration,
      hostIncarnation: decoded.hostIncarnation,
      supervisorEpoch: decoded.supervisorEpoch,
      kernelServiceEpoch: decoded.kernelServiceEpoch,
      hostChallenge: decoded.hostChallenge,
      audience: decoded.audience,
      purpose: decoded.purpose,
      issuedAtMs: decoded.issuedAtMs,
      expiresAtMs: decoded.expiresAtMs,
      nonce: decoded.nonce,
      keyId: decoded.keyId,
    }),
  );
}

export async function hashAgentHostSupervisionAuthorityV2(
  value: AgentHostSupervisionAuthorityV2,
): Promise<string> {
  const bytes = serializeAgentHostSupervisionAuthorityV2(value);
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isAgentTurnFence(value: unknown): value is AgentTurnFence {
  if (
    !record(value) ||
    !exact(value, ["sessionId", "runId", "turnId", "generation"])
  )
    return false;
  return (
    !!decodeExecutorId(value.sessionId) &&
    !!decodeExecutorId(value.runId) &&
    !!decodeExecutorId(value.turnId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) >= 0
  );
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(binary);
}

export function decodeAgentImages(value: unknown): ImageInput[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return undefined;
  const images: ImageInput[] = [];
  let totalBytes = 0;
  for (const candidate of value) {
    const image = decodeImage(candidate);
    if (!image) return undefined;
    totalBytes += atob(image.data).length;
    if (totalBytes > MAX_IMAGES_BYTES) return undefined;
    images.push(image);
  }
  return images;
}

function decodeImage(value: unknown): ImageInput | undefined {
  if (!record(value) || !exact(value, ["mediaType", "data"])) return undefined;
  if (
    typeof value.mediaType !== "string" ||
    !/^image\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(value.mediaType) ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    value.data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    return undefined;
  const bytes = Uint8Array.from(atob(value.data), (character) =>
    character.charCodeAt(0),
  );
  return bytes.byteLength <= MAX_IMAGE_BYTES &&
    base64FromBytes(bytes) === value.data
    ? { mediaType: value.mediaType, data: value.data }
    : undefined;
}

function decodeToolRules(value: unknown): Record<string, string> | undefined {
  if (!record(value) || Object.keys(value).length > MAX_TOOL_RULES)
    return undefined;
  for (const [key, reason] of Object.entries(value)) {
    if (
      !boundedName(key) ||
      !boundedString(reason, MAX_SHORT_TEXT_BYTES, true) ||
      NUL_RE.test(reason)
    )
      return undefined;
  }
  return value as Record<string, string>;
}

function decodeGitIdentity(value: unknown): GitIdentity | null | undefined {
  if (value === null) return null;
  if (!record(value) || !exact(value, ["name", "email"])) return undefined;
  return boundedName(value.name) && boundedName(value.email)
    ? { name: value.name, email: value.email }
    : undefined;
}

export function decodeAgentTurnSpec(
  value: unknown,
  nowMs = Date.now(),
): AgentTurnSpec | undefined {
  if (
    !record(value) ||
    !exact(value, [
      "fence",
      "input",
      "mode",
      "modelPolicy",
      "enginePolicy",
      "mcpPolicy",
      "transcriptPolicy",
      "runPolicy",
      "identityPolicy",
      "environmentPolicy",
      "workspacePolicy",
      "executorPolicy",
    ]) ||
    !isAgentTurnFence(value.fence)
  )
    return undefined;

  const input = value.input;
  if (!record(input) || !exact(input, ["prompt", "promptEntryId", "images"]))
    return undefined;
  const images = input.images;
  if (
    !boundedString(input.prompt, MAX_PROMPT_BYTES, true) ||
    (input.promptEntryId !== undefined &&
      !decodeExecutorId(input.promptEntryId)) ||
    (images !== undefined && !decodeAgentImages(images))
  )
    return undefined;

  if (!(
    value.mode === "ask" ||
    value.mode === "code" ||
    value.mode === "scratch"
  ))
    return undefined;

  const modelPolicy = value.modelPolicy;
  if (
    !record(modelPolicy) ||
    !exact(modelPolicy, ["model", "effort", "fastMode", "fallbackModel"]) ||
    !boundedName(modelPolicy.model) ||
    (modelPolicy.effort !== undefined && !boundedName(modelPolicy.effort)) ||
    (modelPolicy.fastMode !== undefined &&
      typeof modelPolicy.fastMode !== "boolean") ||
    (modelPolicy.fallbackModel !== undefined &&
      !boundedName(modelPolicy.fallbackModel))
  )
    return undefined;

  const enginePolicy = value.enginePolicy;
  if (
    !record(enginePolicy) ||
    !exact(enginePolicy, ["engineSessionId"]) ||
    (enginePolicy.engineSessionId !== undefined &&
      !boundedName(enginePolicy.engineSessionId))
  )
    return undefined;

  const mcpPolicy = value.mcpPolicy;
  if (!record(mcpPolicy) || !exact(mcpPolicy, ["servers"])) return undefined;
  const servers = mcpPolicy.servers;
  if (!(
    servers === "all" ||
    (Array.isArray(servers) &&
      servers.length <= MAX_MCP_SERVERS &&
      servers.every((server) => boundedName(server)))
  ))
    return undefined;

  const transcriptPolicy = value.transcriptPolicy;
  if (
    !record(transcriptPolicy) ||
    !exact(transcriptPolicy, [
      "afterChangeSeq",
      "maxAppendBytes",
      "requireAck",
    ]) ||
    (transcriptPolicy.afterChangeSeq !== undefined &&
      (!Number.isSafeInteger(transcriptPolicy.afterChangeSeq) ||
        (transcriptPolicy.afterChangeSeq as number) < 0)) ||
    !Number.isSafeInteger(transcriptPolicy.maxAppendBytes) ||
    (transcriptPolicy.maxAppendBytes as number) < 1 ||
    (transcriptPolicy.maxAppendBytes as number) >
      MAX_AGENT_TRANSCRIPT_APPEND_BYTES ||
    transcriptPolicy.requireAck !== true
  )
    return undefined;

  const runPolicy = value.runPolicy;
  if (
    !record(runPolicy) ||
    !exact(runPolicy, ["classification", "deniedTools", "confirmTools"]) ||
    !["interactive_prompt", "automation_prompt"].includes(
      String(runPolicy.classification),
    )
  )
    return undefined;
  const deniedTools =
    runPolicy.deniedTools === undefined
      ? undefined
      : decodeToolRules(runPolicy.deniedTools);
  const confirmTools =
    runPolicy.confirmTools === undefined
      ? undefined
      : decodeToolRules(runPolicy.confirmTools);
  if (
    (runPolicy.deniedTools !== undefined && deniedTools === undefined) ||
    (runPolicy.confirmTools !== undefined && confirmTools === undefined)
  )
    return undefined;

  const identityPolicy = value.identityPolicy;
  if (
    !record(identityPolicy) ||
    !exact(identityPolicy, ["user", "mcpGrantUser"]) ||
    (identityPolicy.user !== undefined && !boundedName(identityPolicy.user)) ||
    (identityPolicy.mcpGrantUser !== undefined &&
      !boundedName(identityPolicy.mcpGrantUser))
  )
    return undefined;

  const environmentPolicy = value.environmentPolicy;
  if (
    !record(environmentPolicy) ||
    !exact(environmentPolicy, [
      "author",
      "aws",
      "claudeCliEnv",
      "codexCliEnv",
    ]) ||
    (environmentPolicy.author !== undefined &&
      decodeGitIdentity(environmentPolicy.author) === undefined) ||
    [
      environmentPolicy.aws,
      environmentPolicy.claudeCliEnv,
      environmentPolicy.codexCliEnv,
    ].some((flag) => flag !== undefined && typeof flag !== "boolean")
  )
    return undefined;

  const workspacePolicy = value.workspacePolicy;
  if (
    !record(workspacePolicy) ||
    !exact(workspacePolicy, ["rootId", "repositoriesNote"]) ||
    !decodeExecutorId(workspacePolicy.rootId) ||
    (workspacePolicy.repositoriesNote !== undefined &&
      (!boundedString(
        workspacePolicy.repositoriesNote,
        MAX_REPOSITORIES_NOTE_BYTES,
        true,
      ) ||
        NUL_RE.test(workspacePolicy.repositoriesNote)))
  )
    return undefined;

  const executorPolicy = value.executorPolicy;
  if (
    !record(executorPolicy) ||
    !exact(executorPolicy, [
      "executorId",
      "rootId",
      "generation",
      "accessGrant",
      "deadlineMs",
    ]) ||
    !decodeExecutorId(executorPolicy.executorId) ||
    !decodeExecutorId(executorPolicy.rootId) ||
    executorPolicy.generation !== value.fence.generation ||
    executorPolicy.rootId !== workspacePolicy.rootId ||
    !decodeAgentExecutorAccessGrant(executorPolicy.accessGrant) ||
    !Number.isSafeInteger(executorPolicy.deadlineMs) ||
    (executorPolicy.deadlineMs as number) <= nowMs ||
    (executorPolicy.deadlineMs as number) > nowMs + MAX_AGENT_TURN_DURATION_MS
  )
    return undefined;

  return value as unknown as AgentTurnSpec;
}

const AGENT_TURN_PLAN_HASH_DOMAIN = "OpenSession-Agent-Turn-Plan-v1\0";

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (record(value)) {
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined)
        canonical[key] = canonicalJsonValue(value[key]);
    }
    return canonical;
  }
  return value;
}

/** Canonical digest of every execution-relevant turn field. This exact digest
 * is registered with SessionKernel and signed into the attach authority. */
export async function hashAgentTurnSpecV1(
  spec: AgentTurnSpec,
  nowMs = Date.now(),
): Promise<string> {
  const decoded = decodeAgentTurnSpec(spec, nowMs);
  if (!decoded) throw new Error("Invalid Agent Host turn specification");
  const bytes = textEncoder.encode(
    `${AGENT_TURN_PLAN_HASH_DOMAIN}${JSON.stringify(canonicalJsonValue(decoded))}`,
  );
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return `sha256:${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function decodeAgentHostStartTurn(
  value: unknown,
  nowMs = Date.now(),
): Extract<AgentHostClientMessage, { t: "start_turn" }> | undefined {
  if (
    !record(value) ||
    !exact(value, ["t", "version", "requestId", "planHash", "spec"]) ||
    value.t !== "start_turn" ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !decodeExecutorId(value.requestId) ||
    typeof value.planHash !== "string" ||
    !SHA256_RE.test(value.planHash) ||
    !decodeAgentTurnSpec(value.spec, nowMs)
  )
    return undefined;
  return value as unknown as Extract<
    AgentHostClientMessage,
    { t: "start_turn" }
  >;
}

export function decodeAgentHostHello(
  value: unknown,
): Extract<AgentHostClientMessage, { t: "hello" }> | undefined {
  if (!record(value)) return undefined;
  const requestId = decodeExecutorId(value.requestId);
  if (
    !exact(value, ["t", "version", "requestId"]) ||
    value.t !== "hello" ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !requestId
  )
    return undefined;
  return {
    t: "hello",
    version: AGENT_HOST_PROTOCOL_VERSION,
    requestId,
  };
}
