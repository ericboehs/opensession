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
	expect(html).not.toContain('type="radio"');
});

test("options are native radios inside the question's fieldset", () => {
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
	expect(html).toContain("<fieldset");
	expect(html).toContain('type="radio"');
	expect(html).toContain('value="Ship it"');
	expect(html).toContain('value="Hold it"');
	expect(html).toContain('aria-label="Custom answer"');
	// The old hand-rolled toggle semantics are gone.
	expect(html).not.toContain('aria-pressed');
	expect(html).not.toContain('role="group"');
});

test("the question names its fieldset, since markdown can't live in a legend", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[{ question: "Ship it?", options: [{ label: "Yes" }] }]}
			onAnswer={() => {}}
		/>,
	);

	const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1];
	expect(labelledBy).toBeTruthy();
	// The id it points at is the rendered question, not a <legend>.
	expect(html).toContain(`id="${labelledBy}"`);
	expect(html).not.toContain("<legend");
});

test("each option carries a letter shortcut", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[
				{ question: "Pick", options: [{ label: "One" }, { label: "Two" }] },
			]}
			onAnswer={() => {}}
		/>,
	);

	expect(html).toContain('aria-keyshortcuts="A"');
	expect(html).toContain('aria-keyshortcuts="B"');
});

test("a lone question's header rides the status row instead of stacking", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[{ header: "repo tile", question: "Branch or PR state?" }]}
			onAnswer={() => {}}
		/>,
	);

	// Rendered once, and on the same row as the status label rather than under it.
	expect(html.split("repo tile").length - 1).toBe(1);
	expect(html).toMatch(/needs input<\/span>.*repo tile/s);
	// One question is not a flow: no progress, and nothing to step to.
	expect(html).not.toContain('role="progressbar"');
});

test("several questions step one at a time, with progress on the status row", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[
				{ header: "repo tile", question: "Branch or PR state?" },
				{ header: "sort order", question: "Newest first?" },
			]}
			onAnswer={() => {}}
		/>,
	);

	// Each section keeps its own header, and neither is pulled into the status
	// row (which now carries the position instead).
	expect(html).toContain("repo tile");
	expect(html).toContain("sort order");
	expect(html).toMatch(/needs input<\/span>(?!.*repo tile.*aria-valuetext)/s);
	expect(html).toContain('aria-valuetext="Question 1 of 2"');

	// Only the first question is live; the second is hidden and inert.
	const fieldsets = html.match(/<fieldset[^>]*>/g) ?? [];
	expect(fieldsets).toHaveLength(2);
	expect(fieldsets[0]).toContain("data-active");
	expect(fieldsets[1]).toContain("hidden");
	expect(fieldsets[1]).toContain("inert");
});

test("a lone question shows only the send action, never Previous/Next", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[{ question: "Ship it?", options: [{ label: "Yes" }] }]}
			onAnswer={() => {}}
		/>,
	);

	const buttons = html.match(/<button[^>]*>/g) ?? [];
	const visible = buttons.filter((b) => !b.includes("hidden"));
	expect(visible).toHaveLength(1);
	expect(visible[0]).toContain('type="submit"');

	// The `hidden` attribute alone does not hide them: Button paints
	// `inline-flex`, which outranks the UA rule, and we ship no Preflight. Each
	// hidden action has to carry the class that wins it back.
	for (const button of buttons.filter((b) => b.includes("hidden"))) {
		expect(button).toContain("[hidden]]:hidden");
	}
});

test("multi-select and free-text answers retain the explicit Answer action", () => {
	const html = renderToStaticMarkup(
		<AskCard
			questions={[
				{ question: "Pick all", multiSelect: true, options: [{ label: "One" }] },
			]}
			onAnswer={() => {}}
		/>,
	);

	// Button wraps a string label in its own span (cap-band trim), so the
	// label is the button's last element rather than its text node.
	expect(html).toContain(">Answer</span></button>");
	expect(html).toContain("Select all that apply");
	// Several answers allowed means checkboxes, not radios.
	expect(html).toContain('type="checkbox"');
	expect(html).not.toContain('type="radio"');
});
