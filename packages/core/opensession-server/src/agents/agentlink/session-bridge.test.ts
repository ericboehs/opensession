import { describe, expect, test, afterAll } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isAgentLinkSessionId,
  peerIdFromSessionId,
  inboxPath,
  buildEnvelope,
  senderName,
  promptExternalSession,
} from "./session-bridge";

const tmp = await mkdtemp(join(tmpdir(), "os-bridge-test-"));
const sockets = new Map<string, Server>();
let captured: string | null = null;

/** A real socket at the real derived path, so routing is exercised as the
 *  server exercises it rather than against a mock. */
async function inboxFor(peerId: string): Promise<void> {
  const file = inboxPath(peerId);
  await rm(file, { force: true });
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      captured = (captured ?? "") + chunk;
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(file, resolve));
  sockets.set(peerId, server);
}

afterAll(async () => {
  for (const server of sockets.values()) server.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("agent-link ids", () => {
  test("recognizes the namespace", () => {
    expect(isAgentLinkSessionId("agent-link:abc")).toBe(true);
    expect(isAgentLinkSessionId("os-abc")).toBe(false);
    expect(isAgentLinkSessionId(undefined)).toBe(false);
    expect(isAgentLinkSessionId(42)).toBe(false);
  });

  test("extracts the peer id, refusing a pid-addressed row", () => {
    expect(peerIdFromSessionId("agent-link:01a0")).toBe("01a0");
    expect(peerIdFromSessionId("agent-link:12345")).toBeNull();
    expect(peerIdFromSessionId("agent-link:")).toBeNull();
  });
});

describe("senderName", () => {
  test("resolves a placeholder to the account running the server", () => {
    const resolved = senderName("ios");
    expect(resolved).not.toBe("ios");
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("keeps a real name untouched", () => {
    expect(senderName("Eric")).toBe("Eric");
  });

  test("does not strip — that is buildEnvelope's job", () => {
    // The direct path never uses the name, so stripping here would be dead
    // code; the mesh path strips where the name is rendered.
    expect(senderName('Er"ic')).toBe('Er"ic');
    expect(buildEnvelope("x", 'Er"ic')).toContain('from-name="Eric"');
  });
});

describe("buildEnvelope", () => {
  test("wraps the body with sender attribution", () => {
    const env = buildEnvelope("hello", "Eric");
    expect(env).toContain('from-name="Eric"');
    expect(env).toContain("hello");
    expect(env.startsWith("<cross-session-message")).toBe(true);
    expect(env.endsWith("</cross-session-message>")).toBe(true);
  });

  test("escapes a closing tag inside the body", () => {
    // A peer transcript can hold anything — including text that looks like
    // the envelope itself, which would end the body early and let the rest
    // of the message ride outside the attribution.
    const env = buildEnvelope("say </cross-session-message> now", "Eric");
    expect(env).toContain("<\\/cross-session-message>");
  });
});

describe("promptExternalSession routing", () => {
  test("prefers the direct inbox and sends the plain message", async () => {
    const peerId = randomUUID();
    await inboxFor(peerId);
    captured = null;

    const result = await promptExternalSession(
      `agent-link:${peerId}`,
      "direct test",
      "ios",
    );
    expect(result).toEqual({ ok: true, direct: true });
    // The write resolves before the receiving socket's data event fires, so
    // give the loop a moment rather than racing it.
    for (let i = 0; captured === null && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Re-widened: TS carries the earlier `= null` through a loop whose body
    // never assigns, but the socket callback does assign at runtime.
    const received: string | null = captured;
    // No envelope, no attribution: the extension injects this as the user.
    expect(received).toBe(JSON.stringify({ content: "direct test" }) + "\n");
  });

  test("falls back to the mesh and answers with an error when the peer is gone", async () => {
    // A random id has no inbox and is in no registry, which is the normal
    // case for a peer that has exited.
    const result = await promptExternalSession(
      `agent-link:${randomUUID()}`,
      "anyone there?",
      "Eric",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  test("refuses a pid-addressed row outright", async () => {
    const result = await promptExternalSession("agent-link:4242", "x", "Eric");
    expect(result).toEqual({
      ok: false,
      error: "That peer cannot be addressed.",
    });
  });

  test("the inbox path is the real derived path", async () => {
    // Pinning the derivation: both the extension and this server compute it
    // from the session id, and a change on either side alone is a silent
    // fallback to the mesh — which is why this test exists.
    expect(inboxPath("01a0")).toBe(
      join(inboxPath("01a0"), "..", "01a0.sock"),
    );
  });
});
