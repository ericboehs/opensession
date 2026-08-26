import { expect, test } from "bun:test";

const summarySource = await Bun.file(
	new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const infoSource = await Bun.file(
	new URL("./WorkspaceInfo.tsx", import.meta.url),
).text();
const apiSource = await Bun.file(
	new URL("../lib/api/workspaces.ts", import.meta.url),
).text();

test("workspace surfaces keep committed and uncommitted work separate", () => {
	expect(apiSource).toContain("commits?: WorkspaceCommit[]");
	expect(summarySource).toContain(
		"(diffIsCommitted || commits.length > 0)",
	);
	expect(summarySource).toContain(">Committed</div>");
	expect(summarySource).toContain(">Uncommitted</div>");
	expect(summarySource).toContain("commits.map(committedRow)");
	expect(infoSource).toContain("commits.map((commit)");
	expect(infoSource).toContain("<CommitRow key={commit.sha} commit={commit} />");
});

test("popup review heading keeps one small gap after a lone PR band", () => {
	expect(summarySource).toContain('"[&>.ws-summary-band:last-child]:mb-0"');
	expect(summarySource).toContain(
		'"[.ws-summary-pr-group:has(>.ws-summary-band:last-child)+.ws-summary-review-group_&]:mt-2"',
	);
	expect(summarySource).not.toContain('embedded ? "h-11" : "h-7 mt-0"');
});
