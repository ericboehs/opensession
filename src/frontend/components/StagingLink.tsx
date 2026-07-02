import { useEffect, useState } from "react";
import { fetchPr } from "../lib/api";
import type { UnifiedSession } from "../lib/types";

/**
 * Header link to the PR's staging deploy (the Vercel preview at
 * https://tella-git-<branch>.tella.dev) so a change can be tested on real
 * infra in one click. The URL comes from the PR details endpoint, which parses
 * tella-butler's preview-table comment — so the link only appears when a
 * webapp deploy actually exists for the PR (fusion PRs that don't touch the
 * webapp never get one). While the deploy is still building the link renders
 * dimmed; it flips live on the next poll.
 */
export function StagingLink({ session }: { session: UnifiedSession }) {
	const [staging, setStaging] = useState<{ url: string; status: string } | null>(
		null,
	);

	// Only fusion PRs get butler previews, and a merged/closed PR's alias no
	// longer points at this change — the link is a pre-merge testing affordance.
	const relevant =
		!!session.prUrl &&
		session.prState === "OPEN" &&
		(session.repo ?? "tella-fusion") === "tella-fusion";

	useEffect(() => {
		if (!relevant) {
			setStaging(null);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(session.id)
				.then((pr) => alive && setStaging(pr?.staging ?? null))
				.catch(() => {});
		load();
		// Slow poll so a Building deploy flips to Ready; the server caches PR
		// details for 30s so this stays cheap.
		const t = setInterval(load, 60000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [session.id, relevant]);

	if (!relevant || !staging) return null;

	const building = staging.status !== "Ready";
	return (
		<a
			href={staging.url}
			target="_blank"
			rel="noopener"
			className={`session-link session-link-staging ${building ? "session-link-staging-building" : ""}`}
			title={
				building
					? `Staging deploy ${staging.status.toLowerCase()}… — ${staging.url}`
					: `Test this PR on staging — ${staging.url}`
			}
		>
			Staging ↗
		</a>
	);
}
