import * as React from "react";
import type { SessionUsage } from "../lib/types";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	Rotate90: {
			rotate: "-90deg"
	},
	strokeLine: {
			stroke: "var(--border)"
	},
	flex: {
			display: "flex"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap6: {
			gap: "24px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mb2: {
			marginBottom: "8px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	my2: {
			marginBlock: "8px"
	},
	hPx: {
			height: "1px"
	},
	bgLine: {
			backgroundColor: "var(--border)"
	},
	w64: {
			width: "256px"
	},
	p3: {
			padding: "12px"
	},
	textXs: {
			fontSize: "var(--type-label)",
			lineHeight: "var(--tw-leading,var(--text-xs--line-height))"
	},
});

/**
 * Compact live cost + context readout for the mobile session bar. Shows the
 * running API-equivalent USD spend for the conversation and a ring gauge of
 * how full the model's context window is; tap for a per-token breakdown. Cost
 * comes directly from the engine's completed provider messages. Hidden until
 * the first run reports usage.
 */

function fmtUsd(n: number): string {
	if (n <= 0) return "$0.00";
	if (n < 0.01) return "<$0.01";
	if (n < 100) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString()}`;
}

const compact = new Intl.NumberFormat(undefined, {
	notation: "compact",
	maximumFractionDigits: 1,
});

function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	return compact.format(n);
}

/** Fill-level color: neutral under 85%, red once the window is nearly full. */
function fillTone(frac: number): { stroke: string; text: string } {
	if (frac >= 0.85) return { stroke: "stroke-red", text: "text-red" };
	return { stroke: "stroke-accent", text: "text-dim" };
}

/** SVG progress ring for how full the context window is. */
function ContextRing({
	frac,
	tone,
	size = 14,
}: {
	frac: number;
	tone: string;
	size?: number;
}) {
	const sw = 2;
	const r = (size - sw) / 2;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - Math.min(Math.max(frac, 0), 1));
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${size} ${size}`}
			{...stylex.props(sx.Rotate90)}
			aria-hidden
		>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				strokeWidth={sw}
				{...stylex.props(sx.strokeLine)}
			/>
			<circle
				cx={size / 2}
				cy={size / 2}
				r={r}
				fill="none"
				strokeWidth={sw}
				strokeLinecap="round"
				strokeDasharray={circ}
				strokeDashoffset={offset}
				className={cn("transition-[stroke-dashoffset] duration-300", tone)}
			/>
		</svg>
	);
}

function Row({
	label,
	value,
	strong,
}: {
	label: string;
	value: React.ReactNode;
	strong?: boolean;
}) {
	return (
		<div {...stylex.props(sx.flex, sx.itemsBaseline, sx.justifyBetween, sx.gap6)}>
			<span {...stylex.props(sx.textDim)}>{label}</span>
			<span className={cn("tabular-nums", strong && "text-fg")}>{value}</span>
		</div>
	);
}

export function UsageCost({
	usage,
	className,
}: {
	usage: SessionUsage | undefined;
	className?: string;
}) {
	return (
		<span className={cn("tabular-nums", className)}>
			{fmtUsd(usage?.costUsd ?? 0)}
		</span>
	);
}

export function UsageDetails({
	usage,
	className,
}: {
	usage: SessionUsage | undefined;
	className?: string;
}) {
	const window = usage?.contextWindow || 0;
	const ctx = usage?.contextTokens || 0;
	const frac = window > 0 ? Math.min(ctx / window, 1) : 0;
	const tone = fillTone(frac);
	const totalIn =
		(usage?.inputTokens ?? 0) +
		(usage?.cacheReadTokens ?? 0) +
		(usage?.cacheCreationTokens ?? 0);
	const cacheHit =
		totalIn > 0 ? Math.round(((usage?.cacheReadTokens ?? 0) / totalIn) * 100) : 0;
	const turns = usage?.turns ?? 0;

	return (
		<div className={cn("text-xs", className)}>
			<div {...stylex.props(sx.mb2, sx.flex, sx.itemsBaseline, sx.justifyBetween)}>
				<span {...stylex.props(sx.fontMedium, sx.textFg)}>This conversation</span>
				<span {...stylex.props(sx.textDim)}>
					{turns} turn{turns === 1 ? "" : "s"}
				</span>
			</div>
			<div className="space-y-1.5">
				<Row label="Cost" value={<UsageCost usage={usage} />} strong />
				{window > 0 && (
					<Row
						label="Context"
						value={
							<span className={tone.text}>
								{fmtTokens(ctx)} / {fmtTokens(window)} ({Math.round(frac * 100)}%)
							</span>
						}
					/>
				)}
			</div>
			<div {...stylex.props(sx.my2, sx.hPx, sx.bgLine)} />
			<div className="space-y-1.5">
				<Row label="Input" value={fmtTokens(usage?.inputTokens ?? 0)} />
				<Row label="Output" value={fmtTokens(usage?.outputTokens ?? 0)} />
				<Row
					label="Cache read"
					value={`${fmtTokens(usage?.cacheReadTokens ?? 0)} (${cacheHit}%)`}
				/>
				<Row label="Cache write" value={fmtTokens(usage?.cacheCreationTokens ?? 0)} />
			</div>
		</div>
	);
}

export function UsageMeter({
	usage,
	className,
	showCacheRate = false,
}: {
	usage: SessionUsage | undefined;
	className?: string;
	showCacheRate?: boolean;
}) {
	if (!usage || usage.turns === 0) return null;

	const window = usage.contextWindow || 0;
	const ctx = usage.contextTokens || 0;
	const frac = window > 0 ? Math.min(ctx / window, 1) : 0;
	const tone = fillTone(frac);
	const totalIn =
		usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
	const cacheHit =
		totalIn > 0 ? Math.round((usage.cacheReadTokens / totalIn) * 100) : 0;

	return (
		<Popover.Root>
			<Popover.Trigger
				openOnHover
				delay={200}
				closeDelay={100}
				className={cn(
					// A quiet pill in the session subtitle: this is a readout you can
					// open, not a plate you press.
				"group flex min-h-8 items-center gap-1.5 rounded-full px-1.5 py-1 text-xs font-medium",
					"text-dim hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg",
					"cursor-pointer select-none outline-none transition-colors",
					className,
				)}
				aria-label="Conversation cost & context"
			>
				<UsageCost usage={usage} {...stylex.props(sx.textFg)} />
				{window > 0 && <ContextRing frac={frac} tone={tone.stroke} />}
				{showCacheRate && (
					// Off by default, and the phone header's meter leaves it off: there
					// the meter rides in the title pill's subtitle next to the model
					// name, and the cache rate is the one thing on that line nobody
					// navigates by — it was pushing "Opus 5 + Fable oracle" down to
					// "Opus 5 + …".
					<span className="tabular-nums" {...stylex.props(sx.textDim)}>
						{cacheHit}% cached
					</span>
				)}
			</Popover.Trigger>
			<Popover.Popup side="top" align="end" {...stylex.props(sx.w64, sx.p3, sx.textXs)}>
				<UsageDetails usage={usage} />
			</Popover.Popup>
		</Popover.Root>
	);
}
