import { expect, test } from "bun:test";

const source = await Bun.file(new URL("./WorkspacePane.tsx", import.meta.url)).text();

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

test("workspace Review keeps the implementation summary over the PR canvas", () => {
	expect(source).toContain("sessionCarriesPr(s, reviewTarget)");
	expect(source).toContain("s.workspaceId === workspace.id");
	expect(source).toContain("fetchWorkspaceOverview(workspace.id)");
	expect(source).toContain("<WorkspaceSummary");
	expect(source).toContain("session={presentationSession}");
	expect(source).toContain("walkthrough={presentationSession?.walkthrough}");
});
