import type { AnsweredAskData } from "@tellahq/opensession-protocol/notices";
import {
	ANSWER_OPTION_LETTERS,
	answeredAskState,
} from "../lib/answered-ask";
import { renderMarkdown } from "../lib/markdown";
import { msgRow } from "../lib/msg-classes";
import { cn } from "../ui/cn";
import { IconCheck } from "./icons";
import { useMarkdownRepo } from "./MarkdownBody";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	w35: {
			width: "14px"
	},
	shrink0: {
			flexShrink: "0"
	},
	ptPx: {
			paddingTop: "1px"
	},
	leading5: {
			lineHeight: "20px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	selfEnd: {
			alignSelf: "flex-end"
	},
	rounded2xl: {
			borderRadius: "calc(22px * var(--rf))"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	p4: {
			padding: "16px"
	},
	CornerShapeVarCs: {
			cornerShape: "var(--cs)"
	},
	flex: {
			display: "flex"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gapX15: {
			columnGap: "6px"
	},
	gapY05: {
			rowGap: "2px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	h4: {
			height: "16px"
	},
	w4: {
			width: "16px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	bgGreenSoft: {
			backgroundColor: "var(--green-soft)"
	},
	textGreen: {
			color: "var(--green)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mt3: {
			marginTop: "12px"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap4: {
			gap: "16px"
	},
	mb1: {
			marginBottom: "4px"
	},
	OverflowWrapAnywhere: {
			overflowWrap: "anywhere"
	},
	TextWrapPretty: {
			textWrap: "pretty"
	},
	mt2: {
			marginTop: "8px"
	},
	gap05: {
			gap: "2px"
	},
});

function ChoiceRow({
	letter,
	label,
	description,
	selected,
}: {
	letter: string;
	label: string;
	description?: string;
	selected: boolean;
}) {
	return (
		<div
			role="listitem"
			aria-label={`${label}${selected ? ", selected" : ""}`}
			data-selected={selected ? "" : undefined}
			className={cn(
				"flex min-h-9 items-start gap-2.5 rounded-md px-2.5 py-2 [corner-shape:var(--cs)]",
				selected ? "bg-control" : "text-dim",
			)}
		>
			<span {...stylex.props(sx.w35, sx.shrink0, sx.ptPx, sx.leading5, sx.textFaint, typography.meta)}>
				{letter}
			</span>
			<span {...stylex.props(sx.minW0, sx.flex1)}>
				<span
					className={cn(
						"block text-control-label leading-5 [overflow-wrap:anywhere]",
						selected ? "font-semibold text-fg" : "font-medium",
					)}
				>
					{label}
				</span>
				{description && (
					<span
						className={cn(
							"mt-0.5 block text-supporting leading-[1.45] [overflow-wrap:anywhere]",
							selected ? "text-dim" : "text-faint",
						)}
					>
						{description}
					</span>
				)}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
					selected ? "bg-green-soft text-green" : "text-transparent",
				)}
			>
				<IconCheck size={16} />
			</span>
		</div>
	);
}

/** A durable receipt for an answer sent through AskCard. It sits on the
 * sender side of the transcript, while its quiet surface and status label
 * distinguish it from an ordinary message. Every offered option stays for
 * context, with the exact choice marked as selected. */
export function AnsweredAskCard({
	record,
	entryId,
}: {
	record: AnsweredAskData;
	entryId: string;
}) {
	const repo = useMarkdownRepo();
	const count = record.questions.length;
	const lone = count === 1 ? record.questions[0] : undefined;

	return (
		<div className={msgRow} data-eid={entryId} data-answered-ask="">
			<div className="max-w-[min(600px,90%)]" {...stylex.props(sx.selfEnd, sx.rounded2xl, sx.bgPanel, sx.p4, sx.CornerShapeVarCs)}>
				<div {...stylex.props(sx.flex, sx.flexWrap, sx.itemsCenter, sx.gapX15, sx.gapY05, sx.fontSemibold, typography.label)}>
					<span
						aria-hidden="true"
						{...stylex.props(sx.flex, sx.h4, sx.w4, sx.itemsCenter, sx.justifyCenter, sx.roundedFull, sx.bgGreenSoft, sx.textGreen)}
					>
						<IconCheck size={14} />
					</span>
					<span {...stylex.props(sx.textDim)}>
						{count === 1 ? "Answer sent" : `${count} answers sent`}
					</span>
					{lone?.header && (
						<>
							<span aria-hidden="true" {...stylex.props(sx.textFaint)}>
								·
							</span>
							<span {...stylex.props(sx.textFaint)}>{lone.header}</span>
						</>
					)}
				</div>

				<div {...stylex.props(sx.mt3, sx.flex, sx.flexCol, sx.gap4)}>
					{record.questions.map((question, index) => {
						const { selected, typed } = answeredAskState(question);
						const options = question.options ?? [];
						return (
							<section key={`${question.question}:${index}`}>
								{question.header && !lone && (
									<div {...stylex.props(sx.mb1, sx.fontSemibold, sx.textFaint, typography.meta)}>
										{question.header}
									</div>
								)}
								<div
									className="markdown" {...stylex.props(sx.leading5, sx.textDim, sx.OverflowWrapAnywhere, sx.TextWrapPretty, typography.controlLabel)}
									dangerouslySetInnerHTML={{
										__html: renderMarkdown(question.question, { repo }),
									}}
								/>
								<div
									{...stylex.props(sx.mt2, sx.flex, sx.flexCol, sx.gap05)}
									role="list"
									aria-label="Answer choices"
								>
									{options.map((option, optionIndex) => (
										<ChoiceRow
											key={`${option.label}:${optionIndex}`}
											letter={ANSWER_OPTION_LETTERS[optionIndex] ?? "–"}
											label={option.label}
											description={option.description}
											selected={selected.has(option.label)}
										/>
									))}
									{typed.map((answer, typedIndex) => (
										<ChoiceRow
											key={`${answer}:${typedIndex}`}
											letter="–"
											label={answer}
											description={options.length ? "Custom answer" : undefined}
											selected
										/>
									))}
									{!question.answer.trim() && (
										<ChoiceRow letter="–" label="No answer" selected />
									)}
								</div>
							</section>
						);
					})}
				</div>
			</div>
		</div>
	);
}
