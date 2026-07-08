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

export const PRODUCT_NAME = "Backstage";

/** Short brand monogram for visual brand-mark contexts; same as the full
 *  name until the rename ("OS" post-OpenSession). */
export const PRODUCT_MARK = PRODUCT_NAME;

/** The agent's display name (server: personaName(), config persona.name). */
export const AGENT_NAME = "Michael";

/** Default document.title when no view-specific title applies. */
export const DEFAULT_DOC_TITLE = `${PRODUCT_NAME} — Tella`;

/** "<view> — Backstage" document titles. */
export const docTitle = (view: string) => `${view} — ${PRODUCT_NAME}`;
