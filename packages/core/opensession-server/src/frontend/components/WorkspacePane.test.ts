import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./WorkspacePane.tsx", import.meta.url)).text();
const viewerSource = await Bun.file(
	new URL("./SessionViewer.tsx", import.meta.url),
).text();
const prPanelSource = await Bun.file(
	new URL("./PrPanel.tsx", import.meta.url),
).text();
const summarySource = await Bun.file(
	new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();

test("workspace draft composers accept and persist attachments", () => {
	const composerStart = source.lastIndexOf("<Composer");
	const composerEnd = source.indexOf("/>", composerStart);
	const composer = source.slice(composerStart, composerEnd);

	expect(composerStart).toBeGreaterThan(-1);
	expect(composer).toContain("images={images}");
	expect(composer).toContain("onImagesChange={setImages}");
	expect(composer).toContain("files={files}");
	expect(composer).toContain("onFilesChange={setFiles}");
	expect(composer).toContain("onAddAttachments={addWorkspaceAttachments}");
	expect(source).toContain('window.addEventListener("drop", handleDrop, true)');
	expect(source).toContain("saveDraft(draftKey, { text: prompt, images, files })");
});

test("the first workspace session receives its draft attachments", () => {
	const sendStart = source.indexOf('type: "create_session"');
	const sendEnd = source.indexOf("// App navigates", sendStart);
	const payload = source.slice(sendStart, sendEnd);

	expect(sendStart).toBeGreaterThan(-1);
	expect(payload).toContain("...(images.length ? { images } : {})");
	expect(payload).toContain("files: files.map");
	expect(source).toContain("dropStagingAttachments(draftKey)");
});

test("workspace Review keeps the implementation summary beside the PR canvas", () => {
	expect(source).toContain("sessionCarriesPr(s, reviewTarget)");
	expect(source).toContain("s.workspaceId === workspace.id");
	expect(source).toContain("fetchWorkspaceOverview(workspace.id)");
	expect(source).toContain("<WorkspaceSummary");
	expect(source).toContain("session={presentationSession}");
	expect(source).toContain("onOpenChange={setReviewSummaryOpen}");
	expect(source).toContain(
		"reviewSummaryVisible && WS_SUMMARY_REVIEW_CLEARANCE",
	);
	expect(viewerSource).toContain(
		"summaryVisible && WS_SUMMARY_REVIEW_CLEARANCE",
	);
	expect(source).toContain("walkthrough={presentationSession?.walkthrough}");
});

test("the PR toolbar keeps a compact fallback navigation row", () => {
	const toolbarStart = prPanelSource.indexOf(
		'<div className="shrink-0 bg-surface desktop:mx-2',
	);
	const toolbarEnd = prPanelSource.indexOf(">", toolbarStart);
	const toolbar = prPanelSource.slice(toolbarStart, toolbarEnd);
	const reviewBar = prPanelSource.slice(
		prPanelSource.indexOf("const reviewBar"),
		prPanelSource.indexOf("const reviewBar") + 500,
	);

	expect(toolbar).toContain("desktop:mt-2.5");
	expect(toolbar).toContain("desktop:mb-2");
	expect(toolbar).toContain("desktop:overflow-hidden");
	expect(toolbar).toContain("desktop:rounded-lg");
	expect(toolbar).toContain("desktop:border desktop:border-line");
	expect(reviewBar).toContain("h-8");
	expect(reviewBar).toContain("phone:h-11");
	expect(reviewBar).toContain("bg-panel");
	expect(reviewBar).toContain("phone:bg-surface");
	expect(reviewBar).toContain("desktop:-ml-3");
	expect(prPanelSource).toContain('["files", "Files",');
	expect(prPanelSource).toContain("<ActiveCodeViewIcon size={18} />");
});

test("wide Review moves page navigation into the summary and uses one toolbar row", () => {
	expect(source).toContain("reviewPage={reviewPage}");
	expect(source).toContain("onReviewPageChange={setReviewPage}");
	expect(source).toContain("compactToolbar={reviewSummaryVisible}");
	expect(prPanelSource).toContain("const reviewBar = !compactToolbar");
	expect(prPanelSource).toContain("{compactToolbar && fileControls}");
	expect(summarySource).toContain('aria-label="Pull request pages"');
	expect(summarySource).toContain('onReviewPageChange("overview")');
	expect(summarySource).toContain('onReviewPageChange("files")');
});

test("a lone Review hides the tab strip and keeps New tab in the header", () => {
	expect(source).toContain("tabStripVisible: boolean");
	expect(source).toContain("!tabStripVisible && onNewSession");
	expect(source).toContain("tabStripVisible={tabStripVisible}");
	expect(source).toContain('aria-label="New tab"');
});

test("the PR top bar leaves merge to the summary and actions menu", () => {
	const headerStart = prPanelSource.indexOf("<header");
	const menuStart = prPanelSource.indexOf("<Menu.Root>", headerStart);
	const menuEnd = prPanelSource.indexOf("</Menu.Root>", menuStart);

	expect(headerStart).toBeGreaterThan(-1);
	expect(menuStart).toBeGreaterThan(headerStart);
	expect(prPanelSource.slice(headerStart, menuStart)).not.toContain(
		"Squash and merge",
	);
	expect(prPanelSource.slice(menuStart, menuEnd)).toContain("Squash and merge");
});
