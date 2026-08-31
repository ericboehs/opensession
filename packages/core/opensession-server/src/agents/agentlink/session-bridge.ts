/**
 * Watching and prompting a mesh peer from an Open Session client.
 *
 * A peer is not an Open Session session: nothing here owns its process, its
 * transcript file or its lifecycle. What the clients need is narrow — the
 * conversation so far, and a way to put a message in front of it — so this
 * module provides exactly those two and nothing that would imply more.
 *
 * The return path needs no plumbing. A peer's reply is written to its own pi
 * session file, which is the same file `readPeerClientTranscript` reads, so
 * re-reading after a send is what makes this a conversation rather than a
 * one-way drop.
 */

import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { AGENT_LINK_SOURCE } from "./index";
import { listMeshPeers, type MeshPeer } from "./mesh-registry";
import {
  readPeerClientTranscript,
  type ClientTranscriptEntry,
} from "./transcript";

/** Wire constants of the mesh protocol. These are the peer's format, not
 *  ours: they must match `pi-agent-link` exactly or a frame is ignored. */
const ENVELOPE_TAG = "cross-session-message";
const FRAME_VERSION = 1;
/** "next" queues the message for the peer's next turn rather than trying to
 *  interrupt one in flight. */
const DEFAULT_PRIORITY = "next";
const SEND_TIMEOUT_MS = 5_000;

/** Whether a client's session id addresses a mesh peer rather than a session
 *  this server owns. */
export function isAgentLinkSessionId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(`${AGENT_LINK_SOURCE}:`);
}

/** The peer session id inside a row id. Null for a pid-addressed peer, which
 *  has neither a transcript nor a stable identity to send to. */
export function peerIdFromSessionId(rowId: string): string | null {
  const id = rowId.slice(`${AGENT_LINK_SOURCE}:`.length);
  return id && !/^\d+$/.test(id) ? id : null;
}

async function findPeer(peerId: string): Promise<MeshPeer | null> {
  const peers = await listMeshPeers();
  return peers.find((p) => p.sessionId === peerId) ?? null;
}

/** The conversation so far, or null when there is no readable session file. */
export async function externalTranscript(
  rowId: string,
): Promise<ClientTranscriptEntry[] | null> {
  const peerId = peerIdFromSessionId(rowId);
  if (!peerId) return null;
  return await readPeerClientTranscript(peerId);
}

/**
 * The message as a peer would send it.
 *
 * The envelope is what marks this cross-agent. The receiving agent reads it as
 * a peer request to weigh against its own permissions, NOT as its user
 * speaking — which is the honest framing, since the person typing is on
 * another machine's account and never approved anything in that session.
 */
function buildEnvelope(body: string, fromName: string): string {
  const escaped = body.replace(
    new RegExp(`</(?=${ENVELOPE_TAG}(?:[>\\s/]|$))`, "gi"),
    "<\\/",
  );
  const name = fromName.replace(/["<>]/g, "");
  return `<${ENVELOPE_TAG} from-name="${name}">\n${escaped}\n</${ENVELOPE_TAG}>`;
}

/** Connect, write one newline-terminated JSON frame, close. */
function sendFrame(sock: string, frame: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: sock });
    socket.setTimeout(SEND_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error("timed out connecting to the peer"));
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.end(JSON.stringify(frame) + "\n", () => resolve());
    });
  });
}

export type PromptResult = { ok: true } | { ok: false; error: string };

/**
 * Put a message in front of a peer.
 *
 * Delivery means the peer's socket accepted the frame, not that the agent
 * answered: it may be mid-turn, and "next" priority waits for that turn to
 * finish. Saying otherwise would make a queued message look answered.
 */
export async function promptExternalSession(
  rowId: string,
  content: string,
  fromName: string,
): Promise<PromptResult> {
  const peerId = peerIdFromSessionId(rowId);
  if (!peerId) return { ok: false, error: "That peer cannot be addressed." };
  const peer = await findPeer(peerId);
  // A peer that has exited leaves its registry entry behind for a moment.
  if (!peer?.sock)
    return { ok: false, error: "That session is no longer running." };
  try {
    await sendFrame(peer.sock, {
      msgV: FRAME_VERSION,
      msg_id: randomUUID(),
      type: "user",
      priority: DEFAULT_PRIORITY,
      message: { role: "user", content: buildEnvelope(content, fromName) },
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message || "Send failed." };
  }
}
