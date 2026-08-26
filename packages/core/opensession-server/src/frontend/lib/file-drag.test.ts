import { expect, test } from "bun:test";
import {
  foregroundFileComposerOpen,
  foregroundFileComposerOwns,
  hasDraggedFiles,
} from "./file-drag";

test("recognizes file drags before the files are available", () => {
  expect(hasDraggedFiles({ types: ["Files"] })).toBe(true);
  expect(hasDraggedFiles({ types: ["text/plain", "Files"] })).toBe(true);
});

test("ignores links, text, and internal app drags", () => {
  expect(hasDraggedFiles({ types: ["text/uri-list"] })).toBe(false);
  expect(hasDraggedFiles({ types: ["text/plain"] })).toBe(false);
  expect(hasDraggedFiles({ types: [] })).toBe(false);
  expect(hasDraggedFiles(null)).toBe(false);
});

test("only a visible foreground composer claims the app-wide drop", () => {
  const hidden = { getClientRects: () => ({ length: 0 }) };
  const visible = { getClientRects: () => ({ length: 1 }) };

  expect(foregroundFileComposerOpen([])).toBe(false);
  expect(foregroundFileComposerOpen([hidden])).toBe(false);
  expect(foregroundFileComposerOpen([hidden, visible])).toBe(true);
});

test("the last visible foreground composer owns the drop", () => {
  const background = { getClientRects: () => ({ length: 1 }) };
  const hidden = { getClientRects: () => ({ length: 0 }) };
  const foreground = { getClientRects: () => ({ length: 1 }) };
  const candidates = [background, hidden, foreground];

  expect(foregroundFileComposerOwns(background, candidates)).toBe(false);
  expect(foregroundFileComposerOwns(hidden, candidates)).toBe(false);
  expect(foregroundFileComposerOwns(foreground, candidates)).toBe(true);
  expect(foregroundFileComposerOwns(null, candidates)).toBe(false);
});
