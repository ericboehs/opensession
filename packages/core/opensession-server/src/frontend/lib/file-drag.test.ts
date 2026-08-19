import { expect, test } from "bun:test";
import { hasDraggedFiles } from "./file-drag";

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
