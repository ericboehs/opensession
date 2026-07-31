import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { docTitle } from "../lib/brand";
import { fetchAnalytics } from "../lib/api";
import type { AnalyticsSummary } from "../lib/types";
import { Card } from "../ui/card";
import { Button } from "../ui/button";

/**
 * Analytics: what happened on/because of OpenSession over a date range —
 * sessions, tokens, models, PRs, people, automations. Data comes aggregated
 * from GET /api/analytics (src/server/analytics.ts); this file is pure
 * presentation: stat tiles + hand-rolled SVG bar charts (stacked/grouped)
 * with hover tooltips, and the breakdown tables.
 */

// Validated categorical palette (8 slots, CVD-safe adjacent order) — dark
// values are the default theme, light overrides under html[data-theme].
// Order matters: it's the CVD-safety mechanism, so series always take slots
// in ascending order and a 9th series folds into "Other" (neutral gray).
const VIZ_STYLE = `
.analytics-viz{--viz-1:#3987e5;--viz-2:#008300;--viz-3:#d55181;--viz-4:#c98500;--viz-5:#199e70;--viz-6:#d95926;--viz-7:#9085e9;--viz-8:#e66767;--viz-other:#757575;}
html[data-theme="light"] .analytics-viz{--viz-1:#2a78d6;--viz-2:#008300;--viz-3:#e87ba4;--viz-4:#eda100;--viz-5:#1baf7a;--viz-6:#eb6834;--viz-7:#4a3aa7;--viz-8:#e34948;}
`;
const slot = (i: number) => `var(--viz-${i})`;
const OTHER_COLOR = "var(--viz-other)";

const compactFmt = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const fmt = (n: number) => compactFmt.format(n);
const fmtInt = (n: number) => n.toLocaleString("en-US");

function shortDate(iso: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

function utcToday(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// Session kinds get fixed palette slots (color follows the entity, and the
// slot order is the stack render order).
const KINDS: Array<{ key: string; label: string }> = [
	{ key: "automation", label: "Automations" },
	{ key: "review", label: "PR reviews" },
	{ key: "prompt", label: "Interactive" },
	{ key: "create", label: "Spawned" },
	{ key: "slack", label: "Slack" },
	{ key: "linear", label: "Linear" },
	{ key: "goal", label: "Goals" },
];

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		setWidth(el.clientWidth);
		return () => ro.disconnect();
	}, []);
	return [ref, width];
}

function niceTicks(max: number, count = 3): number[] {
	if (max <= 0) return [];
	const raw = max / count;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
	const ticks: number[] = [];
	for (let t = step; t <= max + step * 0.001; t += step) ticks.push(t);
	return ticks;
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
	const rr = Math.min(r, h / 2, w / 2);
	return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

interface Series {
	label: string;
	color: string;
}

interface BarChartProps {
	labels: string[];
	series: Series[];
	/** values[dayIndex][seriesIndex] */
	values: number[][];
	mode: "stacked" | "grouped";
	height?: number;
	formatValue?: (n: number) => string;
}

/** Stacked/grouped bar chart: hairline gridlines, clean ticks, 2px surface
 *  gaps between stacked segments, rounded caps, and a per-day hover tooltip. */
function BarChart({ labels, series, values, mode, height = 190, formatValue = fmt }: BarChartProps) {
	const [ref, width] = useWidth<HTMLDivElement>();
	const [hover, setHover] = useState<number | null>(null);

	const gutter = 34;
	const bottom = 18;
	const plotH = height - bottom - 6;
	const plotW = Math.max(0, width - gutter - 4);
	const n = labels.length;
	const band = n > 0 ? plotW / n : 0;

	const max = Math.max(
		1,
		...values.map((day) => (mode === "stacked" ? day.reduce((a, b) => a + b, 0) : Math.max(0, ...day))),
	);
	const ticks = niceTicks(max);
	const scaleMax = ticks.length ? Math.max(max, ticks[ticks.length - 1]) : max;
	const yOf = (v: number) => 6 + plotH - (v / scaleMax) * plotH;
	const hOf = (v: number) => (v / scaleMax) * plotH;

	const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 56))));

	if (width === 0) return <div ref={ref} style={{ height }} />;

	const tooltipRows = hover === null ? [] : series.map((s, j) => ({ ...s, value: values[hover][j] })).filter((r) => r.value > 0);
	// Clamp the tooltip inside the container; flip to the left half past midway.
	const tooltipLeft = hover === null ? 0 : Math.min(Math.max(gutter + hover * band + band / 2, 70), width - 90);

	return (
		<div ref={ref} className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
			<svg width={width} height={height} role="img">
				{ticks.map((t) => (
					<g key={t}>
						<line x1={gutter} x2={width} y1={yOf(t)} y2={yOf(t)} stroke="var(--border)" strokeWidth={1} />
						<text x={gutter - 6} y={yOf(t) + 3} textAnchor="end" fontSize={10} fill="var(--text-faint)">
							{formatValue(t)}
						</text>
					</g>
				))}
				<line x1={gutter} x2={width} y1={yOf(0)} y2={yOf(0)} stroke="var(--border)" strokeWidth={1} />
				{hover !== null && band > 0 && (
					<rect x={gutter + hover * band} y={6} width={band} height={plotH} fill="var(--bg-hover)" />
				)}
				{labels.map((label, i) => {
					const x0 = gutter + i * band;
					const marks: React.ReactNode[] = [];
					if (mode === "stacked") {
						const barW = Math.max(2, Math.min(24, band * 0.72));
						const x = x0 + (band - barW) / 2;
						let yCursor = yOf(0);
						let topIdx = -1;
						for (let j = values[i].length - 1; j >= 0; j--) if (values[i][j] > 0) { topIdx = j; break; }
						values[i].forEach((v, j) => {
							if (v <= 0) return;
							const h = hOf(v);
							const y = yCursor - h;
							// 2px surface gap between touching segments (shaved off
							// every segment that has another stacked above it).
							const gap = j === topIdx ? 0 : Math.min(2, h);
							if (j === topIdx) {
								marks.push(<path key={j} d={roundedTopRect(x, y, barW, h, 4)} fill={series[j].color} />);
							} else {
								marks.push(<rect key={j} x={x} y={y + gap} width={barW} height={Math.max(0, h - gap)} fill={series[j].color} />);
							}
							yCursor = y;
						});
					} else {
						const cluster = series.length;
						const barW = Math.max(2, Math.min(10, (band - 4) / cluster));
						const x = x0 + (band - barW * cluster - 2 * (cluster - 1)) / 2;
						values[i].forEach((v, j) => {
							if (v <= 0) return;
							const h = hOf(v);
							marks.push(
								<path
									key={j}
									d={roundedTopRect(x + j * (barW + 2), yOf(0) - h, barW, h, 4)}
									fill={series[j].color}
								/>,
							);
						});
					}
					return (
						<g key={label}>
							{marks}
							{i % labelEvery === 0 && (
								<text x={x0 + band / 2} y={height - 4} textAnchor="middle" fontSize={10} fill="var(--text-faint)">
									{shortDate(label)}
								</text>
							)}
							<rect
								x={x0}
								y={0}
								width={band}
								height={height}
								fill="transparent"
								onMouseEnter={() => setHover(i)}
								onClick={() => setHover(i)}
							/>
						</g>
					);
				})}
			</svg>
			{hover !== null && tooltipRows.length > 0 && (
				<div
					className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-md border border-line bg-panel px-2.5 py-2 shadow-lg"
					style={{ left: tooltipLeft }}
				>
					<div className="mb-1 text-meta font-semibold text-fg">{shortDate(labels[hover])}</div>
					{tooltipRows.map((r) => (
						<div key={r.label} className="flex items-center gap-1.5 whitespace-nowrap text-meta leading-4.5">
							<span className="size-2 shrink-0 rounded-[2px]" style={{ background: r.color }} />
							<span className="text-dim">{r.label}</span>
							<span className="ml-auto pl-3 font-medium tabular-nums text-fg">{formatValue(r.value)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function Legend({ series }: { series: Series[] }) {
	if (series.length < 2) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
			{series.map((s) => (
				<span key={s.label} className="flex items-center gap-1.5 text-meta text-dim">
					<span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
					{s.label}
				</span>
			))}
		</div>
	);
}

function ChartCard({
	title,
	subtitle,
	series,
	children,
}: {
	title: string;
	subtitle?: string;
	series?: Series[];
	children: React.ReactNode;
}) {
	return (
		<Card as="section" className="min-w-0 p-4">
			<h3 className="m-0 text-item-title font-semibold text-fg">{title}</h3>
			{subtitle && <p className="m-0 mb-2 mt-0.5 text-supporting text-dim">{subtitle}</p>}
			{series && <Legend series={series} />}
			{children}
		</Card>
	);
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<Card className="min-w-0 px-4 py-3">
			<div className="text-label text-dim">{label}</div>
			<div className="mt-0.5 text-page-title font-semibold leading-7 text-fg">{value}</div>
			{sub && <div className="mt-0.5 truncate text-meta text-faint">{sub}</div>}
		</Card>
	);
}

const PRESETS = [
	{ label: "7d", days: 7 },
	{ label: "14d", days: 14 },
	{ label: "30d", days: 30 },
	{ label: "90d", days: 90 },
];

const PR_STATE: Record<string, { label: string; color: string }> = {
	OPEN: { label: "Open", color: "var(--viz-2)" },
	MERGED: { label: "Merged", color: "var(--viz-7)" },
	CLOSED: { label: "Closed", color: "var(--viz-8)" },
};

export function Analytics() {
	const [from, setFrom] = useState(() => daysAgo(29));
	const [to, setTo] = useState(utcToday);
	const [data, setData] = useState<AnalyticsSummary | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [showAllPrs, setShowAllPrs] = useState(false);

	useEffect(() => {
		document.title = docTitle("Analytics");
	}, []);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		fetchAnalytics(from, to)
			.then((next) => {
				if (!alive) return;
				setData(next);
				setError("");
			})
			.catch((e) => alive && setError(e?.message || "Failed to load analytics"))
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [from, to]);

	const activePresetDays = useMemo(() => {
		const preset = PRESETS.find((p) => from === daysAgo(p.days - 1) && to === utcToday());
		return preset?.days ?? null;
	}, [from, to]);

	const derived = useMemo(() => {
		if (!data) return null;
		const labels = data.days.map((d) => d.date);

		// Sessions by kind: fixed slots for the known kinds, everything else
		// folds into a neutral "Other".
		const presentKinds = KINDS.filter((k) => data.days.some((d) => (d.sessionsByKind[k.key] || 0) > 0));
		const knownKeys = new Set(KINDS.map((k) => k.key));
		const hasOtherKind = data.days.some((d) =>
			Object.entries(d.sessionsByKind).some(([k, v]) => v > 0 && !knownKeys.has(k)),
		);
		const kindSeries: Series[] = presentKinds.map((k) => ({
			label: k.label,
			color: slot(KINDS.indexOf(k) + 1),
		}));
		if (hasOtherKind) kindSeries.push({ label: "Other", color: OTHER_COLOR });
		const kindValues = data.days.map((d) => {
			const row = presentKinds.map((k) => d.sessionsByKind[k.key] || 0);
			if (hasOtherKind) {
				row.push(
					Object.entries(d.sessionsByKind).reduce((sum, [k, v]) => (knownKeys.has(k) ? sum : sum + v), 0),
				);
			}
			return row;
		});

		// Output tokens by model: top 5 in the range take slots 1-5, the tail
		// folds into "Other".
		const topModels = data.models.slice(0, 5).map((m) => m.model);
		const hasOtherModel = data.models.length > 5;
		const modelSeries: Series[] = topModels.map((m, i) => ({ label: m, color: slot(i + 1) }));
		if (hasOtherModel) modelSeries.push({ label: "Other", color: OTHER_COLOR });
		const modelValues = data.days.map((d) => {
			const row = topModels.map((m) => d.outputByModel[m] || 0);
			if (hasOtherModel) {
				row.push(
					Object.entries(d.outputByModel).reduce((sum, [m, v]) => (topModels.includes(m) ? sum : sum + v), 0),
				);
			}
			return row;
		});

		const prSeries: Series[] = [
			{ label: "Opened", color: slot(1) },
			{ label: "Merged", color: slot(2) },
		];
		const prValues = data.days.map((d) => [d.prsOpened, d.prsMerged]);

		const turnSeries: Series[] = [
			{ label: "Turns", color: slot(1) },
			{ label: "Errors", color: slot(8) },
		];
		const turnValues = data.days.map((d) => [d.turns, d.errors]);

		const factorySeries: Series[] = [
			{ label: "Human-reviewed", color: slot(2) },
			{ label: "No human review", color: slot(8) },
		];
		const factoryByDate = new Map(data.factory.days.map((d) => [d.date, d]));
		const factoryValues = labels.map((date) => {
			const d = factoryByDate.get(date);
			return [d?.reviewed || 0, d?.unreviewed || 0];
		});

		const maxModelOutput = Math.max(1, ...data.models.map((m) => m.outputTokens));

		// Review finding outcomes, cohorted by the day the finding was posted.
		// Guard: the live-rebuilt frontend can briefly run against a not-yet-
		// restarted server whose payload has no reviewQuality.
		const rq = data.reviewQuality;
		const reviewSeries: Series[] = [
			{ label: "Addressed", color: slot(2) },
			{ label: "Pushback", color: slot(4) },
			{ label: "Ignored", color: slot(8) },
			{ label: "Pending", color: OTHER_COLOR },
		];
		const reviewByDate = new Map((rq?.days || []).map((d) => [d.date, d]));
		const reviewValues = labels.map((date) => {
			const d = reviewByDate.get(date);
			return [d?.addressed || 0, d?.dismissed || 0, d?.ignored || 0, d?.pending || 0];
		});
		const splitDate = labels[Math.floor(labels.length / 2)] || "";

		return { labels, kindSeries, kindValues, modelSeries, modelValues, prSeries, prValues, turnSeries, turnValues, factorySeries, factoryValues, maxModelOutput, rq, reviewSeries, reviewValues, splitDate };
	}, [data]);

	const dateInput =
		"rounded-md border border-line bg-panel px-2 py-1.5 text-control-label text-fg [color-scheme:inherit]";

	return (
		<div className="analytics-viz flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg">
			<style>{VIZ_STYLE}</style>
			<div className="mx-auto w-full max-w-[1080px] px-4 pb-10 pt-5 md:px-6">
				<header className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h1 className="m-0 text-section-title font-semibold tracking-[-0.02em] text-fg">Analytics</h1>
						<p className="m-0 mt-1 text-supporting text-dim">
							What happened on OpenSession — sessions, tokens, models, PRs.
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex rounded-md border border-line bg-panel p-0.5">
							{PRESETS.map((p) => (
								<button
									key={p.label}
									type="button"
									className={`cursor-pointer rounded-[5px] border-0 px-2.5 py-1 text-control-label font-medium ${
										activePresetDays === p.days ? "bg-active text-fg" : "bg-transparent text-dim hover:text-fg"
									}`}
									onClick={() => {
										setFrom(daysAgo(p.days - 1));
										setTo(utcToday());
									}}
								>
									{p.label}
								</button>
							))}
						</div>
						<div className="flex items-center gap-1.5">
							<input
								type="date"
								aria-label="From date"
								className={dateInput}
								value={from}
								max={to}
								onChange={(e) => e.target.value && setFrom(e.target.value)}
							/>
							<span className="text-xs text-faint">–</span>
							<input
								type="date"
								aria-label="To date"
								className={dateInput}
								value={to}
								min={from}
								max={utcToday()}
								onChange={(e) => e.target.value && setTo(e.target.value)}
							/>
						</div>
					</div>
				</header>

				{error && <p className="mt-4 text-body text-red">{error}</p>}
				{!data && !error && (
					<div className="flex h-60 items-center justify-center text-body text-dim">Loading analytics…</div>
				)}

				{data && derived && (
					<div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"}>
						<div className="mt-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
							<StatTile
								label="Active sessions"
								value={fmtInt(data.totals.sessions)}
								sub={`${fmtInt(data.totals.sessionsCreated)} created in range`}
							/>
							<StatTile
								label="Turns"
								value={fmtInt(data.totals.turns)}
								sub={`${fmtInt(data.totals.errors)} errors · ${fmtInt(data.totals.cancelled)} cancelled`}
							/>
							<StatTile
								label="Output tokens"
								value={fmt(data.totals.outputTokens)}
								sub={`${fmt(data.totals.inputTokens)} input · ${fmt(data.totals.cacheReadTokens)} cache read`}
							/>
							<StatTile
								label="Agent time"
								value={`${fmt(Math.round(data.totals.durationMs / 3_600_000))}h`}
								sub="wall-clock across turns"
							/>
							<StatTile
								label="PRs opened"
								value={fmtInt(data.totals.prsOpened)}
								sub={`of ${fmtInt(data.totals.allPrsOpened)} across repos`}
							/>
							<StatTile
								label="PRs merged"
								value={fmtInt(data.totals.prsMerged)}
								sub={
									data.totals.allPrsMerged
										? `${Math.round((100 * data.totals.prsMerged) / data.totals.allPrsMerged)}% of all merges`
										: "no merges in range"
								}
							/>
							<StatTile
								label="People active"
								value={fmtInt(data.totals.activePeople)}
								sub="humans with sessions"
							/>
							<StatTile
								label="Automation runs"
								value={fmtInt(data.automations.reduce((sum, a) => sum + a.runs, 0))}
								sub={`across ${fmtInt(data.automations.filter((a) => a.runs > 0).length)} automations`}
							/>
						</div>

						<div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
							<ChartCard title="Sessions per day" subtitle="Distinct sessions with agent activity" series={derived.kindSeries}>
								<BarChart labels={derived.labels} series={derived.kindSeries} values={derived.kindValues} mode="stacked" />
							</ChartCard>
							<ChartCard title="Output tokens per day" subtitle="By model, top 5 in range" series={derived.modelSeries}>
								<BarChart labels={derived.labels} series={derived.modelSeries} values={derived.modelValues} mode="stacked" />
							</ChartCard>
							<ChartCard title="Pull requests per day" subtitle="Opened & merged from OpenSession sessions" series={derived.prSeries}>
								<BarChart labels={derived.labels} series={derived.prSeries} values={derived.prValues} mode="grouped" formatValue={fmtInt} />
							</ChartCard>
							<ChartCard title="Turns per day" subtitle="Completed turns and errored events" series={derived.turnSeries}>
								<BarChart labels={derived.labels} series={derived.turnSeries} values={derived.turnValues} mode="grouped" />
							</ChartCard>
							<ChartCard
								title="Review coverage on merges"
								subtitle="Merged PRs per day, split by whether a human reviewed or commented"
								series={derived.factorySeries}
							>
								<BarChart labels={derived.labels} series={derived.factorySeries} values={derived.factoryValues} mode="stacked" formatValue={fmtInt} />
							</ChartCard>
							<ChartCard
								title="Factory health"
								subtitle="Merged PRs in range: agent (OpenSession sessions) vs everything else"
							>
								<table className="w-full border-collapse text-label">
									<thead>
										<tr className="text-left text-meta text-faint">
											<th className="pb-1.5 font-medium">Metric</th>
											<th className="pb-1.5 text-right font-medium">Agent PRs</th>
											<th className="pb-1.5 text-right font-medium">Other PRs</th>
										</tr>
									</thead>
									<tbody>
										{(() => {
											const { agent, other } = data.factory;
											const pct = (c: typeof agent) =>
												c.merged ? `${Math.round((100 * c.humanReviewed) / c.merged)}%` : "–";
											const rows: Array<[string, string, string]> = [
												["Merged", fmtInt(agent.merged), fmtInt(other.merged)],
												["Human-reviewed", pct(agent), pct(other)],
												["Rework commits after review (avg)", String(agent.avgReworkCommits), String(other.avgReworkCommits)],
												["Reverts", fmtInt(agent.reverts), fmtInt(other.reverts)],
												["Median hours to merge", String(agent.medianHoursToMerge), String(other.medianHoursToMerge)],
												["Avg lines changed", fmtInt(agent.avgLinesChanged), fmtInt(other.avgLinesChanged)],
											];
											return rows.map(([label, a, b]) => (
												<tr key={label} className="border-t border-line">
													<td className="py-1.5 text-fg">{label}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{a}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{b}</td>
												</tr>
											));
										})()}
									</tbody>
								</table>
							</ChartCard>
							{derived.rq && (
								<>
									<ChartCard
										title="Review finding outcomes"
										subtitle="Bot findings by day posted; outcomes settle as PRs progress, so recent days show pending"
										series={derived.reviewSeries}
									>
										<BarChart
											labels={derived.labels}
											series={derived.reviewSeries}
											values={derived.reviewValues}
											mode="stacked"
											formatValue={fmtInt}
										/>
									</ChartCard>
									<ChartCard
										title="Review quality trend"
										subtitle={`Earlier vs recent half of the range (split at ${shortDate(derived.splitDate)}) — is the reviewer getting better?`}
									>
										<table className="w-full border-collapse text-label">
											<thead>
												<tr className="text-left text-meta text-faint">
													<th className="pb-1.5 font-medium">Metric</th>
													<th className="pb-1.5 text-right font-medium">Earlier</th>
													<th className="pb-1.5 text-right font-medium">Recent</th>
												</tr>
											</thead>
											<tbody>
												{(() => {
													const { earlier, recent } = derived.rq;
													const pct = (v: number | null) => (v === null ? "–" : `${v}%`);
													const num = (v: number | null) => (v === null ? "–" : String(v));
													const rows: Array<[string, string, string]> = [
														["Findings posted", fmtInt(earlier.posted), fmtInt(recent.posted)],
														["Addressed rate (of settled)", pct(earlier.addressedRate), pct(recent.addressedRate)],
														["Author pushback", fmtInt(earlier.dismissed), fmtInt(recent.dismissed)],
														["Ignored at close", fmtInt(earlier.ignored), fmtInt(recent.ignored)],
														["Missed bugs detected", fmtInt(earlier.missedBugs), fmtInt(recent.missedBugs)],
														["Reviews run", fmtInt(earlier.reviews), fmtInt(recent.reviews)],
														["Findings per review", num(earlier.avgFindingsPerReview), num(recent.avgFindingsPerReview)],
														["Avg merge-confidence", num(earlier.avgConfidence), num(recent.avgConfidence)],
														["Withheld by noise filter", fmtInt(earlier.withheld), fmtInt(recent.withheld)],
													];
													return rows.map(([label, a, b]) => (
														<tr key={label} className="border-t border-line">
															<td className="py-1.5 text-fg">{label}</td>
															<td className="py-1.5 text-right tabular-nums text-dim">{a}</td>
															<td className="py-1.5 text-right tabular-nums text-dim">{b}</td>
														</tr>
													));
												})()}
											</tbody>
										</table>
										<p className="m-0 mt-2 text-meta text-faint">
											Addressed = author acted on the finding · pushback = author explicitly rejected it · reviews-run
											metrics collect from Jul 28 on. High addressed rate + low pushback/missed bugs = healthier reviews.
										</p>
									</ChartCard>
								</>
							)}
						</div>

						<div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
							<ChartCard title="Models" subtitle="Output tokens and turns per model">
								<div className="flex flex-col gap-2">
									{data.models.slice(0, 8).map((m, i) => (
										<div key={m.model} className="flex items-center gap-3 text-label">
											<span className="w-[42%] truncate text-fg" title={m.model}>
												{m.model}
											</span>
											<span className="h-3 min-w-0 flex-1">
												<span
													className="block h-3 rounded-[3px]"
													style={{
														width: `${Math.max(1.5, (100 * m.outputTokens) / derived.maxModelOutput)}%`,
														background: i < 5 ? slot(i + 1) : OTHER_COLOR,
													}}
												/>
											</span>
											<span className="w-14 text-right tabular-nums text-dim">{fmt(m.outputTokens)}</span>
											<span className="w-14 text-right tabular-nums text-faint">{fmt(m.turns)} turns</span>
										</div>
									))}
								</div>
							</ChartCard>
							<ChartCard title="Repos" subtitle="OpenSession's share of PRs, per repo">
								<table className="w-full border-collapse text-label">
									<thead>
										<tr className="text-left text-meta text-faint">
											<th className="pb-1.5 font-medium">Repo</th>
											<th className="pb-1.5 text-right font-medium">Opened</th>
											<th className="pb-1.5 text-right font-medium">Merged</th>
											<th className="pb-1.5 text-right font-medium">Share of merges</th>
										</tr>
									</thead>
									<tbody>
										{data.repos.map((r) => (
											<tr key={r.repo} className="border-t border-line">
												<td className="py-1.5 text-fg">{r.repo}</td>
												<td className="py-1.5 text-right tabular-nums text-dim">
													{fmtInt(r.prsOpened)} <span className="text-faint">/ {fmtInt(r.allOpened)}</span>
												</td>
												<td className="py-1.5 text-right tabular-nums text-dim">
													{fmtInt(r.prsMerged)} <span className="text-faint">/ {fmtInt(r.allMerged)}</span>
												</td>
												<td className="py-1.5 text-right tabular-nums text-fg">
													{r.allMerged ? `${Math.round((100 * r.prsMerged) / r.allMerged)}%` : "–"}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</ChartCard>
						</div>

						<div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
							<ChartCard title="People" subtitle="Sessions and turns per person">
								<div className="overflow-x-auto">
									<table className="w-full border-collapse text-label">
										<thead>
											<tr className="text-left text-meta text-faint">
												<th className="pb-1.5 font-medium">Person</th>
												<th className="pb-1.5 text-right font-medium">Created</th>
												<th className="pb-1.5 text-right font-medium">Active</th>
												<th className="pb-1.5 text-right font-medium">Turns</th>
												<th className="pb-1.5 text-right font-medium">Output</th>
											</tr>
										</thead>
										<tbody>
											{data.people.slice(0, 12).map((p) => (
												<tr key={p.name} className="border-t border-line">
													<td className="max-w-40 truncate py-1.5 text-fg">{p.name}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmtInt(p.sessionsCreated)}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmtInt(p.sessionsActive)}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmtInt(p.turns)}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmt(p.outputTokens)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</ChartCard>
							<ChartCard title="Automations" subtitle="Runs, turns and errors per automation">
								<div className="overflow-x-auto">
									<table className="w-full border-collapse text-label">
										<thead>
											<tr className="text-left text-meta text-faint">
												<th className="pb-1.5 font-medium">Automation</th>
												<th className="pb-1.5 text-right font-medium">Runs</th>
												<th className="pb-1.5 text-right font-medium">Turns</th>
												<th className="pb-1.5 text-right font-medium">Output</th>
												<th className="pb-1.5 text-right font-medium">Errors</th>
											</tr>
										</thead>
										<tbody>
											{data.automations.slice(0, 12).map((a) => (
												<tr key={a.name} className="border-t border-line">
													<td className="max-w-44 truncate py-1.5 text-fg" title={a.name}>
														{a.name}
													</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmtInt(a.runs)}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmtInt(a.turns)}</td>
													<td className="py-1.5 text-right tabular-nums text-dim">{fmt(a.outputTokens)}</td>
													<td className={`py-1.5 text-right tabular-nums ${a.errors ? "text-red" : "text-faint"}`}>
														{fmtInt(a.errors)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</ChartCard>
						</div>

						{data.prs.length > 0 && (
							<div className="mt-4">
								<ChartCard
									title="Pull requests from OpenSession"
									subtitle={`${fmtInt(data.prs.length)} PRs opened or merged in range`}
								>
									<div className="flex flex-col">
										{(showAllPrs ? data.prs : data.prs.slice(0, 12)).map((pr) => {
											const state = PR_STATE[pr.state] || PR_STATE.OPEN;
											return (
												<a
													key={`${pr.repo}#${pr.number}`}
													href={pr.url}
													target="_blank"
													rel="noopener noreferrer"
													className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-label no-underline hover:bg-hover"
												>
													<span
														className="size-2 shrink-0 rounded-full"
														style={{ background: state.color }}
													/>
													<span className="shrink-0 tabular-nums text-faint">
														{pr.repo}#{pr.number}
													</span>
													<span className="min-w-0 flex-1 truncate text-fg">{pr.title}</span>
													<span className="hidden shrink-0 text-faint sm:inline">{state.label}</span>
													<span className="shrink-0 tabular-nums text-faint">
														{shortDate(pr.mergedAt || pr.createdAt)}
													</span>
												</a>
											);
										})}
									</div>
									{data.prs.length > 12 && (
										<Button
											size="sm"
											className="mt-2 text-control-label"
											onClick={() => setShowAllPrs((v) => !v)}
										>
											{showAllPrs ? "Show fewer" : `Show all ${fmtInt(data.prs.length)}`}
										</Button>
									)}
								</ChartCard>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
