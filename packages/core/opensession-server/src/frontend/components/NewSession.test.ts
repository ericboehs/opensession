import { expect, test } from "bun:test";

test("a long phone prompt scrolls without moving the title bar or send button", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const motionStart = source.indexOf("<motion.div", source.indexOf("const card ="));
  const promptStart = source.indexOf("<NewSessionPrompt", motionStart);
  const layout = source.slice(motionStart, promptStart);

  expect(motionStart).toBeGreaterThan(-1);
  expect(layout).toContain('"relative flex min-h-0 flex-col"');
  expect(layout).toContain('"flex min-h-0 flex-1 flex-col"');
});

test("the phone footer drops the covered safe-area inset while the keyboard is open", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const footerStart = source.indexOf("const FOOTER =");
  const footerEnd = source.indexOf(";", footerStart);
  const footer = source.slice(footerStart, footerEnd);

  expect(footerStart).toBeGreaterThan(-1);
  expect(footer).toContain("phone:pb-[calc(0.75rem+env(safe-area-inset-bottom))]");
  expect(footer).toContain("phone:[body.kb-open_&]:pb-3");
});

test("the phone title bar's project trigger carries no surface of its own", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const triggerStart = source.indexOf("const MOBILE_TRIGGER =");
  const triggerEnd = source.indexOf(";", triggerStart);
  const trigger = source.slice(triggerStart, triggerEnd);

  expect(triggerStart).toBeGreaterThan(-1);
  expect(trigger).not.toContain("phone:bg-");
  expect(trigger).not.toContain("phone:border");
  // Still a 44px target, even without a surface to show for it.
  expect(trigger).toContain("phone:min-h-11");
});

test("the new composer keeps the full model name ahead of its effort suffix", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const pillStart = source.indexOf("const MODEL_PILL");
  const pillEnd = source.indexOf(");", pillStart);
  const pill = source.slice(pillStart, pillEnd);

  expect(pillStart).toBeGreaterThan(-1);
  expect(pill).toContain("max-w-none");
  expect(pill).toContain("phone:[&_[data-effort]]:hidden");
  expect(pill).not.toContain("max-w-[150px]");
});

test("the new composer uses the shared model settings component with every axis", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const pickerStart = source.indexOf("<ModelEffortSelect");
  const pickerEnd = source.indexOf("/>", pickerStart);
  const picker = source.slice(pickerStart, pickerEnd);

  expect(pickerStart).toBeGreaterThan(-1);
  expect(picker).toContain("effort={effort}");
  expect(picker).toContain("onEffortChange={setEffort}");
  expect(picker).toContain("fastMode={fastMode}");
  expect(picker).toContain("onFastModeChange={setFastMode}");
  expect(picker).toContain("accounts={accounts}");
  expect(picker).toContain("accountId={accountId}");
  expect(picker).toContain("onAccountChange={setAccountId}");
});

test("the new session payload persists fast mode", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const createStart = source.indexOf('type: "create_session"');
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createPayload = source.slice(createStart, createEnd);

  expect(createStart).toBeGreaterThan(-1);
  expect(createEnd).toBeGreaterThan(createStart);
  expect(createPayload).toContain("...(fastMode ? { fastMode: true } : {})");
});

test("the new session title uses the visible names of pasted session links", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const createStart = source.indexOf('type: "create_session"');
  const createEnd = source.indexOf("const canCreate =", createStart);
  const createPayload = source.slice(createStart, createEnd);

  expect(createPayload).toContain(
    "titlePrompt: projectComposerSessions(prompt).displayText",
  );
});

test("the floating composer owns app-wide file drops", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();

  expect(source).toContain('data-global-file-composer="new-session"');
  expect(source).toContain("foregroundFileComposerOwns(composer)");
  expect(source).toContain("void addAttachments(dropped)");
  expect(source).toContain("<FullPageFileDropOverlay active={fileDragActive} />");
});

test("dismissing a nonempty composer parks it without an explicit draft action", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const closeStart = source.indexOf("onOpenChange={(next) =>");
  const closeEnd = source.indexOf("modal=\"trap-focus\"", closeStart);
  const closeHandler = source.slice(closeStart, closeEnd);

  expect(closeStart).toBeGreaterThan(-1);
  expect(closeHandler).toContain("if (next || busy) return;");
  expect(closeHandler).toContain("void parkDraftOnExit();");
  expect(closeHandler.indexOf("void parkDraftOnExit();")).toBeLessThan(
    closeHandler.indexOf("onBack();"),
  );
  const createStart = source.indexOf("function handleCreate()");
  const sendStart = source.indexOf("send({", createStart);
  const createHandler = source.slice(createStart, sendStart);
  expect(createHandler).toContain("consumePendingDraftParks(prompt, workspaceId);");
  expect(source).not.toContain('action: "draft"');
  expect(source).not.toContain("Save as draft");
});

test("a parked draft keeps the composer copy and carries its attachments", async () => {
  const source = await Bun.file(new URL("./NewSession.tsx", import.meta.url)).text();
  const parkStart = source.indexOf("async function parkDraftOnExit()");
  const parkEnd = source.indexOf("const createRef", parkStart);
  const park = source.slice(parkStart, parkEnd);

  expect(parkStart).toBeGreaterThan(-1);
  // Leaving copies the draft, it never empties the composer.
  expect(park).not.toContain('saveDraft(DRAFT_KEY, { text: "" })');
  // The workspace composer reads staged files from its own draft key.
  expect(park).toContain("saveDraft(workspaceDraftKey(workspace.id), {");
  expect(park).toContain("images: staged.images,");
  expect(park).toContain("files: staged.files,");
  // Closing twice updates the workspace the first close made.
  expect(park).toContain("parkedWorkspaceId");
  expect(source).toContain("let parkedWorkspaceId: string | null = null;");
});
