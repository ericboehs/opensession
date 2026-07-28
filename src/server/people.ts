/**
 * Team directory for the frontend — the single roster the UI should use for
 * people pickers, avatars, @-mention completion and the sidebar People band.
 * Derived from the same identity config as commit attribution
 * (configuredIdentity() → ~/.backstage/config.json identity.team), so adding a
 * teammate to the config updates every people surface at once instead of the
 * historical trio of hardcoded arrays (UserPicker TEAM, UserAvatar login map,
 * chat.ts CHAT_TEAM).
 */

import { configuredIdentity } from "./config";

export interface DirectoryPerson {
	/** Picker/display first name — the value presence viewers,
	 *  push-subscription keys and `startedBy` use. */
	name: string;
	/** Full display name from the identity roster. */
	fullName: string;
	/** GitHub login (avatar source), when known. */
	github?: string;
	/** IANA timezone, when configured. */
	timezone?: string;
}

/** The mentionable/pickable team, in config order. Members flagged
 *  `directory: false` (attribution-only identities) are excluded. */
export function teamDirectory(): DirectoryPerson[] {
	return configuredIdentity()
		.team.filter((m) => m.directory !== false)
		.map((m) => ({
		name: m.name.split(" ")[0],
		fullName: m.name,
		...(m.github ? { github: m.github } : {}),
		...(m.timezone ? { timezone: m.timezone } : {}),
	}));
}

/** Picker first names — the mention-matching + push-key roster. */
export function teamFirstNames(): string[] {
	return teamDirectory().map((p) => p.name);
}
