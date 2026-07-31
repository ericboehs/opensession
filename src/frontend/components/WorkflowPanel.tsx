import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BASE_PATH } from "../lib/base";
import type {
	WorkflowAgentSnapshot,
	WorkflowJournalEntry,
	WorkflowRunSnapshot,
} from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { cn } from "../ui/cn";
import { Button } from "../ui/button";
import { friendlyModelSlug, opencodeModelParts } from "./ModelEffortSelect";
import { WorkflowAgentTranscript } from "./WorkflowAgentTranscript";

/**
 * Agents tab: live view of a session's dynamic workflow runs (the
 * opensession-workflows MCP). Renders WorkflowRunSnapshot cards — newest run
 * first — with agents grouped by phase, a narrator log feed, and a per-agent
 * drill-in that lazily fetches the full journal entry
 * (/api/workflows/:runId/agents/:seq). Snapshots arrive via the
 * workflow_update WS broadcast; this component is a pure renderer plus the
 * drill-in fetch. Never mounted with zero runs (the tab itself hides).
 *
 * Two levels of drill-in:
 *  - the row expands in place to the full prompt/result (journal entry), and
 *  - "View conversation" swaps the whole panel for WorkflowAgentTranscript —
 *    the agent's real conversation (its tool calls / steps), live while it
 *    runs. The selected agent is re-resolved from `runs` every render so the
 *    WS snapshot keeps its header status/duration honest.
 *
 * Write agents (opts.write — code mode in their own isolated worktree) carry a
 * branch chip + diffstat + merge badge on their row.
 */

interface Props {
	sessionId: string;
	runs: WorkflowRunSnapshot[];
	onCancel: (runId: string) => void;
	/** Sub-agents the session spawned directly (task tool) — rendered as their
	 *  own card above the workflow runs. */
	subagents?: SessionSubagentSnapshot[];
	/** Opens a sub-agent's conversation in its own view tab. */
	onOpenSubagent?: (agentId: string, label: string) => void;
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

function Chip({
	children,
	tone,
	title,
}: {
	children: React.ReactNode;
	/** Merge outcome tints; default is the neutral outlined chip. */
	tone?: "green" | "red";
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"shrink-0 rounded-sm border px-1 py-px text-[11px] font-medium",
				tone === "green"
					? "border-transparent bg-green-soft text-green"
					: tone === "red"
						? "border-transparent bg-red-soft text-red"
						: "border-line text-faint",
			)}
		>
			{children}
		</span>
	);
}

/** Write-agent readout: branch + diffstat (or "no changes") + merge outcome. */
function WriteChips({ a }: { a: WorkflowAgentSnapshot }) {
	const files = a.filesChanged ?? 0;
	return (
		<>
			{a.branch && (
				<Chip title={a.branch}>
					<span>⑂ {a.branch}</span>
				</Chip>
			)}
			{a.changed ? (
				<span className="shrink-0 text-[11px] tabular-nums">
					<span className="text-green">+{a.insertions ?? 0}</span>{" "}
					<span className="text-red">−{a.deletions ?? 0}</span>
					{files > 0 && (
						<span className="text-faint">
							{" "}
							· {files} file{files === 1 ? "" : "s"}
						</span>
					)}
				</span>
			) : (
				a.status === "done" && <Chip>no changes</Chip>
			)}
			{a.merged === "merged" && <Chip tone="green">merged</Chip>}
			{a.merged === "conflict" && <Chip tone="red">conflict</Chip>}
		</>
	);
}

function DetailPre({ text }: { text: string }) {
	return (
		<pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface p-2 font-mono text-meta leading-relaxed text-dim">
			{text}
		</pre>
	);
}

export function WorkflowPanel({
	sessionId: _sessionId,
	runs,
	onCancel,
	subagents,
	onOpenSubagent,
}: Props) {
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
	const subs = subagents ?? [];
	const anyRunning =
		ordered.some((r) => r.status === "running") ||
		subs.some((s) => s.status === "running");
	// 1s heartbeat for elapsed/duration readouts, only while something is live.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!anyRunning) return;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [anyRunning]);

	// The open agent conversation, if any. Held as ids (not the snapshot) so the
	// drilled-in view tracks the live WS snapshot rather than a frozen copy.
	const [openConvo, setOpenConvo] = useState<{
		runId: string;
		seq: number;
	} | null>(null);
	const onOpenAgent = useCallback(
		(runId: string, seq: number) => setOpenConvo({ runId, seq }),
		[],
	);
	const onBack = useCallback(() => setOpenConvo(null), []);
	const convoAgent = useMemo(() => {
		if (!openConvo) return undefined;
		return ordered
			.find((r) => r.runId === openConvo.runId)
			?.agents.find((a) => a.seq === openConvo.seq);
	}, [openConvo, ordered]);

	if (openConvo && convoAgent)
		return (
			<WorkflowAgentTranscript
				runId={openConvo.runId}
				agent={convoAgent}
				onBack={onBack}
			/>
		);

	if (ordered.length === 0 && subs.length === 0) return <WorkflowsEmptyState />;
	return (
		<div className="flex flex-col gap-3 p-3 pb-6">
			{subs.length > 0 && (
				<SubagentsCard subagents={subs} now={now} onOpen={onOpenSubagent} />
			)}
			{ordered.map((run) => (
				<RunCard
					key={run.runId}
					run={run}
					now={now}
					onCancel={onCancel}
					onOpenAgent={onOpenAgent}
				/>
			))}
		</div>
	);
}

/** Sub-agents the session spawned directly with the task tool (opencode child
 *  sessions / Claude-SDK Task agents) — one card in the same visual grammar as
 *  a workflow run: StatusMark rows with agent-type/model chips, tokens and
 *  duration. Clicking a row opens the sub-agent's real conversation in the
 *  sub-agent view tab (the id doubles as the fetchSubagent key). */
function SubagentsCard({
	subagents,
	now,
	onOpen,
}: {
	subagents: SessionSubagentSnapshot[];
	now: number;
	onOpen?: (agentId: string, label: string) => void;
}) {
	const runningN = subagents.filter((s) => s.status === "running").length;
	const errorN = subagents.filter((s) => s.status === "error").length;
	const tokens = subagents.reduce((n, s) => n + (s.tokensOut ?? 0), 0);
	const meta: string[] = [
		`${subagents.length} sub-agent${subagents.length === 1 ? "" : "s"}`,
	];
	if (runningN) meta.push(`${runningN} running`);
	if (errorN) meta.push(`${errorN} failed`);
	if (tokens) meta.push(`${fmtTokens(tokens)} tok`);
	return (
		<div className="rounded-md border border-line bg-surface">
			<div className="px-3 pb-1 pt-2.5">
				<div className="flex items-center gap-2">
					<span className="truncate text-sm font-semibold text-fg">
						Sub-agents
					</span>
					{runningN > 0 && (
						<span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-green-soft px-1.5 py-0.5 text-[11px] font-medium text-green">
							<span className="size-1.5 animate-pulse rounded-full bg-green" />
							running
						</span>
					)}
				</div>
				<div className="mt-0.5 truncate text-xs text-dim tabular-nums">
					{meta.join(" · ")}
				</div>
			</div>
			<div className="flex flex-col px-1.5 pb-2 pt-1">
				{subagents.map((s, i) => {
					const openable = Boolean(s.id && onOpen);
					const durMs =
						s.startedAt !== undefined
							? (s.endedAt ?? (s.status === "running" ? now : undefined)) !==
								undefined
								? (s.endedAt ?? now) - s.startedAt
								: undefined
							: undefined;
					return (
						<button
							key={s.id ?? `pending-${i}`}
							className={cn(
								"flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors",
								openable ? "hover:bg-hover" : "cursor-default",
							)}
							onClick={() => {
								if (s.id && onOpen) onOpen(s.id, s.label);
							}}
							title={openable ? "Open this sub-agent's conversation" : undefined}
						>
							<StatusMark status={s.status} />
							<span className="min-w-0 flex-1 truncate text-sm text-fg">
								{s.label}
							</span>
							{s.agentType && <Chip>{s.agentType}</Chip>}
							{s.model && <Chip>{shortModel(s.model)}</Chip>}
							{s.tokensOut ? (
								<span className="shrink-0 text-[11px] text-faint tabular-nums">
									{fmtTokens(s.tokensOut)} tok
								</span>
							) : null}
							<span className="w-11 shrink-0 text-right text-[11px] text-faint tabular-nums">
								{durMs !== undefined ? fmtDuration(durMs) : ""}
							</span>
							{openable && (
								<span className="shrink-0 text-[11px] text-faint">→</span>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** The discovery surface: with no runs yet, this tab is the only place that
 *  tells you dynamic workflows exist and how to kick one off. */
function WorkflowsEmptyState() {
	return (
		<div className="flex flex-col gap-4 p-4 pb-6">
			<div>
				<div className="mb-1.5 text-sm font-medium text-fg">
					No agent runs yet
				</div>
				<p className="text-xs leading-relaxed text-dim">
					Ask this session to <span className="text-fg">use a workflow</span> and
					it will write a script that fans out many focused agents at once —
					one per file, per topic, per candidate — then combine their results.
					Agents read this worktree by default; write agents get their own
					isolated branch and can be merged back. They&rsquo;ll show up here
					live, grouped by phase — open one to watch what it&rsquo;s doing.
				</p>
			</div>
			<div>
				<div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
					Try
				</div>
				<div className="flex flex-col gap-1.5">
					{[
						"Use a workflow to audit every route handler for missing auth checks.",
						"Use a workflow: one agent per file over src/, each reporting its biggest refactor. Then rank the top 5.",
						"Use a workflow to compare 3 approaches to this problem in parallel and pick a winner.",
						"Use a workflow with write agents: one per file, migrate each to the new API, then merge them.",
					].map((s) => (
						<div
							key={s}
							className="rounded-sm border border-line bg-surface px-2.5 py-2 font-mono text-meta leading-relaxed text-dim"
						>
							{s}
						</div>
					))}
				</div>
			</div>
			<p className="text-xs leading-relaxed text-faint">
				Write agents each work in their own isolated worktree, so they never
				collide; merging back into this session&rsquo;s branch is explicit. For
				heavier, steerable work that opens PRs, ask this session to spawn tasks
				instead.
			</p>
		</div>
	);
}

function RunCard({
	run,
	now,
	onCancel,
	onOpenAgent,
}: {
	run: WorkflowRunSnapshot;
	now: number;
	onCancel: (runId: string) => void;
	onOpenAgent: (runId: string, seq: number) => void;
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
	const [showMcp, setShowMcp] = useState(false);

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
	// Direct mcp.* calls the script made — cheap work that never became an
	// agent row, so without this the panel understates what the run did.
	if (run.totals.mcpCalls) {
		const failed = run.totals.mcpErrors
			? `, ${run.totals.mcpErrors} failed`
			: "";
		meta.push(
			`${run.totals.mcpCalls} tool call${run.totals.mcpCalls === 1 ? "" : "s"}${failed}`,
		);
	}
	if (run.totals.tokensOut) meta.push(`${fmtTokens(run.totals.tokensOut)} tok`);
	if (elapsedMs > 0 || run.status === "running")
		meta.push(fmtDuration(elapsedMs));

	const openConversation = useCallback(
		(seq: number) => onOpenAgent(run.runId, seq),
		[onOpenAgent, run.runId],
	);

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
				onOpenConversation={openConversation}
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
					<Button
						variant="danger"
						size="sm"
						className="shrink-0"
						onClick={() => onCancel(run.runId)}
					>
						Stop
					</Button>
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
			{!!run.mcpCalls?.length && (
				<div className="border-t border-line px-3 py-2">
					<button
						className="text-[11px] font-medium text-dim transition-colors hover:text-fg"
						onClick={() => setShowMcp((v) => !v)}
					>
						{showMcp ? "Hide" : "Show"} tool calls
						{run.totals.mcpCalls && run.totals.mcpCalls > run.mcpCalls.length
							? ` (last ${run.mcpCalls.length} of ${run.totals.mcpCalls})`
							: ""}
					</button>
					{showMcp && (
						<div className="mt-1 flex flex-col gap-0.5">
							{run.mcpCalls.map((c, i) => (
								<div
									key={`${c.seq}-${i}`}
									className="flex items-baseline gap-2 text-xs leading-snug"
								>
									<span className={cn("shrink-0", c.ok ? "text-faint" : "text-red")}>
										{c.ok ? "·" : "✗"}
									</span>
									<span className="truncate text-dim">
										{c.server}.{c.tool}
									</span>
									<span className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">
										{c.cached ? "cached" : `${c.ms}ms`}
									</span>
								</div>
							))}
						</div>
					)}
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
	onOpenConversation,
}: {
	a: WorkflowAgentSnapshot;
	open: boolean;
	detail: WorkflowJournalEntry | "loading" | "missing" | undefined;
	duration: string;
	onToggle: (seq: number) => void;
	onLoadDetail: (seq: number) => void;
	onOpenConversation: (seq: number) => void;
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
				{a.write && <WriteChips a={a} />}
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
							{/* The headline affordance: what the agent actually DID, not
							    just what it said at the end. Available even while it runs
							    (the transcript view polls). */}
							{a.status !== "pending" && (
								<Button
									size="xs"
									className="self-start"
									onClick={() => onOpenConversation(a.seq)}
								>
									View conversation
									<span className="text-faint">→</span>
								</Button>
							)}
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
