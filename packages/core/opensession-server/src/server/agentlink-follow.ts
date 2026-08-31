/**
 * Broadcast half of the post-send follow.
 *
 * Kept out of `agents/agentlink` so the bridge stays a pure reader of the
 * mesh: this is the one place that knows about websocket rooms.
 */

import { followPeerAfterSend } from "../agents/agentlink/session-bridge";
import { broadcastToSession, sessionWatchers } from "./ws-hub";
import { entriesForWire } from "./jsonl-parser";

/** Push a peer's new turns to its watchers for a while after a send. */
export function followPeerSend(rowId: string): void {
  followPeerAfterSend(
    rowId,
    (entries) => {
      broadcastToSession(rowId, {
        type: "transcript_append",
        sessionId: rowId,
        entries: entriesForWire(entries),
      });
    },
    () => (sessionWatchers.get(rowId)?.size ?? 0) > 0,
  );
}
