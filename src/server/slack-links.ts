/**
 * slack-links — the thread ↔ session index for Slack threads anchored by
 * messages backstage sessions posted (typically automation runs), so a human
 * reply in one of those threads drives the posting session instead of
 * spawning a new one. Lives here rather than in the Slack agent so backstage
 * modules can populate it without importing the agent (same reasoning as
 * session-control.ts).
 *
 * The session file (`BackstageSessionFile.slackThreads`) is the source of
 * truth; this in-memory index is a fast reverse-lookup rebuilt on startup and
 * kept in sync as threads are linked. It's parked on globalThis so a
 * `bun --hot` reload keeps it.
 */

const g = globalThis as unknown as {
	__slackLinkThreadToSess?: Map<string, string>;
	__slackLinkSessToThreads?: Map<string, Set<string>>;
};
// `${channel}:${threadTs}` → session id.
const threadToSess: Map<string, string> = (g.__slackLinkThreadToSess ??= new Map());
const sessToThreads: Map<string, Set<string>> = (g.__slackLinkSessToThreads ??= new Map());

const threadKey = (channel: string, threadTs: string) => `${channel}:${threadTs}`;

/** The backstage session that posted the message anchoring this thread, if any. */
export function sessionForThread(
	channel: string,
	threadTs: string,
): string | undefined {
	return threadToSess.get(threadKey(channel, threadTs));
}

/** Link a thread to a session (a session can own several threads; a thread has one session). */
export function linkThreadInIndex(
	sessionId: string,
	channel: string,
	threadTs: string,
): void {
	const key = threadKey(channel, threadTs);
	const prevSess = threadToSess.get(key);
	if (prevSess && prevSess !== sessionId) sessToThreads.get(prevSess)?.delete(key);
	threadToSess.set(key, sessionId);
	let keys = sessToThreads.get(sessionId);
	if (!keys) sessToThreads.set(sessionId, (keys = new Set()));
	keys.add(key);
}

/** Remove all of a session's thread links (session deleted). */
export function unlinkThreadsInIndex(sessionId: string): void {
	for (const key of sessToThreads.get(sessionId) || []) threadToSess.delete(key);
	sessToThreads.delete(sessionId);
}

/** Rebuild the whole index from the session store (called at startup). */
export function rebuildIndex(
	sessions: Array<{
		id: string;
		slackThreads?: Array<{ channel: string; threadTs: string }>;
	}>,
): void {
	threadToSess.clear();
	sessToThreads.clear();
	for (const s of sessions) {
		for (const t of s.slackThreads || []) {
			if (t?.channel && t?.threadTs) linkThreadInIndex(s.id, t.channel, t.threadTs);
		}
	}
}
