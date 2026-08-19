// Per-user default repository for NEW sessions (Settings → Preferences): what
// the New-session palette's repo picker starts on for this user. "" = no
// preference, which falls back to the workspace's own default (GET /api/repos
// → newSessionRepo) and finally to Auto.
//
// The stored value is a repo id, or AUTO_REPO for "let it decide from the
// prompt" — Auto is a choice you can pin, not merely the absence of one.
//
// This replaced the old localStorage stickiness (LAST_REPO_KEY), which was a
// poor man's version of exactly this: it silently pinned whatever you picked
// last, which meant Auto could never be anyone's default once they had used
// the picker even once. See NewSession's seed order for the migration.
//
// A makeUserPref instance — see lib/user-pref for the ui-prefs hydrate
// pattern. Any string the server sends (including "" for an explicit reset) is
// applied as-is; the palette validates it against the live repo list, so a
// preference naming a repo that has since been removed simply stops applying.

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<string>({
	localKey: "opensession-default-repo-pref",
	prefKey: "default-repo",
	changeEvent: "opensession-default-repo-pref-changed",
	defaultValue: "",
	decode: (v) => (typeof v === "string" ? v : null),
	encode: (v) => v,
});

/** The user's preferred new-session repo id, AUTO_REPO, or "" for none. */
export const getDefaultRepoPref = pref.get;
export const setDefaultRepoPref = pref.set;
export const onDefaultRepoPrefChanged = pref.onChanged;
