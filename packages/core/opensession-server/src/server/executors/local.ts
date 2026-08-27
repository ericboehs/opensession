import { spawn, type ChildProcess } from "node:child_process";
import { O_CREAT, O_NOFOLLOW, O_RDWR, O_TRUNC, O_WRONLY } from "node:constants";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExecutorOperation,
  ExecutorOperationOutcome,
  ExecutorStreamEvent,
} from "@tellahq/opensession-protocol/executor";
import {
  ExecutorFailure,
  type Executor,
  type ExecutorContext,
  type ExecutorSuccess,
} from "./contract";

export interface LocalExecutorOptions {
  rootId: string;
  rootPath: string;
  environment?: Readonly<Record<string, string>>;
  maxTrackedProcesses?: number;
  maxPendingOutputBytesPerProcess?: number;
  maxPendingOutputBytesOverall?: number;
}

const DEFAULT_MAX_TRACKED_PROCESSES = 64;
const DEFAULT_MAX_PENDING_OUTPUT_BYTES_PER_PROCESS = 1024 * 1024;
const DEFAULT_MAX_PENDING_OUTPUT_BYTES_OVERALL = 8 * 1024 * 1024;
const MAX_TEXT_EVENT_BYTES = 256 * 1024;
const MAX_TEXT_CHUNK_BYTES = 4 * 1024;
const MIN_TEXT_CHUNK_BYTES = 64;
const MAX_PENDING_EVENTS_OVERALL = 4_096;
const MAX_PENDING_CHUNKS_OVERALL = 8_192;
const EVENT_METADATA_BYTES = 128;
const CHUNK_METADATA_BYTES = 64;
const TRUNCATION_RETAINED_RESERVE =
  EVENT_METADATA_BYTES + CHUNK_METADATA_BYTES + MIN_TEXT_CHUNK_BYTES;
const EXIT_RETAINED_RESERVE = EVENT_METADATA_BYTES;
const CLOSE_EXIT_TIMEOUT_MS = 250;
const TRUNCATION_NOTICE = "[truncated]\n";
const TRUNCATION_NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE);

type PendingEvent =
  | {
      kind: "text";
      channel: "stdout" | "stderr";
      chunks: Buffer[];
      bytes: number;
      lastChunkBytes: number;
    }
  | Extract<ExecutorStreamEvent, { kind: "exit" }>;

interface LocalProcess {
  child: ChildProcess;
  processGroupId?: number;
  streamId: string;
  pending: PendingEvent[];
  pendingBytes: number;
  pendingAllocatedBytes: number;
  pendingMetadataBytes: number;
  pendingChunks: number;
  outputLimit: number;
  eventLimit: number;
  chunkLimit: number;
  decoders: Record<"stdout" | "stderr", TextDecoder>;
  listeners: {
    stdout: (chunk: Buffer) => void;
    stderr: (chunk: Buffer) => void;
    error: (error: Error) => void;
    errorSink: () => void;
    exit: () => void;
    close: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  truncated: boolean;
  exitCode?: number;
  signal?: string;
  exited: boolean;
  directExited: boolean;
  directClosed: boolean;
  acknowledged: boolean;
  terminalResult?: ExecutorSuccess;
  completedOrder?: number;
}

/** Structured local filesystem/process backend confined to one real root. */
export class LocalExecutor implements Executor {
  readonly #rootId: string;
  readonly #root: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #maxTrackedProcesses: number;
  readonly #processOutputLimit: number;
  readonly #processEventLimit: number;
  readonly #processChunkLimit: number;
  readonly #processes = new Map<string, LocalProcess>();
  #completedOrder = 0;
  #closed = false;
  #admissions = 0;
  #admissionsDrained?: { promise: Promise<void>; resolve: () => void };
  #closePromise?: Promise<void>;

  private constructor(options: LocalExecutorOptions, realRoot: string) {
    this.#rootId = options.rootId;
    this.#root = realRoot;
    this.#maxTrackedProcesses = positiveInteger(
      options.maxTrackedProcesses,
      DEFAULT_MAX_TRACKED_PROCESSES,
      "maxTrackedProcesses",
    );
    if (this.#maxTrackedProcesses > MAX_PENDING_EVENTS_OVERALL / 2)
      throw new Error(
        `maxTrackedProcesses cannot exceed ${MAX_PENDING_EVENTS_OVERALL / 2}`,
      );
    this.#processEventLimit = Math.floor(
      MAX_PENDING_EVENTS_OVERALL / this.#maxTrackedProcesses,
    );
    this.#processChunkLimit = Math.floor(
      MAX_PENDING_CHUNKS_OVERALL / this.#maxTrackedProcesses,
    );
    const perProcess = positiveInteger(
      options.maxPendingOutputBytesPerProcess,
      DEFAULT_MAX_PENDING_OUTPUT_BYTES_PER_PROCESS,
      "maxPendingOutputBytesPerProcess",
    );
    const overall = positiveInteger(
      options.maxPendingOutputBytesOverall,
      DEFAULT_MAX_PENDING_OUTPUT_BYTES_OVERALL,
      "maxPendingOutputBytesOverall",
    );
    this.#processOutputLimit = Math.min(
      perProcess,
      Math.floor(overall / this.#maxTrackedProcesses),
    );
    if (
      this.#processOutputLimit <
      TRUNCATION_RETAINED_RESERVE + EXIT_RETAINED_RESERVE
    ) {
      throw new Error(
        "pending output limits must reserve truncation and exit events for every tracked process",
      );
    }
    this.#environment = Object.freeze({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: realRoot,
      LANG: "C.UTF-8",
      ...options.environment,
    });
  }

  static async create(options: LocalExecutorOptions): Promise<LocalExecutor> {
    if (!options.rootId) throw new Error("rootId is required");
    const root = await realpath(options.rootPath);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory())
      throw new Error("local executor root must be a directory");
    return new LocalExecutor(options, root);
  }

  async execute(
    context: ExecutorContext,
    operation: ExecutorOperation,
  ): Promise<ExecutorSuccess> {
    if (context.rootId !== this.#rootId)
      throw new ExecutorFailure(
        "invalid_grant",
        "executor root binding does not match",
      );
    if (this.#closed)
      throw new ExecutorFailure("operation_failed", "executor is closed");
    try {
      switch (operation.kind) {
        case "fs.read":
          return await this.#read(operation);
        case "fs.list":
          return await this.#list(operation.path, operation.recursive ?? false);
        case "fs.stat":
          return await this.#stat(operation.path);
        case "fs.write":
          return await this.#write(operation);
        case "fs.mkdir":
          return await this.#mkdir(
            operation.path,
            operation.recursive ?? false,
          );
        case "fs.remove":
          return await this.#remove(
            operation.path,
            operation.recursive ?? false,
          );
        case "fs.move":
          return await this.#move(
            operation.from,
            operation.to,
            operation.replace ?? false,
          );
        case "process.spawn":
          this.#beginAdmission();
          try {
            return await this.#spawn(operation);
          } finally {
            this.#endAdmission();
          }
        case "process.status":
          return this.#processStatus(operation.processId);
        case "process.signal":
          return this.#signal(operation.processId, operation.signal);
        case "terminal.open":
        case "terminal.write":
        case "terminal.resize":
        case "terminal.close":
        case "service.start":
        case "service.status":
        case "service.stop":
        case "portal.open":
        case "portal.status":
        case "portal.close":
          throw new ExecutorFailure(
            "unsupported",
            `${operation.kind} is not supported by the local executor`,
          );
      }
    } catch (cause) {
      throw normalizeLocalError(cause);
    }
  }

  /** Diagnostics for verifying bounded buffering without materializing output. */
  bufferedProcessStats(processId: string): {
    bytes: number;
    allocatedBytes: number;
    metadataBytes: number;
    retainedBytes: number;
    events: number;
    chunks: number;
  } {
    const tracked = this.#processes.get(processId);
    if (!tracked)
      throw new ExecutorFailure("not_found", "process was not found");
    return {
      bytes: tracked.pendingBytes,
      allocatedBytes: tracked.pendingAllocatedBytes,
      metadataBytes: tracked.pendingMetadataBytes,
      retainedBytes:
        tracked.pendingAllocatedBytes + tracked.pendingMetadataBytes,
      events: tracked.pending.length,
      chunks: tracked.pendingChunks,
    };
  }

  /** Mark a terminal status durable after its ledger transition commits. */
  acknowledgeDurableTerminal(
    _context: ExecutorContext,
    operation: ExecutorOperation,
    outcome: ExecutorOperationOutcome,
  ): void {
    if (
      (operation.kind !== "process.status" &&
        operation.kind !== "process.signal") ||
      outcome.kind !== "process" ||
      outcome.state !== "exited" ||
      operation.processId !== outcome.processId
    )
      return;
    const tracked = this.#processes.get(outcome.processId);
    if (!tracked?.terminalResult)
      throw new ExecutorFailure(
        "conflict",
        "process terminal status is not ready to acknowledge",
      );
    tracked.acknowledged = true;
  }

  /** Explicit test/shutdown cleanup; no process or timer is created at import time. */
  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      if (this.#admissions) {
        this.#admissionsDrained ??= promiseWithResolvers();
        await this.#admissionsDrained.promise;
      }
      let results: PromiseSettledResult<void>[] = [];
      try {
        results = await Promise.allSettled(
          [...this.#processes.values()].map((tracked) =>
            this.#terminateDirectChild(tracked),
          ),
        );
      } finally {
        for (const tracked of this.#processes.values()) this.#detach(tracked);
        this.#processes.clear();
      }
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new ExecutorFailure(
          "operation_failed",
          `failed to confirm termination of ${failures.length} local process(es)`,
        );
    })();
    return this.#closePromise;
  }

  // Descendants that detach or close inherited FDs can outlive both direct-child
  // events, and setsid descendants escape the saved process group entirely.
  // Confirming those requires a future cgroup/Job Object containment backend.
  async #terminateDirectChild(tracked: LocalProcess): Promise<void> {
    if (
      tracked.processGroupId &&
      (!tracked.directExited || !tracked.directClosed)
    ) {
      try {
        globalThis.process.kill(-tracked.processGroupId, "SIGKILL");
      } catch {}
    }
    if (
      tracked.directExited ||
      (!tracked.processGroupId && tracked.directClosed)
    )
      return;
    try {
      tracked.child.kill("SIGKILL");
    } catch {}
    if (!tracked.directExited)
      await waitForChildExit(tracked.child, CLOSE_EXIT_TIMEOUT_MS);
  }

  #beginAdmission(): void {
    if (this.#closed)
      throw new ExecutorFailure("operation_failed", "executor is closed");
    this.#admissions++;
  }

  #endAdmission(): void {
    this.#admissions--;
    if (!this.#admissions) {
      this.#admissionsDrained?.resolve();
      this.#admissionsDrained = undefined;
    }
  }

  async #read(
    operation: Extract<ExecutorOperation, { kind: "fs.read" }>,
  ): Promise<ExecutorSuccess> {
    const path = await this.#existingPath(operation.path, true);
    if (
      operation.offset !== undefined &&
      (!Number.isSafeInteger(operation.offset) || operation.offset < 0)
    ) {
      throw new ExecutorFailure(
        "invalid_request",
        "read offset must be a non-negative safe integer",
      );
    }
    if (
      operation.length !== undefined &&
      (!Number.isSafeInteger(operation.length) || operation.length < 0)
    ) {
      throw new ExecutorFailure(
        "invalid_request",
        "read length must be a non-negative safe integer",
      );
    }
    const contents = await readFile(path);
    const offset = operation.offset ?? 0;
    const selected = contents.subarray(
      offset,
      operation.length === undefined ? undefined : offset + operation.length,
    );
    const streamId = crypto.randomUUID();
    try {
      const data = new TextDecoder("utf-8", { fatal: true }).decode(selected);
      return {
        outcome: {
          kind: "fs.read",
          streamId,
          size: selected.byteLength,
          binary: false,
        },
        events: [
          {
            kind: "text",
            streamId,
            sequence: 0,
            channel: "file",
            data,
            eof: true,
          },
        ],
      };
    } catch {
      return {
        outcome: {
          kind: "fs.read",
          streamId,
          size: selected.byteLength,
          binary: true,
        },
        events: [
          {
            kind: "binary",
            streamId,
            sequence: 0,
            offset: 0,
            data: selected.toString("base64"),
            metadata: { encoding: "base64", byteLength: selected.byteLength },
            eof: true,
          },
        ],
      };
    }
  }

  async #list(input: string, recursive: boolean): Promise<ExecutorSuccess> {
    const start = await this.#existingPath(input, true);
    const startStat = await stat(start);
    if (!startStat.isDirectory())
      throw new ExecutorFailure(
        "invalid_request",
        "list path is not a directory",
      );
    const entries: Extract<
      ExecutorOperationOutcome,
      { kind: "fs.list" }
    >["entries"] = [];
    const visit = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const absolute = resolve(directory, child.name);
        const childStat = await lstat(absolute);
        const type = childStat.isSymbolicLink()
          ? "symlink"
          : childStat.isDirectory()
            ? "directory"
            : "file";
        entries.push({
          path: this.#relativePath(absolute),
          type,
          ...(type === "file" ? { size: childStat.size } : {}),
        });
        if (recursive && type === "directory") await visit(absolute);
      }
    };
    await visit(start);
    return { outcome: { kind: "fs.list", entries } };
  }

  async #stat(input: string): Promise<ExecutorSuccess> {
    const lexical = this.#lexicalPath(input);
    await this.#assertParentConfined(lexical);
    const entryStat = await lstat(lexical);
    const type = entryStat.isSymbolicLink()
      ? "symlink"
      : entryStat.isDirectory()
        ? "directory"
        : "file";
    return {
      outcome: {
        kind: "fs.stat",
        entry: {
          path: this.#relativePath(lexical),
          type,
          size: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
        },
      },
    };
  }

  async #write(
    operation: Extract<ExecutorOperation, { kind: "fs.write" }>,
  ): Promise<ExecutorSuccess> {
    const target = await this.#writablePath(operation.path);
    const data =
      operation.encoding === "base64"
        ? Buffer.from(operation.data, "base64")
        : Buffer.from(operation.data, "utf8");
    const flags =
      operation.create === false
        ? O_RDWR | O_NOFOLLOW
        : O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW;
    const handle = await open(target, flags, 0o666);
    try {
      if (operation.create === false) await handle.truncate(0);
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    await this.#existingPath(operation.path, true);
    return {
      outcome: { kind: "fs.changed", path: this.#relativePath(target) },
    };
  }

  async #mkdir(input: string, recursive: boolean): Promise<ExecutorSuccess> {
    const target = await this.#writablePath(input);
    await mkdir(target, { recursive });
    await this.#existingPath(input, true);
    return {
      outcome: { kind: "fs.changed", path: this.#relativePath(target) },
    };
  }

  async #remove(input: string, recursive: boolean): Promise<ExecutorSuccess> {
    const target = this.#lexicalPath(input);
    if (target === this.#root)
      throw new ExecutorFailure(
        "invalid_request",
        "executor root cannot be removed",
      );
    await this.#assertParentConfined(target);
    const targetStat = await lstat(target);
    if (!targetStat.isSymbolicLink())
      await this.#assertRealConfined(await realpath(target));
    await rm(target, { recursive, force: false });
    return {
      outcome: { kind: "fs.changed", path: this.#relativePath(target) },
    };
  }

  async #move(
    fromInput: string,
    toInput: string,
    replace: boolean,
  ): Promise<ExecutorSuccess> {
    const from = await this.#existingPath(fromInput, false);
    if (from === this.#root)
      throw new ExecutorFailure(
        "invalid_request",
        "executor root cannot be moved",
      );
    const to = await this.#writablePath(toInput);
    if (!replace) {
      try {
        await lstat(to);
        throw new ExecutorFailure(
          "conflict",
          "move destination already exists",
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
      }
    }
    await rename(from, to);
    await this.#assertParentConfined(to);
    return { outcome: { kind: "fs.changed", path: this.#relativePath(to) } };
  }

  async #spawn(
    operation: Extract<ExecutorOperation, { kind: "process.spawn" }>,
  ): Promise<ExecutorSuccess> {
    if (
      !operation.executable ||
      operation.executable.includes("\0") ||
      operation.args.some(
        (arg) => typeof arg !== "string" || arg.includes("\0"),
      )
    ) {
      throw new ExecutorFailure(
        "invalid_request",
        "process executable and arguments must be native strings",
      );
    }
    const cwd = await this.#existingPath(operation.cwd ?? ".", true);
    if (!(await stat(cwd)).isDirectory())
      throw new ExecutorFailure(
        "invalid_request",
        "process cwd is not a directory",
      );
    if (this.#closed)
      throw new ExecutorFailure("operation_failed", "executor is closed");
    this.#makeProcessRoom();
    const child = spawn(operation.executable, operation.args, {
      cwd,
      env: { ...this.#environment } as NodeJS.ProcessEnv,
      detached: true,
      shell: false,
      stdio: [
        operation.stdin === "pipe" ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ] as any,
    }) as ChildProcess;
    const processId = crypto.randomUUID();
    const streamId = crypto.randomUUID();
    const tracked: LocalProcess = {
      child,
      processGroupId: child.pid,
      streamId,
      pending: [],
      pendingBytes: 0,
      pendingAllocatedBytes: 0,
      pendingMetadataBytes: 0,
      pendingChunks: 0,
      outputLimit: this.#processOutputLimit,
      eventLimit: this.#processEventLimit,
      chunkLimit: this.#processChunkLimit,
      decoders: {
        stdout: new TextDecoder(),
        stderr: new TextDecoder(),
      },
      listeners: {} as LocalProcess["listeners"],
      truncated: false,
      exited: false,
      directExited: false,
      directClosed: false,
      acknowledged: false,
    };
    tracked.listeners = {
      stdout: (chunk) => this.#collect(tracked, "stdout", Buffer.from(chunk)),
      stderr: (chunk) => this.#collect(tracked, "stderr", Buffer.from(chunk)),
      error: (error) => this.#appendText(tracked, "stderr", error.message),
      errorSink: () => {},
      exit: () => {
        tracked.directExited = true;
      },
      close: (code, signal) => {
        tracked.directClosed = true;
        this.#flushDecoder(tracked, "stdout");
        this.#flushDecoder(tracked, "stderr");
        tracked.exited = true;
        tracked.completedOrder = this.#completedOrder++;
        if (code !== null) tracked.exitCode = code;
        if (signal) tracked.signal = signal;
        tracked.pending.push({
          kind: "exit",
          streamId,
          sequence: 0,
          exitCode: code,
          ...(signal ? { signal } : {}),
        });
        tracked.pendingMetadataBytes += EVENT_METADATA_BYTES;
      },
    };
    this.#processes.set(processId, tracked);
    child.stdout?.on("data", tracked.listeners.stdout);
    child.stderr?.on("data", tracked.listeners.stderr);
    child.on("error", tracked.listeners.errorSink);
    child.once("error", tracked.listeners.error);
    child.once("exit", tracked.listeners.exit);
    child.once("close", tracked.listeners.close);
    return {
      outcome: { kind: "process", processId, state: "running", streamId },
    };
  }

  #processStatus(processId: string): ExecutorSuccess {
    const tracked = this.#processes.get(processId);
    if (!tracked)
      throw new ExecutorFailure("not_found", "process was not found");
    if (tracked.terminalResult) return tracked.terminalResult;

    const streamId = crypto.randomUUID();
    const events = materializeEvents(tracked.pending, streamId);
    tracked.pending.length = 0;
    tracked.pendingBytes = 0;
    tracked.pendingAllocatedBytes = 0;
    tracked.pendingMetadataBytes = 0;
    tracked.pendingChunks = 0;
    const result: ExecutorSuccess = {
      outcome: {
        kind: "process",
        processId,
        state: tracked.exited ? "exited" : "running",
        ...(tracked.exitCode !== undefined
          ? { exitCode: tracked.exitCode }
          : {}),
        streamId,
      },
      ...(events.length ? { events } : {}),
    };
    if (tracked.exited) {
      tracked.terminalResult = result;
      this.#detach(tracked);
    } else if (tracked.truncated) {
      tracked.truncated = false;
      tracked.decoders.stdout = new TextDecoder();
      tracked.decoders.stderr = new TextDecoder();
    }
    return result;
  }

  #makeProcessRoom(): void {
    while (this.#processes.size >= this.#maxTrackedProcesses) {
      let oldest: [string, LocalProcess] | undefined;
      for (const entry of this.#processes) {
        if (
          entry[1].acknowledged &&
          entry[1].completedOrder !== undefined &&
          (!oldest ||
            entry[1].completedOrder < (oldest[1].completedOrder ?? Infinity))
        )
          oldest = entry;
      }
      if (!oldest)
        throw new ExecutorFailure(
          "executor_busy",
          "local process capacity is exhausted",
        );
      this.#reap(...oldest);
    }
  }

  #collect(
    tracked: LocalProcess,
    channel: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    if (tracked.truncated) return;
    this.#appendText(
      tracked,
      channel,
      tracked.decoders[channel].decode(chunk, { stream: true }),
    );
  }

  #flushDecoder(tracked: LocalProcess, channel: "stdout" | "stderr"): void {
    if (!tracked.truncated)
      this.#appendText(tracked, channel, tracked.decoders[channel].decode());
  }

  #appendText(
    tracked: LocalProcess,
    channel: "stdout" | "stderr",
    text: string,
  ): void {
    if (!text || tracked.truncated) return;
    const available =
      tracked.outputLimit - tracked.pendingBytes - TRUNCATION_NOTICE_BYTES;
    const { selected, complete } = utf8Prefix(text, Math.max(0, available));
    let retainedAll = complete;
    for (const part of splitUtf8(selected, MAX_TEXT_EVENT_BYTES)) {
      if (!this.#appendPendingText(tracked, channel, part)) {
        retainedAll = false;
        break;
      }
    }
    if (!retainedAll) {
      this.#appendPendingText(tracked, channel, TRUNCATION_NOTICE, true);
      tracked.truncated = true;
      tracked.decoders.stdout = new TextDecoder();
      tracked.decoders.stderr = new TextDecoder();
    }
  }

  #appendPendingText(
    tracked: LocalProcess,
    channel: "stdout" | "stderr",
    data: string,
    notice = false,
  ): boolean {
    const encoded = Buffer.from(data);
    const last = tracked.pending.at(-1);
    if (
      last?.kind === "text" &&
      last.channel === channel &&
      last.bytes + encoded.byteLength <= MAX_TEXT_EVENT_BYTES
    )
      return this.#appendEncoded(tracked, last, encoded, notice);
    const normalEventLimit = tracked.eventLimit - 2;
    if (!notice && tracked.pending.length >= normalEventLimit) return false;
    if (!this.#reserveRetained(tracked, EVENT_METADATA_BYTES, notice))
      return false;
    const event: Extract<PendingEvent, { kind: "text" }> = {
      kind: "text",
      channel,
      chunks: [],
      bytes: 0,
      lastChunkBytes: 0,
    };
    tracked.pending.push(event);
    tracked.pendingMetadataBytes += EVENT_METADATA_BYTES;
    return this.#appendEncoded(tracked, event, encoded, notice);
  }

  #appendEncoded(
    tracked: LocalProcess,
    event: Extract<PendingEvent, { kind: "text" }>,
    data: Buffer,
    notice: boolean,
  ): boolean {
    let offset = 0;
    while (offset < data.byteLength) {
      let target = event.chunks.at(-1);
      if (target && event.lastChunkBytes === target.byteLength) {
        if (target.byteLength < MAX_TEXT_CHUNK_BYTES) {
          const capacity = Math.min(
            MAX_TEXT_CHUNK_BYTES,
            Math.max(
              target.byteLength * 2,
              target.byteLength + data.byteLength - offset,
            ),
          );
          const delta = capacity - target.byteLength;
          if (!this.#reserveRetained(tracked, delta, notice)) return false;
          const grown = Buffer.allocUnsafe(capacity);
          target.copy(grown);
          event.chunks[event.chunks.length - 1] = grown;
          tracked.pendingAllocatedBytes += delta;
          target = grown;
        } else target = undefined;
      }
      if (!target) {
        const normalChunkLimit = tracked.chunkLimit - 1;
        if (!notice && tracked.pendingChunks >= normalChunkLimit) return false;
        const capacity = Math.min(
          MAX_TEXT_CHUNK_BYTES,
          Math.max(MIN_TEXT_CHUNK_BYTES, data.byteLength - offset),
        );
        const retained = capacity + CHUNK_METADATA_BYTES;
        if (!this.#reserveRetained(tracked, retained, notice)) return false;
        target = Buffer.allocUnsafe(capacity);
        event.chunks.push(target);
        event.lastChunkBytes = 0;
        tracked.pendingChunks++;
        tracked.pendingAllocatedBytes += capacity;
        tracked.pendingMetadataBytes += CHUNK_METADATA_BYTES;
      }
      const length = Math.min(
        data.byteLength - offset,
        target.byteLength - event.lastChunkBytes,
      );
      data.copy(target, event.lastChunkBytes, offset, offset + length);
      event.lastChunkBytes += length;
      event.bytes += length;
      tracked.pendingBytes += length;
      offset += length;
    }
    return true;
  }

  #reserveRetained(
    tracked: LocalProcess,
    bytes: number,
    notice: boolean,
  ): boolean {
    const reserve = notice
      ? EXIT_RETAINED_RESERVE
      : TRUNCATION_RETAINED_RESERVE + EXIT_RETAINED_RESERVE;
    return (
      tracked.pendingAllocatedBytes + tracked.pendingMetadataBytes + bytes <=
      tracked.outputLimit - reserve
    );
  }

  #reap(processId: string, tracked: LocalProcess): void {
    this.#detach(tracked);
    tracked.pending.length = 0;
    tracked.pendingBytes = 0;
    tracked.pendingAllocatedBytes = 0;
    tracked.pendingMetadataBytes = 0;
    tracked.pendingChunks = 0;
    this.#processes.delete(processId);
  }

  #detach(tracked: LocalProcess): void {
    tracked.child.stdout?.removeListener("data", tracked.listeners.stdout);
    tracked.child.stderr?.removeListener("data", tracked.listeners.stderr);
    tracked.child.removeListener("error", tracked.listeners.error);
    tracked.child.removeListener("exit", tracked.listeners.exit);
    tracked.child.removeListener("close", tracked.listeners.close);
    tracked.child.stdout?.destroy();
    tracked.child.stderr?.destroy();
    tracked.child.stdin?.destroy();
  }

  #signal(
    processId: string,
    signal: "interrupt" | "terminate" | "kill",
  ): ExecutorSuccess {
    const tracked = this.#processes.get(processId);
    if (!tracked)
      throw new ExecutorFailure("not_found", "process was not found");
    if (!tracked.exited && tracked.child.pid) {
      const nativeSignal =
        signal === "interrupt"
          ? "SIGINT"
          : signal === "terminate"
            ? "SIGTERM"
            : "SIGKILL";
      try {
        globalThis.process.kill(-tracked.child.pid, nativeSignal);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== "ESRCH") throw cause;
      }
    }
    return this.#processStatus(processId);
  }

  #lexicalPath(input: string): string {
    if (
      typeof input !== "string" ||
      input.includes("\0") ||
      isAbsolute(input) ||
      /^[A-Za-z]:[\\/]/.test(input)
    ) {
      throw new ExecutorFailure(
        "invalid_request",
        "executor paths must be relative",
      );
    }
    const segments = input.split(/[\\/]+/);
    if (segments.includes(".."))
      throw new ExecutorFailure(
        "invalid_request",
        "path traversal is not allowed",
      );
    const target = resolve(this.#root, input || ".");
    this.#assertLexicallyConfined(target);
    return target;
  }

  async #existingPath(
    input: string,
    followFinalSymlink: boolean,
  ): Promise<string> {
    const lexical = this.#lexicalPath(input);
    await this.#assertParentConfined(lexical);
    const targetStat = await lstat(lexical);
    if (targetStat.isSymbolicLink() && !followFinalSymlink) return lexical;
    await this.#assertRealConfined(await realpath(lexical));
    return lexical;
  }

  async #writablePath(input: string): Promise<string> {
    const lexical = this.#lexicalPath(input);
    if (lexical === this.#root) return lexical;
    await this.#assertParentConfined(lexical);
    try {
      const targetStat = await lstat(lexical);
      if (targetStat.isSymbolicLink()) {
        try {
          await this.#assertRealConfined(await realpath(lexical));
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
            throw new ExecutorFailure(
              "invalid_request",
              "dangling symlink write targets are not allowed",
            );
          }
          throw cause;
        }
      } else {
        await this.#assertRealConfined(await realpath(lexical));
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
    }
    return lexical;
  }

  async #assertParentConfined(target: string): Promise<void> {
    let current = target === this.#root ? target : resolve(target, "..");
    for (;;) {
      try {
        await this.#assertRealConfined(await realpath(current));
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code !== "ENOENT") throw cause;
        const parent = resolve(current, "..");
        if (parent === current)
          throw new ExecutorFailure(
            "invalid_request",
            "path has no confined ancestor",
          );
        current = parent;
      }
    }
  }

  #assertLexicallyConfined(target: string): void {
    const rel = relative(this.#root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ExecutorFailure(
        "invalid_request",
        "path escapes the executor root",
      );
    }
  }

  async #assertRealConfined(target: string): Promise<void> {
    this.#assertLexicallyConfined(target);
  }

  #relativePath(target: string): string {
    return relative(this.#root, target).split(sep).join("/") || ".";
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolveWait, rejectWait) => {
    const finish = () => {
      clearTimeout(timeout);
      child.removeListener("exit", finish);
      child.removeListener("close", finish);
      resolveWait();
    };
    const timeout = setTimeout(() => {
      child.removeListener("exit", finish);
      child.removeListener("close", finish);
      rejectWait(
        new Error("direct child did not terminate before close deadline"),
      );
    }, timeoutMs);
    timeout.unref?.();
    child.once("exit", finish);
    child.once("close", finish);
  });
}

function materializeEvents(
  pending: readonly PendingEvent[],
  streamId: string,
): ExecutorStreamEvent[] {
  return pending.map((event, sequence) =>
    event.kind === "text"
      ? {
          kind: "text",
          streamId,
          sequence,
          channel: event.channel,
          data: Buffer.concat(event.chunks, event.bytes).toString("utf8"),
        }
      : { ...event, streamId, sequence },
  );
}

function promiseWithResolvers(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return selected;
}

function utf8Prefix(
  text: string,
  maxBytes: number,
): { selected: string; complete: boolean } {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes)
      return { selected: text.slice(0, end), complete: false };
    bytes += characterBytes;
    end += character.length;
  }
  return { selected: text, complete: true };
}

function splitUtf8(text: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest) {
    const { selected } = utf8Prefix(rest, maxBytes);
    if (!selected) break;
    parts.push(selected);
    rest = rest.slice(selected.length);
  }
  return parts;
}

function normalizeLocalError(cause: unknown): ExecutorFailure {
  if (cause instanceof ExecutorFailure) return cause;
  const code = (cause as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ESRCH")
    return new ExecutorFailure("not_found", "executor target was not found");
  if (code === "EEXIST" || code === "ENOTEMPTY")
    return new ExecutorFailure(
      "conflict",
      "executor target conflicts with existing state",
    );
  return new ExecutorFailure(
    "operation_failed",
    cause instanceof Error ? cause.message : String(cause),
  );
}
