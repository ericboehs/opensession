import * as React from "react";
import { Card } from "./card";
import { cn, mergeStylexProps } from "./cn";
import { fieldClasses } from "./input";
import { markTileClass } from "../lib/mark-tile";
import { Skeleton, SkeletonBar } from "./state";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	minW0: {
			minWidth: "0"
	},
	m0: {
			margin: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	tracking002em: {
			letterSpacing: "-.02em"
	},
	textFg: {
			color: "var(--text)"
	},
	mt15: {
			marginTop: "6px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	flex: {
			display: "flex"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	gap15: {
			gap: "6px"
	},
	flexShrink0: {
			flexShrink: "0"
	},
	h15: {
			height: "6px"
	},
	w15: {
			width: "6px"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	wFull: {
			width: "100%"
	},
	maxW720px: {
			maxWidth: "720px"
	},
	mb5: {
			marginBottom: "20px"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "16px"
	},
	px5: {
			paddingInline: "20px"
	},
	mb2: {
			marginBottom: "8px"
	},
	mt9: {
			marginTop: "36px"
	},
	minH6: {
			minHeight: "24px"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	gapX2: {
			columnGap: "8px"
	},
	gapY15: {
			rowGap: "6px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	flexCol: {
			flexDirection: "column"
	},
	gap3: {
			gap: "12px"
	},
	mt2: {
			marginTop: "8px"
	},
	h25: {
			height: "10px"
	},
	p5: {
			padding: "20px"
	},
	gapX4: {
			columnGap: "16px"
	},
	gapY25: {
			rowGap: "10px"
	},
	py4: {
			paddingBlock: "16px"
	},
	flex1: {
			flex: "1"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	mt1: {
			marginTop: "4px"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	mb3: {
			marginBottom: "12px"
	},
	gap35: {
			gap: "14px"
	},
	mb4: {
			marginBottom: "16px"
	},
	grid: {
			display: "grid"
	},
	gridCols2: {
			gridTemplateColumns: "repeat(2,minmax(0,1fr))"
	},
	justifyEnd: {
			justifyContent: "flex-end"
	},
});

export function SettingsPanel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.wFull, sx.maxW720px)} {...props} />;
}

/**
 * A settings page's header: its title, an optional sentence of context, and
 * optional actions on the right. Every panel opens with one, so pages share a
 * top rhythm no matter who wrote them. The h1 hides inside the phone sheet,
 * which already names the section in its own nav bar.
 */
export function SettingsHeader({
	title,
	description,
	actions,
	className,
	...props
}: Omit<React.ComponentPropsWithoutRef<"header">, "title"> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<header {...mergeStylexProps(cn(className), sx.mb5, sx.flex, sx.itemsStart, sx.justifyBetween, sx.gap4, sx.px5)}
			{...props}
		>
			<div {...stylex.props(sx.minW0)}>
				<h1 {...mergeStylexProps("[.settings-sheet_&]:hidden", sx.m0, sx.fontTitle, sx.tracking002em, sx.textFg, typography.pageTitle)}>
					{title}
				</h1>
				{description && (
					<p {...mergeStylexProps("[.settings-sheet_&]:mt-0", sx.m0, sx.mt15, sx.leadingRelaxed, sx.textDim, typography.supporting)}>
						{description}
					</p>
				)}
			</div>
			{actions && <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap2)}>{actions}</div>}
		</header>
	);
}

/**
 * The label above a group of settings, with optional actions on its right —
 * the group's own "add"/"refresh" buttons. Pages kept re-deriving that row
 * (a flex override here, a local `SectionHeader` there), which is how the
 * groups drifted apart; the slot keeps one shape.
 */
export function SettingsGroupLabel({
	actions,
	className,
	children,
	...props
}: React.ComponentPropsWithoutRef<"div"> & { actions?: React.ReactNode }) {
	return (
		<div {...mergeStylexProps(cn(className), sx.mb2, sx.mt9, sx.flex, sx.minH6, sx.flexWrap, sx.itemsCenter, sx.justifyBetween, sx.gapX2, sx.gapY15, sx.px5, typography.label, sx.fontSemibold, sx.textFaint)}
			{...props}
		>
			<span {...stylex.props(sx.minW0)}>{children}</span>
			{actions && <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap15)}>{actions}</div>}
		</div>
	);
}

/** The surface every settings group sits on: a soft fill and quiet outline.
 * Together they separate a group from the page, so a page of settings reads as
 * a few blocks rather than a stack of outlined boxes.
 *
 * Card supplies the borderless base, so this adds the corner, fill and outline.
 * A settings group is a CONTAINER of rows rather than a single card, and
 * the scale gives a container the largest step: `rounded-2xl` (22px × --rf), the
 * same corner the phone sheet's section list already carries.
 *
 * The fill is `settings-plate`, not `raised`: a page of these is a column of
 * blocks, and at the full L1 grey the column reads as the page's material
 * rather than as a few quiet groups on paper. See base.css.
 *
 * That fill is deliberately below where a fill alone holds a shape, which is
 * why this surface carries a hairline where the house rule says a card should
 * not (see src/frontend/AGENTS.md). The edge REPLACES the weight the fill gave
 * up rather than adding to it: the two together are quieter than the L1 grey
 * was on its own. Do not restore the heavier fill and keep the edge, and do
 * not add the edge back to `Card`, which is borderless for the reason the rule
 * gives.
 *
 * It takes `divider-soft` rather than the `line` the rules inside take. Those
 * are two different jobs at the same scale: a rule between groups has content
 * on both sides and has to be read as a separation, while this one only has to
 * close the block's shape, and the fill under it is already saying where the
 * block is. At the row weight the outline was the loudest thing on the page.
 * `divider-soft` is `line` at a third, so it lands well under the rules it
 * contains and the block reads as one object rather than a frame. */
const settingsSurface =
	"rounded-2xl border border-divider-soft bg-settings-plate";

/**
 * The rule between two groups of rows: inset from the card's edges, so it
 * separates the rows without cutting the block in half. An edge-to-edge rule
 * makes every seam as strong as the card's own outline, and a card of eight of
 * them reads as a table rather than a list of settings.
 *
 * It is drawn as a pseudo-element rather than a `border-t`, because a border
 * cannot be inset: it would need padding on the row, which would move the
 * text. `inset-x-5` matches `SettingRow`'s own `px-5`, so the rule starts where
 * a title starts and ends where a control ends.
 */
const settingGroupRule =
	"[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-5 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']";

/**
 * A settings group's card. Its DIRECT children are separated by an inset rule,
 * so what a rule means is "a different setting begins here." Put rows that
 * answer one question inside a single `SettingGroup` and they sit together
 * with no seam between them.
 *
 * A card whose children are all bare rows still divides every row, which is
 * right for a list of like things (repos, accounts, tools) and wrong for a
 * page of preferences, where consecutive rows are often facets of the same
 * choice.
 */
export function SettingCard({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<Card {...mergeStylexProps(cn(settingsSurface, settingGroupRule, className), sx.overflowHidden)}
			{...props}
		/>
	);
}

/**
 * Rows that answer one question, carried as a single child of `SettingCard`:
 * no rule between them, one rule above the group. "Group by" and "Group by
 * project" are one setting asked twice, not two settings.
 */
export function SettingGroup({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.flex, sx.flexCol)} {...props} />;
}

/**
 * The rows of a settings group that hasn't arrived, standing in for the rows
 * it will become.
 *
 * A settings page is a column of groups, and a group that answers with a
 * centred spinner takes its whole block out of the page until it resolves —
 * so a page with three of them is three holes that fill in at different
 * moments, each one shoving what is under it. Ghost rows keep the block's
 * shape, so the page arrives once.
 *
 * Built out of the real `SettingCard` and `SettingRow` rather than beside
 * them: the seams come from SettingCard's own divider rule and the padding from
 * the row itself, so a change to either is inherited here instead of being
 * something to remember. That is what the hand-tuned `rowClassName` on the
 * one call site that nested `ListSkeleton` inside a card was already drifting
 * away from.
 *
 * No ghost control on the right. Every real row has one, but they are all the
 * same right-aligned pill, and a column of identical grey pills reads as
 * broken buttons where ragged text bars read as titles about to arrive — the
 * argument `SKELETON_WIDTHS` makes in ui/state. Controls are `ml-auto`, so
 * nothing on the left moves when they land.
 *
 * A leading tile is the opposite case and `icon` draws one: it sets where the
 * text starts, so leaving it out on a list that has one means every bar slides
 * right as the rows arrive — the one thing a placeholder exists to prevent.
 * Pass the size the real `IconTile` takes; the corner comes from the tile's own
 * rule, so the two can't drift.
 */
export function SettingCardSkeleton({
	rows = 3,
	icon,
	label = "Loading",
	className,
	...props
}: React.ComponentPropsWithoutRef<"div"> & {
	rows?: number;
	/** Tile size in px, matching the `IconTile` these rows carry. */
	icon?: number;
	label?: string;
}) {
	return (
		<Skeleton label={label} className={className} {...props}>
			<SettingCard>
				{GHOST_ROWS.slice(0, rows).map((row) => (
					<SettingRow key={row.title} {...stylex.props(icon !== undefined && sx.gap3)}>
						{icon !== undefined && (
							// Inline size, like IconTile's own: the tile scale is a
							// number a caller passes, not a step in the class scale.
							<SkeletonBar
								className={markTileClass(icon)}
								style={{ width: icon, height: icon }}
							/>
						)}
						<SettingRowText>
							<SkeletonBar className={row.title} />
							<SkeletonBar {...mergeStylexProps(cn(row.description), sx.mt2, sx.h25)} />
						</SettingRowText>
					</SettingRow>
				))}
			</SettingCard>
		</Skeleton>
	);
}

/**
 * A short name over a long sentence, which is the proportion a real settings
 * row has — the title is a repo or a tool, the description is a line of prose
 * about it. Ragged for the reason ui/state gives, and paired rather than drawn
 * from one pool so a title never comes out longer than the sentence under it.
 * Literal utilities: Tailwind only compiles class names it can find.
 */
const GHOST_ROWS = [
	{ title: "w-[34%]", description: "w-[78%]" },
	{ title: "w-[22%]", description: "w-[54%]" },
	{ title: "w-[41%]", description: "w-[67%]" },
	{ title: "w-[27%]", description: "w-[85%]" },
	{ title: "w-[36%]", description: "w-[61%]" },
	{ title: "w-[24%]", description: "w-[73%]" },
];

/** A section for content that isn't a list of rows — an editor, a picker, a
 * filter bar. Same surface SettingCard gives rows, so a page of prose sits in
 * the page's rhythm instead of floating on it. */
export function SettingsSection({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <Card {...mergeStylexProps(cn(settingsSurface, className), sx.p5)} {...props} />;
}

/**
 * One setting: its label and description on the left, its control on the
 * right. On a narrow screen the control drops to its own line instead of
 * squeezing the label into a two-word column — `flex-wrap` plus the text's
 * min width is what decides that, and the control's `ml-auto` keeps it
 * right-aligned once it lands there.
 *
 * Rows are centered, which is right while the text is a title and one line of
 * description. A row that grows past that (an account with usage bars) should
 * pass `items-start`: an avatar and a control floating in the middle of a tall
 * row read as unanchored, and top-aligning ties them to the title they belong
 * to.
 */
export function SettingRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div {...mergeStylexProps(cn(className), sx.flex, sx.flexWrap, sx.itemsCenter, sx.gapX4, sx.gapY25, sx.px5, sx.py4)}
			{...props}
		/>
	);
}

export function SettingRowText({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn("max-sm:min-w-[55%]", className), sx.minW0, sx.flex1)} {...props} />;
}

export function SettingRowTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), typography.itemTitle, sx.fontMedium, sx.textFg)} {...props} />;
}

export function SettingRowDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-setting-description="" {...mergeStylexProps(cn(className), sx.mt1, typography.supporting, sx.textDim)}
			{...props}
		/>
	);
}

export function SettingRowControl({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.mlAuto, sx.shrink0)} {...props} />;
}

/**
 * A row's state, read before its actions: a dot and a word. Connected rows
 * carry one and unconnected rows carry a Connect button, which is what keeps
 * the two apart at a glance. A row whose only difference is the verb on a
 * neutral button ("Connect" vs "Disconnect") reads as the same row twice.
 */
export function StatusChip({ label, dot }: { label: string; dot: string }) {
	return (
		<span {...stylex.props(sx.flex, sx.flexShrink0, sx.itemsCenter, sx.gap15, sx.textDim, typography.label)}>
			<span {...stylex.props(sx.h15, sx.w15, sx.roundedFull)} style={{ background: dot }} />
			{label}
		</span>
	);
}

/** The ⋯ trigger for a row's overflow menu: quiet until hovered or open.
 *  Shared so a row's actions look the same on every settings page.
 *
 *  `before:-inset-2` grows the 28px box to a 44px target without moving
 *  anything, which a row whose only path to an action is this menu needs on a
 *  phone. It is the last thing in the row, so the grown area overlaps only the
 *  status text beside it. */
export const rowMenuTriggerClasses =
	"relative flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-[color,background] before:absolute before:-inset-2 before:content-[''] hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg";

export function SettingsHint({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			data-settings-hint="" {...mergeStylexProps(cn(className), sx.mt2, sx.px5, typography.supporting, sx.textFaint)}
			{...props}
		/>
	);
}

/**
 * Settings fields are the app's fields — `ui/input`'s recipe, not a local one.
 * These aliases stay because ~20 call sites pass a class rather than render a
 * component (native selects with their own appearance resets, mostly); the
 * shape behind them is now shared with every other field and, through it, with
 * every button.
 *
 * They go through `fieldClasses("md")` rather than composing `fieldClass` with
 * their own padding, which is what had settings rendering 35px fields beside
 * the primitive's 32px ones — two field heights visible on one page, e.g.
 * /settings/connections. Reaching for the size step instead of re-spelling it
 * is the whole point of having one.
 */
export const settingsSelectClass = fieldClasses("md", "cursor-pointer");

export function SettingsForm({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div {...mergeStylexProps(cn(settingsSurface, className), sx.mb3, sx.flex, sx.flexCol, sx.gap35, sx.p5)}
			{...props}
		/>
	);
}

export function SettingsFormTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.mb4, typography.itemTitle, sx.fontSemibold, sx.textFg)} {...props} />;
}

export function SettingsFormRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn("max-sm:grid-cols-1", className), sx.grid, sx.gridCols2, sx.gap3)} {...props} />;
}

export function SettingsField({
	className,
	...props
}: React.ComponentPropsWithoutRef<"label">) {
	return (
		<label {...mergeStylexProps(cn(className), sx.mb3, sx.flex, sx.minW0, sx.flexCol, sx.gap15, typography.label, sx.fontMedium, sx.textDim)}
			{...props}
		/>
	);
}

export const settingsInputClass = fieldClasses("md");

/** Multi-line text entry inside settings — memory entries, the personal
 *  prompt. One class so every editor in settings reads the same. */
export const settingsTextareaClass = fieldClasses("md", "resize-y py-2");

export function SettingsFormActions({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div {...mergeStylexProps(cn(className), sx.mt1, sx.flex, sx.justifyEnd, sx.gap2)} {...props} />;
}
