import type { TranscriptEntry } from "./types";
import { orderTranscriptEntries } from "./transcript-state";

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
	private hasUnsequenced = false;
	private lastSeq = 0;

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

	replace(entries: TranscriptEntry[], notify = true, v2 = false) {
		this.cancelFrame();
		this.byId.clear();
		this.orderedIds = [];
		for (const entry of v2 ? orderTranscriptEntries(entries) : entries) {
			if (!this.byId.has(entry.id)) this.orderedIds.push(entry.id);
			this.byId.set(entry.id, entry);
		}
		this.refreshOrderingMetadata();
		this.publish(notify);
	}

	merge(entries: TranscriptEntry[], v2 = false, immediate = false) {
		if (entries.length === 0) return;
		let changed = false;
		let needsOrder = false;
		for (const entry of entries) {
			const current = this.byId.get(entry.id);
			if (
				current?.changeSeq !== undefined &&
				entry.changeSeq !== undefined &&
				entry.changeSeq < current.changeSeq
			)
				continue;
			if (!current) {
				this.orderedIds.push(entry.id);
				if (
					v2 &&
					(entry.seq === undefined ||
						this.hasUnsequenced ||
						entry.seq < this.lastSeq)
				)
					needsOrder = true;
				if (entry.seq === undefined) this.hasUnsequenced = true;
				else this.lastSeq = Math.max(this.lastSeq, entry.seq);
			} else if (v2 && current.seq !== entry.seq) {
				// Live tool results arrive without seq, then the durable append fills it
				// in. Reorder that existing id now, rather than leaving the result at
				// whichever end of the current turn its live frame first occupied.
				needsOrder = true;
			}
			this.byId.set(entry.id, entry);
			changed = true;
		}
		if (!changed) return;
		if (v2 && needsOrder) this.orderV2();
		if (immediate) {
			this.cancelFrame();
			this.publish();
		} else {
			this.schedulePublish();
		}
	}

	prepend(entries: TranscriptEntry[], v2 = false) {
		if (entries.length === 0) return;
		if (v2) {
			this.merge(entries, true);
			return;
		}
		let changed = false;
		for (const entry of entries) {
			const current = this.byId.get(entry.id);
			if (
				current?.changeSeq !== undefined &&
				entry.changeSeq !== undefined &&
				entry.changeSeq < current.changeSeq
			)
				continue;
			if (!current) {
				this.orderedIds.push(entry.id);
			}
			this.byId.set(entry.id, entry);
			changed = true;
		}
		if (!changed) return;
		this.orderedIds.sort(
			(a, b) =>
				new Date(this.byId.get(a)!.timestamp).getTime() -
				new Date(this.byId.get(b)!.timestamp).getTime(),
		);
		this.refreshOrderingMetadata();
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

	private orderV2() {
		this.orderedIds = orderTranscriptEntries(
			this.orderedIds
				.map((id) => this.byId.get(id))
				.filter((entry): entry is TranscriptEntry => Boolean(entry)),
		).map((entry) => entry.id);
		this.refreshOrderingMetadata();
	}

	private refreshOrderingMetadata() {
		this.hasUnsequenced = false;
		this.lastSeq = 0;
		for (const id of this.orderedIds) {
			const seq = this.byId.get(id)?.seq;
			if (seq === undefined) this.hasUnsequenced = true;
			else this.lastSeq = Math.max(this.lastSeq, seq);
		}
	}

	private cancelFrame() {
		if (this.frame !== null && typeof cancelAnimationFrame !== "undefined") {
			cancelAnimationFrame(this.frame);
		}
		this.frame = null;
	}
}
