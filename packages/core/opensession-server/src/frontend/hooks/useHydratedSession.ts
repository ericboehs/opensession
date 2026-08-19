import { useEffect, useMemo, useState } from "react";
import { fetchSession } from "../lib/api";
import { mergeSessionDetail } from "../lib/session-detail";
import type { UnifiedSession } from "../lib/types";

/**
 * The whole session behind the open route.
 *
 * The list is a SUMMARY now: it carries what rows render and drops the engine
 * ids, the transcript path and the model-switch history, which together were
 * ~14% of its bytes and which nothing but the open conversation reads. The
 * archived index goes further and carries summaries outright (`slim`). So the
 * open session always fetches its own detail, and three ordinary things stop
 * being possible: opening a session that isn't in the live list at all,
 * opening one from Archived, and having the session you are reading archived
 * out from under you by someone else.
 *
 * The list row stays the base when there is one — it is the copy the poll
 * keeps fresh, where a hydrated copy is a snapshot from whenever it was
 * fetched — and the detail response only fills in what the row omits. The
 * fetch repeats whenever the row's `lastActivity` moves, so a `/model` switch
 * or a first run lands in the open conversation as fast as it used to.
 *
 * Resolves aliases the same way the list lookup does, so an old link keeps
 * working. A failure leaves the last good copy in place rather than retrying:
 * the caller already renders "not found" for a route it can't resolve, and a
 * list row without its detail still renders the conversation.
 */
export function useHydratedSession(
	sessionId: string | null,
	fromList: UnifiedSession | null,
): UnifiedSession | null {
	const [hydrated, setHydrated] = useState<UnifiedSession | null>(null);
	const have =
		hydrated &&
		sessionId &&
		(hydrated.id === sessionId || hydrated.aliasIds?.includes(sessionId))
			? hydrated
			: null;
	// Refetch on new activity: the detail-only fields change when the session
	// runs, and `lastActivity` is the list's marker that it has.
	const at = fromList?.lastActivity ?? null;

	useEffect(() => {
		if (!sessionId) return;
		const controller = new AbortController();
		void fetchSession(sessionId, { signal: controller.signal })
			.then((session) => {
				if (session) setHydrated(session);
			})
			.catch(() => {
				// Offline or a server hiccup. The list poll is still running and
				// may yet produce the session; nothing here should throw the
				// route away over one failed request.
			});
		return () => controller.abort();
	}, [sessionId, at]);

	// Memoized for its IDENTITY, not its cost: the merge would otherwise mint a
	// fresh session object on every render of the app, and the viewer hangs
	// effects off the session it is handed.
	return useMemo(() => {
		if (!sessionId) return null;
		if (!fromList) return have;
		return mergeSessionDetail(fromList, have);
	}, [sessionId, fromList, have]);
}
