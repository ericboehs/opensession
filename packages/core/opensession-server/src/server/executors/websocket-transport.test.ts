import { describe, expect, test } from "bun:test";
import { ExecutorWebSocketTransport } from "./websocket-transport";

class Socket {
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Executor WebSocket transport", () => {
  test("accepts bounded text JSON and rejects malformed, binary, and oversized frames", () => {
    const socket = new Socket();
    const transport = new ExecutorWebSocketTransport(socket, {
      maxFrameBytes: 16,
    });
    const received: unknown[] = [];
    transport.onMessage((message) => {
      received.push(message);
    });
    transport.receive('{"ok":true}');
    expect(received).toEqual([{ ok: true }]);
    transport.receive(new Uint8Array([1]));
    expect(socket.closes.at(-1)?.[0]).toBe(1003);

    const malformed = new Socket();
    new ExecutorWebSocketTransport(malformed).receive("{");
    expect(malformed.closes.at(-1)?.[0]).toBe(1007);
    const oversized = new Socket();
    new ExecutorWebSocketTransport(oversized, { maxFrameBytes: 3 }).receive(
      '"long"',
    );
    expect(oversized.closes.at(-1)?.[0]).toBe(1009);
  });

  test("serializes inbound frames and bounds aggregate queued messages and bytes", async () => {
    const socket = new Socket();
    const transport = new ExecutorWebSocketTransport(socket, {
      maxInboundQueuedMessages: 2,
      maxInboundQueuedBytes: 32,
    });
    const order: number[] = [];
    let release!: () => void;
    transport.onMessage(async (message) => {
      const value = (message as { value: number }).value;
      order.push(value);
      if (value === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
    });
    transport.receive('{"value":1}');
    transport.receive('{"value":2}');
    expect(order).toEqual([1]);
    release();
    await tick();
    expect(order).toEqual([1, 2]);

    const flooded = new Socket();
    const bounded = new ExecutorWebSocketTransport(flooded, {
      maxInboundQueuedMessages: 1,
    });
    bounded.onMessage(() => new Promise(() => {}));
    bounded.receive("{}");
    bounded.receive("{}");
    expect(flooded.closes.at(-1)?.[0]).toBe(1013);
  });

  test("serializes sends and closes 1013 on queued or socket pressure", async () => {
    const socket = new Socket();
    const transport = new ExecutorWebSocketTransport(socket, {
      maxQueuedBytes: 10,
      bufferedAmountHighWater: 10,
    });
    await expect(transport.send({ tooLarge: true })).rejects.toThrow(
      "backpressure",
    );
    expect(socket.closes.at(-1)?.[0]).toBe(1013);

    const buffered = new Socket();
    buffered.bufferedAmount = 11;
    const pressured = new ExecutorWebSocketTransport(buffered, {
      bufferedAmountHighWater: 10,
    });
    await expect(pressured.send({ ok: true })).rejects.toThrow("backpressure");
    expect(buffered.closes.at(-1)?.[0]).toBe(1013);
    await tick();
  });

  test("cleans listeners and closes idempotently", () => {
    const socket = new Socket();
    const transport = new ExecutorWebSocketTransport(socket);
    let closes = 0;
    transport.onClose(() => closes++);
    transport.close("done");
    transport.close("again");
    transport.socketClosed("late");
    expect(closes).toBe(1);
    expect(socket.closes).toHaveLength(1);
  });
});
