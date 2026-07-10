import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BASE_PATH } from "../lib/base";
import type {
	WorkflowAgentSnapshot,
	WorkflowJournalEntry,
	WorkflowRunSnapshot,
} from "../../server/workflow-types";
import { cn } from "../ui/cn";
import { friendlyModelSlug, opencodeModelParts } from "./ModelEffortSelect";

/**
 * Agents tab: live view of a session's dynamic workflow runs (the
 * opensession-workflows MCP). Renders WorkflowRunSnapshot cards — newest run
 * first — with agents grouped by phase, a narrator log feed, and a per-agent
 * drill-in that lazily fetches the full journal entry
 * (/api/workflows/:runId/agents/:seq). Snapshots arrive via the
 * workflow_update WS broadcast; this component is a pure renderer plus the
 * drill-in fetch. Never mounted with zero runs (the tab itself hides).
 */

interface Props {
	sessionId: string;
	runs: WorkflowRunSnapshot[];
	onCancel: (runId: string) => void;
}

const RUN_PILL: Record<WorkflowRunSnapshot["status"], string> = {
	running: "bg-green-soft text-green",
	done: "bg-active text-dim",
	error: "bg-red-soft text-red",
	cancelled: "bg-active text-faint",
	interrupted: "bg-active text-yellow",
};

/** Status mark: glyphs for the terminal states (✓/✕ stay legible at a glance
 *  — a red accent dot and an error dot would read the same), pulsing green
 *  dot = running (matches the run pill's green), dim dot = pending/cancelled. */
function StatusMark({ status }: { status: WorkflowAgentSnapshot["status"] }) {
	if (status === "done" || status === "error") {
		const ok = status === "done";
		return (
			<svg
				viewBox="0 0 12 12"
				className={cn("size-3 shrink-0", ok ? "text-green" : "text-red")}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{ok ? (
					<path d="M2.5 6.5 5 9l4.5-6" />
				) : (
					<path d="M3 3l6 6M9 3l-6 6" />
				)}
			</svg>
		);
	}
	return (
		<span className="flex size-3 shrink-0 items-center justify-center">
			<span
				className={cn(
					"size-2 rounded-full",
					status === "running" ? "bg-green animate-pulse" : "bg-line-strong",
				)}
			/>
		</span>
	);
}

function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** "opencode/anthropic/claude-sonnet-5" → "Sonnet 5" (chips stay short). */
function shortModel(id: string): string {
	const oc = opencodeModelParts(id);
	return friendlyModelSlug(oc ? oc.model : id);
}

function agentDuration(a: WorkflowAgentSnapshot, now: number): string {
	if (!a.startedAt) return "";
	const end = a.endedAt
		? new Date(a.endedAt).getTime()
		: a.status === "running"
			? now
			: undefined;
	if (end === undefined) return "";
	return fmtDuration(end - new Date(a.startedAt).getTime());
}

function Chip({ children }: { children: React.ReactNode }) {
	return (
		<span className="shrink-0 rounded-sm border border-line px-1 py-px text-[11px] font-medium text-faint">
			{children}
		</span>
	);
}

function DetailPre({ text }: { text: string }) {
	return (
		<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface p-2 font-mono text-[11.5px] leading-relaxed text-dim">
			{text}
		</pre>
	);
}

export function WorkflowPanel({ sessionId: _sessionId, runs, onCancel }: Props) {
	// Server list + WS prepends both keep newest-first; re-sorting is cheap
	// insurance against an out-of-order upsert.
	const ordered = useMemo(
		() =>
			[...runs].sort(
				(a, b) =>
					new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			),
		[runs],
	);
	const anyRunning = ordered.some((r) => r.status === "running");
	// 1s heartbeat for elapsed/duration readouts, only while something is live.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!anyRunning) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [anyRunning]);

	if (ordered.length === 0) return null;
	return (
		<div className="flex flex-col gap-3 p-3 pb-6">
			{ordered.map((run) => (
				<RunCard key={run.runId} run={run} now={now} onCancel={onCancel} />
			))}
		</div>
	);
}

function RunCard({
	run,
	now,
	onCancel,
}: {
	run: WorkflowRunSnapshot;
	now: number;
	onCancel: (runId: string) => void;
}) {
	// Expanded agent rows (by seq) + their lazily-fetched journal entries.
	const [openAgents, setOpenAgents] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [details, setDetails] = useState<
		Record<number, WorkflowJournalEntry | "loading" | "missing">
	>({});
	const [allLogs, setAllLogs] = useState(false);
	const [showResult, setShowResult] = useState(false);

	// Phase order: meta-seeded titles first, then first-seen agent phases;
	// agents without a phase render as a leading ungrouped block.
	const groups = useMemo(() => {
		const order: string[] = [];
		const seen = new Set<string>();
		for (const t of run.phases)
			if (!seen.has(t)) {
				seen.add(t);
				order.push(t);
			}
		for (const a of run.agents)
			if (a.phase && !seen.has(a.phase)) {
				seen.add(a.phase);
				order.push(a.phase);
			}
		const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
		for (const t of order) byPhase.set(t, []);
		const loose: WorkflowAgentSnapshot[] = [];
		for (const a of run.agents) {
			if (a.phase && byPhase.has(a.phase)) byPhase.get(a.phase)!.push(a);
			else loose.push(a);
		}
		return { order, byPhase, loose };
	}, [run.phases, run.agents]);

	const toggleAgent = useCallback((seq: number) => {
		setOpenAgents((prev) => {
			const next = new Set(prev);
			if (next.has(seq)) next.delete(seq);
			else next.add(seq);
			return next;
		});
	}, []);

	const loadDetail = useCallback(
		async (seq: number) => {
			setDetails((prev) => ({ ...prev, [seq]: "loading" }));
			try {
				const res = await fetch(
					`${BASE_PATH}/api/workflows/${encodeURIComponent(run.runId)}/agents/${seq}`,
				);
				if (!res.ok) throw new Error(String(res.status));
				const data = (await res.json()) as
					| WorkflowJournalEntry
					| { entry?: WorkflowJournalEntry }
					| null;
				// Tolerate both a bare journal entry and an { entry } envelope.
				const entry =
					data && typeof data === "object" && "entry" in data
						? (data as { entry?: WorkflowJournalEntry }).entry
						: (data as WorkflowJournalEntry | null);
				if (!entry || typeof entry.prompt !== "string")
					throw new Error("bad shape");
				setDetails((prev) => ({ ...prev, [seq]: entry }));
			} catch {
				setDetails((prev) => ({ ...prev, [seq]: "missing" }));
			}
		},
		[run.runId],
	);

	const startMs = new Date(run.startedAt).getTime();
	const elapsedMs =
		(run.endedAt
			? new Date(run.endedAt).getTime()
			: run.status === "running"
				? now
				: startMs) - startMs;
	const runningN = run.agents.filter((a) => a.status === "running").length;
	const errorN = run.agents.filter((a) => a.status === "error").length;
	const meta: string[] = [
		`${run.totals.agents} agent${run.totals.agents === 1 ? "" : "s"}`,
	];
	if (runningN) meta.push(`${runningN} running`);
	if (errorN) meta.push(`${errorN} failed`);
	if (run.totals.tokensOut) meta.push(`${fmtTokens(run.totals.tokensOut)} tok`);
	if (elapsedMs > 0 || run.status === "running")
		meta.push(fmtDuration(elapsedMs));

	function agentRow(a: WorkflowAgentSnapshot) {
		return (
			<AgentRow
				key={a.seq}
				a={a}
				open={openAgents.has(a.seq)}
				detail={details[a.seq]}
				// Precomputed string so the 1s ticker only re-renders rows whose
				// readout actually changes (running rows) — done rows memo-bail.
				duration={agentDuration(a, now)}
				onToggle={toggleAgent}
				onLoadDetail={loadDetail}
			/>
		);
	}

	return (
		<div className="rounded-md border border-line bg-surface">
			<div className="flex items-start justify-between gap-2 px-3 pb-1 pt-2.5">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="truncate text-sm font-semibold text-fg">
							{run.name}
						</span>
						<span
							className={cn(
								"inline-flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
								RUN_PILL[run.status],
							)}
						>
							{run.status === "running" && (
								<span className="size-1.5 animate-pulse rounded-full bg-green" />
							)}
							{run.status}
						</span>
					</div>
					<div className="mt-0.5 truncate text-xs text-dim tabular-nums">
						{meta.join(" · ")}
					</div>
				</div>
				{run.status === "running" && (
					<button
						className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-red transition-colors hover:border-line-strong hover:bg-panel"
						onClick={() => onCancel(run.runId)}
					>
						Stop
					</button>
				)}
			</div>
			{(run.agents.length > 0 ||
				(run.status === "running" && groups.order.length > 0)) && (
				<div className="flex flex-col px-1.5 pb-2 pt-1">
					{groups.loose.map(agentRow)}
					{groups.order.map((title) => {
						const agents = groups.byPhase.get(title)!;
						// Empty phases only preview upcoming work on a live run.
						if (agents.length === 0 && run.status !== "running") return null;
						const doneN = agents.filter((a) => a.status === "done").length;
						return (
							<div key={title}>
								<div className="flex items-baseline gap-2 px-2 pb-0.5 pt-1.5">
									<span
										className={cn(
											"truncate text-xs font-medium",
											run.status === "running" && title === run.currentPhase
												? "text-fg"
												: "text-faint",
										)}
									>
										{title}
									</span>
									<span className="shrink-0 text-[11px] text-faint tabular-nums">
										{agents.length ? `${doneN}/${agents.length}` : "queued"}
									</span>
								</div>
								{agents.map(agentRow)}
							</div>
						);
					})}
				</div>
			)}
			{run.logs.length > 0 && (
				<div className="border-t border-line px-3 py-2">
					<div className="flex flex-col gap-0.5">
						{(allLogs ? run.logs : run.logs.slice(-20)).map((l, i) => (
							<div
								key={`${l.ts}-${i}`}
								className="text-xs leading-snug text-faint"
							>
								{l.message}
							</div>
						))}
					</div>
					{run.logs.length > 20 && (
						<button
							className="mt-1 text-[11px] font-medium text-dim transition-colors hover:text-fg"
							onClick={() => setAllLogs((v) => !v)}
						>
							{allLogs ? "Show recent" : `Show all ${run.logs.length}`}
						</button>
					)}
				</div>
			)}
			{run.status === "error" && run.error && (
				<div className="border-t border-line px-3 py-2 text-xs text-red">
					{run.error}
				</div>
			)}
			{run.status === "done" && run.result !== undefined && (
				<div className="border-t border-line px-3 py-2">
					<button
						className="text-[11px] font-medium text-dim transition-colors hover:text-fg"
						onClick={() => setShowResult((v) => !v)}
					>
						{showResult ? "Hide result" : "Show result"}
					</button>
					{showResult && (
						<div className="mt-1.5">
							<DetailPre
								text={
									typeof run.result === "string"
										? run.result
										: JSON.stringify(run.result, null, 2)
								}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** One agent row + its lazy drill-in. Memoized so the 1s elapsed ticker only
 *  re-renders rows whose props change (running rows get a new `duration`
 *  string; settled rows bail) — a 200-agent run must not re-render thousands
 *  of nodes per second. The drill-in body mounts only while expanded: the 0fr
 *  grid wrapper stays mounted so the expand still animates (enter-only —
 *  collapse unmounts the content immediately). */
const AgentRow = React.memo(function AgentRow({
	a,
	open,
	detail,
	duration,
	onToggle,
	onLoadDetail,
}: {
	a: WorkflowAgentSnapshot;
	open: boolean;
	detail: WorkflowJournalEntry | "loading" | "missing" | undefined;
	duration: string;
	onToggle: (seq: number) => void;
	onLoadDetail: (seq: number) => void;
}) {
	const full = typeof detail === "object" ? detail : undefined;
	const promptText = full?.prompt ?? a.promptPreview;
	const resultText = full
		? (full.outcome.error ??
			(full.outcome.structured !== undefined
				? JSON.stringify(full.outcome.structured, null, 2)
				: full.outcome.text))
		: (a.error ?? a.resultPreview);
	return (
		<>
			<button
				className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors hover:bg-hover"
				onClick={() => onToggle(a.seq)}
			>
				<StatusMark status={a.status} />
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-sm",
						a.status === "cancelled"
							? "text-faint line-through"
							: "text-fg",
					)}
				>
					{a.label}
				</span>
				{a.cached && <Chip>cached</Chip>}
				{a.model && <Chip>{shortModel(a.model)}</Chip>}
				{a.tokens && (
					<span className="shrink-0 text-[11px] text-faint tabular-nums">
						{fmtTokens(a.tokens.output)} tok
					</span>
				)}
				<span className="w-11 shrink-0 text-right text-[11px] text-faint tabular-nums">
					{duration}
				</span>
			</button>
			<div
				className={cn(
					"grid transition-[grid-template-rows] duration-200 ease-out",
					open
						? "[grid-template-rows:1fr]"
						: "[grid-template-rows:0fr]",
				)}
			>
				<div className="min-h-0 overflow-hidden">
					{open && (
						<div className="mx-2 mb-1.5 mt-0.5 flex flex-col gap-1.5 rounded-sm bg-panel p-2">
							<div className="text-[11px] font-medium text-faint">Prompt</div>
							<DetailPre text={promptText} />
							{(resultText || a.status === "error") && (
								<>
									<div
										className={cn(
											"text-[11px] font-medium",
											a.status === "error" || full?.outcome.error
												? "text-red"
												: "text-faint",
										)}
									>
										{a.status === "error" || full?.outcome.error
											? "Error"
											: "Result"}
									</div>
									<DetailPre text={resultText || "(no output)"} />
								</>
							)}
							{detail === undefined &&
								(a.status === "done" || a.status === "error") && (
									<button
										className="self-start text-[11px] font-medium text-accent hover:underline"
										onClick={() => onLoadDetail(a.seq)}
									>
										Show full prompt & result
									</button>
								)}
							{detail === "loading" && (
								<span className="text-[11px] text-faint">Loading…</span>
							)}
							{detail === "missing" && (
								// Transient failures happen (the snapshot flips done before
								// the journal entry lands) — keep the miss retryable.
								<button
									className="self-start text-[11px] font-medium text-accent hover:underline"
									onClick={() => onLoadDetail(a.seq)}
								>
									Couldn't load the full record — retry
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</>
	);
});
