// Factory for the per-user MAPS that follow you across devices: sidebar
// hides, snoozes, lanes, tab colors. Each is a `Record<string, V>` held
// server-side under the UserPicker name, mirrored in an in-memory cache so the
// public API stays synchronous, and written back by PUTting the whole map.
//
// The whole-map PUT is what makes the lifecycle worth owning in one place: the
// server replaces the stored map wholesale, so anything missing from the cache
// at write time is DELETED for that user. The rules that follow from it:
//
//   - A failed GET commits nothing and leaves the store unhydrated. A server
//     restart or a 502 used to leave `cache = {}` marked loaded, and the next
//     hide or snooze then PUT that empty map over everything else the user had.
//   - A write made before the server map has landed is held as an intent
//     rather than PUT. It is applied on top of the server map when hydration
//     lands, and only then persisted. A merely fresh browser never PUTs its
//     empty map over the stored one.
//   - A hydration that resolves after a user switch, or after a newer
//     hydration started, is discarded.
//
// lib/user-pref.ts is the scalar counterpart (one value, localStorage-backed);
// lib/pins.ts stays hand-rolled because it is an ordered array with a legacy
// localStorage migration and a server-push path.
import { getCurrentUser } from "../components/UserPicker";

const USER_CHANGE_EVENT = "opensession-user-changed";

export interface UserMap<V> {
	/** Synchronous read of the cached map. */
	get: () => Record<string, V>;
	/**
	 * Apply a change: the mutator gets the current map and returns the next one,
	 * or null to mean "nothing changed" (no event, no PUT). Returns the map in
	 * effect afterwards.
	 */
	update: (
		mutate: (current: Record<string, V>) => Record<string, V> | null,
	) => Record<string, V>;
	/** Subscribe to changes (local writes and hydrations). */
	onChanged: (handler: () => void) => () => void;
	/** Whether the cache reflects the server map for the current user. */
	ready: () => boolean;
	/** Pull the server map in. Runs on load and user switch; exported for tests. */
	hydrate: (user?: string) => Promise<void>;
}

export function makeUserMap<V>(opts: {
	/** Window event dispatched whenever the map changes. */
	changeEvent: string;
	fetchMap: (user: string) => Promise<Record<string, V>>;
	saveMap: (user: string, map: Record<string, V>) => Promise<unknown>;
	/** Defaults to the UserPicker name; injectable for tests. */
	currentUser?: () => string;
	/** Delay before retrying a hydration that failed. */
	retryMs?: number;
}): UserMap<V> {
	const currentUser = opts.currentUser ?? getCurrentUser;
	const retryMs = opts.retryMs ?? 5_000;

	let cache: Record<string, V> = {};
	let hydratedFor: string | null = null;
	let hydrationVersion = 0;
	let hydrating = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	// Writes made before this user's server map landed, keyed by user so a
	// switch mid-flight can't carry one person's intent onto another's map. A
	// null entry is a deletion.
	const pendingIntents = new Map<string, Record<string, { value: V } | null>>();

	// Capability check, not just `typeof window`: test runners can leave a bare
	// `window` global without DOM methods, and these modules must stay
	// importable outside a browser (their domain helpers are unit-tested).
	function hasDom(): boolean {
		return (
			typeof window !== "undefined" &&
			typeof window.addEventListener === "function"
		);
	}

	function emit(): void {
		if (
			typeof window === "undefined" ||
			typeof window.dispatchEvent !== "function"
		)
			return;
		window.dispatchEvent(new Event(opts.changeEvent));
	}

	function get(): Record<string, V> {
		return cache;
	}

	function ready(): boolean {
		return hydratedFor === currentUser();
	}

	function recordIntents(
		user: string,
		prev: Record<string, V>,
		next: Record<string, V>,
	): void {
		const intents = pendingIntents.get(user) ?? {};
		for (const [key, value] of Object.entries(next)) {
			if (prev[key] !== value) intents[key] = { value };
		}
		for (const key of Object.keys(prev)) {
			if (!(key in next)) intents[key] = null;
		}
		pendingIntents.set(user, intents);
	}

	function save(user: string, map: Record<string, V>): void {
		void Promise.resolve(opts.saveMap(user, map)).catch(() => {});
	}

	function update(
		mutate: (current: Record<string, V>) => Record<string, V> | null,
	): Record<string, V> {
		const next = mutate(cache);
		if (!next || next === cache) return cache;
		const user = currentUser();
		const hydrated = hydratedFor === user;
		if (!hydrated) recordIntents(user, cache, next);
		cache = next;
		emit();
		// Unhydrated the cache is not yet the user's map, so PUTting it would
		// replace the stored map with a truncated one. hydrate() persists the
		// merge instead.
		if (hydrated) save(user, next);
		else if (!hydrating) void hydrate(user);
		return next;
	}

	function scheduleRetry(user: string): void {
		if (!hasDom()) return;
		clearTimeout(retry);
		const handle = setTimeout(() => {
			retry = undefined;
			if (currentUser() === user && hydratedFor !== user) void hydrate(user);
		}, retryMs);
		retry = handle;
		// Never hold a test runner or a script open on the retry.
		(handle as unknown as { unref?: () => void }).unref?.();
	}

	async function hydrate(user: string = currentUser()): Promise<void> {
		const version = ++hydrationVersion;
		hydrating = true;
		let server: Record<string, V>;
		try {
			server = await opts.fetchMap(user);
		} catch {
			// Offline, or the server is restarting: keep the cache and stay
			// unhydrated, so no write can PUT an empty map over the stored one.
			hydrating = false;
			scheduleRetry(user);
			return;
		}
		hydrating = false;
		// A newer hydration, or a user switch mid-flight, wins.
		if (version !== hydrationVersion || currentUser() !== user) return;
		const intents = pendingIntents.get(user) ?? {};
		pendingIntents.delete(user);
		const next: Record<string, V> = { ...server };
		for (const [key, intent] of Object.entries(intents)) {
			if (intent) next[key] = intent.value;
			else delete next[key];
		}
		clearTimeout(retry);
		retry = undefined;
		cache = next;
		hydratedFor = user;
		emit();
		// Only a write made before the server map landed still needs persisting.
		if (Object.keys(intents).length) save(user, next);
	}

	function onChanged(handler: () => void): () => void {
		if (!hasDom()) return () => {};
		window.addEventListener(opts.changeEvent, handler);
		return () => window.removeEventListener(opts.changeEvent, handler);
	}

	if (hasDom()) {
		void hydrate(currentUser());
		window.addEventListener(USER_CHANGE_EVENT, () => void hydrate());
	}

	return { get, update, onChanged, ready, hydrate };
}
