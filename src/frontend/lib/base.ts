/**
 * App base path (Backstage → OpenSession rename, docs/rename-opensession-plan.md).
 *
 * The server dual-serves the whole app under `/opensession` (primary) and the
 * legacy `/backstage` alias — same handlers, no redirects, so old bookmarks,
 * PWA installs and in-flight clients never break. The bundle is shared by both
 * prefixes, so everything URL-shaped derives from BASE_PATH: the prefix THIS
 * page was served under. That keeps API/WS calls, router matches, pushState
 * navigation and the service-worker scope self-consistent per install.
 *
 * Share/deep links that leave the app (clipboard, Slack) should use
 * PRIMARY_BASE_PATH — new links carry the new name; the alias keeps every old
 * link working.
 */

export const PRIMARY_BASE_PATH = "/opensession";
export const LEGACY_BASE_PATH = "/backstage";
/** Bare-domain serving (os.tella.dev): the app lives at the root, no prefix. */
export const ROOT_BASE_PATH = "";

function detectBasePath(): string {
	if (typeof location !== "undefined") {
		const p = location.pathname;
		if (p === LEGACY_BASE_PATH || p.startsWith(`${LEGACY_BASE_PATH}/`)) {
			return LEGACY_BASE_PATH;
		}
		if (p === PRIMARY_BASE_PATH || p.startsWith(`${PRIMARY_BASE_PATH}/`)) {
			return PRIMARY_BASE_PATH;
		}
		// Neither prefix → served at the domain root (os.tella.dev). Every
		// consumer builds URLs as `${BASE_PATH}/...`, so "" yields root-relative
		// paths; the server normalizes unprefixed paths onto its internal
		// /backstage literals (opensession.ts fetch preamble).
		return ROOT_BASE_PATH;
	}
	return PRIMARY_BASE_PATH;
}

/** The prefix this page is served under ("/opensession", "/backstage", or "" at the domain root). */
export const BASE_PATH = detectBasePath();

/** Strip either prefix off a pathname → the app-internal route ("/" rooted). */
export function stripBasePath(pathname: string): string {
	for (const prefix of [PRIMARY_BASE_PATH, LEGACY_BASE_PATH]) {
		if (pathname === prefix) return "/";
		if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
	}
	return pathname;
}
