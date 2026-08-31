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
import { userInfo, homedir } from "node:os";
import { join } from "node:path";
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

/** Where a session running our pi extension listens for its own user. Derived
 *  from the session id on both sides, so there is no registration to go stale. */
const INBOX_DIR = join(homedir(), ".opensession", "peer-inbox");
const inboxPath = (sessionId: string) => join(INBOX_DIR, `${sessionId}.sock`);

/**
 * Names the clients send as a stand-in rather than as an identity. iOS
 * documents "ios" as exactly that — "a stand-in, not a name, so surfaces that
 * present the name can fall back" — and this is such a surface: the value is
 * about to be shown to another agent as who is asking.
 */
const PLACEHOLDER_SENDERS = new Set(["ios", "mac", "web", "anonymous", ""]);

/** Who to tell the peer this came from. Falls back to the account running the
 *  server, which on a self-hosted install is the person holding the phone. */
function senderName(user: string): string {
  const name = user.trim();
  if (!PLACEHOLDER_SENDERS.has(name.toLowerCase())) return name;
  try {
    return userInfo().username || "Open Session";
  } catch {
    return "Open Session";
  }
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

export type PromptResult =
  | { ok: true; direct: boolean }
  | { ok: false; error: string };

/** Bounded polls after a send. A peer answering a real question can take a
 *  while, so the budget is generous; the idle check below usually ends it
 *  sooner. */
const FOLLOW_INTERVAL_MS = 1_200;
const FOLLOW_BUDGET_MS = 120_000;
/** Row ids with a poll already running, so repeated sends extend the existing
 *  follow instead of stacking timers on one row. */
const following = new Map<string, number>();

/**
 * Push a peer's new turns to whoever is watching, for a while after a send.
 *
 * pi writes a turn to its session file when it processes it, so the message
 * just delivered is not there yet and neither is the reply. Nothing pushes
 * either — this server does not own the peer and gets no event from it — so
 * without this a send looks like it vanished until the client re-opened the
 * row.
 *
 * This is a stopgap for the missing event stream, not a substitute for one:
 * it costs a file read per tick and resolves at interval granularity.
 */
export function followPeerAfterSend(
  rowId: string,
  emit: (entries: ClientTranscriptEntry[]) => void,
  hasWatchers: () => boolean,
): void {
  const deadline = Date.now() + FOLLOW_BUDGET_MS;
  // Already following: just extend the deadline.
  if (following.has(rowId)) {
    following.set(rowId, deadline);
    return;
  }
  following.set(rowId, deadline);

  const peerId = peerIdFromSessionId(rowId);
  if (!peerId) {
    following.delete(rowId);
    return;
  }

  let lastId: string | undefined;
  let sawChange = false;

  const stop = () => {
    following.delete(rowId);
    clearInterval(timer);
  };

  const tick = async () => {
    // Nobody is looking, or the budget ran out.
    if (!hasWatchers() || Date.now() > (following.get(rowId) ?? 0)) return stop();
    let entries: ClientTranscriptEntry[] | null = null;
    try {
      entries = await readPeerClientTranscript(peerId);
    } catch {
      return; // A transient read loses one tick, not the follow.
    }
    if (!entries?.length) return;

    if (lastId === undefined) {
      // First tick establishes the baseline: everything already on screen.
      lastId = entries[entries.length - 1]!.id;
      return;
    }
    const index = entries.findIndex((e) => e.id === lastId);
    // Baseline fell out of the tail — the next full open will reconcile it.
    const fresh = index === -1 ? [] : entries.slice(index + 1);
    if (fresh.length) {
      lastId = entries[entries.length - 1]!.id;
      sawChange = true;
      emit(fresh);
    }

    // The answer landed and the peer went quiet: stop rather than burn the
    // remaining budget re-reading an unchanging file.
    if (sawChange) {
      const peer = await findPeer(peerId);
      if (!peer || peer.status === "idle") return stop();
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, FOLLOW_INTERVAL_MS);
  // Never hold the process open for a poll.
  (timer as unknown as { unref?: () => void }).unref?.();
}

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

  // Preferred path: the session's own inbox, where the message is delivered as
  // the user speaking. agent-link cannot do this — it frames every inbound
  // message as coming from another agent and explicitly not from your user,
  // which is right between agents and wrong for the person holding the phone.
  try {
    await sendFrame(inboxPath(peerId), { content });
    // Direct: the extension in that session will push the turn back, so the
    // caller must not also poll for it — two sources, two ids, one message
    // drawn twice.
    return { ok: true, direct: true };
  } catch {
    // No inbox: an older session, or one started before the extension was
    // installed. Fall through to the mesh.
  }

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
      message: {
        role: "user",
        content: buildEnvelope(content, senderName(fromName)),
      },
    });
    return { ok: true, direct: false };
  } catch (error) {
    return { ok: false, error: (error as Error)?.message || "Send failed." };
  }
}
