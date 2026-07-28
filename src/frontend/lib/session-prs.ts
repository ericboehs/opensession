import type { UnifiedSession } from "./types";

/** Bare attached branches are targets, not PRs; every explicit PR still counts. */
function pullRequests(session: UnifiedSession) {
	return (session.prs || []).filter(
		(ref) =>
			ref.source !== "attached" ||
			ref.number != null ||
			ref.url != null ||
			ref.state != null,
	);
}

/** A multi-PR session has landed once every actual PR is terminal and one merged. */
export function sessionPrMerged(session: UnifiedSession): boolean {
	const refs = pullRequests(session);
	if (refs.length > 0)
		return (
			refs.every((ref) => ref.state === "MERGED" || ref.state === "CLOSED") &&
			refs.some((ref) => ref.state === "MERGED")
		);
	return session.prState === "MERGED";
}

/** A multi-PR session is reviewed once no actual PR is still awaiting review. */
export function sessionPrApproved(session: UnifiedSession): boolean {
	const refs = pullRequests(session);
	if (refs.length > 0)
		return refs.every(
			(ref) =>
				ref.state === "MERGED" ||
				ref.state === "CLOSED" ||
				ref.reviewDecision === "APPROVED",
		);
	return session.prReviewDecision === "APPROVED";
}
