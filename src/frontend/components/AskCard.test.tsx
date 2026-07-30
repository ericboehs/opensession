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
  expect(html).toContain('aria-label="Answer"');
  expect(html).not.toContain('role="group"');
});

test("renders question markdown and selectable options accessibly", () => {
  const html = renderToStaticMarkup(
    <AskCard
      questions={[
        {
          header: "Human ask",
          question: "Should **this change** ship?",
          options: [
            { label: "Ship it", description: "Push the commit now." },
            { label: "Hold it" },
          ],
        },
      ]}
      onAnswer={() => {}}
    />,
  );

  expect(html).toContain("<strong>this change</strong>");
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-pressed="false"');
  expect(html).toContain('aria-label="Custom answer"');
});
