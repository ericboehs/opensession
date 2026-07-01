/**
 * slack-links — the channel ↔ session index for Slack channels linked to
 * backstage sessions, plus a tiny event bridge so the Slack agent (which runs in
 * the same process but a different module) can push inbound channel messages to
 * backstage's WebSocket fan-out without importing backstage.ts (that would re-run
 * the server bootstrap / create a circular import — same reasoning as
 * session-control.ts).
 *
 * The session file (`BackstageSessionFile.slackChannel`) is the source of truth;
 * this in-memory index is a fast reverse-lookup rebuilt on startup and kept in
 * sync on link/unlink. It's parked on globalThis so a `bun --hot` reload keeps it.
 */

/** A message in a linked channel, shaped for the backstage chat panel. */
export interface LinkedChannelMessage {
	ts: string;
	userId: string | null;
	userName: string;
	avatarUrl?: string;
	text: string;
	isBot: boolean;
}

const g = globalThis as unknown as {
	__slackLinkChanToSess?: Map<string, string>;
	__slackLinkSessToChan?: Map<string, string>;
	__linkedChannelSink?: (channelId: string, msg: LinkedChannelMessage) => void;
};
const chanToSess: Map<string, string> = (g.__slackLinkChanToSess ??= new Map());
const sessToChan: Map<string, string> = (g.__slackLinkSessToChan ??= new Map());

/** The backstage session id a channel is linked to, if any. */
export function sessionForChannel(channelId: string): string | undefined {
	return chanToSess.get(channelId);
}

/** The channel a session is linked to, if any. */
export function channelForSession(sessionId: string): string | undefined {
	return sessToChan.get(sessionId);
}

/** Add/replace a link in the index (one channel ↔ one session). */
export function linkInIndex(sessionId: string, channelId: string): void {
	// Drop any stale mappings for either side first (keeps it strictly 1:1).
	const prevChan = sessToChan.get(sessionId);
	if (prevChan) chanToSess.delete(prevChan);
	const prevSess = chanToSess.get(channelId);
	if (prevSess) sessToChan.delete(prevSess);
	chanToSess.set(channelId, sessionId);
	sessToChan.set(sessionId, channelId);
}

/** Remove a session's link from the index. */
export function unlinkInIndex(sessionId: string): void {
	const chan = sessToChan.get(sessionId);
	if (chan) chanToSess.delete(chan);
	sessToChan.delete(sessionId);
}

/** Rebuild the whole index from the session store (called at startup). */
export function rebuildIndex(
	sessions: Array<{ id: string; slackChannel?: { channelId: string } }>,
): void {
	chanToSess.clear();
	sessToChan.clear();
	for (const s of sessions) {
		if (s.slackChannel?.channelId) linkInIndex(s.id, s.slackChannel.channelId);
	}
}

// ── Event bridge (Slack agent → backstage WS) ──────────────────────────────
/** backstage.ts registers a sink at startup that broadcasts to WS clients. */
export function registerLinkedChannelSink(
	sink: (channelId: string, msg: LinkedChannelMessage) => void,
): void {
	g.__linkedChannelSink = sink;
}

/** Called by the Slack event handler when a message lands in a linked channel. */
export function emitLinkedChannelMessage(
	channelId: string,
	msg: LinkedChannelMessage,
): void {
	g.__linkedChannelSink?.(channelId, msg);
}
