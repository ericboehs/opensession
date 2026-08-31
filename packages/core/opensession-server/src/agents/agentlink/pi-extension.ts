/**
 * pi extension: push this session's turns to Open Session as they finalize.
 *
 * Loaded inside pi, not by this server:
 *
 *   pi -e path/to/pi-extension.ts
 *
 * Why it exists. pi offers no way to attach to a session already running in a
 * terminal — RPC is a launch mode that owns stdin/stdout — so the server reads
 * a peer by polling its transcript file after a send. That works, but it costs
 * a read per tick, resolves at interval granularity, and only runs after a
 * send: a turn you started by typing in the terminal never reaches the phone.
 *
 * An extension does have the event stream, so this closes the gap from the
 * only side that can. It pushes two things: each finalized message, and the
 * running/idle transitions the sidebar would otherwise learn from a cache.
 *
 * It is strictly an optimization: with it, turns arrive as
 * they finalize; without it, the poll still catches them.
 *
 * Rules it follows, because it is running inside someone's working session:
 *   - never throws into the session
 *   - never blocks a turn (fire and forget, short timeout)
 *   - stays silent on failure, including when the server is simply not running
 *
 * It also carries the inbound half. agent-link cannot serve this: it frames
 * every inbound message as "from another agent session on this machine, not
 * your user", which is right between agents and wrong for the person holding
 * the phone — it strips their authority from their own instruction. Messages
 * arriving here are delivered as what they are: the user speaking.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type Server } from "node:net";
import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const SERVER =
  process.env.OPENSESSION_URL?.replace(/\/$/, "") || "http://127.0.0.1:3850";
/** A push is a nicety; it must never hold up the agent. */
const TIMEOUT_MS = 1_500;
/** Floor between streaming updates. Measured against a real turn: pi feeds
 *  faster than this, so the cadence is set here, not by the model. At 50ms a
 *  turn arrives about 23 characters at a time, which reads as continuous;
 *  120ms was visibly chunky and 400ms landed in lumps. */
const STREAM_INTERVAL_MS = 50;
/** Where this session listens for its own user's messages. The server derives
 *  the same path from the session id, so no registration handshake is needed. */
const INBOX_DIR = join(homedir(), ".opensession", "peer-inbox");
const inboxPath = (sessionId: string) => join(INBOX_DIR, `${sessionId}.sock`);

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined;
  let inbox: Server | undefined;
  let inboxFile: string | undefined;
  let isIdle: (() => boolean) | undefined;
  // One failure is a hiccup; a run of them means no server, so stop trying.
  let consecutiveFailures = 0;
  const GIVE_UP_AFTER = 3;

  // Streaming state. The id is minted when a message starts and reused by
  // every update and the final version, so the clients grow one bubble
  // instead of appending a new one per token.
  let messageId: string | undefined;
  let pending: unknown;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let lastStreamAt = 0;
  let lastLength = -1;

  async function post(payload: Record<string, unknown>): Promise<void> {
    if (!sessionId || consecutiveFailures >= GIVE_UP_AFTER) return;
    try {
      const res = await fetch(`${SERVER}/api/agentlink/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      consecutiveFailures = res.ok ? 0 : consecutiveFailures + 1;
    } catch {
      consecutiveFailures += 1;
    }
  }

  /** Listen for messages this session's own user sends from a client. */
  async function openInbox(id: string): Promise<void> {
    try {
      await mkdir(INBOX_DIR, { recursive: true, mode: 0o700 });
      const file = inboxPath(id);
      // A crashed session leaves its socket file behind; the bind below fails
      // until it is gone.
      await unlink(file).catch(() => {});
      const server = createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          // LF only, matching pi's own framing rules.
          let index: number;
          while ((index = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            void deliver(line);
          }
        });
        socket.on("error", () => {});
      });
      server.on("error", () => {});
      server.listen(file);
      inbox = server;
      inboxFile = file;
    } catch {
      // No inbox means the server falls back to the mesh path. Degraded, not
      // broken, and never worth interrupting the session over.
    }
  }

  async function deliver(line: string): Promise<void> {
    let content = "";
    try {
      const parsed = JSON.parse(line) as { content?: unknown };
      content = typeof parsed.content === "string" ? parsed.content : "";
    } catch {
      return;
    }
    if (!content.trim()) return;
    try {
      // No framing, no attribution banner: this is the user, so it is
      // delivered exactly as if they had typed it here. Steer when the agent
      // is mid-turn so the message lands in the run it was meant for.
      const idle = isIdle?.() ?? true;
      await pi.sendUserMessage(
        content,
        idle ? undefined : { deliverAs: "steer" },
      );
    } catch {
      // A failed injection is the client's problem to retry, not grounds for
      // disturbing the session.
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager?.getSessionId?.();
    isIdle = ctx.isIdle?.bind(ctx);
    consecutiveFailures = 0;
    if (sessionId && !inbox) await openInbox(sessionId);
  });

  pi.on("session_shutdown", async () => {
    inbox?.close();
    inbox = undefined;
    if (inboxFile) await unlink(inboxFile).catch(() => {});
    inboxFile = undefined;
  });

  /** Rough size of a message's rendered text, to skip updates that changed
   *  nothing a reader would see. */
  function contentLength(message: unknown): number {
    const content = (message as { content?: unknown })?.content;
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    let total = 0;
    for (const part of content as { text?: string; thinking?: string }[]) {
      total += (part?.text?.length ?? 0) + (part?.thinking?.length ?? 0);
    }
    return total;
  }

  function sendStream(message: unknown): void {
    lastStreamAt = Date.now();
    lastLength = contentLength(message);
    if (messageId) void post({ message, id: messageId });
  }

  pi.on("message_start", async () => {
    messageId = randomUUID();
    lastStreamAt = 0;
    lastLength = -1;
  });

  pi.on("message_update", async (event) => {
    const message = (event as { message?: unknown })?.message;
    if (!message || !messageId) return;
    // Nothing a reader would notice changed.
    if (contentLength(message) === lastLength) return;

    const since = Date.now() - lastStreamAt;
    // Leading edge: the first token of a turn, and anything after a quiet
    // stretch, goes out immediately instead of waiting out the interval.
    if (since >= STREAM_INTERVAL_MS && !streamTimer) {
      sendStream(message);
      return;
    }
    // Otherwise ride the trailing timer, keeping only the newest version.
    pending = message;
    if (streamTimer) return;
    streamTimer = setTimeout(
      () => {
        streamTimer = undefined;
        const next = pending;
        pending = undefined;
        if (next) sendStream(next);
      },
      Math.max(0, STREAM_INTERVAL_MS - since),
    );
    // Never hold the process open for a partial render.
    streamTimer.unref?.();
  });

  pi.on("message_end", async (event) => {
    const message = (event as { message?: unknown })?.message;
    // The final version supersedes anything still queued.
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = undefined;
    }
    pending = undefined;
    const id = messageId;
    messageId = undefined;
    if (!message) return;
    await post({ message, ...(id ? { id } : {}) });
    // No return value: message_end can replace the finalized message, and
    // this extension must never alter what the session recorded.
  });

  // Status. `agent_settled`, not `agent_end`: pi may auto-retry or drain a
  // queue after a run ends, and reporting idle there would show a session as
  // finished while it is still working.
  pi.on("agent_start", async () => {
    await post({ status: "running" });
  });

  pi.on("agent_settled", async () => {
    await post({ status: "idle" });
  });
}
