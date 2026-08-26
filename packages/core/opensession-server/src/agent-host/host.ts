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
import { connect, createServer, type Server, type Socket } from "node:net";
import { createLinuxPeerCredentialVerifier } from "../server/security/transport/linux-peer-credentials";
import {
  createVerifiedUnixSocketServer,
  type VerifiedUnixSocketServer,
} from "../server/security/transport/unix-socket-security";
import {
  AGENT_HOST_PROTOCOL_VERSION,
  AGENT_HOST_SUPERVISION_AUDIENCE,
  AGENT_HOST_SUPERVISION_PURPOSE,
  INITIAL_AGENT_HOST_STREAM_BYTES,
  INITIAL_AGENT_HOST_STREAM_CHUNKS,
  MAX_AGENT_HOST_REPLAY_BYTES,
  MAX_AGENT_HOST_REPLAY_FRAMES,
  MAX_AGENT_HOST_STREAM_BYTES,
  MAX_AGENT_HOST_STREAM_CHUNKS,
  MAX_AGENT_HOST_WRITABLE_BYTES,
  decodeAgentHostAttach,
  decodeAgentHostHello,
  decodeAgentHostOperationCancelReceipt,
  decodeAgentHostOperationQueryReceipt,
  decodeAgentHostOperationReceipt,
  decodeAgentHostOperationStream,
  decodeAgentHostStartTurn,
  decodeAgentHostSupervisionPublicKeyringV2,
  decodeExecutorId,
  hashAgentTurnSpecV2,
  verifySignedAgentHostSupervisionEnvelopeV2,
  type AgentHostAttachResumeCursorV4,
  type AgentHostClientMessage,
  type AgentHostInitialOperationV4,
  type AgentHostOperationCancelV4,
  type AgentHostServerMessage,
  type AgentHostSupervisionPublicKeyringV2,
  type AgentOperationReceiptV1,
  type AgentTurnFence,
  type AgentTurnSpec,
} from "@tellahq/opensession-protocol";
import type {
  AgentHostOperationCancel,
  AgentHostOperationQuery,
  AgentHostOperationRequest,
  AgentHostOperationTransport,
  AgentTurnDriver,
  AgentTurnDriverFactory,
  AgentTurnResult,
} from "./driver";
import {
  AGENT_HOST_MAX_FRAME_BYTES,
  BoundedNdjsonDecoder,
  encodeNdjsonFrame,
} from "./socket-framing";

export type AgentHostFailpoint =
  | "afterAttachChallengeConsumed"
  | "afterAttachVerifiedBeforeOwnerSwap"
  | "afterOwnerSwapBeforeAttachedWrite"
  | "afterOperationIntentBufferedBeforeWrite"
  | "afterStreamAcceptedBeforeDriverDelivery"
  | "afterDriverDeliveryBeforeStreamAck"
  | "onReconnectDeadline";
export interface AgentHostOptions {
  /** Legacy test/development listener. Production must use inheritedFd. */
  socketPath?: string;
  /** Already-listening AF_UNIX descriptor supplied by systemd socket activation. */
  inheritedFd?: number;
  /** Exact non-root gateway UID accepted through SO_PEERCRED. */
  expectedPeerUid?: number;
  createDriver: AgentTurnDriverFactory;
  readonly hostId: string;
  readonly hostGeneration: number;
  readonly hostIncarnation: string;
  readonly supervisionKeyring: AgentHostSupervisionPublicKeyringV2;
  maxFrameBytes?: number;
  cancellationDeadlineMs?: number;
  livenessProbeTimeoutMs?: number;
  attachDeadlineMs?: number;
  reconnectGraceMs?: number;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  failpoint?: (point: AgentHostFailpoint) => void | Promise<void>;
}
type Timer = ReturnType<typeof setTimeout>;
interface Authority {
  fence: Readonly<AgentTurnFence>;
  planHash: string;
  supervisorEpoch: number;
  envelope: unknown;
}
interface Peer {
  socket: Socket;
  hello: boolean;
  challenge?: string;
  attached?: Authority;
  closed: boolean;
  timer?: Timer;
  reads: Promise<void>;
  writes: Promise<void>;
  queuedBytes: number;
}
interface Op {
  request: Readonly<AgentHostInitialOperationV4>;
  receipt?: AgentOperationReceiptV1;
  receiptJson?: string;
  sent: Set<number>;
  through: number;
  pending: number;
  creditsBytes: number;
  creditsChunks: number;
  terminal: boolean;
  delivery: Promise<void>;
  owedCreditBytes: number;
  owedCreditChunks: number;
  timer?: Timer;
}
interface Frame {
  seq: number;
  bytes: Buffer;
}
interface Turn {
  fence: Readonly<AgentTurnFence>;
  spec: AgentTurnSpec;
  driver: AgentTurnDriver;
  owner: Peer;
  authority: Authority;
  requestId: string;
  ops: Map<string, Op>;
  seq: number;
  replay: Frame[];
  replayBytes: number;
  reconnect?: Timer;
  deadline?: Timer;
  runSettled: boolean;
  result?: AgentTurnResult;
  cancelling: boolean;
  cancelSettled: boolean;
}
interface Identity {
  dev: number;
  ino: number;
}
const rec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const sameFence = (a: AgentTurnFence, b: AgentTurnFence) =>
  a.sessionId === b.sessionId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  a.generation === b.generation;
const terminal = (s: AgentOperationReceiptV1["state"]) =>
  s === "settled" || s === "indeterminate";
const rank = (s: AgentOperationReceiptV1["state"]) =>
  s === "prepared" ? 0 : s === "executing" ? 1 : 2;

export class AgentHost {
  private server?: Server;
  private inheritedServer?: VerifiedUnixSocketServer;
  private peerVerifier?: Awaited<ReturnType<typeof createLinuxPeerCredentialVerifier>>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private active?: Turn;
  private attaching?: Peer;
  private owner?: Peer;
  private poisoned = false;
  private socketIdentity?: Identity;
  private claimIdentity?: Identity;
  private claimNonce?: string;
  private peers = new Set<Peer>();
  private epochs = new Map<string, number>();
  private generations = new Map<string, number>();
  private keyring: AgentHostSupervisionPublicKeyringV2;
  constructor(private options: AgentHostOptions) {
    const ring = decodeAgentHostSupervisionPublicKeyringV2(
      options.supervisionKeyring,
    );
    if (
      !decodeExecutorId(options.hostId) ||
      !Number.isSafeInteger(options.hostGeneration) ||
      options.hostGeneration < 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(options.hostIncarnation) ||
      !ring
    )
      throw new Error("Invalid Agent Host v4 identity or public keyring");
    this.keyring = ring;
  }
  start() {
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.listen().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInner().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private duration(v: number | undefined, fallback: number, name: string) {
    const n = v ?? fallback;
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`${name} must be positive`);
    return n;
  }
  private set(fn: () => void, ms: number) {
    const t = (this.options.setTimeout ?? setTimeout)(fn, ms);
    t.unref?.();
    return t;
  }
  private clear(t?: Timer) {
    if (t) (this.options.clearTimeout ?? clearTimeout)(t);
  }
  private async hit(point: AgentHostFailpoint) {
    await this.options.failpoint?.(point);
  }

  private async listen() {
    if (this.poisoned)
      throw new Error("Agent Host requires process replacement");
    if (this.options.inheritedFd !== undefined) {
      if (this.options.socketPath !== undefined)
        throw new Error("Agent Host inherited listener cannot name a socket path");
      const expectedPeerUid = this.options.expectedPeerUid;
      if (
        !Number.isSafeInteger(expectedPeerUid) ||
        expectedPeerUid! <= 0 ||
        expectedPeerUid! > 0xffff_ffff
      )
        throw new Error("Agent Host inherited listener requires an exact non-root gateway UID");
      const verifier = await createLinuxPeerCredentialVerifier();
      this.peerVerifier = verifier;
      const inherited = createVerifiedUnixSocketServer(
        verifier,
        { uid: expectedPeerUid! },
        (accepted) => {
          accepted.assertCurrent();
          this.accept(accepted.socket);
          accepted.socket.resume();
        },
        () => {},
        { listenerMode: "inherited-fd-only" },
      );
      this.inheritedServer = inherited;
      try {
        await inherited.listen({ inheritedFd: this.options.inheritedFd });
        return;
      } catch (error) {
        verifier.close();
        this.peerVerifier = undefined;
        this.inheritedServer = undefined;
        throw error;
      }
    }
    if (!this.options.socketPath)
      throw new Error("Agent Host listener is unavailable");
    await this.prepareParent();
    try {
      await this.claim();
      await this.removeStale();
      const server = createServer((s) => this.accept(s));
      this.server = server;
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(this.options.socketPath, ok);
      });
      const st = await lstat(this.options.socketPath);
      if (!st.isSocket() || st.isSymbolicLink())
        throw new Error("unsafe Agent Host socket");
      await chmod(this.options.socketPath, 0o600);
      this.socketIdentity = { dev: st.dev, ino: st.ino };
    } catch (e) {
      await this.unlinkSocket();
      await this.releaseClaim();
      throw e;
    }
  }
  private async stopInner() {
    await this.starting?.catch(() => {});
    const server = this.server;
    const inheritedServer = this.inheritedServer;
    this.server = undefined;
    this.inheritedServer = undefined;
    const active = this.active;
    if (active) this.poisoned = true;
    for (const p of this.peers) {
      p.closed = true;
      p.socket.destroy();
    }
    this.peers.clear();
    if (server?.listening)
      await new Promise<void>((ok) => server.close(() => ok()));
    if (inheritedServer) await inheritedServer.closeAndDrain(5_000);
    if (active) {
      await Promise.allSettled([
        Promise.resolve().then(() => active.driver.cancel()),
        Promise.resolve().then(() => active.driver.shutdown()),
      ]);
    }
    this.peerVerifier?.close();
    this.peerVerifier = undefined;
    if (this.options.socketPath) {
      await this.unlinkSocket();
      if (!this.active) await this.releaseClaim();
    }
  }
  private async prepareParent() {
    const path = this.options.socketPath!;
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("Agent Host socket path must be absolute and normalized");
    const parent = dirname(path),
      root = parse(parent).root;
    if (parent === root) throw new Error("invalid socket parent");
    let current = root;
    for (const part of parent.slice(root.length).split("/").filter(Boolean)) {
      current = resolve(current, part);
      try {
        const st = await lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink())
          throw new Error("unsafe socket parent");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        await mkdir(current, { mode: 0o700 });
      }
    }
    const st = await lstat(parent),
      uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      throw new Error("socket parent owner mismatch");
    await chmod(parent, 0o700);
  }
  private get claimPath() {
    return `${this.options.socketPath!}.claim`;
  }
  private async claim() {
    const nonce = crypto.randomUUID(),
      tmp = `${this.claimPath}.tmp-${nonce}`;
    await writeFile(tmp, JSON.stringify({ pid: process.pid, nonce }), {
      flag: "wx",
      mode: 0o400,
    });
    const st = await lstat(tmp);
    try {
      await link(tmp, this.claimPath);
      this.claimNonce = nonce;
      this.claimIdentity = { dev: st.dev, ino: st.ino };
      await this.verifyClaim(this.claimPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw Object.assign(new Error("Agent Host socket is already claimed"), {
          code: "EADDRINUSE",
        });
      throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  }
  private async verifyClaim(path: string) {
    const st = await lstat(path),
      data = JSON.parse(await readFile(path, "utf8"));
    const i = this.claimIdentity;
    if (
      !i ||
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.dev !== i.dev ||
      st.ino !== i.ino ||
      data.nonce !== this.claimNonce
    ) {
      this.poisoned = true;
      throw new Error("Agent Host claim ownership changed");
    }
  }
  private async removeStale() {
    const path = this.options.socketPath!;
    try {
      const st = await lstat(path);
      if (!st.isSocket() || st.isSymbolicLink())
        throw new Error("unsafe socket");
      if (await this.probe())
        throw Object.assign(new Error("Agent Host socket is already live"), {
          code: "EADDRINUSE",
        });
      const old = `${path}.stale-${crypto.randomUUID()}`;
      await rename(path, old);
      await unlink(old);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private probe() {
    const path = this.options.socketPath!;
    return new Promise<boolean>((ok, fail) => {
      const s = connect(path);
      let done = false;
      const finish = (v: boolean, e?: Error) => {
        if (done) return;
        done = true;
        this.clear(timer);
        s.destroy();
        e ? fail(e) : ok(v);
      };
      const timer = this.set(
        () => finish(false, new Error("liveness probe timed out")),
        this.duration(
          this.options.livenessProbeTimeoutMs,
          250,
          "livenessProbeTimeoutMs",
        ),
      );
      s.once("connect", () => finish(true));
      s.once("error", (e: NodeJS.ErrnoException) =>
        e.code === "ENOENT" || e.code === "ECONNREFUSED"
          ? finish(false)
          : finish(false, e),
      );
    });
  }
  private async unlinkSocket() {
    const path = this.options.socketPath!;
    const i = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!i) return;
    try {
      const st = await lstat(path);
      if (
        st.isSocket() &&
        !st.isSymbolicLink() &&
        st.dev === i.dev &&
        st.ino === i.ino
      ) {
        const q = `${path}.cleanup-${crypto.randomUUID()}`;
        await rename(path, q);
        await unlink(q);
      }
    } catch {}
  }
  private async releaseClaim() {
    if (!this.claimNonce || !this.claimIdentity) return;
    await this.verifyClaim(this.claimPath);
    const q = `${this.claimPath}.release-${this.claimNonce}`;
    await rename(this.claimPath, q);
    await this.verifyClaim(q);
    await unlink(q);
    this.claimNonce = undefined;
    this.claimIdentity = undefined;
  }

  private accept(socket: Socket) {
    const p: Peer = {
      socket,
      hello: false,
      closed: false,
      reads: Promise.resolve(),
      writes: Promise.resolve(),
      queuedBytes: 0,
    };
    this.peers.add(p);
    const decoder = new BoundedNdjsonDecoder(
      this.options.maxFrameBytes ?? AGENT_HOST_MAX_FRAME_BYTES,
    );
    p.timer = this.set(
      () => this.close(p),
      this.duration(this.options.attachDeadlineMs, 5_000, "attachDeadlineMs"),
    );
    socket.on("data", (b) => {
      try {
        for (const v of decoder.push(Buffer.from(b)))
          p.reads = p.reads
            .then(() => this.receive(p, v))
            .catch(() => this.close(p));
      } catch {
        this.close(p);
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch {
        this.close(p);
      }
    });
    socket.on("error", () => this.close(p));
    socket.on("close", () => this.disconnected(p));
  }
  private async receive(p: Peer, raw: unknown) {
    if (p.closed) return;
    if (!p.hello) {
      const hello = decodeAgentHostHello(raw);
      if (!hello) {
        if (rec(raw) && id(raw.requestId) && raw.version !== 4)
          this.send(p, {
            t: "error",
            version: 4,
            requestId: raw.requestId,
            code: "unsupported_version",
            message: "Unsupported Agent Host protocol version",
          });
        this.close(p);
        return;
      }
      p.hello = true;
      p.challenge = crypto.randomUUID();
      this.send(p, {
        ...hello,
        accepted: true,
        hostId: this.options.hostId,
        hostGeneration: this.options.hostGeneration,
        hostIncarnation: this.options.hostIncarnation,
        hostChallenge: p.challenge,
      });
      return;
    }
    if (!p.attached) {
      await this.attach(p, raw);
      return;
    }
    const m =
      decodeAgentHostStartTurn(raw, this.now()) ??
      decodeAgentHostOperationReceipt(raw) ??
      decodeAgentHostOperationQueryReceipt(raw) ??
      decodeAgentHostOperationCancelReceipt(raw) ??
      decodeAgentHostOperationStream(raw);
    if (!m) return this.invalid(p, raw);
    if (m.t === "start_turn") return this.startTurn(p, m);
    const turn = this.active;
    if (!turn || turn.owner !== p || !sameFence(turn.fence, m.fence))
      return this.close(p);
    await this.operationMessage(turn, m);
  }
  private invalid(p: Peer, raw: unknown) {
    this.send(p, {
      t: "error",
      version: 4,
      requestId: rec(raw) && id(raw.requestId) ? raw.requestId : "invalid",
      code: "invalid_request",
      message: "Invalid Agent Host request",
    });
    this.close(p);
  }
  private async attach(p: Peer, raw: unknown) {
    const challenge = p.challenge;
    p.challenge = undefined;
    await this.hit("afterAttachChallengeConsumed");
    const m = decodeAgentHostAttach(raw);
    if (!challenge || !m || this.attaching || this.poisoned)
      return this.close(p);
    const e = m.receipt.expected;
    if (
      !sameFence(e.fence, m.fence) ||
      e.planHash !== m.planHash ||
      e.hostId !== this.options.hostId ||
      e.hostGeneration !== this.options.hostGeneration ||
      e.hostIncarnation !== this.options.hostIncarnation ||
      e.hostChallenge !== challenge ||
      e.audience !== AGENT_HOST_SUPERVISION_AUDIENCE ||
      e.purpose !== AGENT_HOST_SUPERVISION_PURPOSE
    )
      return this.close(p);
    this.attaching = p;
    const a = await verifySignedAgentHostSupervisionEnvelopeV2(
      m.receipt.envelope,
      this.keyring,
      e,
      this.now(),
    );
    await this.hit("afterAttachVerifiedBeforeOwnerSwap");
    if (!a || p.closed || this.attaching !== p) return this.close(p);
    const turn = this.active,
      resumed =
        !!turn &&
        sameFence(turn.fence, a.fence) &&
        turn.authority.planHash === a.planHash;
    const oldEpoch = this.epochs.get(a.fence.sessionId) ?? 0,
      oldGen = this.generations.get(a.fence.sessionId) ?? 0;
    if (
      a.supervisorEpoch <= oldEpoch ||
      a.fence.generation < oldGen ||
      (turn && !resumed) ||
      (resumed && m.resume === null) ||
      (!turn && m.resume !== null)
    ) {
      this.attaching = undefined;
      return this.close(p);
    }
    const authority: Authority = {
      fence: Object.freeze({ ...a.fence }),
      planHash: a.planHash,
      supervisorEpoch: a.supervisorEpoch,
      envelope: m.receipt.envelope,
    };
    const old = resumed ? turn.owner : this.owner;
    p.attached = authority;
    this.owner = p;
    if (resumed) turn.owner = p;
    this.epochs.set(a.fence.sessionId, a.supervisorEpoch);
    this.generations.set(a.fence.sessionId, a.fence.generation);
    this.attaching = undefined;
    this.clear(p.timer);
    p.timer = undefined;
    if (resumed) {
      this.clear(turn.reconnect);
      turn.reconnect = undefined;
    }
    if (old && old !== p) this.close(old);
    await this.hit("afterOwnerSwapBeforeAttachedWrite");
    const recovery = resumed && this.needsRecovery(turn, m.resume!);
    this.send(p, {
      t: "attached",
      version: 4,
      requestId: m.requestId,
      fence: authority.fence,
      planHash: authority.planHash as `sha256:${string}`,
      supervisorEpoch: authority.supervisorEpoch,
      mode: resumed ? (recovery ? "recovery_required" : "resumed") : "fresh",
      replayFromHostSeq: resumed
        ? recovery
          ? turn.seq + 1
          : m.resume!.lastHostSeq + 1
        : 0,
    });
    if (resumed) {
      if (recovery) await this.recover(turn, m.resume!);
      else
        for (const f of turn.replay)
          if (f.seq > m.resume!.lastHostSeq) this.sendBytes(p, f.bytes);
    } else
      p.timer = this.set(
        () => {
          if (this.owner === p && !this.active) this.close(p);
        },
        this.duration(this.options.attachDeadlineMs, 5000, "attachDeadlineMs"),
      );
  }
  private async startTurn(
    p: Peer,
    m: Extract<AgentHostClientMessage, { t: "start_turn" }>,
  ) {
    const a = p.attached;
    if (
      !a ||
      this.owner !== p ||
      !sameFence(a.fence, m.spec.fence) ||
      a.planHash !== m.planHash
    )
      return this.close(p);
    let hash;
    try {
      hash = await hashAgentTurnSpecV2(m.spec, this.now());
    } catch {
      return this.close(p);
    }
    if (hash !== a.planHash) return this.close(p);
    if (this.active) return this.invalid(p, m);
    this.clear(p.timer);
    p.timer = undefined;
    let driver;
    try {
      driver = this.options.createDriver(m.spec);
    } catch (e) {
      this.send(p, {
        t: "error",
        version: 4,
        requestId: m.requestId,
        code: "turn_failed",
        message: String(e),
        fence: m.spec.fence,
      });
      return;
    }
    const t: Turn = {
      fence: m.spec.fence,
      spec: m.spec,
      driver,
      owner: p,
      authority: a,
      requestId: m.requestId,
      ops: new Map(),
      seq: 0,
      replay: [],
      replayBytes: 0,
      runSettled: false,
      cancelling: false,
      cancelSettled: false,
    };
    this.active = t;
    t.deadline = this.set(
      () => this.cancelTurn(t, "turn_deadline"),
      Math.max(0, m.spec.limits.turnDeadlineMs - this.now()),
    );
    this.sequenced(t, {
      t: "turn_started",
      version: 4,
      requestId: m.requestId,
      fence: t.fence,
    } as never);
    const transport: AgentHostOperationTransport = {
      requestOperation: (r) => this.requestOp(t, r),
      queryOperation: (q) => this.queryOp(t, q),
      cancelOperation: (c) => this.cancelOp(t, c),
    };
    let run;
    try {
      run = Promise.resolve(driver.run(m.spec, transport));
    } catch (e) {
      run = Promise.reject(e);
    }
    void run.then(
      (r) => {
        t.runSettled = true;
        t.result = r;
        this.complete(t);
      },
      (e) => {
        t.runSettled = true;
        t.result = { status: "failed", error: String(e) };
        this.complete(t);
      },
    );
  }
  private async requestOp(t: Turn, r: AgentHostOperationRequest) {
    if (this.active !== t || t.cancelling) throw Error("turn unavailable");
    if (
      t.ops.has(r.operationId) ||
      t.ops.size >= Math.min(8, t.spec.limits.maxInFlightOperations)
    )
      throw Error("operation limit");
    if (
      r.deadlineMs <= this.now() ||
      r.deadlineMs > t.spec.limits.turnDeadlineMs
    )
      throw Error("invalid deadline");
    const o: Op = {
      request: r,
      sent: new Set(),
      through: 0,
      pending: 0,
      creditsBytes: 0,
      creditsChunks: 0,
      terminal: false,
      delivery: Promise.resolve(),
      owedCreditBytes: 0,
      owedCreditChunks: 0,
    };
    t.ops.set(r.operationId, o);
    const seq = this.buffer(t, {
      t: "operation_request",
      version: 4,
      requestId: t.requestId,
      fence: t.fence,
      operationId: r.operationId,
      descriptor: r.descriptor,
      descriptorDigest: r.descriptorDigest,
      deadlineMs: r.deadlineMs,
    } as never);
    o.sent.add(seq);
    await this.hit("afterOperationIntentBufferedBeforeWrite");
    this.writeBuffered(t, seq);
    this.credit(
      t,
      o,
      0,
      INITIAL_AGENT_HOST_STREAM_BYTES,
      INITIAL_AGENT_HOST_STREAM_CHUNKS,
    );
    o.timer = this.set(
      () => {
        void this.cancelOp(t, {
          operationId: r.operationId,
          cancelId: `deadline-${crypto.randomUUID()}`,
          reason: "turn_deadline",
        });
      },
      Math.max(0, r.deadlineMs - this.now()),
    );
  }
  private async queryOp(t: Turn, q: AgentHostOperationQuery) {
    const o = t.ops.get(q.operationId);
    if (
      !o ||
      o.receipt?.payloadDigest !== q.payloadDigest ||
      o.request.descriptorDigest !== q.descriptorDigest ||
      o.request.descriptor.kind !== q.kind
    )
      throw Error("invalid query");
    o.sent.add(
      this.sequenced(t, {
        t: "operation_query",
        version: 4,
        requestId: t.requestId,
        fence: t.fence,
        ...q,
      } as never),
    );
  }
  private async cancelOp(t: Turn, c: AgentHostOperationCancel) {
    const o = t.ops.get(c.operationId);
    if (!o) throw Error("unknown operation");
    o.sent.add(
      this.sequenced(t, {
        t: "operation_cancel",
        version: 4,
        requestId: t.requestId,
        fence: t.fence,
        ...c,
      } as never),
    );
  }
  private async operationMessage(
    t: Turn,
    m: Exclude<
      AgentHostClientMessage,
      { t: "hello" | "attach" | "start_turn" }
    >,
  ) {
    const o = t.ops.get(m.operationId);
    if (!o) return this.invalid(t.owner, m);
    if (m.t === "operation_stream") return this.stream(t, o, m);
    if (
      !o.sent.has(m.ackHostSeq) ||
      !this.applyReceipt(o, m.receipt) ||
      (m.t === "operation_query_receipt" && m.fromStreamSeq !== o.through + 1)
    )
      return this.invalid(t.owner, m);
    this.complete(t);
  }
  private applyReceipt(o: Op, r: AgentOperationReceiptV1) {
    if (
      r.kind !== o.request.descriptor.kind ||
      r.descriptorDigest !== o.request.descriptorDigest
    )
      return false;
    const json = JSON.stringify(r),
      old = o.receipt;
    if (
      old &&
      (rank(r.state) < rank(old.state) ||
        (r.state === old.state && json !== o.receiptJson) ||
        (terminal(old.state) && json !== o.receiptJson) ||
        r.planHash !== old.planHash ||
        r.authorityHash !== old.authorityHash ||
        r.payloadDigest !== old.payloadDigest ||
        JSON.stringify(r.actorIdentity) !== JSON.stringify(old.actorIdentity))
    )
      return false;
    o.receipt = r;
    o.receiptJson = json;
    o.terminal = terminal(r.state);
    if (o.terminal) {
      this.clear(o.timer);
      o.timer = undefined;
    }
    return true;
  }
  private async stream(
    t: Turn,
    o: Op,
    m: Extract<AgentHostClientMessage, { t: "operation_stream" }>,
  ) {
    const n = Buffer.from(m.bytes, "base64url").byteLength;
    if (
      o.terminal ||
      !o.receipt ||
      o.receipt.state === "prepared" ||
      m.streamSeq !== o.through + o.pending + 1 ||
      n > o.creditsBytes ||
      o.creditsChunks < 1
    )
      return this.close(t.owner);
    o.creditsBytes -= n;
    o.creditsChunks--;
    o.pending++;
    try {
      await this.hit("afterStreamAcceptedBeforeDriverDelivery");
    } catch (error) {
      o.pending--;
      throw error;
    }
    o.delivery = o.delivery.then(async () => {
      try {
        await t.driver.deliverOperationStream({
          operationId: m.operationId,
          streamSeq: m.streamSeq,
          encoding: m.encoding,
          bytes: m.bytes,
        });
      } catch {
        o.pending--;
        this.cancelTurn(t, "shutdown");
        return;
      }
      o.through = m.streamSeq;
      o.pending--;
      o.owedCreditBytes += n;
      o.owedCreditChunks += 1;
      await this.hit("afterDriverDeliveryBeforeStreamAck");
      if (this.active === t) {
        this.credit(t, o, o.through, o.owedCreditBytes, o.owedCreditChunks);
        o.owedCreditBytes = 0;
        o.owedCreditChunks = 0;
      }
      this.complete(t);
    });
    await o.delivery;
  }
  private credit(
    t: Turn,
    o: Op,
    through: number,
    bytes: number,
    chunks: number,
  ) {
    const b = Math.min(
        bytes,
        MAX_AGENT_HOST_STREAM_BYTES - o.creditsBytes,
        t.spec.limits.maxBufferedStreamBytes - o.creditsBytes,
      ),
      c = Math.min(
        chunks,
        MAX_AGENT_HOST_STREAM_CHUNKS - o.creditsChunks,
        t.spec.limits.maxBufferedStreamChunks - o.creditsChunks,
      );
    if (b <= 0 || c <= 0) return;
    o.creditsBytes += b;
    o.creditsChunks += c;
    o.sent.add(
      this.sequenced(t, {
        t: "operation_stream_ack",
        version: 4,
        requestId: t.requestId,
        fence: t.fence,
        operationId: o.request.operationId,
        throughStreamSeq: through,
        creditBytes: b,
        creditChunks: c,
      } as never),
    );
  }
  private buffer(t: Turn, m: Omit<AgentHostServerMessage, "hostSeq">) {
    const seq = ++t.seq,
      bytes = encodeNdjsonFrame(
        { ...m, hostSeq: seq },
        this.options.maxFrameBytes,
      );
    t.replay.push({ seq, bytes });
    t.replayBytes += bytes.length;
    while (
      t.replay.length > MAX_AGENT_HOST_REPLAY_FRAMES ||
      t.replayBytes > MAX_AGENT_HOST_REPLAY_BYTES
    ) {
      const f = t.replay.shift()!;
      t.replayBytes -= f.bytes.length;
    }
    return seq;
  }
  private writeBuffered(t: Turn, seq: number) {
    const f = t.replay.find((x) => x.seq === seq);
    if (!f) throw Error("intent evicted before write");
    this.sendBytes(t.owner, f.bytes);
  }
  private sequenced(t: Turn, m: Omit<AgentHostServerMessage, "hostSeq">) {
    const s = this.buffer(t, m);
    this.writeBuffered(t, s);
    return s;
  }
  private needsRecovery(t: Turn, r: AgentHostAttachResumeCursorV4) {
    const oldest = t.replay[0]?.seq ?? t.seq + 1;
    if (r.lastHostSeq > t.seq || r.lastHostSeq < oldest - 1) return true;
    const c = new Map(
      r.operations.map((x) => [x.operationId, x.throughStreamSeq]),
    );
    return [...t.ops].some(
      ([k, o]) => !o.terminal || (c.get(k) ?? 0) !== o.through,
    );
  }
  private async recover(t: Turn, r: AgentHostAttachResumeCursorV4) {
    const c = new Map(
      r.operations.map((x) => [x.operationId, x.throughStreamSeq]),
    );
    for (const o of t.ops.values()) {
      if (o.owedCreditChunks > 0) {
        this.credit(t, o, o.through, o.owedCreditBytes, o.owedCreditChunks);
        o.owedCreditBytes = 0;
        o.owedCreditChunks = 0;
      }
      if (!o.receipt) {
        o.sent.add(
          this.sequenced(t, {
            t: "operation_request",
            version: 4,
            requestId: t.requestId,
            fence: t.fence,
            operationId: o.request.operationId,
            descriptor: o.request.descriptor,
            descriptorDigest: o.request.descriptorDigest,
            deadlineMs: o.request.deadlineMs,
          } as never),
        );
      } else
        await this.queryOp(t, {
          operationId: o.request.operationId,
          kind: o.request.descriptor.kind,
          descriptorDigest: o.request.descriptorDigest,
          payloadDigest: o.receipt.payloadDigest,
          afterStreamSeq: c.get(o.request.operationId) ?? 0,
        });
    }
  }
  private send(p: Peer, m: AgentHostServerMessage) {
    try {
      return this.sendBytes(
        p,
        encodeNdjsonFrame(m, this.options.maxFrameBytes),
      );
    } catch {
      return false;
    }
  }
  private sendBytes(p: Peer, b: Buffer) {
    if (
      p.closed ||
      !p.socket.writable ||
      p.socket.writableLength + p.queuedBytes + b.length >
        MAX_AGENT_HOST_WRITABLE_BYTES
    ) {
      this.close(p);
      return false;
    }
    p.queuedBytes += b.length;
    p.writes = p.writes
      .then(
        () =>
          new Promise<void>((ok, fail) => {
            if (
              p.closed ||
              p.socket.writableLength + b.length > MAX_AGENT_HOST_WRITABLE_BYTES
            )
              return fail();
            p.socket.write(b, (e) => (e ? fail(e) : ok()));
          }),
      )
      .finally(() => {
        p.queuedBytes -= b.length;
      })
      .catch(() => this.close(p));
    return true;
  }
  private disconnected(p: Peer) {
    p.closed = true;
    this.peers.delete(p);
    this.clear(p.timer);
    if (this.attaching === p) this.attaching = undefined;
    const t = this.active;
    if (t?.owner === p)
      t.reconnect = this.set(
        () => {
          void this.hit("onReconnectDeadline").finally(() =>
            this.cancelTurn(t, "reconnect_deadline"),
          );
        },
        this.duration(
          this.options.reconnectGraceMs,
          30_000,
          "reconnectGraceMs",
        ),
      );
    else if (this.owner === p) this.owner = undefined;
  }
  private cancelTurn(t: Turn, reason: AgentHostOperationCancelV4["reason"]) {
    if (this.active !== t || t.cancelling) return;
    t.cancelling = true;
    for (const o of t.ops.values())
      if (!o.terminal)
        void this.cancelOp(t, {
          operationId: o.request.operationId,
          cancelId: `cancel-${crypto.randomUUID()}`,
          reason,
        }).catch(() => {});
    let p;
    try {
      p = Promise.resolve(t.driver.cancel());
    } catch (e) {
      p = Promise.reject(e);
    }
    const timer = this.set(
      () => {
        if (!t.cancelSettled) this.poisoned = true;
      },
      this.duration(
        this.options.cancellationDeadlineMs,
        5000,
        "cancellationDeadlineMs",
      ),
    );
    void p.finally(() => {
      this.clear(timer);
      t.cancelSettled = true;
      this.complete(t);
    });
  }
  private complete(t: Turn) {
    if (
      this.active !== t ||
      !t.runSettled ||
      [...t.ops.values()].some((o) => !o.terminal || o.pending) ||
      (t.cancelling && !t.cancelSettled)
    )
      return;
    this.clear(t.deadline);
    this.clear(t.reconnect);
    for (const o of t.ops.values()) this.clear(o.timer);
    this.active = undefined;
    if (this.owner === t.owner) this.owner = undefined;
    this.close(t.owner);
  }
  private close(p: Peer) {
    if (!p.closed) {
      p.closed = true;
      p.socket.destroy();
    }
  }
}
export function createAgentHost(options: AgentHostOptions) {
  return new AgentHost(options);
}
