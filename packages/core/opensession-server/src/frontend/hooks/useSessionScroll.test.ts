import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./useSessionScroll.ts", import.meta.url)).text();

test("following readers stay synchronously pinned through large transcript growth", () => {
	expect(source).toContain(
		"if (!disclosureSettleRef.current) el.scrollTop = el.scrollHeight;",
	);
	expect(source).not.toContain("startFollowGlide");
	expect(source).not.toContain("FOLLOW_GLIDE");
});
