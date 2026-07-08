import { useEffect, useState } from "react";
import { fetchPr } from "../lib/api";
import type { PrCheck, UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconArrowUpRight, IconGlobe } from "./icons";
import { checkClass, isDeployment } from "./PrPanel";

/**
 * Header link to the PR's staging deploy (the Vercel preview at
 * https://tella-git-<branch>.tella.dev) so a change can be tested on real
 * infra in one click. The URL comes from the PR details endpoint, which parses
 * tella-butler's preview-table comment — so the link only appears when a
 * webapp deploy actually exists for the PR (fusion PRs that don't touch the
 * webapp never get one). While the deploy is still building the link renders
 * dimmed; it flips live on the next poll.
 *
 * Before butler posts the comment at all there's still a window where we KNOW a
 * deploy is coming — the Vercel preview shows up as a pending StatusContext in
 * the PR checks first. In that window we render a shimmering placeholder globe
 * (no URL to click yet) so the staging affordance loads in lockstep with the
 * checks headline instead of popping in cold once the URL lands. The shimmer is
 * gated on a *pending deploy check* so it never appears on backend-only PRs
 * that will never deploy (they'd otherwise shimmer forever).
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
	// A Vercel preview deploy is queued/running but butler hasn't posted the URL
	// comment yet — enough to show a loading placeholder, not enough to link.
	const [deployPending, setDeployPending] = useState(false);
	const { copied, copy } = useCopy();

	// Only fusion PRs get butler previews, and a merged/closed PR's alias no
	// longer points at this change — the link is a pre-merge testing affordance.
	const relevant =
		!!session.prUrl &&
		session.prState === "OPEN" &&
		(session.repo ?? "tella-fusion") === "tella-fusion";

	useEffect(() => {
		if (!relevant) {
			setStaging(null);
			setDeployPending(false);
			return;
		}
		let alive = true;
		const load = () =>
			fetchPr(session.id)
				.then((pr) => {
					if (!alive) return;
					setStaging(pr?.staging ?? null);
					setDeployPending(
						!!pr?.checks?.some(
							(c: PrCheck) =>
								isDeployment(c) &&
								checkClass(c.status, c.conclusion) === "check-pending",
						),
					);
				})
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

	if (!relevant) return null;

	// No URL yet. If a deploy is on its way (pending check), hold the slot with a
	// shimmering globe so the affordance loads alongside the checks; otherwise
	// (backend-only PR, no deploy) render nothing.
	if (!staging) {
		if (!deployPending) return null;
		const shimmerGlobe = (size: number, className?: string) => (
			<span className="staging-globe-wrap staging-shimmer" aria-hidden="true">
				<IconGlobe size={size} className={className} />
			</span>
		);
		if (variant === "header") {
			return (
				<Tooltip
					label="Staging deploy starting… — the preview link appears once it's up"
					side="bottom"
					multiline
				>
					<span
						className="viewer-code-icon staging-icon is-pending"
						aria-disabled="true"
					>
						{shimmerGlobe(25)}
					</span>
				</Tooltip>
			);
		}
		return (
			<span
				className="staging-link staging-link-pending"
				title="Staging deploy starting… the preview link appears once it's up"
			>
				{shimmerGlobe(15, "staging-globe")}
				Staging
			</span>
		);
	}

	const building = staging.status !== "Ready";
	// Deep-link to the agent-flagged route (set_preview_path) so the button
	// opens the feature under test, not the app root.
	const href = withPreviewPath(staging.url, session.previewPath);

	// ⌘/Ctrl-click copies the link instead of opening it (mirrors the browser's
	// own modifier semantics elsewhere) — hold Cmd on macOS, Ctrl on Windows.
	const onClick = (e: React.MouseEvent) => {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			copy(href, { toast: "Link copied" });
			return;
		}
		// A still-building deploy isn't testable yet, so swallow a plain click —
		// the spinning globe signals "not ready". (⌘-click above still copies.)
		if (building) e.preventDefault();
	};

	// The globe carries a spinning ring while the deploy builds so "not ready
	// yet" reads at a glance and pairs with the click being disabled above.
	// While a ⌘-copy is fresh the globe morphs into a drawing checkmark; otherwise
	// it's the (optionally spinning) globe.
	const globe = (size: number, className?: string) =>
		copied ? (
			<CopyCheck
				copied
				size={size}
				idle={<IconGlobe size={size} className={className} />}
			/>
		) : (
			<span className="staging-globe-wrap">
				{building && <span className="staging-spinner" aria-hidden="true" />}
				<IconGlobe size={size} className={className} />
			</span>
		);

	if (variant === "header") {
		return (
			<Tooltip
				label={
					copied
						? "Link copied"
						: building
							? `Staging deploy ${staging.status.toLowerCase()}… — ⌘-click to copy the link`
							: "Open staging deploy — test this PR on real infra (⌘-click to copy the link)"
				}
				side="bottom"
				multiline
			>
				<a
					href={href}
					target="_blank"
					rel="noopener"
					onClick={onClick}
					aria-disabled={building || undefined}
					className={`viewer-code-icon staging-icon ${building ? "is-building" : "is-ready"}`}
				>
					{/* The globe glyph only fills ~60% of its box (thin circle in a 24
					    viewBox), so it still needs a hair more than the play/sidebar
					    icons to read at the same weight in the top bar. */}
					{globe(25)}
				</a>
			</Tooltip>
		);
	}

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			onClick={onClick}
			aria-disabled={building || undefined}
			className={`staging-link ${building ? "staging-link-building" : ""}`}
			title={
				copied
					? "Link copied"
					: building
						? `Staging deploy ${staging.status.toLowerCase()}… — ⌘-click to copy — ${href}`
						: `Test this PR on staging (⌘-click to copy the link) — ${href}`
			}
		>
			{globe(15, "staging-globe")}
			Staging
			<IconArrowUpRight size={15} className="staging-ext" />
		</a>
	);
}
