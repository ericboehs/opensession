/** Superseded automated reviews remain on GitHub for history, not as actionable discussion. */
export function isOutdatedReviewComment(body: string): boolean {
	return /<!--\s*(?:os|michael)-review-outdated\s*-->/.test(body);
}
