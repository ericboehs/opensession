import * as React from "react";
import type { SessionUsage } from "../lib/types";
import { Popover } from "../ui/popover";
import { cn } from "../ui/cn";

/**
 * Compact live cost + context pill for the composer footer. Shows the running
 * API-equivalent USD spend for the conversation and how full the model's context
 * window is; click for a per-token breakdown. Cost is authoritative for Claude
 * runs (the SDK's total_cost_usd — what subscription usage-credits are billed at)
 * and approximate for Codex (marked with ~). Hidden until the first run reports
 * usage.
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

/** Fill-level color: neutral under 75%, red once the window is nearly full. */
function fillTone(frac: number): { bar: string; text: string } {
	if (frac >= 0.85) return { bar: "bg-red", text: "text-red" };
	return { bar: "bg-accent", text: "text-dim" };
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
		<div className="flex items-baseline justify-between gap-6">
			<span className="text-dim">{label}</span>
			<span className={cn("tabular-nums", strong && "text-fg")}>{value}</span>
		</div>
	);
}

export function UsageMeter({ usage }: { usage: SessionUsage | undefined }) {
	if (!usage || usage.turns === 0) return null;

	const window = usage.contextWindow || 0;
	const ctx = usage.contextTokens || 0;
	const frac = window > 0 ? Math.min(ctx / window, 1) : 0;
	const tone = fillTone(frac);
	const approx = usage.costApproximate;
	const totalIn =
		usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
	const cacheHit =
		totalIn > 0 ? Math.round((usage.cacheReadTokens / totalIn) * 100) : 0;

	return (
		<Popover.Root>
			<Popover.Trigger
				className={cn(
					"group flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium",
					"text-dim hover:bg-accent-soft hover:text-fg transition-colors outline-none",
					"cursor-pointer select-none",
				)}
				title="Conversation cost & context — click for a breakdown"
			>
				<span className={cn("tabular-nums", "text-fg")}>
					{approx ? "~" : ""}
					{fmtUsd(usage.costUsd)}
				</span>
				{window > 0 && (
					<span className="flex items-center gap-1.5">
						<span
							className="h-1.5 w-10 overflow-hidden rounded-full bg-line"
							aria-hidden
						>
							<span
								className={cn("block h-full rounded-full transition-[width]", tone.bar)}
								style={{ width: `${Math.max(frac * 100, 2)}%` }}
							/>
						</span>
						<span className={cn("tabular-nums", tone.text)}>
							{fmtTokens(ctx)}/{fmtTokens(window)}
						</span>
					</span>
				)}
			</Popover.Trigger>
			<Popover.Popup side="top" align="end" className="w-64 p-3 text-xs">
				<div className="mb-2 flex items-baseline justify-between">
					<span className="font-medium text-fg">This conversation</span>
					<span className="text-dim">
						{usage.turns} turn{usage.turns === 1 ? "" : "s"}
					</span>
				</div>
				<div className="space-y-1.5">
					<Row
						label={approx ? "Cost (approx.)" : "Cost"}
						value={`${approx ? "~" : ""}${fmtUsd(usage.costUsd)}`}
						strong
					/>
					{window > 0 && (
						<Row
							label="Context"
							value={
								<span className={tone.text}>
									{fmtTokens(ctx)} / {fmtTokens(window)} (
									{Math.round(frac * 100)}%)
								</span>
							}
						/>
					)}
				</div>
				<div className="my-2 h-px bg-line" />
				<div className="space-y-1.5">
					<Row label="Input" value={fmtTokens(usage.inputTokens)} />
					<Row label="Output" value={fmtTokens(usage.outputTokens)} />
					<Row
						label="Cache read"
						value={`${fmtTokens(usage.cacheReadTokens)} (${cacheHit}%)`}
					/>
					<Row
						label="Cache write"
						value={fmtTokens(usage.cacheCreationTokens)}
					/>
				</div>
				{approx && (
					<p className="mt-2 text-[11px] leading-snug text-dim">
						Codex cost is estimated from list rates; Claude cost is the exact
						API-billed amount.
					</p>
				)}
			</Popover.Popup>
		</Popover.Root>
	);
}
