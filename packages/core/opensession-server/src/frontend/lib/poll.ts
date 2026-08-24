/**
 * setInterval that skips ticks while the tab is hidden and fires immediately
 * when it becomes visible again. Background PWA windows and unfocused tabs
 * stop hitting polled endpoints (the per-session /pr pollers were burning the
 * shared GitHub GraphQL budget from tabs nobody was looking at, 2026-07-23).
 * Returns a cleanup function.
 */
export function pollWhileVisible(fn: () => void, ms: number): () => void {
	const tick = () => {
		if (!document.hidden) fn();
	};
	const iv = setInterval(tick, ms);
	document.addEventListener("visibilitychange", tick);
	return () => {
		clearInterval(iv);
		document.removeEventListener("visibilitychange", tick);
	};
}

/** GitHub webhooks are the primary PR refresh path; this only recovers missed events. */
export const PR_WEBHOOK_FALLBACK_POLL_MS = 5 * 60_000;
