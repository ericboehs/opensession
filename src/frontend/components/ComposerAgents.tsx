import React, { useMemo, useState } from "react";
import type { WorkflowRunSnapshot } from "../../server/workflow-types";
import type { SessionSubagentSnapshot } from "../lib/api";
import { cn } from "../ui/cn";
import { IconChevronDown, IconChevronRight } from "./icons";

/**
 * Phone-only "agents running" flap above the composer. On a phone the Agents
 * right-panel tab is hidden behind the collapsed overlay panel, so a live
 * workflow fan-out has no glance. This is a three-step progression:
 *
 *   collapsed pill  →  expanded mini-card  →  full Agents panel
 *
 * The pill (always visible) summarizes: running count · done/total · current
 * phase. Tapping it expands an in-place mini-card with the phase stepper, agent
 * tallies (running / done / queued / failed), and the labels of what's actually
 * running right now — without leaving the composer. "Open full panel" hands off
 * to the sidebar for the transcript-level drill-in.
 *
 * `runs` is the caller-filtered list of *running* workflow runs (usually one).
 * `subagents` (direct task-tool spawns, passed only while one is live) fold
 * into the same tallies and running-labels list — the phase stepper stays
 * workflow-only. When both empty the parent unmounts us, resetting the
 * expand state.
 */
interface Props {
	runs: WorkflowRunSnapshot[];
	subagents?: SessionSubagentSnapshot[];
	onOpenPanel: () => void;
}

/** The tally/label subset both agent flavors share. */
interface GlanceAgent {
	key: string;
	label: string;
	status: string;
	phase?: string;
}

export function ComposerAgents({ runs, subagents, onOpenPanel }: Props) {
	const [open, setOpen] = useState(false);

	const stats = useMemo(() => {
		const agents: GlanceAgent[] = [
			...runs.flatMap((r) =>
				r.agents.map((a) => ({
					key: `wf-${r.runId}-${a.seq}`,
					label: a.label,
					status: a.status,
					phase: a.phase,
				})),
			),
			...(subagents ?? []).map((s, i) => ({
				key: s.id ?? `sub-${i}`,
				label: s.label,
				status: s.status,
			})),
		];
		const running = agents.filter((a) => a.status === "running");
		const done = agents.filter((a) => a.status === "done").length;
		const pending = agents.filter((a) => a.status === "pending").length;
		const error = agents.filter((a) => a.status === "error").length;
		const single = runs.length === 1 ? runs[0] : null;
		const steps = single?.phases ?? [];
		// currentPhase is a title; its index in the ordered phases list is the
		// step number. -1 (unknown/absent) → treat as the first step.
		const curIdx = single?.currentPhase
			? Math.max(0, steps.indexOf(single.currentPhase))
			: 0;
		return {
			total: agents.length,
			running,
			runningCount: running.length,
			done,
			pending,
			error,
			single,
			steps,
			curIdx,
			phase: single?.currentPhase,
		};
	}, [runs]);

	const {
		total,
		running,
		runningCount,
		done,
		pending,
		error,
		single,
		steps,
		curIdx,
		phase,
	} = stats;

	return (
		<div className="composer-agents" data-open={open ? "" : undefined}>
			{open && (
				<div className="composer-agents-detail">
					<div className="composer-agents-name">
						{single
							? single.name
							: runs.length > 0
								? `${runs.length} workflows running`
								: "Sub-agents"}
					</div>

					{steps.length > 1 && (
						<ol className="composer-agents-steps">
							{steps.map((s, i) => (
								<li
									key={s}
									className={cn(
										"composer-agents-step",
										i < curIdx && "is-done",
										i === curIdx && "is-current",
									)}
								>
									<span className="composer-agents-step-mark">
										{i < curIdx ? "✓" : i + 1}
									</span>
									<span className="composer-agents-step-label">{s}</span>
								</li>
							))}
						</ol>
					)}

					<div className="composer-agents-tallies">
						<span>
							<i className="composer-agents-dot" />
							{runningCount} running
						</span>
						{done > 0 && (
							<span className="is-done">
								{done}/{total} done
							</span>
						)}
						{pending > 0 && <span className="is-dim">{pending} queued</span>}
						{error > 0 && <span className="is-error">{error} failed</span>}
					</div>

					{running.length > 0 && (
						<ul className="composer-agents-list">
							{running.slice(0, 4).map((a) => (
								<li key={a.key}>
									<i className="composer-agents-dot sm" />
									<span className="composer-agents-list-label">{a.label}</span>
									{a.phase && single?.phases?.length !== 1 ? (
										<span className="is-dim"> · {a.phase}</span>
									) : null}
								</li>
							))}
							{running.length > 4 && (
								<li className="is-dim">+{running.length - 4} more</li>
							)}
						</ul>
					)}

					<button
						type="button"
						className="composer-agents-open"
						onClick={onOpenPanel}
					>
						Open full panel
						<IconChevronRight size={15} />
					</button>
				</div>
			)}

			<button
				type="button"
				className="composer-agents-summary"
				aria-expanded={open}
				aria-label={open ? "Collapse running agents" : "Show running agents"}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="composer-agents-dot" />
				<span className="composer-agents-label">
					<strong>{runningCount} running</strong>
					{total > runningCount ? (
						<span className="is-dim"> · {done}/{total} done</span>
					) : null}
					{!open && phase ? <span className="is-dim"> · {phase}</span> : null}
				</span>
				<IconChevronDown
					size={16}
					className={cn("composer-agents-caret", open && "is-open")}
				/>
			</button>
		</div>
	);
}
