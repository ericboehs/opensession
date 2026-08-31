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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SERVER =
  process.env.OPENSESSION_URL?.replace(/\/$/, "") || "http://127.0.0.1:3850";
/** A push is a nicety; it must never hold up the agent. */
const TIMEOUT_MS = 1_500;

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined;
  // One failure is a hiccup; a run of them means no server, so stop trying.
  let consecutiveFailures = 0;
  const GIVE_UP_AFTER = 3;

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

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager?.getSessionId?.();
    consecutiveFailures = 0;
  });

  pi.on("message_end", async (event) => {
    const message = (event as { message?: unknown })?.message;
    if (!message) return;
    await post({ message });
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
