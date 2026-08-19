import { useEffect, useState } from "react";
import { fetchPr } from "../lib/api";
import {
	pollWhileVisible,
	PR_WEBHOOK_FALLBACK_POLL_MS,
} from "../lib/poll";
import type { PrCheck, UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { toast } from "../ui/toast";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconArrowUpRight, IconGlobe } from "./icons";
import { checkClass, isDeployment } from "./PrPanel";
import { useShortcutLabel } from "../hooks/useShortcutBindings";

// The open-preview chord's handler lives in SessionViewer: this component
// mounts once per layout variant, so a listener here would register several
// times. All that happens here is advertising whatever it is bound to.

/* The amber pill in the workspace panel. Sized to the Merge button it sits
   beside (13px/600, 5px 11px, 7px corner) so the two read as one row. The base
   carries geometry only — each state below brings its own border and ink, so
   nothing has two competing colour utilities on it. */
const LINK_BASE =
	"inline-flex items-center gap-[5px] whitespace-nowrap rounded-md border px-[11px] py-[5px] text-label font-semibold no-underline";
const LINK_READY = "border-yellow/45 text-yellow hover:bg-yellow/12";
/* Deploy still building — not testable yet, so a plain click is swallowed (see
   onClick) and the pill reads as not-ready with a spinning globe. */
const LINK_BUILDING = `${LINK_READY} cursor-default opacity-55`;
/* Nothing to link to yet: quiet, and no hover wash to imply it opens. */
const LINK_PENDING = "border-line text-dim cursor-default";

/* The header globe rides in the session header's icon cluster, so it takes the
   same 32px square box as the share / ⋯ / panel buttons. Its state colouring
   (dim → amber → green) is its own — that's what the control communicates. */
const ICON_BASE =
	"inline-flex size-8 items-center justify-center rounded-control border border-transparent bg-transparent no-underline";
const ICON_READY = "cursor-pointer text-green hover:bg-green-soft";
/* Amber while a deploy is in flight. Building swallows the click (see onClick),
   so it gets no pointer; rebuilding still opens the previous deploy. */
const ICON_BUILDING =
	"cursor-default text-yellow opacity-72 hover:bg-yellow/13 hover:opacity-100";
const ICON_REBUILDING =
	"cursor-pointer text-yellow opacity-72 hover:bg-yellow/13 hover:opacity-100";
const ICON_PENDING = "cursor-default text-dim";

/* Spinning ring around the globe while the preview environment builds.
   border-t-current picks up the amber/green icon tone; the ring sits just
   outside the thin globe circle so it reads as a halo, not a second outline.
   The bar variant's globe is only 15px, so its ring shrinks to hug it. */
const RING_BASE =
	"pointer-events-none absolute top-1/2 left-1/2 rounded-full border border-transparent border-t-current opacity-90 animate-[preview-spin_0.7s_linear_infinite]";
/* base.css freezes every animation under prefers-reduced-motion and then hands
   the progress spinners their duration back — this is one of them (a stopped
   spinner makes a live deploy look hung), so it restates it for itself now that
   it no longer carries the class base.css lists. */
const RING_MOTION =
	"motion-reduce:[animation-duration:0.7s]! motion-reduce:[animation-iteration-count:infinite]!";
// The 22px ring haloes the 17/25px glyphs; the bar's 15px globe gets a 16px one.
const RING_LG = "size-[22px] -mt-[11px] -ml-[11px]";
const RING_SM = "size-4 -mt-2 -ml-2";

/**
 * Header link to the PR's preview environment (the Vercel preview at
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
	refreshTick,
}: {
	session: UnifiedSession;
	/** "bar" = the labelled Preview environment link; "header" = a compact
	 *  state-colored icon; "action" = a cell in the mobile workspace grid. */
	variant?: "bar" | "header" | "action";
	/** Bumped when GitHub reports PR/check/deployment activity for this session. */
	refreshTick?: number;
}) {
	const [staging, setStaging] = useState<{ url: string; status: string } | null>(
		null,
	);
	// A Vercel preview deploy is queued/running but butler hasn't posted the URL
	// comment yet — enough to show a loading placeholder, not enough to link.
	const [deployPending, setDeployPending] = useState(false);
	const { copied, copy } = useCopy();
	// Read up here with the other hooks, not beside the tooltip it feeds. Every
	// state below this line returns early, so a call further down runs on some
	// renders and not others: the render where the URL lands would add a hook the
	// previous render didn't have, and React tears the whole tree down over it.
	const openChord = useShortcutLabel("open-preview");

	// A merged/closed PR's alias no longer points at this change — the link is a
	// pre-merge testing affordance. Repos without deployment metadata simply
	// return no staging URL.
	const relevant = !!session.prUrl && session.prState === "OPEN";

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
		// Webhooks normally flip Building to Ready; this is only a missed-event
		// fallback, and hidden tabs skip it entirely.
		const stop = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
		return () => {
			alive = false;
			stop();
		};
	}, [session.id, relevant, refreshTick]);

	if (!relevant) return null;

	// No URL yet. If a deploy is on its way (pending check), hold the slot with a
	// shimmering globe so the affordance loads alongside the checks; otherwise
	// (backend-only PR, no deploy) render nothing.
	if (!staging) {
		if (!deployPending) return null;
		const shimmerGlobe = (size: number) => (
			<span
				className="relative inline-flex items-center justify-center animate-[staging-shimmer_1.4s_ease-in-out_infinite]"
				aria-hidden="true"
			>
				<IconGlobe size={size} />
			</span>
		);
		if (variant === "header") {
			return (
				<Tooltip
					label="Preview environment starting… the link appears once it's up"
					side="bottom"
					multiline
				>
					{/* `staging-icon` is a hook, not styling: PrStatusBar's strip nudges
					    this globe flush-left through `.pr-bar > .staging-icon`. */}
					<span
						className={`staging-icon ${ICON_BASE} ${ICON_PENDING}`}
						aria-disabled="true"
					>
						{shimmerGlobe(25)}
					</span>
				</Tooltip>
			);
		}
		if (variant === "action") {
			return (
				<span
					className="flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-supporting font-semibold text-faint"
					title="Preview environment starting… the link appears once it's up"
				>
					<span className="inline-flex size-5 shrink-0 items-center justify-center">
						{shimmerGlobe(17)}
					</span>
					<span className="min-w-0 flex-1 truncate">Preview environment</span>
				</span>
			);
		}
		return (
			<span
				className={`${LINK_BASE} ${LINK_PENDING}`}
				title="Preview environment starting… the link appears once it's up"
			>
				{shimmerGlobe(15)}
				Preview environment
			</span>
		);
	}

	// A push mid-review kicks off a *new* Vercel preview, but butler's
	// preview-table comment still advertises the previous deploy as Ready — so
	// staging.status alone leaves the globe green while a rebuild is in flight.
	// The branch alias keeps serving the last Ready deploy until the new one
	// lands, so a rebuild only means "possibly one push behind", never a dead
	// link — keep it clickable, spin the globe, and say so in the tooltip.
	// Only a first deploy that has never gone Ready gets a dead (swallowed)
	// click: before that the alias 404s.
	const rebuilding = deployPending && staging.status === "Ready";
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
		// Before the first deploy goes Ready the alias 404s, so swallow a plain
		// click — but never silently (an unexplained dead link reads as a bug).
		if (building) {
			e.preventDefault();
			toast(
				`Preview environment is ${staging.status.toLowerCase()}. The link goes live once the first deploy finishes.`,
			);
		}
	};

	// The globe carries a spinning ring while any deploy is in flight — first
	// build (link dead until it lands) and rebuild (link opens the previous
	// deploy) alike. While a ⌘-copy is fresh the globe morphs into a drawing
	// checkmark; otherwise it's the (optionally spinning) globe.
	const spinning = building || rebuilding;
	const globe = (size: number, ring: string) =>
		copied ? (
			<CopyCheck copied size={size} idle={<IconGlobe size={size} />} />
		) : (
			<span className="relative inline-flex items-center justify-center">
				{spinning && (
					<span
						className={`${RING_BASE} ${RING_MOTION} ${ring}`}
						aria-hidden="true"
					/>
				)}
				<IconGlobe size={size} />
			</span>
		);

	const iconState = building
		? ICON_BUILDING
		: rebuilding
			? ICON_REBUILDING
			: ICON_READY;
	const chordHint = openChord ? `${openChord}; ` : "";
	const tooltip = (copyHint: string) =>
		copied
			? "Link copied"
			: building
				? `Preview environment ${staging.status.toLowerCase()}… ${copyHint}`
				: rebuilding
					? `Redeploying for the latest push. Opens the previous deploy until it lands (${chordHint}${copyHint})`
					: `Open the preview environment to test this PR on real infra (${chordHint}${copyHint})`;

	if (variant === "header") {
		return (
			<Tooltip label={tooltip("⌘-click to copy the link")} side="bottom" multiline>
				<a
					href={href}
					target="_blank"
					rel="noopener"
					onClick={onClick}
					aria-disabled={building || undefined}
					// `staging-icon` is a hook, not styling: PrStatusBar's strip nudges
					// this globe flush-left through `.pr-bar > .staging-icon`.
					className={`staging-icon ${ICON_BASE} ${iconState}`}
				>
					{/* The globe glyph only fills ~60% of its box (thin circle in a 24
					    viewBox), so it still needs a hair more than the play/sidebar
					    icons to read at the same weight in the top bar. */}
					{globe(25, RING_LG)}
				</a>
			</Tooltip>
		);
	}
	if (variant === "action") {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener"
				onClick={onClick}
				aria-disabled={building || undefined}
				className={`flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-supporting font-semibold no-underline outline-none transition-colors hover:bg-hover focus-visible:bg-hover ${building ? "cursor-default text-faint" : "text-fg"}`}
				title={`${tooltip("⌘-click to copy the link")} · ${href}`}
			>
				<span className="inline-flex size-5 shrink-0 items-center justify-center text-faint">
					{globe(17, RING_LG)}
				</span>
				<span className="min-w-0 flex-1 truncate">Preview environment</span>
			</a>
		);
	}

	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			onClick={onClick}
			aria-disabled={building || undefined}
			className={`${LINK_BASE} ${building ? LINK_BUILDING : LINK_READY}`}
			title={`${tooltip("⌘-click to copy the link")} · ${href}`}
		>
			{globe(15, RING_SM)}
			Preview environment
			<IconArrowUpRight size={15} className="-ml-px opacity-80" />
		</a>
	);
}
