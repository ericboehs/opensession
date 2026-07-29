const KEY = "opensession-tab-splits";
const CHANGE_EVENT = "opensession-tab-splits-changed";

export type TabSplit = {
	leftId: string;
	rightId: string;
	ratio: number;
};

type SplitMap = Record<string, TabSplit>;

function validSplit(value: unknown): value is TabSplit {
	if (!value || typeof value !== "object") return false;
	const split = value as Partial<TabSplit>;
	return (
		typeof split.leftId === "string" &&
		!!split.leftId &&
		typeof split.rightId === "string" &&
		!!split.rightId &&
		split.leftId !== split.rightId &&
		typeof split.ratio === "number" &&
		Number.isFinite(split.ratio)
	);
}

function read(): SplitMap {
	try {
		const value = JSON.parse(localStorage.getItem(KEY) || "{}");
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry): entry is [string, TabSplit] => validSplit(entry[1])),
		);
	} catch {
		return {};
	}
}

function write(map: SplitMap): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(map));
	} catch {
		/* private mode / quota */
	}
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clampSplitRatio(ratio: number): number {
	return Math.min(0.8, Math.max(0.2, ratio));
}

export function getTabSplit(workspaceId: string): TabSplit | null {
	const split = read()[workspaceId];
	return split ? { ...split, ratio: clampSplitRatio(split.ratio) } : null;
}

export function saveTabSplit(workspaceId: string, split: TabSplit): void {
	if (!workspaceId || !validSplit(split)) return;
	const map = read();
	map[workspaceId] = { ...split, ratio: clampSplitRatio(split.ratio) };
	write(map);
}

export function clearTabSplit(workspaceId: string): void {
	if (!workspaceId) return;
	const map = read();
	if (!(workspaceId in map)) return;
	delete map[workspaceId];
	write(map);
}

export function splitIsLive(split: TabSplit | null, ids: string[]): split is TabSplit {
	if (!split) return false;
	const live = new Set(ids);
	return live.has(split.leftId) && live.has(split.rightId);
}

export function onTabSplitChanged(handler: () => void): () => void {
	window.addEventListener(CHANGE_EVENT, handler);
	window.addEventListener("storage", handler);
	return () => {
		window.removeEventListener(CHANGE_EVENT, handler);
		window.removeEventListener("storage", handler);
	};
}
