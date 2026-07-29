/**
 * Per-user UI reading preferences (small string key→value map). Like pins.ts /
 * tab-colors.ts, each user (the self-selected `backstage-user` name from the
 * UserPicker — not an auth identity) gets one JSON file
 * `~/.opensession-ui-prefs/<user>.json` of shape `{ prefs: { [key]: value } }`.
 * These are cross-device view preferences (first user: the turn-activity fold
 * setting) — the localStorage copy on each browser is just a cache of this.
 *
 * Writes are PATCH-merge (not replace): each device only knows the prefs it
 * has touched, so a whole-map PUT from a stale device would clobber keys set
 * elsewhere. A key set to null in the patch is deleted.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";

const PREFS_DIR = stateDir("ui-prefs");

// Guardrails on a free-form map: sane key shape, short string values, bounded
// entry count — this is a preferences file, not a datastore.
const KEY_RE = /^[a-z][a-zA-Z0-9-]{0,40}$/;
const MAX_VALUE_LEN = 200;
const LONG_VALUE_KEYS = new Set(["repo-order"]);
const MAX_LONG_VALUE_LEN = 16_384;
const MAX_ENTRIES = 100;

export function maxValueLength(key: string): number {
	return LONG_VALUE_KEYS.has(key) ? MAX_LONG_VALUE_LEN : MAX_VALUE_LEN;
}

/** Map a free-form user name to a safe filename; empty/odd input → Anonymous. */
function sanitizeUser(user: string): string {
	const cleaned = (user || "")
		.trim()
		.replace(/[^A-Za-z0-9_-]/g, "_")
		.slice(0, 64);
	return cleaned || "Anonymous";
}

function fileFor(user: string): string {
	return `${PREFS_DIR}/${sanitizeUser(user)}.json`;
}

export type UiPrefs = Record<string, string>;

/** Keep only valid key → short-string entries. */
function clean(input: unknown): UiPrefs {
	const out: UiPrefs = {};
	if (input && typeof input === "object") {
		for (const [key, value] of Object.entries(
			input as Record<string, unknown>,
		)) {
			if (Object.keys(out).length >= MAX_ENTRIES) break;
			if (
				KEY_RE.test(key) &&
				typeof value === "string" &&
				value.length <= maxValueLength(key)
			) {
				out[key] = value;
			}
		}
	}
	return out;
}

export function getUiPrefs(user: string): UiPrefs {
	try {
		const f = fileFor(user);
		if (!existsSync(f)) return {};
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return clean(raw?.prefs);
	} catch {
		return {};
	}
}

/**
 * Merge `patch` into a user's prefs (null value deletes the key). Returns the
 * stored map after the merge.
 */
export function patchUiPrefs(user: string, patch: unknown): UiPrefs {
	const current = getUiPrefs(user);
	if (patch && typeof patch === "object") {
		for (const [key, value] of Object.entries(
			patch as Record<string, unknown>,
		)) {
			if (!KEY_RE.test(key)) continue;
			if (value === null) delete current[key];
			else if (typeof value === "string" && value.length <= maxValueLength(key))
				current[key] = value;
		}
	}
	const cleaned = clean(current);
	if (!existsSync(PREFS_DIR)) mkdirSync(PREFS_DIR, { recursive: true });
	writeJsonAtomic(fileFor(user), { prefs: cleaned });
	return cleaned;
}
