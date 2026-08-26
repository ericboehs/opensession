import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createServer, connect, type Server, type Socket } from "node:net";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  decodeAgentHostHello,
  decodeAgentHostStartTurn,
  decodeAgentImages,
  decodeAgentHostSupervisionPublicKeyringV2,
  decodeExecutorId,
  hashAgentTurnSpecV1,
  isAgentTurnFence,
  verifySignedAgentHostSupervisionEnvelopeV2,
  type AgentHostClientMessage,
  type AgentHostServerMessage,
  type AgentHostSupervisionPublicKeyringV2,
  type AgentTurnFence,
  type AgentTurnSpec,
  type StreamEvent,
  type TranscriptEntry,
} from "@tellahq/opensession-protocol";
import type {
  AgentTurnDriver,
  AgentTurnDriverFactory,
  AgentTurnResult,
} from "./driver";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  BoundedNdjsonDecoder,
  encodeNdjsonFrame,
} from "./socket-framing";

export interface AgentHostOptions {
  socketPath: string;
  createDriver: AgentTurnDriverFactory;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisionKeyring: AgentHostSupervisionPublicKeyringV2;
  maxFrameBytes?: number;
  cancellationDeadlineMs?: number;
  livenessProbeTimeoutMs?: number;
  attachDeadlineMs?: number;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  controlDeadlineMs?: number;
}

interface AttachedAuthority {
  fence: AgentTurnFence;
  planHash: string;
  supervisorEpoch: number;
}

interface ConnectionState {
  readonly id: string;
  socket: Socket;
  handshake: boolean;
  challenge?: string;
  challengeConsumed: boolean;
  attached?: AttachedAuthority;
  attachTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  queue: Promise<void>;
}

interface ActiveTurn {
  fence: AgentTurnFence;
  driver: AgentTurnDriver;
  owner: ConnectionState;
  requestId: string;
  pendingAppendId?: string;
  askIds: Set<string>;
  abandonTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  cancelling: boolean;
  cancelSettled: boolean;
  runSettled: boolean;
  pendingControls: number;
  controlTimers: Set<ReturnType<typeof setTimeout>>;
  shutdownStarted: boolean;
  result?: AgentTurnResult;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

type DriverEmission =
  | { t: "event"; event: StreamEvent }
  | { t: "transcript_proposal"; appendId: string; entries: TranscriptEntry[] }
  | { t: "ask"; askId: string; input: Record<string, unknown> };

const allowed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function sameLineage(left: AgentTurnFence, right: AgentTurnFence): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.turnId === right.turnId
  );
}

function sameFence(left: AgentTurnFence, right: AgentTurnFence): boolean {
  return sameLineage(left, right) && left.generation === right.generation;
}

function decodeMessage(value: unknown): AgentHostClientMessage | undefined {
  if (
    !record(value) ||
    value.version !== AGENT_HOST_PROTOCOL_VERSION ||
    !nonempty(value.requestId) ||
    !nonempty(value.t)
  )
    return undefined;
  if (value.t === "hello") return decodeAgentHostHello(value);
  if (value.t === "start_turn") return decodeAgentHostStartTurn(value);
  if (!isAgentTurnFence(value.fence)) return undefined;
  switch (value.t) {
    case "steer":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "text",
        "images",
        "steerId",
      ]) &&
        nonempty(value.text) &&
        nonempty(value.steerId)
        ? (() => {
            const images =
              value.images === undefined
                ? undefined
                : decodeAgentImages(value.images);
            return value.images !== undefined && !images
              ? undefined
              : ({ ...value, images } as unknown as AgentHostClientMessage);
          })()
        : undefined;
    case "answer": {
      const result = value.result;
      const validResult =
        record(result) &&
        (result.behavior === "allow"
          ? record(result.updatedInput) &&
            allowed(result, ["behavior", "updatedInput"])
          : result.behavior === "deny" &&
            typeof result.message === "string" &&
            allowed(result, ["behavior", "message"]));
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "askId",
        "result",
      ]) &&
        nonempty(value.askId) &&
        validResult
        ? (value as unknown as AgentHostClientMessage)
        : undefined;
    }
    case "cancel":
    case "shutdown":
      return allowed(value, ["t", "version", "requestId", "fence"])
        ? (value as unknown as AgentHostClientMessage)
        : undefined;
    case "transcript_ack":
      return allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "appendId",
        "changeSeq",
      ]) &&
        nonempty(value.appendId) &&
        Number.isSafeInteger(value.changeSeq) &&
        (value.changeSeq as number) >= 0
        ? (value as unknown as AgentHostClientMessage)
        : undefined;
    default:
      return undefined;
  }
}

export class AgentHost {
  private server?: Server;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private active?: ActiveTurn;
  private socketIdentity?: SocketIdentity;
  private claimIdentity?: SocketIdentity;
  private claimNonce?: string;
  private serverEpoch?: string;
  private poisoned = false;
  private attaching?: ConnectionState;
  private attachedOwner?: ConnectionState;
  private readonly highWaterSupervisorEpochs = new Map<string, number>();
  private readonly highWaterGenerations = new Map<string, number>();
  private readonly connections = new Set<ConnectionState>();
  private readonly keyring: AgentHostSupervisionPublicKeyringV2;
  private readonly hostId: string;
  private readonly hostGeneration: number;
  private readonly hostIncarnation: string;

  constructor(private readonly options: AgentHostOptions) {
    const keyring = decodeAgentHostSupervisionPublicKeyringV2(
      options.supervisionKeyring,
    );
    if (
      !decodeExecutorId(options.hostId) ||
      !Number.isSafeInteger(options.hostGeneration) ||
      options.hostGeneration < 1 ||
      typeof options.hostIncarnation !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(options.hostIncarnation) ||
      !keyring
    )
      throw new Error("Invalid Agent Host v3 identity or public keyring");
    this.hostId = options.hostId;
    this.hostGeneration = options.hostGeneration;
    this.hostIncarnation = options.hostIncarnation;
    this.keyring = keyring;
  }

  start(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.stopping) throw new Error("Agent Host is stopping");
    this.starting = this.startListening().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInternal().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async startListening(): Promise<void> {
    if (this.poisoned)
      throw new Error("Agent Host requires process replacement");
    await this.prepareSocketParent();
    try {
      await this.acquireClaim();
      await this.removeStaleSocketWhileClaimed();
      const server = createServer((socket) => this.accept(socket));
      this.server = server;
      this.serverEpoch = crypto.randomUUID();
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => rejectListen(error);
        server.once("error", onError);
        server.listen(this.options.socketPath, () => {
          server.off("error", onError);
          resolveListen();
        });
      });
      const socketStat = await lstat(this.options.socketPath);
      if (!socketStat.isSocket() || socketStat.isSymbolicLink())
        throw new Error("Agent Host socket path is unsafe");
      await chmod(this.options.socketPath, 0o600);
      this.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    } catch (error) {
      const server = this.server;
      this.server = undefined;
      this.serverEpoch = undefined;
      if (server?.listening)
        await new Promise<void>((resolveClose) =>
          server.close(() => resolveClose()),
        );
      await this.unlinkOwnedSocket();
      await this.releaseClaim();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    if (this.attaching) this.poisoned = true;
    this.attaching = undefined;
    this.attachedOwner = undefined;
    this.serverEpoch = undefined;
    const active = this.active;
    if (active) {
      this.poisoned = true;
      this.beginCancellation(active);
      this.clearAbandonTimer(active);
      this.clearControlTimers(active);
      if (!active.shutdownStarted)
        this.invokeDriver(() => active.driver.shutdown());
    }
    for (const connection of this.connections) {
      connection.closed = true;
      connection.socket.removeAllListeners();
      connection.socket.destroy();
    }
    this.connections.clear();
    if (server?.listening)
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    await this.unlinkOwnedSocket();
    if (!active) await this.releaseClaim();
  }

  private async prepareSocketParent(): Promise<void> {
    const socketPath = this.options.socketPath;
    if (!isAbsolute(socketPath) || resolve(socketPath) !== socketPath)
      throw new Error("Agent Host socket path must be absolute and normalized");
    const parent = dirname(socketPath);
    const root = parse(parent).root;
    if (parent === root)
      throw new Error(
        "Agent Host socket parent must not be the filesystem root",
      );
    let current = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
      current = resolve(current, part);
      try {
        const currentStat = await lstat(current);
        if (!currentStat.isDirectory() || currentStat.isSymbolicLink())
          throw new Error(
            "Agent Host socket path contains an unsafe component",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
        const created = await lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink())
          throw new Error("Agent Host socket parent creation raced a symlink");
      }
    }
    const parentStat = await lstat(parent);
    const uid = process.getuid?.();
    if (uid !== undefined && parentStat.uid !== uid)
      throw new Error("Agent Host socket parent has a different owner");
    await chmod(parent, 0o700);
  }

  private get claimPath(): string {
    return `${this.options.socketPath}.claim`;
  }

  private async acquireClaim(): Promise<void> {
    const nonce = crypto.randomUUID();
    const temporary = `${this.claimPath}.tmp-${nonce}`;
    await writeFile(temporary, JSON.stringify({ pid: process.pid, nonce }), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporary, 0o400);
    const temporaryStat = await lstat(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink())
      throw new Error("Agent Host temporary claim is unsafe");
    try {
      await link(temporary, this.claimPath);
      this.claimNonce = nonce;
      this.claimIdentity = {
        dev: temporaryStat.dev,
        ino: temporaryStat.ino,
      };
      await this.verifyClaim(this.claimPath, nonce, this.claimIdentity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw Object.assign(new Error("Agent Host socket is already claimed"), {
          code: "EADDRINUSE",
        });
      throw error;
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  private async removeStaleSocketWhileClaimed(): Promise<void> {
    if (!this.claimNonce) throw new Error("Agent Host socket is not claimed");
    let socketStat;
    try {
      socketStat = await lstat(this.options.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (socketStat.isSymbolicLink() || !socketStat.isSocket())
      throw new Error("Agent Host socket path is unsafe");
    if (await this.socketAcceptsConnections())
      throw Object.assign(new Error("Agent Host socket is already live"), {
        code: "EADDRINUSE",
      });
    const stalePath = `${this.options.socketPath}.stale-${crypto.randomUUID()}`;
    await rename(this.options.socketPath, stalePath);
    await unlink(stalePath);
  }

  private socketAcceptsConnections(): Promise<boolean> {
    return new Promise((resolveProbe, rejectProbe) => {
      const socket = connect(this.options.socketPath);
      const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
      const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
      let settled = false;
      const settle = (live: boolean, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        socket.destroy();
        if (error) rejectProbe(error);
        else resolveProbe(live);
      };
      const timeoutMs = this.positiveDeadline(
        this.options.livenessProbeTimeoutMs,
        250,
        "livenessProbeTimeoutMs",
      );
      const timer = setTimer(
        () => settle(false, new Error("Agent Host liveness probe timed out")),
        timeoutMs,
      );
      timer.unref?.();
      socket.once("connect", () => settle(true));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT")
          settle(false);
        else settle(false, error);
      });
    });
  }

  private async unlinkOwnedSocket(): Promise<void> {
    const identity = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!identity || !this.claimNonce) return;
    try {
      const current = await lstat(this.options.socketPath);
      if (
        !current.isSocket() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        return;
      const cleanupPath = `${this.options.socketPath}.cleanup-${crypto.randomUUID()}`;
      await rename(this.options.socketPath, cleanupPath);
      await unlink(cleanupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async releaseClaim(): Promise<void> {
    const nonce = this.claimNonce;
    const identity = this.claimIdentity;
    if (!nonce || !identity) return;
    await this.verifyClaim(this.claimPath, nonce, identity);
    const quarantine = `${this.claimPath}.release-${nonce}`;
    await rename(this.claimPath, quarantine);
    try {
      await this.verifyClaim(quarantine, nonce, identity);
    } catch (error) {
      this.poisoned = true;
      try {
        await link(quarantine, this.claimPath);
        await unlink(quarantine);
      } catch {}
      throw error;
    }
    await unlink(quarantine);
    this.claimNonce = undefined;
    this.claimIdentity = undefined;
  }

  private async verifyClaim(
    path: string,
    nonce: string,
    identity: SocketIdentity,
  ): Promise<void> {
    const claimStat = await lstat(path);
    const claim = JSON.parse(await readFile(path, "utf8")) as {
      nonce?: unknown;
    };
    if (
      !claimStat.isFile() ||
      claimStat.isSymbolicLink() ||
      claimStat.dev !== identity.dev ||
      claimStat.ino !== identity.ino ||
      claim.nonce !== nonce
    ) {
      this.poisoned = true;
      throw new Error("Agent Host claim ownership changed");
    }
  }

  private positiveDeadline(
    configured: number | undefined,
    fallback: number,
    name: string,
  ): number {
    const value = configured ?? fallback;
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive finite number`);
    return value;
  }

  private accept(socket: Socket): void {
    const state: ConnectionState = {
      id: crypto.randomUUID(),
      socket,
      handshake: false,
      challengeConsumed: false,
      closed: false,
      queue: Promise.resolve(),
    };
    const decoder = new BoundedNdjsonDecoder(
      this.options.maxFrameBytes ?? AGENT_HOST_MAX_FRAME_BYTES,
    );
    this.connections.add(state);
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    state.attachTimer = setTimer(
      () => this.close(state),
      this.positiveDeadline(
        this.options.attachDeadlineMs,
        5_000,
        "attachDeadlineMs",
      ),
    );
    state.attachTimer.unref?.();
    socket.on("data", (chunk) => {
      try {
        for (const value of decoder.push(Buffer.from(chunk))) {
          state.queue = state.queue
            .then(() => this.receive(state, value))
            .catch(() => this.close(state));
        }
      } catch {
        this.close(state);
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch {}
    });
    socket.on("error", () => this.close(state));
    socket.on("close", () => this.disconnected(state));
  }

  private async receive(
    connection: ConnectionState,
    value: unknown,
  ): Promise<void> {
    if (connection.closed) return;
    if (!connection.handshake) {
      const hello = decodeAgentHostHello(value);
      if (!hello) {
        if (
          record(value) &&
          nonempty(value.requestId) &&
          value.version !== AGENT_HOST_PROTOCOL_VERSION
        ) {
          this.send(connection, {
            t: "error",
            version: AGENT_HOST_PROTOCOL_VERSION,
            requestId: value.requestId,
            code: "unsupported_version",
            message: "Unsupported Agent Host protocol version",
          });
          connection.closed = true;
          connection.socket.end();
        } else {
          this.close(connection);
        }
        return;
      }
      connection.handshake = true;
      connection.challenge = crypto.randomUUID();
      this.send(connection, {
        ...hello,
        accepted: true,
        hostId: this.hostId,
        hostGeneration: this.hostGeneration,
        hostIncarnation: this.hostIncarnation,
        hostChallenge: connection.challenge,
      });
      return;
    }
    if (!connection.attached) {
      await this.attach(connection, value);
      return;
    }
    const message = decodeMessage(value);
    if (!message || message.t === "hello") {
      this.error(
        connection,
        record(value) && nonempty(value.requestId)
          ? value.requestId
          : "invalid",
        "invalid_request",
        "Invalid Agent Host request",
      );
      this.close(connection);
      return;
    }
    if (message.t === "start_turn") {
      if (
        !sameFence(connection.attached.fence, message.spec.fence) ||
        connection.attached.planHash !== message.planHash
      ) {
        this.close(connection);
        return;
      }
      await this.startAuthorizedTurn(
        connection,
        message.requestId,
        message.spec,
      );
      return;
    }
    const active = this.active;
    if (
      !active ||
      active.owner !== connection ||
      !sameFence(active.fence, message.fence)
    ) {
      this.close(connection);
      return;
    }
    try {
      switch (message.t) {
        case "steer":
          this.dispatchControl(active, connection, message.requestId, () =>
            active.driver.steer({
              steerId: message.steerId,
              text: message.text,
              images: message.images,
            }),
          );
          break;
        case "answer":
          if (!active.askIds.delete(message.askId))
            throw new Error("Unknown askId");
          this.dispatchControl(active, connection, message.requestId, () =>
            active.driver.answer(message.askId, message.result),
          );
          break;
        case "cancel":
          this.beginCancellation(active);
          break;
        case "transcript_ack":
          if (active.pendingAppendId !== message.appendId)
            throw new Error("Unknown appendId");
          active.pendingAppendId = undefined;
          this.dispatchControl(active, connection, message.requestId, () =>
            active.driver.transcriptAck(message.appendId, message.changeSeq),
          );
          break;
        case "shutdown":
          this.beginCancellation(active);
          active.shutdownStarted = true;
          this.dispatchControl(active, connection, message.requestId, () =>
            active.driver.shutdown(),
          );
          this.close(connection);
          void this.stop();
          break;
      }
    } catch (error) {
      this.error(
        connection,
        message.requestId,
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        active.fence,
      );
    }
  }

  private async attach(
    connection: ConnectionState,
    value: unknown,
  ): Promise<void> {
    const requestId =
      record(value) && nonempty(value.requestId) ? value.requestId : "invalid";
    const challenge = connection.challenge;
    // A challenge is consumed before any parsing or asynchronous verification.
    connection.challenge = undefined;
    connection.challengeConsumed = true;
    if (
      this.poisoned ||
      this.attaching ||
      this.attachedOwner ||
      !challenge ||
      !record(value) ||
      !allowed(value, [
        "t",
        "version",
        "requestId",
        "fence",
        "planHash",
        "receipt",
      ]) ||
      value.t !== "attach" ||
      value.version !== AGENT_HOST_PROTOCOL_VERSION ||
      !nonempty(value.requestId) ||
      !isAgentTurnFence(value.fence) ||
      typeof value.planHash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(value.planHash) ||
      !record(value.receipt) ||
      !allowed(value.receipt, ["expected", "envelope"]) ||
      !record(value.receipt.expected)
    ) {
      this.close(connection);
      return;
    }
    const expected = value.receipt.expected;
    if (
      !isAgentTurnFence(expected.fence) ||
      !sameFence(expected.fence, value.fence) ||
      expected.planHash !== value.planHash ||
      expected.hostId !== this.hostId ||
      expected.hostGeneration !== this.hostGeneration ||
      expected.hostIncarnation !== this.hostIncarnation ||
      expected.hostChallenge !== challenge ||
      expected.audience !== AGENT_HOST_SUPERVISION_AUDIENCE ||
      expected.purpose !== AGENT_HOST_SUPERVISION_PURPOSE
    ) {
      this.close(connection);
      return;
    }
    this.attaching = connection;
    const authority = await verifySignedAgentHostSupervisionEnvelopeV2(
      value.receipt.envelope,
      this.keyring,
      expected as never,
      (this.options.now ?? Date.now)(),
    );
    if (
      this.attaching !== connection ||
      connection.closed ||
      this.attachedOwner ||
      !authority
    ) {
      if (this.attaching === connection) this.attaching = undefined;
      this.close(connection);
      return;
    }
    const sessionKey = authority.fence.sessionId;
    const previousEpoch = this.highWaterSupervisorEpochs.get(sessionKey) ?? 0;
    const previousGeneration = this.highWaterGenerations.get(sessionKey) ?? 0;
    if (
      authority.supervisorEpoch <= previousEpoch ||
      authority.fence.generation < previousGeneration
    ) {
      this.attaching = undefined;
      this.close(connection);
      return;
    }
    this.highWaterSupervisorEpochs.set(sessionKey, authority.supervisorEpoch);
    this.highWaterGenerations.set(sessionKey, authority.fence.generation);
    connection.attached = {
      fence: { ...authority.fence },
      planHash: authority.planHash,
      supervisorEpoch: authority.supervisorEpoch,
    };
    this.attaching = undefined;
    this.attachedOwner = connection;
    if (connection.attachTimer)
      (this.options.clearTimeout ?? globalThis.clearTimeout)(
        connection.attachTimer,
      );
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    connection.attachTimer = setTimer(
      () => {
        if (
          this.attachedOwner === connection &&
          connection.attached &&
          !this.active
        )
          this.close(connection);
      },
      this.positiveDeadline(
        this.options.attachDeadlineMs,
        5_000,
        "attachDeadlineMs",
      ),
    );
    connection.attachTimer.unref?.();
    this.send(connection, {
      t: "attached",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      fence: connection.attached.fence,
      planHash: connection.attached.planHash,
      supervisorEpoch: connection.attached.supervisorEpoch,
    });
  }

  private async startAuthorizedTurn(
    owner: ConnectionState,
    requestId: string,
    spec: AgentTurnSpec,
  ): Promise<void> {
    if (
      this.attachedOwner !== owner ||
      !owner.attached ||
      !sameFence(owner.attached.fence, spec.fence)
    ) {
      this.close(owner);
      return;
    }
    const expectedPlanHash = owner.attached.planHash;
    const actualPlanHash = await hashAgentTurnSpecV1(
      spec,
      (this.options.now ?? Date.now)(),
    );
    if (
      this.attachedOwner !== owner ||
      owner.closed ||
      owner.attached.planHash !== expectedPlanHash ||
      actualPlanHash !== expectedPlanHash
    ) {
      this.close(owner);
      return;
    }
    if (owner.attachTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(owner.attachTimer);
      owner.attachTimer = undefined;
    }
    if (this.active) {
      const code =
        sameLineage(this.active.fence, spec.fence) &&
        !sameFence(this.active.fence, spec.fence)
          ? "stale_generation"
          : "host_busy";
      this.error(
        owner,
        requestId,
        code,
        "Agent Host already owns a turn",
        spec.fence,
      );
      return;
    }
    let driver: AgentTurnDriver;
    try {
      driver = this.options.createDriver(spec);
    } catch (error) {
      this.error(
        owner,
        requestId,
        "turn_failed",
        error instanceof Error ? error.message : String(error),
        spec.fence,
      );
      return;
    }
    const active: ActiveTurn = {
      fence: { ...spec.fence },
      driver,
      owner,
      requestId,
      askIds: new Set(),
      cancelling: false,
      cancelSettled: false,
      runSettled: false,
      pendingControls: 0,
      controlTimers: new Set(),
      shutdownStarted: false,
    };
    this.active = active;
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    active.deadlineTimer = setTimer(
      () => {
        if (this.active !== active) return;
        active.shutdownStarted = true;
        this.beginCancellation(active);
        this.invokeDriver(() => active.driver.shutdown());
      },
      Math.max(0, spec.executorPolicy.deadlineMs - Date.now()),
    );
    active.deadlineTimer.unref?.();
    this.send(owner, {
      t: "turn_started",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      fence: active.fence,
    });
    let run: Promise<AgentTurnResult>;
    try {
      run = Promise.resolve(
        driver.run(spec, {
          event: (event) => this.emitFor(active, { t: "event", event }),
          proposeTranscript: (appendId, entries) => {
            if (!nonempty(appendId) || active.pendingAppendId)
              throw new Error(
                "Transcript proposal requires its prior acknowledgement",
              );
            if (
              Buffer.byteLength(JSON.stringify(entries)) >
              spec.transcriptPolicy.maxAppendBytes
            )
              throw new Error("Transcript proposal exceeds maxAppendBytes");
            if (
              !this.emitFor(active, {
                t: "transcript_proposal",
                appendId,
                entries,
              })
            )
              throw new Error("Transcript proposal owner is disconnected");
            active.pendingAppendId = appendId;
          },
          ask: (askId, input) => {
            if (!nonempty(askId) || active.askIds.has(askId))
              throw new Error("Invalid askId");
            if (!this.emitFor(active, { t: "ask", askId, input }))
              throw new Error("Ask owner is disconnected");
            active.askIds.add(askId);
          },
        }),
      );
    } catch (error) {
      run = Promise.reject(error);
    }
    void run.then(
      (result) => this.finishTurn(active, result),
      (error) =>
        this.finishTurn(active, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  }

  private finishTurn(active: ActiveTurn, result: AgentTurnResult): void {
    active.runSettled = true;
    active.result = result;
    this.completeIfDrained(active);
  }

  private emitFor(active: ActiveTurn, message: DriverEmission): boolean {
    if (this.active !== active || active.cancelling || active.owner.closed)
      return false;
    return this.send(active.owner, {
      ...message,
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId: active.requestId,
      fence: active.fence,
    } as AgentHostServerMessage);
  }

  private error(
    connection: ConnectionState,
    requestId: string,
    code: Extract<AgentHostServerMessage, { t: "error" }>["code"],
    message: string,
    fence?: AgentTurnFence,
  ): void {
    this.send(connection, {
      t: "error",
      version: AGENT_HOST_PROTOCOL_VERSION,
      requestId,
      code,
      message,
      fence,
    });
  }

  private send(
    connection: ConnectionState,
    message: AgentHostServerMessage,
  ): boolean {
    if (connection.closed || !connection.socket.writable) return false;
    try {
      connection.socket.write(
        encodeNdjsonFrame(message, this.options.maxFrameBytes),
      );
      return true;
    } catch {
      this.close(connection);
      return false;
    }
  }

  private close(connection: ConnectionState): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.socket.destroy();
  }

  private disconnected(connection: ConnectionState): void {
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.attachTimer) {
      (this.options.clearTimeout ?? globalThis.clearTimeout)(
        connection.attachTimer,
      );
      connection.attachTimer = undefined;
    }
    if (this.attaching === connection) this.attaching = undefined;
    const active = this.active;
    if (active?.owner === connection) this.beginCancellation(active);
    else if (this.attachedOwner === connection) this.attachedOwner = undefined;
  }

  private beginCancellation(active: ActiveTurn): void {
    if (this.active !== active || active.cancelling) return;
    active.cancelling = true;
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    active.abandonTimer = setTimer(
      () => {
        if (
          this.active === active &&
          (!active.runSettled || !active.cancelSettled)
        )
          this.poisoned = true;
      },
      this.positiveDeadline(
        this.options.cancellationDeadlineMs,
        5_000,
        "cancellationDeadlineMs",
      ),
    );
    active.abandonTimer.unref?.();
    let cancel: Promise<void>;
    try {
      cancel = Promise.resolve(active.driver.cancel());
    } catch (error) {
      cancel = Promise.reject(error);
    }
    void cancel.then(
      () => {
        active.cancelSettled = true;
        this.completeIfDrained(active);
      },
      () => {
        active.cancelSettled = true;
        this.completeIfDrained(active);
      },
    );
  }

  private dispatchControl(
    active: ActiveTurn,
    connection: ConnectionState,
    requestId: string,
    action: () => void | Promise<void>,
  ): void {
    if (this.active !== active) return;
    active.pendingControls += 1;
    const setTimer = this.options.setTimeout ?? globalThis.setTimeout;
    const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
    let settled = false;
    const timer = setTimer(
      () => {
        active.controlTimers.delete(timer);
        if (settled) return;
        this.poisoned = true;
      },
      this.positiveDeadline(
        this.options.controlDeadlineMs ?? this.options.cancellationDeadlineMs,
        5_000,
        "controlDeadlineMs",
      ),
    );
    timer.unref?.();
    active.controlTimers.add(timer);
    let control: Promise<void>;
    try {
      control = Promise.resolve(action());
    } catch (error) {
      control = Promise.reject(error);
    }
    void control.then(
      () => settle(),
      (error) => settle(error),
    );
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      active.controlTimers.delete(timer);
      active.pendingControls -= 1;
      if (error !== undefined && this.active === active)
        this.error(
          connection,
          requestId,
          "invalid_request",
          error instanceof Error ? error.message : String(error),
          active.fence,
        );
      this.completeIfDrained(active);
    };
  }

  private completeIfDrained(active: ActiveTurn): void {
    if (
      this.active !== active ||
      !active.runSettled ||
      active.pendingControls > 0
    )
      return;
    if (active.cancelling && !active.cancelSettled) return;
    this.clearAbandonTimer(active);
    if (active.deadlineTimer) {
      const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
      clearTimer(active.deadlineTimer);
      active.deadlineTimer = undefined;
    }
    this.active = undefined;
    if (this.attachedOwner === active.owner) this.attachedOwner = undefined;
    if (active.result)
      this.send(active.owner, {
        t: "turn_finished",
        version: AGENT_HOST_PROTOCOL_VERSION,
        requestId: active.requestId,
        fence: active.fence,
        ...active.result,
      });
  }

  private clearControlTimers(active: ActiveTurn): void {
    const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
    for (const timer of active.controlTimers) clearTimer(timer);
    active.controlTimers.clear();
  }

  private clearAbandonTimer(active: ActiveTurn): void {
    if (!active.abandonTimer) return;
    const clearTimer = this.options.clearTimeout ?? globalThis.clearTimeout;
    clearTimer(active.abandonTimer);
    active.abandonTimer = undefined;
  }

  private invokeDriver(action: () => void | Promise<void>): void {
    try {
      void Promise.resolve(action()).catch(() => undefined);
    } catch {}
  }

  private lineageKey(fence: AgentTurnFence): string {
    return `${fence.sessionId}\0${fence.runId}\0${fence.turnId}`;
  }
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
  return new AgentHost(options);
}
