/**
 * Frontend team directory — fetched once from GET /api/people (derived
 * server-side from the identity config) and cached module-wide. Starts from
 * the historical hardcoded roster so everything renders correctly before (or
 * without) the fetch, then upgrades in place: the fetched logins are merged
 * into UserAvatar's login map and subscribers re-render via `usePeople()`.
 */

import { useEffect, useState } from "react";
import { BASE_PATH } from "./base";
import { registerGithubLogins } from "../components/UserAvatar";

export interface Person {
	/** Picker/display first name ("Michiel"). */
	name: string;
	fullName: string;
	github?: string;
	timezone?: string;
}

// Fallback mirror of the built-in roster (kept minimal — the fetch replaces it).
const DEFAULT_PEOPLE: Person[] = [
	{ name: "Michiel", fullName: "Michiel Westerbeek", github: "happylinks" },
	{ name: "Jaap", fullName: "Jaap Frolich", github: "jfrolich" },
	{ name: "Kent", fullName: "Kent de Bruin", github: "kentdebruin" },
	{ name: "Grant", fullName: "Grant Shaddick", github: "9ranty" },
	{ name: "Johnny", fullName: "Johnny Lin", github: "johnnylinsf" },
	{ name: "John", fullName: "John Soutar", github: "soutar" },
	{ name: "Louise", fullName: "Louise de Sadeleer", github: "louisedesadeleer" },
];

const CHANGE_EVENT = "opensession-people-changed";
let people: Person[] = DEFAULT_PEOPLE;
let fetched = false;

/** Current roster, synchronously (fallback until the fetch lands). */
export function getPeople(): Person[] {
	void ensurePeople();
	return people;
}

/** Picker first names for the roster. */
export function getPeopleNames(): string[] {
	return getPeople().map((p) => p.name);
}

export function personByName(name?: string | null): Person | undefined {
	if (!name) return undefined;
	const first = name.trim().split(/\s+/)[0]?.toLowerCase();
	return people.find((p) => p.name.toLowerCase() === first);
}

let inflight: Promise<void> | null = null;
export function ensurePeople(): Promise<void> {
	if (fetched) return Promise.resolve();
	if (inflight) return inflight;
	inflight = fetch(`${BASE_PATH}/api/people`)
		.then((r) => (r.ok ? r.json() : null))
		.then((body: { people?: Person[] } | null) => {
			const list = body?.people?.filter((p) => p && typeof p.name === "string");
			if (!list?.length) return;
			people = list;
			fetched = true;
			registerGithubLogins(
				Object.fromEntries(
					list
						.filter((p) => p.github)
						.map((p) => [p.name.toLowerCase(), p.github as string]),
				),
			);
			window.dispatchEvent(new Event(CHANGE_EVENT));
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/** Reactive roster — triggers the fetch on first use. */
export function usePeople(): Person[] {
	const [list, setList] = useState(people);
	useEffect(() => {
		void ensurePeople();
		const handler = () => setList(people);
		window.addEventListener(CHANGE_EVENT, handler);
		return () => window.removeEventListener(CHANGE_EVENT, handler);
	}, []);
	return list;
}
