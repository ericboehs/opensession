/**
 * Per-user workspace snoozes. Like pins.ts, each user (the self-selected
 * `backstage-user` name from the UserPicker — not an auth identity) gets one
 * JSON file under `~/.opensession-snoozes/` of shape
 * `{ snoozes: { [rowKey]: isoUntil } }`, where `rowKey` is a sidebar row key
 * (`workspace:<id>` or a solo session id) and `isoUntil` is when the snooze
 * lapses. Filename, directory resolution and legacy-name fallback come from
 * shared/user-store.ts. Snoozing is attention management (an overlay, like a
 * pin, not a workspace state), so it lives per-user and syncs across devices;
 * the lane derivation is untouched — the frontend parks actively-snoozed rows
 * in the Snoozed section and lets lapsed entries fall back to their derived
 * lane. The server does no time logic: the frontend prunes lapsed entries when
 * it sees them (marking the row unread so the wake is visible).
 */

import { userStore } from "./shared/user-store";

export type Snoozes = Record<string, string>;

/** Keep only string-key entries whose value parses as a date. */
function clean(input: unknown): Snoozes {
	const out: Snoozes = {};
	if (input && typeof input === "object") {
		for (const [key, until] of Object.entries(
			input as Record<string, unknown>,
		)) {
			if (
				typeof key === "string" &&
				key.length > 0 &&
				key.length <= 128 &&
				typeof until === "string" &&
				!Number.isNaN(Date.parse(until))
			) {
				out[key] = until;
			}
		}
	}
	return out;
}

const store = userStore<Snoozes>({ name: "snoozes", field: "snoozes", clean });

export function getSnoozes(user: string): Snoozes {
	return store.get(user);
}

/** Replace a user's snoozes (validated). Returns the stored map. */
export function setSnoozes(user: string, snoozes: unknown): Snoozes {
	return store.set(user, snoozes);
}
