import { utilityClassName } from "../ui/cn";
import React from "react";
import { cn } from "../ui/cn";
import { markTileShadow } from "../lib/mark-tile";
import { repoLetter } from "../lib/repo-label";
import {
	hasRepoIcon,
	REPO_TILE_INK,
	repoColor,
	repoIconFill,
	repoIconRevision,
} from "../lib/repo-colors";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	sizeFull: {
			width: "100%",
			height: "100%"
	},
	objectCover: {
			objectFit: "cover"
	},
	BorderRadiusInherit: {
			borderRadius: "inherit",

		cornerShape: "var(--cs)",},
	translateYPx: {
			translate: "0 1px"
	},
});

// The display-name map lives in lib/repo-label and the tile colors in
// lib/repo-colors, so lib-level formatters can reach both without a component
// import; re-exported here because most callers reach them alongside the tile.
// Both stay keyed on the raw id, so they're stable across a display rename.
export { repoLabel } from "../lib/repo-label";
export { repoColor } from "../lib/repo-colors";

// Bumped when the icons behind /repo-icon/<id>.png are redrawn: the response
// is cacheable, so without a new URL an installed PWA keeps painting the old
// art until its copy expires. 3 dropped the owner/org-avatar fallback, so the
// repos that were wearing their org's mark had to stop asking for it; 4 trims
// the empty margin around every icon, so the copies drawn small have to go; 5
// pads by ink rather than by bounding box, which grows the round ones; 6 drops
// the padding entirely, so an icon reaches the tile's edge the way a lettered
// tile's color does.
const ICON_VERSION = 6;

// A repo's icon tile (sidebar Repo dropdown, session-header breadcrumb, repo
// menus): the server's /repo-icon/<id>.png when the repo was given an icon of
// its own, else a colored letter — the default, and deliberately so, since an
// org's mark is the same picture for every repo it owns. The color is assigned
// per repo across the registered set (lib/repo-colors), so two tiles differ
// even when their letters don't. Every icon arrives drawn to the same
// proportions (see the route), so the tile scales them all identically.
// `size` (px) shrinks it for tight spots like the phone header's model line;
// omitted = the 18px default. `round` makes it a full circle (e.g. the phone
// title pill, where it sits against the pill's own rounding).
//
// `className` is merged so a caller can adjust the tile in place instead of
// reaching through `.repo-tile` from an ancestor's stylesheet — the sidebar's
// repo bands wear a 22px tile that way. Note it cannot override what `size`
// sets: those land as INLINE style below, which beats any utility. Geometry a
// caller wants scaled proportionally (radius and letter together) belongs in
// `size`; a caller that needs only some of it passes utilities here.
//
// `repo-tile` itself is now a bare hook, not styling: one ancestor still reaches
// the tile through it — INFO_HERO's `[&_.repo-tile]:shadow-[…]` (the phone
// session-info hero). The phone header used to be a second, but its tile moved
// out of the metadata line and into the title pill's own leading slot, and the
// rule that held it there had been matching nothing since.
const TILE =
	// Settings applies body leading to every descendant, which makes the fallback
	// letter's line box taller than the tile and leaves its cap height visibly
	// high. A direct-child rule wins that page-level override; the one-pixel
	// nudge then centers the glyph optically rather than its font metrics.
	utilityClassName("repo-tile inline-flex size-[18px] shrink-0 items-center justify-center rounded-sm text-meta font-bold [&>span]:!leading-none");

export function RepoTile({
	name,
	size,
	round,
	glow = false,
	className,
}: {
	name: string;
	size?: number;
	round?: boolean;
	glow?: boolean;
	className?: string;
}) {
	// Failure is tracked per name AND icon revision, so a tile retries the img
	// both when it switches repo and when this repo's art changes — a repo
	// given an icon from Settings had already 404'd, and without the revision
	// in the key it would keep painting its letter until a reload.
	const [failedFor, setFailedFor] = React.useState<string | null>(null);
	const style: React.CSSProperties = {};
	if (size) {
		style.width = size;
		style.height = size;
		style.fontSize = Math.round(size * 0.6);
		style.borderRadius = round ? "50%" : Math.max(3, Math.round(size * 0.28));
	} else if (round) {
		style.borderRadius = "50%";
	}
	// The tile's ink, on BOTH variants. legacy.css put `color: #fff` on
	// `.repo-tile` itself, which the image variant inherited too — so it stays
	// on both, from the same module as the fill (the two are chosen together,
	// see REPO_TILE_INK) rather than as a raw colour in a utility.
	style.color = REPO_TILE_INK;
	if (glow) style.boxShadow = markTileShadow(repoColor(name));
	const rev = repoIconRevision(name);
	const attempt = `${name}:${rev ?? 0}`;
	if (hasRepoIcon(name) && failedFor !== attempt) {
		return (
			<span className={cn(TILE, className)} style={style}>
				{/* The img fills the tile and inherits its rounding; the tile keeps
				    no colored backing, so icons with transparency sit on the
				    surface itself. No inset on purpose, at either end: the route
				    crops every icon to its artwork and adds no margin back
				    (png-trim.ts), so the art reaches the tile's edge exactly the
				    way a lettered tile's color reaches its own. Any breathing
				    room here — or baked into the image — is what makes an icon
				    read a size smaller than the tiles beside it.
				    `border-radius: inherit` is spelled as the property rather
				    than `rounded-[inherit]`: any `rounded-*` class also picks up
				    base.css's squircle grant, and this img has always worn a
				    plain round corner inside its squircled tile. */}
				<img
					src={`/repo-icon/${encodeURIComponent(name)}.png?v=${ICON_VERSION}${
						rev ? `&r=${rev}` : ""
					}`}
					alt=""
					loading="lazy"
					{...stylex.props(sx.sizeFull, sx.objectCover, sx.BorderRadiusInherit)}
					onError={() => setFailedFor(attempt)}
				/>
			</span>
		);
	}
	style.background = repoIconFill(repoColor(name));
	const letter = repoLetter(name);
	return (
		<span className={cn(TILE, className)} style={style}>
			<span {...stylex.props(sx.translateYPx)}>{letter}</span>
		</span>
	);
}
