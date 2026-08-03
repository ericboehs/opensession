/**
 * Who am I, and which sessions are mine?
 *
 * The server's session list is everyone's — on a busy install that's thousands
 * of rows, most of them automation runs (GitHub reviews, triage, nightly
 * sweeps). The web sidebar bands those away; a terminal sidebar has no room for
 * bands, so `os` filters instead, and defaults to the only band you asked for:
 * yours.
 *
 * Matching is by *name token*, deliberately not by substring. `startedBy` is a
 * display name the web UI wrote ("Alice"), while the token we hold may be a
 * full name ("Alice Smith"), a GitHub login ("asmith") or the unix
 * user. Exact token equality is what keeps "John" from matching "Johnny".
 */

import type { Session } from "./types";

export type Identity = {
	/** Display name used for prompts — config.user, or $USER. */
	user?: string;
	/** GitHub login the token was minted for. */
	login?: string;
	/** Name the server knows this login by (`/api/auth/status`). */
	name?: string;
};

/** Scope of the sidebar list. */
export type SessionScope = "mine" | "team" | "all";

export const SCOPES: SessionScope[] = ["mine", "team", "all"];

export const SCOPE_LABEL: Record<SessionScope, string> = {
	mine: "mine",
	team: "team",
	all: "all",
};

/** Placeholders that would otherwise match half the fleet. */
const JUNK = new Set(["tui", "anonymous", "unknown", "root", "ubuntu", "user"]);

function tokensOf(value: string | undefined): string[] {
	const trimmed = (value ?? "").trim().toLowerCase();
	if (!trimmed) return [];
	const first = trimmed.split(/\s+/)[0] ?? "";
	// Full string and first name only — surnames are too collision-prone to
	// stand alone as an identity ("Lin" would claim half the team's rows).
	return [trimmed, first].filter((t) => t.length > 1 && !JUNK.has(t));
}

/** The set of names that mean "me", from every source we have. */
export function identityTokens(identity: Identity): Set<string> {
	return new Set([
		...tokensOf(identity.name),
		...tokensOf(identity.login),
		...tokensOf(identity.user),
	]);
}

/** True when `startedBy` names the person holding this identity. */
export function startedByMe(startedBy: string | null | undefined, tokens: Set<string>): boolean {
	if (!startedBy || !tokens.size) return false;
	for (const token of tokensOf(startedBy)) {
		if (tokens.has(token)) return true;
	}
	return false;
}

/** An automation run — the band the terminal sidebar hides by default. */
export function isAutomation(session: Session): boolean {
	return !!session.automation;
}

export function inScope(session: Session, scope: SessionScope, tokens: Set<string>): boolean {
	if (scope === "all") return true;
	if (isAutomation(session)) return false;
	if (scope === "team") return true;
	return startedByMe(session.startedBy, tokens);
}

export function nextScope(scope: SessionScope): SessionScope {
	return SCOPES[(SCOPES.indexOf(scope) + 1) % SCOPES.length]!;
}
