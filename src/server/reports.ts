/**
 * Reports — first-class recurring documents produced by automations (morning
 * support digest today; AWS-spend / churn / MRR analyses tomorrow). One
 * self-contained HTML file + JSON sidecar per report, grouped per automation:
 *
 *   ~/.opensession-reports/<automationId>/<reportId>.html
 *   ~/.opensession-reports/<automationId>/<reportId>.json
 *
 * Report ids are timestamp-prefixed so lexicographic order = chronological.
 * Published from agent runs via the opensession-report in-process MCP
 * (src/agents/slack/report-tools.ts — publish-only, wired into every
 * automation run); browsed via routes/reports.ts and the frontend Reports
 * view (left: one row per automation with history, right: the rendered HTML).
 * Publishes broadcast `reports_changed` so open Reports views refresh.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { writeJsonAtomic } from "./shared/atomic-write";
import { broadcastToAll } from "./ws-hub";
import { writeFileSync } from "fs";

export const REPORTS_ROOT = join(homedir(), ".opensession-reports");

/** Reports an automation may keep; older ones are pruned on publish. */
const MAX_REPORTS_PER_GROUP = 100;
/** A report is one self-contained HTML document — keep it bounded. */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export interface ReportMeta {
	/** Timestamp-prefixed id, unique within the group (= the filename stem). */
	id: string;
	title: string;
	/** Grouping key: the publishing automation's id. */
	automationId: string;
	/** Display name captured at publish time (survives automation renames). */
	automationName: string;
	/** The run's session, so the UI can link back to the producing session. */
	sessionId?: string;
	createdAt: string;
	/** Short plain-text gist for list rows / notifications. */
	summary?: string;
}

export interface ReportGroup {
	automationId: string;
	automationName: string;
	count: number;
	latest: ReportMeta;
}

/** Path-segment guard for ids that travel through URLs. */
function safeSegment(s: string): boolean {
	return /^[\w.-]+$/.test(s);
}

function groupDir(automationId: string): string {
	return join(REPORTS_ROOT, automationId);
}

/** Sidecar filenames in a group dir, newest first (ids sort chronologically). */
function sidecarsFor(automationId: string): string[] {
	const dir = groupDir(automationId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.reverse();
}

function readMeta(automationId: string, sidecar: string): ReportMeta | null {
	try {
		const raw = readFileSync(join(groupDir(automationId), sidecar), "utf8");
		const meta = JSON.parse(raw) as ReportMeta;
		return meta && typeof meta.id === "string" ? meta : null;
	} catch {
		return null;
	}
}

export function publishReport(input: {
	automationId: string;
	automationName: string;
	sessionId?: string;
	title: string;
	html: string;
	summary?: string;
}): ReportMeta {
	if (!safeSegment(input.automationId)) {
		throw new Error(`Invalid automation id "${input.automationId}"`);
	}
	const bytes = Buffer.byteLength(input.html, "utf8");
	if (!input.html.trim()) throw new Error("Report HTML is empty");
	if (bytes > MAX_REPORT_BYTES) {
		throw new Error(
			`Report too large (${bytes} bytes > ${MAX_REPORT_BYTES}) — a report is one self-contained HTML document, trim embedded data`,
		);
	}
	const now = new Date();
	// 2026-07-12-060002-4f3a: lexicographic = chronological, readable on disk.
	const stamp = now
		.toISOString()
		.slice(0, 19)
		.replace("T", "-")
		.replace(/:/g, "");
	const id = `${stamp}-${Math.random().toString(16).slice(2, 6)}`;
	const meta: ReportMeta = {
		id,
		title: (input.title || "Untitled report").trim().slice(0, 200),
		automationId: input.automationId,
		automationName: (input.automationName || "?").trim().slice(0, 120),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		createdAt: now.toISOString(),
		...(input.summary
			? { summary: input.summary.trim().slice(0, 2000) }
			: {}),
	};
	const dir = groupDir(input.automationId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.html`), input.html, "utf8");
	writeJsonAtomic(join(dir, `${id}.json`), meta);
	// Prune beyond the cap (both files) — newest first, drop the tail.
	for (const stale of sidecarsFor(input.automationId).slice(
		MAX_REPORTS_PER_GROUP,
	)) {
		try {
			rmSync(join(dir, stale));
			rmSync(join(dir, stale.replace(/\.json$/, ".html")), {
				force: true,
			});
		} catch {}
	}
	broadcastToAll({ type: "reports_changed", automationId: input.automationId });
	return meta;
}

/** One row per automation that has published at least one report. */
export function listReportGroups(): ReportGroup[] {
	if (!existsSync(REPORTS_ROOT)) return [];
	const groups: ReportGroup[] = [];
	for (const entry of readdirSync(REPORTS_ROOT, { withFileTypes: true })) {
		if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
		const sidecars = sidecarsFor(entry.name);
		if (!sidecars.length) continue;
		const latest = readMeta(entry.name, sidecars[0]);
		if (!latest) continue;
		groups.push({
			automationId: entry.name,
			automationName: latest.automationName,
			count: sidecars.length,
			latest,
		});
	}
	return groups.sort((a, b) =>
		b.latest.createdAt.localeCompare(a.latest.createdAt),
	);
}

/** A group's full history, newest first. */
export function listReports(automationId: string): ReportMeta[] {
	if (!safeSegment(automationId)) return [];
	return sidecarsFor(automationId)
		.map((s) => readMeta(automationId, s))
		.filter((m): m is ReportMeta => !!m);
}

/** The report HTML itself, or null when it doesn't exist. */
export function readReportHtml(
	automationId: string,
	reportId: string,
): string | null {
	if (!safeSegment(automationId) || !safeSegment(reportId)) return null;
	const file = join(groupDir(automationId), `${reportId}.html`);
	if (!existsSync(file)) return null;
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}
