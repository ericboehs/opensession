import React, { useEffect, useState } from "react";
import { docTitle } from "../lib/brand";
import {
	fetchReportGroups,
	fetchReports,
	reportRawUrl,
} from "../lib/api";
import type { ReportGroup, ReportMeta } from "../lib/types";
import { IconChevronRight, IconFile } from "./icons";

interface Props {
	selectedAutomationId?: string;
	selectedReportId?: string;
	onSelect: (automationId: string, reportId?: string) => void;
	onOpenSession: (id: string) => void;
	addHandler: (handler: (message: any) => void) => () => void;
}

function formatDate(value: string, detailed = false): string {
	const date = new Date(value);
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		...(detailed ? { year: "numeric", hour: "numeric", minute: "2-digit" } : {}),
	}).format(date);
}

export function Reports({
	selectedAutomationId,
	selectedReportId,
	onSelect,
	onOpenSession,
	addHandler,
}: Props) {
	const [groups, setGroups] = useState<ReportGroup[] | null>(null);
	const [history, setHistory] = useState<ReportMeta[]>([]);
	const [error, setError] = useState("");

	async function loadGroups() {
		try {
			const next = await fetchReportGroups();
			setGroups(next);
			setError("");
			if (!selectedAutomationId && next[0]) onSelect(next[0].automationId);
		} catch (e: any) {
			setError(e?.message || "Failed to load reports");
			setGroups([]);
		}
	}

	useEffect(() => {
		document.title = docTitle("Reports");
		loadGroups();
		return addHandler((message) => {
			if (message.type === "reports_changed") loadGroups();
		});
	}, [addHandler]);

	useEffect(() => {
		if (!selectedAutomationId) {
			setHistory([]);
			return;
		}
		let alive = true;
		fetchReports(selectedAutomationId)
			.then((reports) => {
				if (!alive) return;
				setHistory(reports);
				if (!selectedReportId && reports[0])
					onSelect(selectedAutomationId, reports[0].id);
			})
			.catch((e) => alive && setError(e?.message || "Failed to load history"));
		return () => {
			alive = false;
		};
	}, [selectedAutomationId]);

	const selected = history.find((report) => report.id === selectedReportId) || history[0];

	if (groups === null)
		return <div className="flex flex-1 items-center justify-center text-dim">Loading reports…</div>;

	if (!groups.length)
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<div className="max-w-[420px] text-center">
					<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-lg bg-surface text-dim">
						<IconFile size={24} />
					</div>
					<h1 className="m-0 text-xl font-semibold text-fg">Reports</h1>
					<p className="mt-2 text-sm leading-6 text-dim">
						Recurring automation reports will collect here, with the latest result and full history in one place.
					</p>
					{error && <p className="mt-3 text-sm text-red">{error}</p>}
				</div>
			</div>
		);

	return (
		<div className="flex min-h-0 flex-1 max-[720px]:flex-col">
			<aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel max-[720px]:w-full max-[720px]:max-h-[38vh] max-[720px]:border-r-0 max-[720px]:border-b">
				<div className="border-b border-line px-4 py-4">
					<h1 className="m-0 text-lg font-semibold tracking-[-0.02em] text-fg">Reports</h1>
					<p className="m-0 mt-1 text-xs text-dim">Recurring intelligence, organized by automation</p>
				</div>
				<div className="min-h-0 overflow-y-auto p-2">
					{groups.map((group) => (
						<button
							key={group.automationId}
							type="button"
							className={`mb-1 flex w-full items-start gap-3 rounded-md border-0 px-3 py-3 text-left cursor-pointer ${selectedAutomationId === group.automationId ? "bg-active" : "bg-transparent hover:bg-hover"}`}
							onClick={() => onSelect(group.automationId)}
						>
							<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-surface text-accent"><IconFile size={17} /></span>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-sm font-medium text-fg">{group.automationName}</span>
								<span className="mt-1 block truncate text-xs text-dim">{group.latest.title}</span>
								<span className="mt-1.5 block text-[11px] text-faint">{formatDate(group.latest.createdAt)} · {group.count} {group.count === 1 ? "report" : "reports"}</span>
							</span>
							<IconChevronRight size={16} className="mt-2 shrink-0 text-faint" />
						</button>
					))}
				</div>
			</aside>

			<section className="flex min-w-0 flex-1 flex-col bg-bg">
				{selected && (
					<>
						<header className="flex shrink-0 items-start gap-4 border-b border-line px-5 py-3">
							<div className="min-w-0 flex-1">
								<h2 className="m-0 truncate text-base font-semibold text-fg">{selected.title}</h2>
								<p className="m-0 mt-1 text-xs text-dim">{formatDate(selected.createdAt, true)}{selected.summary ? ` · ${selected.summary}` : ""}</p>
							</div>
							{selected.sessionId && <button type="button" className="shrink-0 rounded-md border border-line bg-panel px-3 py-1.5 text-xs text-fg cursor-pointer hover:bg-hover" onClick={() => onOpenSession(selected.sessionId!)}>Open run</button>}
							<select
								aria-label="Report history"
								className="max-w-[190px] shrink-0 rounded-md border border-line bg-panel px-2 py-1.5 text-xs text-fg"
								value={selected.id}
								onChange={(event) => onSelect(selected.automationId, event.target.value)}
							>
								{history.map((report) => <option key={report.id} value={report.id}>{formatDate(report.createdAt, true)}</option>)}
							</select>
						</header>
						<iframe
							key={selected.id}
							title={selected.title}
							sandbox="allow-same-origin"
							src={reportRawUrl(selected.automationId, selected.id)}
							className="min-h-0 flex-1 border-0 bg-white"
						/>
					</>
				)}
			</section>
		</div>
	);
}
