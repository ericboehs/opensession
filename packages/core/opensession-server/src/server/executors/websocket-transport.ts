import type { DuplexJsonTransport } from "../../runner-executor/agent";

export interface ExecutorWebSocket {
  readonly bufferedAmount: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface WebSocketTransportOptions {
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  bufferedAmountHighWater?: number;
  maxInboundQueuedBytes?: number;
  maxInboundQueuedMessages?: number;
}

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_BYTES = 2_097_152;
const DEFAULT_BUFFERED_HIGH_WATER = 2_097_152;
const DEFAULT_MAX_INBOUND_QUEUED_BYTES = 2_097_152;
const DEFAULT_MAX_INBOUND_QUEUED_MESSAGES = 256;
const encoder = new TextEncoder();

/** Strict JSON transport adapter. It has no effects until Bun dispatches socket events. */
export class ExecutorWebSocketTransport implements DuplexJsonTransport {
  readonly #socket: ExecutorWebSocket;
  readonly #maxFrameBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #bufferedHighWater: number;
  readonly #maxInboundQueuedBytes: number;
  readonly #maxInboundQueuedMessages: number;
  readonly #messages = new Set<(message: unknown) => void | Promise<void>>();
  readonly #closes = new Set<(reason?: unknown) => void>();
  readonly #inbound: Array<{ value: unknown; bytes: number }> = [];
  #sendTail: Promise<void> = Promise.resolve();
  #queuedBytes = 0;
  #inboundBytes = 0;
  #inboundMessages = 0;
  #processingInbound = false;
  #closed = false;

  constructor(
    socket: ExecutorWebSocket,
    options: WebSocketTransportOptions = {},
  ) {
    this.#socket = socket;
    this.#maxFrameBytes = positive(
      options.maxFrameBytes,
      DEFAULT_MAX_FRAME_BYTES,
    );
    this.#maxQueuedBytes = positive(
      options.maxQueuedBytes,
      DEFAULT_MAX_QUEUED_BYTES,
    );
    this.#bufferedHighWater = positive(
      options.bufferedAmountHighWater,
      DEFAULT_BUFFERED_HIGH_WATER,
    );
    this.#maxInboundQueuedBytes = positive(
      options.maxInboundQueuedBytes,
      DEFAULT_MAX_INBOUND_QUEUED_BYTES,
    );
    this.#maxInboundQueuedMessages = positive(
      options.maxInboundQueuedMessages,
      DEFAULT_MAX_INBOUND_QUEUED_MESSAGES,
    );
  }

  onMessage(handler: (message: unknown) => void | Promise<void>): () => void {
    if (this.#closed) return () => {};
    this.#messages.add(handler);
    return () => this.#messages.delete(handler);
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    if (this.#closed) return () => {};
    this.#closes.add(handler);
    return () => this.#closes.delete(handler);
  }

  receive(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.#closed) return;
    if (typeof data !== "string")
      return this.#fail(1003, "binary frames are not supported");
    const bytes = encoder.encode(data).byteLength;
    if (bytes > this.#maxFrameBytes)
      return this.#fail(1009, "executor frame is too large");
    if (
      this.#inboundBytes + bytes > this.#maxInboundQueuedBytes ||
      this.#inboundMessages + 1 > this.#maxInboundQueuedMessages
    )
      return this.#fail(1013, "executor inbound queue is under pressure");
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return this.#fail(1007, "executor frame is not valid JSON");
    }
    this.#inbound.push({ value, bytes });
    this.#inboundBytes += bytes;
    this.#inboundMessages++;
    void this.#drainInbound();
  }

  send(message: unknown): Promise<void> {
    if (this.#closed)
      return Promise.reject(new Error("executor socket is closed"));
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch {
      return Promise.reject(new Error("executor message is not serializable"));
    }
    const bytes = encoder.encode(serialized).byteLength;
    if (
      bytes > this.#maxFrameBytes ||
      this.#queuedBytes + bytes > this.#maxQueuedBytes ||
      this.#socket.bufferedAmount > this.#bufferedHighWater
    ) {
      this.#fail(1013, "executor socket is under backpressure");
      return Promise.reject(new Error("executor socket is under backpressure"));
    }
    this.#queuedBytes += bytes;
    const sent = this.#sendTail.then(() => {
      if (this.#closed) throw new Error("executor socket is closed");
      if (this.#socket.bufferedAmount > this.#bufferedHighWater) {
        this.#fail(1013, "executor socket is under backpressure");
        throw new Error("executor socket is under backpressure");
      }
      const result = this.#socket.send(serialized);
      if (
        (typeof result === "number" && result <= 0) ||
        this.#socket.bufferedAmount > this.#bufferedHighWater
      ) {
        this.#fail(1013, "executor socket is under backpressure");
        throw new Error("executor socket is under backpressure");
      }
    });
    this.#sendTail = sent
      .catch(() => {})
      .finally(() => {
        this.#queuedBytes -= bytes;
      });
    return sent;
  }

  close(reason = "executor connection closed"): void {
    this.#fail(1000, reason);
  }

  socketClosed(reason?: unknown): void {
    this.#finish(reason);
  }

  async #drainInbound(): Promise<void> {
    if (this.#processingInbound || this.#closed) return;
    this.#processingInbound = true;
    try {
      while (!this.#closed) {
        const item = this.#inbound.shift();
        if (!item) return;
        try {
          for (const handler of [...this.#messages]) await handler(item.value);
        } catch {
          this.#fail(1008, "executor frame was rejected");
        } finally {
          this.#inboundBytes = Math.max(0, this.#inboundBytes - item.bytes);
          this.#inboundMessages = Math.max(0, this.#inboundMessages - 1);
        }
      }
    } finally {
      this.#processingInbound = false;
    }
  }

  #fail(code: number, reason: string): void {
    if (this.#closed) return;
    try {
      this.#socket.close(code, reason);
    } finally {
      this.#finish(reason);
    }
  }

  #finish(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbound.length = 0;
    this.#inboundBytes = 0;
    this.#inboundMessages = 0;
    this.#messages.clear();
    for (const handler of [...this.#closes]) handler(reason);
    this.#closes.clear();
  }
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
