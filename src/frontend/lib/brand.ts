/**
 * Product + agent branding for the frontend — the single place the UI gets
 * its names from, so the Backstage → OpenSession rename is a one-line flip
 * here (see docs/rename-opensession-plan.md).
 *
 * Server-side equivalents live in src/server/config.ts (productName(),
 * productMark(), personaName(), backed by ~/.backstage/config.json). The
 * frontend has no bootstrap/config API yet, so these are build-time
 * constants; when a config endpoint exists, hydrate them from it and keep
 * these values as the fallbacks.
 *
 * Naming rules:
 * - PRODUCT_NAME is the full wordmark, used in prose, titles, and headers.
 * - PRODUCT_MARK is the short visual monogram for brand-mark contexts only
 *   (logo chip, favicon, loading screen) — e.g. "OS" for OpenSession. Never
 *   use the short mark in code identifiers, package names, or CLI/env names.
 * - These are display strings only. Protocol identifiers (localStorage
 *   `backstage-user`, `/backstage/` routes, `bks-` prefixes) stay literal.
 */

type InstanceBrand = {
	productName?: string;
	productMark?: string;
	personaName?: string;
	publicBaseUrl?: string;
	githubBotLogins?: string[];
	defaultRepoId?: string;
	plainWorkspaceId?: string;
};

const INSTANCE: InstanceBrand =
	typeof window === "undefined"
		? {}
		: ((window as typeof window & {
				__OPENSESSION_INSTANCE__?: InstanceBrand;
			}).__OPENSESSION_INSTANCE__ || {});

export const PRODUCT_NAME = INSTANCE.productName || "OpenSession";

/** Short brand monogram for visual brand-mark contexts (logo chip, favicon,
 *  loading screen) — never in code identifiers, package names, or CLI/env. */
export const PRODUCT_MARK = INSTANCE.productMark || "OS";

/** The agent's display name (server: personaName(), config persona.name). */
export const AGENT_NAME = INSTANCE.personaName || "Assistant";
export const PUBLIC_BASE_URL =
	INSTANCE.publicBaseUrl ||
	(typeof location === "undefined" ? "http://127.0.0.1:3850" : location.origin);
export const GITHUB_BOT_LOGINS = new Set(
	(INSTANCE.githubBotLogins || []).map((login) => login.toLowerCase()),
);
/** Primary GitHub bot login (first policy.githubBotLogins entry) for display
 *  fallbacks; empty string when the instance has no bot. */
export const GITHUB_BOT_NAME = (INSTANCE.githubBotLogins || [])[0] || "";
export const DEFAULT_REPO_ID = INSTANCE.defaultRepoId || "opensession";

/** Plain workspace id for deep links into app.plain.com (server:
 *  `integrations.plain.workspaceId`). Null when the instance has none —
 *  consumers hide their "open in Plain" affordances. */
export const PLAIN_WORKSPACE_ID = INSTANCE.plainWorkspaceId || null;

/** Default document.title when no view-specific title applies. */
export const DEFAULT_DOC_TITLE = PRODUCT_NAME;

/** "<view> — Backstage" document titles. */
export const docTitle = (view: string) => `${view} — ${PRODUCT_NAME}`;
