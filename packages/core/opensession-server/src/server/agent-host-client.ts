import { connect, type Socket } from "node:net";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  decodeAgentTurnSpec,
  decodeExecutorId,
  isAgentTurnFence,
  type AgentHostChallengeDescriptorV3,
  type AgentHostClientMessage,
  type AgentHostServerMessage,
  type AgentHostSignedAttachReceiptV3,
  type AgentTurnFence,
  type AgentTurnSpec,
  type AskResult,
  type ImageInput,
} from "@tellahq/opensession-protocol";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  BoundedNdjsonDecoder,
  encodeNdjsonFrame,
} from "../agent-host/socket-framing";

export interface AgentHostClientOptions {
  socketPath: string;
  timeoutMs?: number;
  maxFrameBytes?: number;
  obtainSignedAttach: (
    challenge: Readonly<AgentHostChallengeDescriptorV3>,
    requested: Readonly<{ fence: AgentTurnFence; planHash: string }>,
  ) => Promise<AgentHostSignedAttachReceiptV3>;
  onMessage?: (
    message: Exclude<AgentHostServerMessage, { t: "hello" | "attached" }>,
  ) => void;
}

interface PendingRequest {
  expected: AgentHostServerMessage["t"];
  resolve: (message: AgentHostServerMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const allowed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function sameFence(left: AgentTurnFence, right: AgentTurnFence): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId &&
    left.generation === right.generation
  );
}

function decodeServerMessage(
  value: unknown,
): AgentHostServerMessage | undefined {
  if (
    !record(value) ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !nonempty(value.requestId) ||
    !nonempty(value.t)
  )
    return undefined;
  switch (value.t) {
    case "hello":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "accepted",
        "hostId",
        "hostGeneration",
        "hostIncarnation",
        "hostChallenge",
      ]) &&
        value.accepted === true &&
        !!decodeExecutorId(value.hostId) &&
        Number.isSafeInteger(value.hostGeneration) &&
        (value.hostGeneration as number) > 0 &&
        typeof value.hostIncarnation === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value.hostIncarnation) &&
        typeof value.hostChallenge === "string" &&
        /^[A-Za-z0-9_-]{16,256}$/.test(value.hostChallenge)
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "attached":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "planHash",
        "supervisorEpoch",
      ]) &&
        isAgentTurnFence(value.fence) &&
        typeof value.planHash === "string" &&
        Number.isSafeInteger(value.supervisorEpoch) &&
        (value.supervisorEpoch as number) > 0
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "error":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "code",
        "message",
        "fence",
      ]) &&
        [
          "unsupported_version",
          "invalid_request",
          "stale_generation",
          "host_busy",
          "turn_failed",
        ].includes(String(value.code)) &&
        typeof value.message === "string" &&
        (value.fence === undefined || isAgentTurnFence(value.fence))
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "turn_started":
      return allowed(value, ["t", "version", "requestId", "fence"]) &&
        isAgentTurnFence(value.fence)
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "event":
      return allowed(value, ["t", "version", "requestId", "fence", "event"]) &&
        isAgentTurnFence(value.fence) &&
        record(value.event)
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "transcript_proposal":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "appendId",
        "entries",
      ]) &&
        isAgentTurnFence(value.fence) &&
        nonempty(value.appendId) &&
        Array.isArray(value.entries)
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "ask":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "askId",
        "input",
      ]) &&
        isAgentTurnFence(value.fence) &&
        nonempty(value.askId) &&
        record(value.input)
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    case "turn_finished":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "status",
        "error",
      ]) &&
        isAgentTurnFence(value.fence) &&
        ["completed", "cancelled", "failed"].includes(String(value.status)) &&
        (value.error === undefined || typeof value.error === "string")
        ? (value as unknown as AgentHostServerMessage)
        : undefined;
    default:
      return undefined;
  }
}

export class AgentHostClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private connectingFence?: AgentTurnFence;
  private connectingPlanHash?: string;
  private fence?: AgentTurnFence;
  private planHash?: string;
  private ready = false;
  private uncertain = false;
  private readonly pending = new Map<string, PendingRequest>();
  private requestSequence = 0;

  constructor(private readonly options: AgentHostClientOptions) {}

  connect(fence: AgentTurnFence, planHash: string): Promise<void> {
    if (!isAgentTurnFence(fence) || !/^sha256:[a-f0-9]{64}$/.test(planHash))
      throw new Error("Invalid Agent Host attachment request");
    if (this.uncertain)
      throw new Error(
        "Agent Host ownership is uncertain; retry after host replacement",
      );
    if (this.connecting) {
      if (
        !this.connectingFence ||
        !sameFence(this.connectingFence, fence) ||
        this.connectingPlanHash !== planHash
      )
        throw new Error("Agent Host client is attaching to another turn");
      return this.connecting;
    }
    if (this.ready && this.socket && !this.socket.destroyed) {
      if (
        !this.fence ||
        !sameFence(this.fence, fence) ||
        this.planHash !== planHash
      )
        throw new Error("Agent Host client is attached to another turn");
      return Promise.resolve();
    }
    const requested = Object.freeze({
      fence: Object.freeze({ ...fence }),
      planHash,
    });
    this.connectingFence = { ...fence };
    this.connectingPlanHash = planHash;
    this.connecting = new Promise<void>((resolveConnect, rejectConnect) => {
      const socket = connect(this.options.socketPath);
      const decoder = new BoundedNdjsonDecoder(
        this.options.maxFrameBytes ?? AGENT_HOST_MAX_FRAME_BYTES,
      );
      this.socket = socket;
      this.ready = false;
      let settled = false;
      const timeout = setTimeout(
        () => failConnect(new Error("Agent Host connect/attach timed out")),
        this.options.timeoutMs ?? 5_000,
      );
      timeout.unref?.();
      const failConnect = (error: Error) => {
        clearTimeout(timeout);
        this.uncertain = true;
        this.fail(error, socket);
        this.disposeSocket(socket);
        if (!settled) {
          settled = true;
          rejectConnect(error);
        }
      };
      socket.on("connect", async () => {
        try {
          const helloId = this.nextRequestId();
          const hello = await this.request(helloId, "hello", {
            t: "hello",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: helloId,
          });
          if (hello.t !== "hello" || settled || this.socket !== socket) return;
          const challenge = Object.freeze({
            hostId: hello.hostId,
            hostGeneration: hello.hostGeneration,
            hostIncarnation: hello.hostIncarnation,
            hostChallenge: hello.hostChallenge,
          });
          const receipt = await this.options.obtainSignedAttach(
            challenge,
            requested,
          );
          if (settled || this.socket !== socket) return;
          const attachId = this.nextRequestId();
          const attached = await this.request(attachId, "attached", {
            t: "attach",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: attachId,
            fence: requested.fence,
            planHash,
            receipt,
          });
          if (
            attached.t !== "attached" ||
            !sameFence(attached.fence, requested.fence) ||
            attached.planHash !== planHash ||
            attached.supervisorEpoch !== receipt.expected.supervisorEpoch ||
            settled ||
            this.socket !== socket
          )
            throw new Error(
              "Agent Host returned a mismatched attach acknowledgement",
            );
          settled = true;
          clearTimeout(timeout);
          this.ready = true;
          this.fence = { ...fence };
          this.planHash = planHash;
          resolveConnect();
        } catch (error) {
          failConnect(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      socket.on("data", (chunk) => {
        try {
          for (const value of decoder.push(Buffer.from(chunk)))
            this.receive(socket, value);
        } catch {
          failConnect(new Error("Malformed Agent Host frame"));
        }
      });
      socket.on("end", () => {
        try {
          decoder.finish();
        } catch {
          failConnect(new Error("Malformed Agent Host frame"));
        }
      });
      socket.on("error", failConnect);
      socket.on("close", () =>
        failConnect(new Error("Agent Host disconnected")),
      );
    }).finally(() => {
      this.connecting = undefined;
      this.connectingFence = undefined;
      this.connectingPlanHash = undefined;
    });
    return this.connecting;
  }

  async startTurn(spec: AgentTurnSpec): Promise<void> {
    if (this.connecting || !this.ready || !this.socket || this.socket.destroyed)
      throw new Error("Agent Host handshake is not complete");
    if (!this.fence || !this.planHash || !sameFence(this.fence, spec.fence))
      throw new Error("Agent Host client is not attached to this turn");
    if (!decodeAgentTurnSpec(spec))
      throw new Error("Invalid Agent Host turn specification");
    const requestId = this.nextRequestId();
    await this.request(requestId, "turn_started", {
      t: "start_turn",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      planHash: this.planHash,
      spec,
    });
  }

  steer(text: string, steerId: string, images?: ImageInput[]): string {
    return this.sendFenced({ t: "steer", text, steerId, images });
  }

  answer(askId: string, result: AskResult): string {
    return this.sendFenced({ t: "answer", askId, result });
  }

  cancel(): string {
    return this.sendFenced({ t: "cancel" });
  }
  transcriptAck(appendId: string, changeSeq: number): string {
    return this.sendFenced({ t: "transcript_ack", appendId, changeSeq });
  }
  shutdown(): string {
    return this.sendFenced({ t: "shutdown" });
  }

  close(): void {
    const socket = this.socket;
    if (socket) {
      this.fail(new Error("Agent Host client closed"), socket);
      this.disposeSocket(socket);
    }
    this.socket = undefined;
    this.ready = false;
    this.fence = undefined;
    this.planHash = undefined;
  }

  private sendFenced(message: Record<string, unknown>): string {
    if (!this.fence) throw new Error("Agent Host client has no active turn");
    const requestId = this.nextRequestId();
    this.write({
      ...message,
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      fence: this.fence,
    } as AgentHostClientMessage);
    return requestId;
  }

  private request(
    requestId: string,
    expected: AgentHostServerMessage["t"],
    message: AgentHostClientMessage,
  ): Promise<AgentHostServerMessage> {
    return new Promise<AgentHostServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`Agent Host ${expected} timed out`);
        if (expected === "turn_started") this.desynchronize(error);
        reject(error);
      }, this.options.timeoutMs ?? 5_000);
      timer.unref?.();
      this.pending.set(requestId, { expected, resolve, reject, timer });
      try {
        this.write(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: AgentHostClientMessage): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable)
      throw new Error("Agent Host is disconnected");
    this.socket.write(encodeNdjsonFrame(message, this.options.maxFrameBytes));
  }

  private receive(socket: Socket, value: unknown): void {
    if (socket !== this.socket || this.uncertain) return;
    const message = decodeServerMessage(value);
    if (!message) {
      this.socket?.destroy(new Error("Invalid Agent Host message"));
      return;
    }
    if (
      message.t !== "hello" &&
      message.t !== "attached" &&
      message.t !== "error"
    ) {
      if (!this.fence || !sameFence(this.fence, message.fence)) {
        this.socket?.destroy(new Error("Stale Agent Host fence"));
        return;
      }
    }
    const pending = this.pending.get(message.requestId);
    if (message.t === "error") {
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.requestId);
        pending.reject(new Error(`${message.code}: ${message.message}`));
      } else {
        this.options.onMessage?.(message);
      }
      return;
    }
    if (pending && pending.expected === message.t) {
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      pending.resolve(message);
    }
    if (message.t === "turn_finished") {
      this.fence = undefined;
      this.planHash = undefined;
    }
    if (
      message.t !== "hello" &&
      message.t !== "attached" &&
      message.t !== "turn_started"
    )
      this.options.onMessage?.(message);
  }

  private desynchronize(error: Error): void {
    const socket = this.socket;
    if (!socket || this.uncertain) return;
    this.uncertain = true;
    this.ready = false;
    if (this.fence && socket.writable) {
      const requestId = this.nextRequestId();
      try {
        socket.end(
          encodeNdjsonFrame(
            {
              t: "cancel",
              version: AGENT_HOST_PROTOCOL_VERSION,
              requestId,
              fence: this.fence,
            },
            this.options.maxFrameBytes,
          ),
        );
        socket.destroySoon();
      } catch {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
    this.fail(error, socket, true);
  }

  private fail(error: Error, socket: Socket, preserveFence = false): void {
    if (socket !== this.socket) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.socket = undefined;
    this.ready = false;
    if (!preserveFence) {
      this.fence = undefined;
      this.planHash = undefined;
    }
  }

  private disposeSocket(socket: Socket): void {
    socket.removeAllListeners();
    socket.destroy();
  }

  private nextRequestId(): string {
    this.requestSequence += 1;
    return `agent-host-${this.requestSequence}-${crypto.randomUUID()}`;
  }
}
