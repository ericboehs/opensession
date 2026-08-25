import { expect, test } from "bun:test";
import { readFollowingLive } from "./transcript-anchor";

const viewer = await Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text();

test("fresh transcript ranges reaffirm a cached reader's live edge", () => {
	const settled = viewer.match(
		/const onVisibleRangesSettled = useCallback\([\s\S]*?\}, \[followingLive, scrollToLatest, transcriptIndex\]\);/,
	)?.[0];

	expect(settled).toContain("settledIndexRef.current = transcriptIndex");
	expect(settled).toContain(
		'if (readFollowingLive(followingLive)) scrollToLatest("auto")',
	);
});

test("late action clearance keeps a following transcript at the bottom", () => {
	const clearanceEffect = viewer.match(
		/useLayoutEffect\(\(\) => \{\s*if \(readFollowingLive\(followingLive\)\) scrollToLatest\("auto"\);\s*\}, \[actionClearance, followingLive, scrollToLatest\]\);/,
	)?.[0];

	expect(clearanceEffect).toBeDefined();
	expect(viewer).toContain("actionClearance,");
});

test("the stable callback reads current live-edge intent when it runs", () => {
	const following = { current: true };
	expect(readFollowingLive(following)).toBe(true);
	following.current = false;
	expect(readFollowingLive(following)).toBe(false);
});
