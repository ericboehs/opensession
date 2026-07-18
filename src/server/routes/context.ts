/**
 * Shared request context for the HTTP route handlers under src/server/routes/.
 * Built once per request in opensession.ts's fetch and passed down the
 * ordered handler chain.
 */

export interface RouteContext {
	req: Request;
	url: URL;
	/** Pathname normalized onto the historical /backstage prefix (the
	 *  /opensession alias is folded in before dispatch — rename-compat). */
	path: string;
	/** The prefix THIS request used ("/opensession" | "/backstage") —
	 *  responses that embed it (manifest, sw.js scope, redirects) answer in
	 *  kind so each install/bookmark stays self-consistent. */
	publicPrefix: string;
	/** Verified sign-in identity (web-auth.ts) when GitHub web sign-in is
	 *  active; null when signed out or when the feature is off. When set,
	 *  handlers should prefer it over any client-supplied `user` field. */
	authUser?: { login: string; name: string } | null;
}

export type RouteHandler = (
	ctx: RouteContext,
) => Promise<Response | undefined>;
