import type { TranscriptEntry } from "./types";

type Listener = () => void;
type Updater =
	| TranscriptEntry[]
	| ((previous: TranscriptEntry[]) => TranscriptEntry[]);

/**
 * Normalized transcript projection. Live upserts are O(k) and publish at most
 * once per animation frame; snapshots preserve entry object identity for
 * untouched turns so memoized history stays cold.
 */
export class TranscriptViewStore {
	private byId = new Map<string, TranscriptEntry>();
	private orderedIds: string[] = [];
	private snapshot: TranscriptEntry[] = [];
	private listeners = new Set<Listener>();
	private frame: number | null = null;

	constructor(entries: TranscriptEntry[] = []) {
		this.replace(entries, false);
	}

	subscribe = (listener: Listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	getSnapshot = () => this.snapshot;
	getServerSnapshot = () => this.snapshot;

	replace(entries: TranscriptEntry[], notify = true) {
		this.cancelFrame();
		this.byId.clear();
		this.orderedIds = [];
		for (const entry of entries) {
			if (!this.byId.has(entry.id)) this.orderedIds.push(entry.id);
			this.byId.set(entry.id, entry);
		}
		this.publish(notify);
	}

	merge(entries: TranscriptEntry[]) {
		if (entries.length === 0) return;
		for (const entry of entries) {
			if (!this.byId.has(entry.id)) this.orderedIds.push(entry.id);
			this.byId.set(entry.id, entry);
		}
		this.schedulePublish();
	}

	prepend(entries: TranscriptEntry[]) {
		if (entries.length === 0) return;
		let changed = false;
		for (const entry of entries) {
			if (!this.byId.has(entry.id)) {
				this.orderedIds.push(entry.id);
				changed = true;
			}
			this.byId.set(entry.id, entry);
		}
		if (!changed) return;
		this.orderedIds.sort(
			(a, b) =>
				new Date(this.byId.get(a)!.timestamp).getTime() -
				new Date(this.byId.get(b)!.timestamp).getTime(),
		);
		this.schedulePublish();
	}

	update(updater: Updater) {
		const current = this.orderedIds
			.map((id) => this.byId.get(id))
			.filter((entry): entry is TranscriptEntry => Boolean(entry));
		this.replace(typeof updater === "function" ? updater(current) : updater);
	}

	private schedulePublish() {
		if (this.frame !== null) return;
		if (typeof requestAnimationFrame === "undefined") {
			this.publish();
			return;
		}
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			this.publish();
		});
	}

	private publish(notify = true) {
		this.snapshot = this.orderedIds
			.map((id) => this.byId.get(id))
			.filter((entry): entry is TranscriptEntry => Boolean(entry));
		if (notify) for (const listener of this.listeners) listener();
	}

	private cancelFrame() {
		if (this.frame !== null && typeof cancelAnimationFrame !== "undefined") {
			cancelAnimationFrame(this.frame);
		}
		this.frame = null;
	}
}
