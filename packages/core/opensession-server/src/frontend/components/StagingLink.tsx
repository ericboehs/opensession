import { useEffect, useState } from "react";
import { PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { useSessionPrResource } from "../hooks/useApiResources";
import type { PrCheck, UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { WS_SUMMARY_ICON } from "../lib/workspace-summary-classes";
import { cn } from "../ui/cn";
import { Tooltip } from "../ui/tooltip";
import { toast } from "../ui/toast";
import { CopyCheck, useCopy } from "../ui/copy";
import { IconArrowUpRight, IconGlobe, IconLink } from "./icons";
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

/* The summary card's preview mark. It rides at the head of the PR band's
   status row, immediately before the glyph for where the work stands, so the
   band says both on one line: this is the pull request, and this is where you
   can try it.

   A 28px square rather than the card's 20px rail, which every other leading
   mark takes. Those marks are decoration on a row whose whole width is the
   target; this one IS the target, and 20px is too little to aim at.

   The mark stays bare at rest so it belongs to the tinted status band rather
   than reading as a disabled grey control. Its own ink supplies the hover and
   press washes, which makes the band darken under the pointer. */
const SUMMARY_MARK =
	"grid size-7 shrink-0 place-items-center rounded-md no-underline focus-ring " +
	"transition-[background-color,scale] duration-150 ease-out";
/** Pointer and press. The press step also takes a hair of scale, which is what
 *  makes a 28px target feel like it answered. */
const SUMMARY_MARK_HOVER =
	"hover:bg-[color-mix(in_srgb,currentColor_26%,transparent)] " +
	"active:scale-[0.96] active:bg-[color-mix(in_srgb,currentColor_34%,transparent)]";
/* The mark's 20px glyph sits inside a 28px target. Pull its box 4px toward the
   following label so the visible glyph keeps the row's 6px icon-to-text gap. */
const SUMMARY_MARK_PAIR = "-mr-1";

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
 * Header link to the PR's preview environment (a per-branch deploy, e.g. a
 * Vercel preview) so a change can be tested on real infra in one click. The
 * URL comes from the PR details endpoint, which parses the deploy bot's
 * preview-table comment, so the link only appears when a deploy actually
 * exists for the PR (PRs that never deploy never get one). While the deploy is still building the link renders
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
	 *  state-colored icon; "action" = a cell in the mobile workspace grid;
	 *  "summary" = a row in the header's workspace summary card. */
	variant?: "bar" | "header" | "action" | "summary";
	/** Bumped when GitHub reports PR/check/deployment activity for this session. */
	refreshTick?: number;
}) {
	const { copied, copy } = useCopy();
	const [copyModifierHeld, setCopyModifierHeld] = useState(false);
	useEffect(() => {
		const syncModifier = (e: KeyboardEvent) =>
			setCopyModifierHeld(e.metaKey || e.ctrlKey);
		const clearModifier = () => setCopyModifierHeld(false);
		window.addEventListener("keydown", syncModifier);
		window.addEventListener("keyup", syncModifier);
		window.addEventListener("blur", clearModifier);
		return () => {
			window.removeEventListener("keydown", syncModifier);
			window.removeEventListener("keyup", syncModifier);
			window.removeEventListener("blur", clearModifier);
		};
	}, []);
	// Read up here with the other hooks, not beside the tooltip it feeds. Every
	// state below this line returns early, so a call further down runs on some
	// renders and not others: the render where the URL lands would add a hook the
	// previous render didn't have, and React tears the whole tree down over it.
	const openChord = useShortcutLabel("open-preview");

	// A merged/closed PR's alias no longer points at this change. The link is a
	// pre-merge testing affordance. Repos without deployment metadata simply
	// return no staging URL.
	const relevant = !!session.prUrl && session.prState === "OPEN";
	const prResource = useSessionPrResource(
		session.id,
		session.repo || undefined,
		undefined,
		{
			enabled: relevant,
			refreshInterval: PR_WEBHOOK_FALLBACK_POLL_MS,
			revision: refreshTick,
		},
	);
	const staging = prResource.data?.staging ?? null;
	// A Vercel preview deploy is queued/running but butler hasn't posted the URL
	// comment yet. That is enough to show a loading placeholder, not enough to link.
	const deployPending = !!prResource.data?.checks?.some(
		(c: PrCheck) =>
			isDeployment(c) &&
			checkClass(c.status, c.conclusion) === "check-pending",
	);

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
		if (variant === "summary") {
			return (
				<Tooltip
					label="Preview environment starting… the link appears once it's up"
					side="bottom"
					multiline
				>
					<span
						// PrStatusBar uses this marker to add breathing room only when
						// the preview mark is absent.
						data-summary-preview
						// Nothing to open yet, so the mark drops its pointer and its
						// plate rather than offering a target that does nothing.
						className={cn(
							SUMMARY_MARK,
							SUMMARY_MARK_PAIR,
							WS_SUMMARY_ICON,
							"cursor-default",
						)}
						aria-label="Preview environment starting"
					>
						{shimmerGlobe(20)}
					</span>
				</Tooltip>
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
	// checkmark; holding the copy modifier previews the link action, and the
	// globe remains the resting (optionally spinning) state.
	const spinning = building || rebuilding;
	const restingIcon = (size: number) =>
		copyModifierHeld ? <IconLink size={size} /> : <IconGlobe size={size} />;
	const globe = (size: number, ring: string) =>
		copied ? (
			<CopyCheck copied size={size} idle={restingIcon(size)} />
		) : (
			<span className="relative inline-flex items-center justify-center">
				{spinning && !copyModifierHeld && (
					<span
						className={`${RING_BASE} ${RING_MOTION} ${ring}`}
						aria-hidden="true"
					/>
				)}
				{restingIcon(size)}
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
					: `Open the preview environment to test this PR (${chordHint}${copyHint})`;

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
	if (variant === "summary") {
		return (
			// The band is at the top of a floating card, so the tip hangs below it
			// rather than over the header the card came from.
			<Tooltip label={tooltip("⌘-click to copy the link")} side="bottom" multiline>
				<a
					href={href}
					target="_blank"
					rel="noopener"
					onClick={onClick}
					aria-disabled={building || undefined}
					data-summary-preview
					// The label the mark used to carry is now the tooltip's first line,
					// and the deploy's own state rides in there with it: an icon cannot
					// say "Redeploying" and the band has no room for a word that is only
					// true for a minute at a time.
					aria-label="Preview environment"
					className={cn(
						SUMMARY_MARK,
						SUMMARY_MARK_PAIR,
						// Amber only while a deploy is in flight. A card of quiet rows
						// keeps its colour for the ones with something to report, and a
						// preview that is simply up has nothing.
						spinning ? "text-yellow" : WS_SUMMARY_ICON,
						building ? "cursor-default" : SUMMARY_MARK_HOVER,
					)}
				>
					{globe(20, RING_LG)}
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
			className={`${LINK_BASE} ${building ? LINK_BUILDING : LINK_READY}`}
			title={`${tooltip("⌘-click to copy the link")} · ${href}`}
		>
			{globe(15, RING_SM)}
			Preview environment
			<IconArrowUpRight size={15} className="-ml-px opacity-80" />
		</a>
	);
}
