import { expect, test } from "bun:test";

test("a consumed draft clears persistence before clearing React state", async () => {
  const source = await Bun.file(new URL("./Composer.tsx", import.meta.url)).text();
  const consumeStart = source.indexOf("const consume = () => {");
  const consumeEnd = source.indexOf("const consumed = handler", consumeStart);
  const consume = source.slice(consumeStart, consumeEnd);

  expect(consumeStart).toBeGreaterThan(-1);
  expect(consume.indexOf("clearDraft(draftKey)")).toBeGreaterThan(-1);
  expect(consume.indexOf("clearDraft(draftKey)")).toBeLessThan(
    consume.indexOf('setInnerValue("")'),
  );
});
