import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MergeUndoControl } from "./MergeUndoControl";

test("keeps the merge result and Undo in one inline control", () => {
  const html = renderToStaticMarkup(<MergeUndoControl onUndo={() => undefined} />);
  expect(html).toContain("PR merged");
  expect(html).toContain(">Undo</span></button>");
  expect(html).toContain("phone:hidden");
  expect(html.match(/<button/g)).toHaveLength(1);
});
