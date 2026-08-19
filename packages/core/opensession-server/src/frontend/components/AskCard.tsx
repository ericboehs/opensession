import * as React from "react";
import { Questionnaire } from "@shadcn/react/questionnaire";
import { AGENT_NAME } from "../lib/brand";
import { renderMarkdown } from "../lib/markdown";
import type { AskQuestion } from "../lib/types";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { IconCheck, IconReturn } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";

interface Props {
	questions: AskQuestion[];
	onAnswer: (answers: Record<string, string>) => void;
}

/**
 * Item names are positional. The wire format keys answers by question TEXT,
 * but that text is prose — over a kilobyte in the wild, and two questions in
 * one ask can repeat it — so it can't be a native form field name. We name the
 * fields q0..qN and map back to the question on submit.
 */
const itemName = (index: number) => `q${index}`;

/**
 * A `hidden` navigation action still lays out, because Button's own
 * `inline-flex` outranks the UA's `[hidden]` rule and this app ships no
 * Preflight. A class plus an attribute outranks the class on its own.
 */
const HIDE_WHEN_INERT = "[&[hidden]]:hidden";

/** One option row: the whole row is the label for a hidden native radio. */
const CHOICE_ROW =
	"group relative flex min-h-11 w-full cursor-pointer select-none items-start gap-3 rounded-[calc(12px*var(--rf))] bg-control px-3 py-2.5 text-left transition-[background-color] hover:bg-hover [corner-shape:var(--cs)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent-ink)]";

/**
 * Interactive AskUserQuestion card — the agent is waiting on these answers.
 *
 * Behaviour comes from the headless `@shadcn/react` Questionnaire; the optics
 * are ours. That split is the point: the parts give us a real `fieldset` per
 * question, native radios and checkboxes, arrow-key movement between answers,
 * letter shortcuts, Cmd/Ctrl+Enter to send, and an error region that announces
 * — none of which the old hand-rolled `aria-pressed` buttons had. Every class
 * below is still this app's own, so nothing about the card's surface changed.
 *
 * Surfaces: one raised card on the transcript — no outline of its own, the
 * surface step is the edge — with the choices as control-surface rows on top
 * of it. Deliberately two surfaces, not the three nested greys it used to wear
 * (card → section → row), which read as boxes-in-boxes.
 *
 * Selection is NEUTRAL, not accent: the accent is red here, and filling a
 * chosen row with it read as an error/warning rather than a pick. Same reason
 * the composer keeps its resting border on focus (see .composer in legacy.css).
 * It also doesn't tint the row at all — the filled indicator carries it, with
 * the hairline stepping up. The indicator is a circle for single-select and a
 * rounded square for multi-select, so the shape says how many answers are
 * allowed.
 *
 * Two things the primitive can't know about this surface:
 *
 *  - We ship no Tailwind Preflight, so the `fieldset` it renders arrives with
 *    the UA's border, margin and padding — zeroed on the item below, the same
 *    way the free-text field has to zero its own inset border.
 *  - It hides an inactive item with the `hidden` attribute, and a `flex` class
 *    beats the UA's `[hidden]` rule. `[&[hidden]]:hidden` is a class plus an
 *    attribute, so it wins back.
 *
 * A lone single-select question still answers on the first click — that is the
 * hot path (96% of recorded asks are one question) and it stays one
 * interaction, not select-then-send.
 */
export function AskCard({ questions, onAnswer }: Props) {
	const repo = useMarkdownRepo();
	const titleBase = React.useId();
	const [picks, setPicks] = React.useState<Record<string, string[]>>({});
	const [custom, setCustom] = React.useState<Record<string, string>>({});
	const [submitted, setSubmitted] = React.useState(false);
	// Only a pointer answers on the spot. Arrow keys and letter shortcuts pick
	// by calling click() on the radio, which is indistinguishable from a real
	// click by the time the change lands — so a keyboard user browsing the
	// options with ArrowDown would send the first one they touched. A pointer
	// press always precedes its change; a synthesised click never does.
	const pointerPick = React.useRef(false);

	// Mirrors what we render below. Handing the collection to the root is what
	// gets item order and answer shortcuts into the first paint, rather than
	// waiting for each part to register itself.
	const items = React.useMemo(
		() =>
			questions.map((q, i) => ({
				name: itemName(i),
				required: true,
				choices: (q.options ?? []).map((o) => ({ value: o.label })),
			})),
		[questions],
	);

	// A card asking one thing: its header belongs on the status row (below).
	const lone = questions.length === 1 ? questions[0] : undefined;
	const titleId = (i: number) => `${titleBase}-q${i}`;

	function answerFor(index: number): string {
		const name = itemName(index);
		const parts = [...(picks[name] ?? [])];
		const typed = (custom[name] ?? "").trim();
		if (typed) parts.push(typed);
		return parts.join(", ");
	}

	function choose(index: number, q: AskQuestion, label: string, checked: boolean) {
		if (submitted) return;
		const name = itemName(index);
		const byPointer = pointerPick.current;
		pointerPick.current = false;

		if (q.multiSelect) {
			setPicks((prev) => {
				const current = prev[name] ?? [];
				return {
					...prev,
					[name]: checked
						? [...current, label]
						: current.filter((l) => l !== label),
				};
			});
			return;
		}

		// One single-select question is the common ask: clicking IS answering.
		if (lone && byPointer) {
			setPicks({ [name]: [label] });
			setSubmitted(true);
			onAnswer({ [q.question]: label });
			return;
		}

		// Otherwise a pick replaces the pick and clears anything typed: the
		// field says "Or type your own answer…", and the primitive treats the
		// two as one answer slot.
		setPicks((prev) => ({ ...prev, [name]: [label] }));
		setCustom((prev) => ({ ...prev, [name]: "" }));
	}

	function write(index: number, q: AskQuestion, value: string) {
		if (submitted) return;
		const name = itemName(index);
		setCustom((prev) => ({ ...prev, [name]: value }));
		if (!q.multiSelect && value.trim()) {
			setPicks((prev) => ({ ...prev, [name]: [] }));
		}
	}

	// Only reached once every item validates — the root holds the submit back
	// and focuses the first unanswered question otherwise.
	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitted) return;
		setSubmitted(true);
		const answers: Record<string, string> = {};
		questions.forEach((q, i) => {
			answers[q.question] = answerFor(i);
		});
		onAnswer(answers);
	}

	return (
		<Questionnaire.Root
			items={items}
			shortcuts="letters"
			onSubmit={handleSubmit}
			className="mx-auto mb-6 mt-2 flex w-full max-w-[var(--session-col)] flex-col gap-5 rounded-xl bg-raised p-4 [corner-shape:var(--cs)]"
		>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
				<span
					aria-hidden="true"
					className="h-1.5 w-1.5 shrink-0 rounded-full bg-green shadow-[0_0_0_3px_var(--green-soft)]"
				/>
				<span className="text-label font-semibold text-dim">
					{AGENT_NAME} needs input
				</span>
				{/* One question's header rides this row instead of claiming a line of
				    its own: it is a two-word topic tag, so stacked under the status it
				    made a three-deep ladder of labels before the question itself. Slack
				    joins them the same way (`*header* — question`, see asks.ts). With
				    several questions each section keeps its own header, since there it
				    says which of them you are looking at. */}
				{lone?.header && (
					<>
						<span aria-hidden="true" className="text-label text-faint">
							·
						</span>
						<span className="text-label font-semibold text-faint">{lone.header}</span>
					</>
				)}
				{/* Several questions step one at a time, so the row says where you are. */}
				{questions.length > 1 && (
					<>
						<span aria-hidden="true" className="text-label text-faint">
							·
						</span>
						<Questionnaire.Progress className="text-label font-semibold text-faint" />
					</>
				)}
			</div>

			{questions.map((q, i) => (
				<Questionnaire.Item
					key={itemName(i)}
					name={itemName(i)}
					required
					multiple={q.multiSelect}
					aria-labelledby={titleId(i)}
					// Zero the UA fieldset (no Preflight), and win back `hidden`
					// against the `flex` on the same element.
					className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 [&[hidden]]:hidden"
				>
					{((q.header && !lone) || q.multiSelect) && (
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							{q.header && !lone && (
								<span className="text-label font-semibold text-faint">{q.header}</span>
							)}
							{q.multiSelect && (
								<Questionnaire.Description
									className="text-meta text-faint"
									render={<span />}
								>
									Select all that apply
								</Questionnaire.Description>
							)}
						</div>
					)}
					{/* The question is prose, not a title: it is often several sentences,
					    and setting it semibold turned whole paragraphs bold. Body weight
					    on the transcript's own 14px/24px rhythm — the raised card and the
					    "needs input" label already mark it as the thing being asked.
					    It replaces the fieldset's `legend` (markdown is block content,
					    which a legend may not hold), so it names the item by id. */}
					<Questionnaire.Title
						id={titleId(i)}
						render={
							<div
								className="markdown text-body leading-6 text-fg [overflow-wrap:anywhere]"
								dangerouslySetInnerHTML={{
									__html: renderMarkdown(q.question, { repo }),
								}}
							/>
						}
					/>
					<Questionnaire.Choices className="flex flex-col gap-1.5">
						{q.options?.map((opt) => {
							const active = (picks[itemName(i)] ?? []).includes(opt.label);
							return (
								<Questionnaire.Choice
									key={opt.label}
									value={opt.label}
									checked={active}
									onPointerDown={() => {
										pointerPick.current = true;
									}}
									onChange={(e) => choose(i, q, opt.label, e.target.checked)}
									// No hairline: the row's own surface against the card is the
									// edge. And a pick doesn't tint the row — the filled
									// indicator says it. Washing the row grey made the chosen
									// option look dimmed, not chosen, and collided with the
									// hover wash on its neighbours.
									className={CHOICE_ROW}
								>
									<Questionnaire.ChoiceInput className="sr-only" />
									<Questionnaire.ChoiceLabel className="min-w-0 flex-1">
										<span className="block text-control-label font-semibold leading-5 text-fg">
											{opt.label}
										</span>
										{opt.description && (
											<span className="mt-0.5 block text-supporting leading-[1.45] text-dim">
												{opt.description}
											</span>
										)}
									</Questionnaire.ChoiceLabel>
									{/* Same quiet key hint a menu row wears (MenuShortcut). */}
									<Questionnaire.ChoiceShortcut className="mt-px shrink-0 text-label leading-5 text-faint" />
									<span
										aria-hidden="true"
										className={cn(
											"mt-px flex h-5 w-5 shrink-0 items-center justify-center border transition-[background-color,border-color,color]",
											q.multiSelect
												? "rounded-[calc(6px*var(--rf))] [corner-shape:var(--cs)]"
												: "rounded-full",
											active
												? "border-transparent bg-fg text-bg"
												: "border-line-strong text-transparent",
										)}
									>
										<IconCheck size={20} />
									</span>
								</Questionnaire.Choice>
							);
						})}
						<Questionnaire.Input
							aria-label={q.options?.length ? "Custom answer" : "Answer"}
							/* border-0 is load-bearing, not tidying: this app deliberately
							   doesn't ship Tailwind's Preflight (see styles/tailwind.css), so
							   an <input> with no border utility keeps the UA's 2px inset
							   border — the dark outline this field used to wear. Any borderless
							   input here has to zero it explicitly.

							   No ring on focus either — same call the composer makes: it read
							   as an error state on a field you're simply typing in, and the
							   caret is affordance enough. */
							className={cn(
								"h-11 w-full rounded-[calc(12px*var(--rf))] border-0 bg-control px-3 text-base text-fg outline-none placeholder:text-faint disabled:opacity-60 sm:text-control-label [corner-shape:var(--cs)]",
								q.options?.length && "mt-1.5",
							)}
							placeholder={
								q.options?.length ? "Or type your own answer…" : "Type your answer…"
							}
							value={custom[itemName(i)] ?? ""}
							onChange={(e) => write(i, q, e.target.value)}
						/>
					</Questionnaire.Choices>
					<Questionnaire.Error className="text-meta text-red" />
				</Questionnaire.Item>
			))}

			{/* An action the active question has no use for arrives carrying
			    `hidden`, and Button's own `inline-flex` outranks the UA's
			    `[hidden]` rule — so each one has to win it back the same way the
			    item does. Without this, every single-question ask (almost all of
			    them) wears a dead Previous and Next. */}
			<div className="flex items-center justify-end gap-2">
				<Questionnaire.Previous
					render={<Button variant="ghost" size="lg" className={HIDE_WHEN_INERT} />}
				>
					Previous
				</Questionnaire.Previous>
				<Questionnaire.Next
					render={
						<Button
							variant="default"
							size="lg"
							icon={<IconReturn size={20} />}
							className={HIDE_WHEN_INERT}
						/>
					}
				>
					Next
				</Questionnaire.Next>
				{/* The glyph reports the state the label also names: an answer on its
				    way out before you press, a tick once it has gone. */}
				<Questionnaire.Submit
					disabled={submitted}
					render={
						<Button
							variant="primary"
							size="lg"
							icon={submitted ? <IconCheck size={20} /> : <IconReturn size={20} />}
						/>
					}
				>
					{submitted ? "Sent" : "Answer"}
				</Questionnaire.Submit>
			</div>
		</Questionnaire.Root>
	);
}
