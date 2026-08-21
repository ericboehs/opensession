import { activeSessionKernels, peekSessionKernel, sessionKernel, } from "./kernel";

function immutableCopy<V>(value: V, seen = new WeakMap<object, unknown>()): V {
	if (!value || typeof value !== "object") return value;
	const prior = seen.get(value as object);
	if (prior) return prior as V;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(immutableCopy(item, seen));
		return copy as V;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	const copy = Object.create(prototype) as Record<string, unknown>;
	seen.set(value as object, copy);
	for (const [key, item] of Object.entries(value as Record<string, unknown>))
		copy[key] = immutableCopy(item, seen);
	return copy as V;
}

/** Map-compatible view whose values physically live inside SessionKernel. */
export class SessionOwnedMap<V> implements Map<string, V> {
	readonly [Symbol.toStringTag] = "SessionOwnedMap";
	constructor(private readonly slot: string) {}

	get size(): number {
		return [...this.keys()].length;
	}

	clear(): void {
		for (const kernel of activeSessionKernels()) kernel.deleteRuntime(this.slot);
	}

	delete(sessionId: string): boolean {
		const kernel = peekSessionKernel(sessionId);
		if (!kernel) return false;
		return kernel.applySync(`delete:${this.slot}`, () =>
			kernel.deleteRuntime(this.slot),
		);
	}

	get(sessionId: string): V | undefined {
		const value = peekSessionKernel(sessionId)?.getRuntime<V>(this.slot);
		return value === undefined ? undefined : immutableCopy(value);
	}

	has(sessionId: string): boolean {
		return this.get(sessionId) !== undefined;
	}

	set(sessionId: string, value: V): this {
		sessionKernel(sessionId).applySync(`set:${this.slot}`, () =>
			sessionKernel(sessionId).setRuntime(this.slot, immutableCopy(value)),
		);
		return this;
	}

	*entries(): MapIterator<[string, V]> {
		for (const kernel of activeSessionKernels()) {
			const value = kernel.runtimeEntries<V>(this.slot);
			if (value !== undefined) yield [kernel.sessionId, immutableCopy(value)];
		}
	}

	keys(): MapIterator<string> {
		return this.keyIterator();
	}

	private *keyIterator(): MapIterator<string> {
		for (const [sessionId] of this.entries()) yield sessionId;
	}

	values(): MapIterator<V> {
		return this.valueIterator();
	}

	private *valueIterator(): MapIterator<V> {
		for (const [, value] of this.entries()) yield value;
	}

	forEach(
		callbackfn: (value: V, key: string, map: Map<string, V>) => void,
		thisArg?: unknown,
	): void {
		for (const [key, value] of this.entries())
			callbackfn.call(thisArg, value, key, this);
	}

	[Symbol.iterator](): MapIterator<[string, V]> {
		return this.entries();
	}
}

export class SessionOwnedSet {
	readonly [Symbol.toStringTag] = "SessionOwnedSet";
	private readonly map: SessionOwnedMap<true>;
	constructor(slot: string) {
		this.map = new SessionOwnedMap(slot);
	}
	get size(): number {
		return this.map.size;
	}
	add(value: string): this {
		this.map.set(value, true);
		return this;
	}
	clear(): void {
		this.map.clear();
	}
	delete(value: string): boolean {
		return this.map.delete(value);
	}
	has(value: string): boolean {
		return this.map.has(value);
	}
	entries(): SetIterator<[string, string]> {
		return this.entryIterator();
	}
	private *entryIterator(): SetIterator<[string, string]> {
		for (const key of this.map.keys()) yield [key, key];
	}
	keys(): SetIterator<string> {
		return this.map.keys();
	}
	values(): SetIterator<string> {
		return this.map.keys();
	}
	forEach(
		callbackfn: (value: string, value2: string, set: SessionOwnedSet) => void,
		thisArg?: unknown,
	): void {
		for (const key of this.map.keys()) callbackfn.call(thisArg, key, key, this);
	}
	[Symbol.iterator](): SetIterator<string> {
		return this.values();
	}
}
