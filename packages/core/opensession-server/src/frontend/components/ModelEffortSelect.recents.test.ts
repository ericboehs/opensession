import { expect, test } from "bun:test";

test("the top-level model menu exposes three recent choices", async () => {
	const source = await Bun.file(new URL("./ModelEffortSelect.tsx", import.meta.url)).text();

	expect(source).toContain("<Menu.GroupLabel>Recent models</Menu.GroupLabel>");
	expect(source).toContain(".slice(0, 3)");
	expect(source).toContain("renderModelOption(option, true)");
	expect(source).toContain("pushRecentModel(option.id)");
});
