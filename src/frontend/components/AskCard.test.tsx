import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AskCard } from "./AskCard";

test("renders a free-text question without options", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[{ question: "What should happen next?" }]}
      onAnswer={() => {}}
    />,
  );

  expect(html).toContain("What should happen next?");
  expect(html).toContain('placeholder="Type your answer…"');
  expect(html).not.toContain("ask-card-options");
});
