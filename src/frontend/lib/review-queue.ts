import type { UnifiedSession } from "./types";
import type { OpenPr } from "./api";

export type ReviewBucket = "ready" | "attention" | "waiting";
export type ReviewSource = "mine" | "requested" | "automation" | "other";

export type ReviewQueuePr = OpenPr & {
	mergeable?: string;
};

export interface ReviewQueueItem {
	pr: ReviewQueuePr;
	sessionId: string | null;
	source: ReviewSource;
	bucket: ReviewBucket;
	status: string;
}

function sessionRepo(session: UnifiedSession): string {
	return session.repo || "tella-fusion";
}

function sessionMatchesPr(
	session: UnifiedSession,
	pr: ReviewQueuePr,
	primaryOnly = false,
): boolean {
	if (sessionRepo(session) === pr.repo && session.branch === pr.branch) return true;
	if (primaryOnly) return false;
	return (
		(session.prs || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		) ||
		(session.attachedRepos || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		) ||
		(session.linkedPrs || []).some(
			(ref) => ref.repo === pr.repo && ref.branch === pr.branch,
		)
	);
}

function newest(sessions: UnifiedSession[]): UnifiedSession | null {
	return (
		[...sessions].sort((a, b) =>
			(b.lastActivity || "").localeCompare(a.lastActivity || ""),
		)[0] || null
	);
}

function classify(
	pr: ReviewQueuePr,
	source: ReviewSource,
): Pick<ReviewQueueItem, "bucket" | "status"> {
	const checks = pr.checks;
	const decision = (pr.reviewDecision || "").toUpperCase();
	const conflicting = pr.mergeable === "CONFLICTING";
	// No reported checks means no known CI blocker. This matches the merge action
	// elsewhere in the sidebar and avoids parking PRs outside the rollup window.
	const green = checks.failed === 0 && checks.pending === 0;

	if (pr.isDraft) return { bucket: "waiting", status: "Draft" };
	if (conflicting)
		return { bucket: "attention", status: "Merge conflict" };
	if (checks.failed > 0)
		return {
			bucket: "attention",
			status: `${checks.failed} failing`,
		};
	if (decision === "CHANGES_REQUESTED")
		return { bucket: "attention", status: "Changes requested" };
	if (pr.reviewActive)
		return { bucket: "waiting", status: "Review running" };
	if (source === "requested")
		return { bucket: "attention", status: "Review requested" };
	if (source === "automation" && decision !== "APPROVED") {
		return green
			? { bucket: "attention", status: "Review needed" }
			: checks.pending > 0
				? { bucket: "waiting", status: `${checks.pending} running` }
				: { bucket: "waiting", status: "Checks unknown" };
	}
	if (green && (source === "mine" || decision === "APPROVED")) {
		return {
			bucket: "ready",
			status: decision === "APPROVED" ? "Approved" : "Green",
		};
	}
	if (checks.pending > 0)
		return { bucket: "waiting", status: `${checks.pending} running` };
	if (checks.total === 0)
		return { bucket: "waiting", status: "Checks unknown" };
	return { bucket: "waiting", status: "Awaiting review" };
}

/**
 * Build one actionable row per open PR. Source is about why the PR belongs in
 * this person's inbox; bucket is about what they can do with it right now.
 */
export function buildReviewQueue(
	prs: ReviewQueuePr[],
	sessions: UnifiedSession[],
	currentUser: string,
	githubLogin: string | null,
): ReviewQueueItem[] {
	const me = currentUser.trim().split(/\s+/)[0]?.toLowerCase() || "";
	const github = githubLogin?.toLowerCase() || "";
	const seen = new Set<string>();
	const items: ReviewQueueItem[] = [];

	for (const pr of prs) {
		if (!pr.url || seen.has(pr.url)) continue;
		seen.add(pr.url);

		const related = sessions.filter((session) => sessionMatchesPr(session, pr));
		const primary = related.filter(
			(session) =>
				!session.archived && sessionMatchesPr(session, pr, true),
		);
		const automation = pr.author.toLowerCase() === "tella-butler";
		const requested = (pr.reviewRequested || []).some(
			(person) => person.toLowerCase() === me,
		);
		const mine =
			!automation &&
			!!github &&
			pr.author.toLowerCase() === github;
		const source: ReviewSource = requested
			? "requested"
			: automation
				? "automation"
				: mine
					? "mine"
					: "other";
		const state = classify(pr, source);

		items.push({
			pr,
			sessionId: newest(primary)?.id || null,
			source,
			...state,
		});
	}

	return items.sort((a, b) =>
		(b.pr.updatedAt || "").localeCompare(a.pr.updatedAt || ""),
	);
}
