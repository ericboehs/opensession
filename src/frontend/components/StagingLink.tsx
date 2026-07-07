import { useEffect, useState } from "react";
import { fetchPr } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { IconArrowUpRight, IconGlobe } from "./icons";

/**
 * Header link to the PR's staging deploy (the Vercel preview at
 * https://tella-git-<branch>.tella.dev) so a change can be tested on real
 * infra in one click. The URL comes from the PR details endpoint, which parses
 * tella-butler's preview-table comment — so the link only appears when a
 * webapp deploy actually exists for the PR (fusion PRs that don't touch the
 * webapp never get one). While the deploy is still building the link renders
 * dimmed; it flips live on the next poll.
 */
export function StagingLink({
	session,
	variant = "bar",
}: {
	session: UnifiedSession;
	/** "bar" = the labelled Staging link (right panel's action row); "header" = a
	 *  single state-colored 🌐 icon (amber while building, green once Ready) for
	 *  the session header, sized to match the panel-toggle icon beside it. */
	variant?: "bar" | "header";
}) {
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
	// Deep-link to the agent-flagged route (set_preview_path) so the button
	// opens the feature under test, not the app root.
	const href = withPreviewPath(staging.url, session.previewPath);

	if (variant === "header") {
		return (
			<Tooltip
				label={
					building
						? `Staging deploy ${staging.status.toLowerCase()}…`
						: "Open staging deploy — test this PR on real infra"
				}
				side="bottom"
			>
				<a
					href={href}
					target="_blank"
					rel="noopener"
					className={`viewer-code-icon staging-icon ${building ? "is-building" : "is-ready"}`}
				>
					<IconGlobe size={26} />
				</a>
			</Tooltip>
		);
	}

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			className={`staging-link ${building ? "staging-link-building" : ""}`}
			title={
				building
					? `Staging deploy ${staging.status.toLowerCase()}… — ${href}`
					: `Test this PR on staging — ${href}`
			}
		>
			<IconGlobe size={15} className="staging-globe" />
			Staging
			<IconArrowUpRight size={15} className="staging-ext" />
		</a>
	);
}
