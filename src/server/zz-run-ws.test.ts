/**
 * run-ws transport tests: seq/ack replay (ws-buffer.ts + run-ws.ts) and the
 * upgrade auth rules. Drives a real Bun.serve wired exactly like backstage.ts
 * (fetch → handleSandboxWsUpgrade, websocket → sandboxWs* hooks) with scripted
 * WS clients playing the host side — no model runs, no sandboxes.
 *
 * zz- prefix: keeps this at the end of the full suite like the other
 * integration-ish test files.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as runWs from "./run-ws";
import { WsFrameBuffer, replayStartFor } from "../runner-host/ws-buffer";

// ── scratch server (same wiring as backstage.ts / the verify suites) ─────────

const srv = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, server) {
    return (
      runWs.handleSandboxWsUpgrade(req, server, new URL(req.url).pathname) ??
      undefined
    );
  },
  websocket: {
    open(ws) {
      runWs.sandboxWsOpen(ws);
    },
    message(ws, m) {
      runWs.sandboxWsMessage(ws, m as any);
    },
    close(ws) {
      runWs.sandboxWsClose(ws);
    },
  },
});
const BASE = `127.0.0.1:${srv.port}`;

afterAll(() => {
  srv.stop(true);
});

async function until<T>(fn: () => T | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scripted host: dials the run-ws route and records inbound messages. */
function dialHost(hostId: string, token: string) {
  const inbox: any[] = [];
  const sock = new WebSocket(`ws://${BASE}/backstage/run-ws/${hostId}`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  let open = false;
  let closed = false;
  sock.onopen = () => {
    open = true;
  };
  sock.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  sock.onclose = () => {
    closed = true;
  };
  return {
    sock,
    inbox,
    isOpen: () => open,
    isClosed: () => closed,
    nextAck: (after = 0) =>
      until(() => inbox.filter((m) => m.t === "ack")[after], 5_000),
  };
}

// ── ws-buffer unit behavior ───────────────────────────────────────────────────

describe("WsFrameBuffer", () => {
  test("stamps monotonically and replays after a watermark", () => {
    const buf = new WsFrameBuffer();
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", i });
    expect(buf.lastSeq).toBe(5);
    const r = buf.replayFrom(2);
    expect(r.gap).toBeNull();
    expect(r.lines.map((l) => JSON.parse(l).seq)).toEqual([3, 4, 5]);
  });

  test("ack releases frames below the watermark", () => {
    const buf = new WsFrameBuffer();
    for (let i = 1; i <= 4; i++) buf.stamp({ t: "event", i });
    buf.ack(3);
    expect(buf.replayFrom(3).lines.map((l) => JSON.parse(l).seq)).toEqual([4]);
  });

  test("overflow drops oldest and reports the gap", () => {
    const buf = new WsFrameBuffer(3, Number.MAX_SAFE_INTEGER);
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", i });
    const r = buf.replayFrom(0);
    expect(r.gap).toEqual({ from: 1, to: 2 });
    expect(r.lines.map((l) => JSON.parse(l).seq)).toEqual([3, 4, 5]);
    // A replay that starts past the hole reports no gap.
    expect(buf.replayFrom(2).gap).toBeNull();
  });

  test("byte bound trims like the frame bound", () => {
    const buf = new WsFrameBuffer(10_000, 90);
    for (let i = 1; i <= 5; i++) buf.stamp({ t: "event", pad: "x".repeat(20) });
    const r = buf.replayFrom(0);
    expect(r.lines.length).toBeLessThan(5);
    expect(r.gap?.from).toBe(1);
  });
});

describe("replayStartFor", () => {
  test("matching epoch resumes from the server's consumed watermark", () => {
    expect(replayStartFor({ seq: 3, epoch: "e1" }, "e1", 7)).toBe(3);
    // Clamped — the server can't have consumed frames we never produced.
    expect(replayStartFor({ seq: 9, epoch: "e1" }, "e1", 7)).toBe(7);
  });
  test("new/unknown epoch streams from the connection point (no replay)", () => {
    expect(replayStartFor({ seq: 3, epoch: "e2" }, "e1", 7)).toBe(7);
    expect(replayStartFor({ seq: 3 }, "e1", 7)).toBe(7);
    expect(replayStartFor({ seq: 3, epoch: "e1" }, null, 0)).toBe(0);
  });
});

// ── end-to-end: dial, consume, drop, redial, replay, dedupe ──────────────────

describe("run-ws seq/ack replay", () => {
  test("reconnect replays the disconnect window exactly once", async () => {
    const hostId = "rh-zz-replay";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const buf = new WsFrameBuffer();

    // First connection: hello-ack arrives with seq 0 and a stable epoch.
    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    expect(ack1.seq).toBe(0);
    const epoch: string = ack1.epoch;
    expect(epoch).toBeTruthy();

    // Stream hello + three sequenced frames, then attach a consumer.
    c1.sock.send(JSON.stringify({ t: "hello", hostId, state: "running", pendingAsks: [] }));
    for (let i = 1; i <= 3; i++) {
      c1.sock.send(buf.stamp({ t: "event", event: { type: "text_chunk", text: `e${i}` } }));
    }
    const got1: any[] = [];
    let closed1 = false;
    const connector = runWs.runWsConnector(hostId);
    await until(() => runWs.hasLiveRunWsConnection(hostId));
    const conn1 = await connector.connect({
      onMsg: (m) => got1.push(m),
      onClose: () => {
        closed1 = true;
      },
    });
    await until(() => got1.length >= 4);
    expect(got1.map((m) => m.t)).toEqual(["hello", "event", "event", "event"]);
    // The consumed watermark advanced to 3 — a ping piggybacks an ack with it.
    c1.sock.send('{"t":"ping"}');
    const flushAck = await until(() => c1.inbox.find((m) => m.t === "ack" && m.seq === 3));
    expect(flushAck.epoch).toBe(epoch);
    expect(conn1.send({ t: "pong" })).toBe(true);

    // Server-side drop (network blip): host keeps stamping while offline.
    expect(runWs.dropRunWsConnection(hostId)).toBe(true);
    await until(() => c1.isClosed() && closed1);
    for (let i = 4; i <= 6; i++) {
      buf.stamp({ t: "event", event: { type: "text_chunk", text: `e${i}` } });
    }

    // Redial: the hello-ack still carries the SAME epoch and the consumed
    // watermark (3) — replay from there, deliberately overlapping (2..6) to
    // prove the server drops already-consumed seqs.
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.epoch).toBe(epoch);
    expect(ack2.seq).toBe(3);
    const from = replayStartFor(ack2, epoch, buf.lastSeq);
    expect(from).toBe(3);
    for (const line of buf.replayFrom(from - 1).lines) c2.sock.send(line); // overlap: 3..6
    const got2: any[] = [];
    const conn2 = await connector.connect({ onMsg: (m) => got2.push(m), onClose: () => {} });
    await until(() => got2.length >= 3);
    expect(got2.map((m) => m.seq)).toEqual([4, 5, 6]); // 3 deduped, 4..6 once
    c2.sock.send('{"t":"ping"}');
    await until(() => c2.inbox.find((m) => m.t === "ack" && m.seq === 6));
    conn2.close();
    runWs.unregisterRunWsHost(hostId);
  });

  test("frames parked before a consumer attaches are not acked (and survive a drop)", async () => {
    const hostId = "rh-zz-preattach";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const buf = new WsFrameBuffer();

    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    expect(ack1.seq).toBe(0);
    c1.sock.send(buf.stamp({ t: "event", event: { type: "text_chunk", text: "a" } }));
    c1.sock.send(buf.stamp({ t: "event", event: { type: "text_chunk", text: "b" } }));
    // Give the server a beat to park them, then drop with no consumer attached.
    await new Promise((r) => setTimeout(r, 100));
    c1.sock.close();
    await until(() => c1.isClosed());

    // The parked frames died with the socket — but they were never acked, so
    // the redial's hello-ack still says 0 and the replay recovers them.
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.seq).toBe(0);
    for (const line of buf.replayFrom(replayStartFor(ack2, ack2.epoch, 0)).lines) {
      c2.sock.send(line);
    }
    const got: any[] = [];
    const conn = await runWs.runWsConnector(hostId).connect({
      onMsg: (m) => got.push(m),
      onClose: () => {},
    });
    await until(() => got.length >= 2);
    expect(got.map((m) => m.seq)).toEqual([1, 2]);
    conn.close();
    runWs.unregisterRunWsHost(hostId);
  });

  test("unregister mints a fresh epoch (no replay into a new registration)", async () => {
    const hostId = "rh-zz-epoch";
    const token = crypto.randomUUID();
    runWs.registerRunWsHost(hostId, token);
    const c1 = dialHost(hostId, token);
    const ack1 = await c1.nextAck();
    runWs.unregisterRunWsHost(hostId);
    await until(() => c1.isClosed());

    runWs.registerRunWsHost(hostId, token);
    const c2 = dialHost(hostId, token);
    const ack2 = await c2.nextAck();
    expect(ack2.epoch).not.toBe(ack1.epoch);
    // Host side: mismatched epoch → stream from the connection point only.
    expect(replayStartFor(ack2, ack1.epoch, 5)).toBe(5);
    c2.sock.close();
    runWs.unregisterRunWsHost(hostId);
  });
});

// ── upgrade auth ───────────────────────────────────────────────────────────────

describe("run-ws upgrade auth", () => {
  test("run-ws rejects a wrong/missing token pre-upgrade", async () => {
    runWs.registerRunWsHost("rh-zz-auth", "right-token");
    const wrong = await fetch(`http://${BASE}/backstage/run-ws/rh-zz-auth`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(403);
    const missing = await fetch(`http://${BASE}/backstage/run-ws/rh-zz-auth`);
    expect(missing.status).toBe(403);
    const unknownHost = await fetch(`http://${BASE}/backstage/run-ws/rh-zz-nope`, {
      headers: { authorization: "Bearer right-token" },
    });
    expect(unknownHost.status).toBe(403);
    runWs.unregisterRunWsHost("rh-zz-auth");
  });
});
