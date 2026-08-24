import { makeUserPref } from "./user-pref";

const pref = makeUserPref<boolean>({
	localKey: "opensession-first-mile-complete-v1",
	prefKey: "first-mile-complete-v1",
	changeEvent: "opensession-first-mile-changed",
	defaultValue: false,
	decode: (raw) => raw === "true" ? true : raw === "false" ? false : null,
	encode: (value) => String(value),
});

export function firstMileComplete(): boolean {
	return pref.get();
}

export function completeFirstMile(): void {
	pref.set(true);
}

export function onFirstMileChanged(handler: () => void): () => void {
	return pref.onChanged(handler);
}
