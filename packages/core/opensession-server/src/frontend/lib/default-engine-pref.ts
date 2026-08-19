// Per-user default engine for NEW sessions (Settings → Preferences): which
// engine the New-session palette (and the workspace/support first-session
// composers) start you on. "" = no preference, which leaves the routing to the
// instance — the per-model default engine map, else OpenCode. A makeUserPref
// instance — see lib/user-pref for the server-side ui-prefs hydrate pattern.
//
// The stored value is an engine id. It is validated against the engines the
// server currently offers where it is applied, rather than here, so an engine
// that is turned off later reads as no preference instead of preselecting a
// session that cannot run. That rule is lib/new-session-model, applied by
// resolveNewSessionModel in lib/default-model-pref beside the model half.

import { makeUserPref } from "./user-pref";

const pref = makeUserPref<string>({
	localKey: "opensession-default-engine-pref",
	prefKey: "default-engine",
	changeEvent: "opensession-default-engine-pref-changed",
	defaultValue: "",
	decode: (v) => (typeof v === "string" ? v : null),
	encode: (v) => v,
});

/** The user's preferred engine for new sessions, or "" for no preference. */
export const getDefaultEnginePref = pref.get;
export const setDefaultEnginePref = pref.set;
export const onDefaultEnginePrefChanged = pref.onChanged;
