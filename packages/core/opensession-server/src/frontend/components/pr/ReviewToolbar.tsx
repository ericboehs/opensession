import type { ReactNode } from "react";
import { WS_SUMMARY_REVIEW_BAR_CLEARANCE } from "../../lib/workspace-summary-classes";
import * as stylex from "@stylexjs/stylex";
import { mergeStylexProps } from "../../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	pointerEventsNone: {
			pointerEvents: "none"
	},
	sticky: {
			position: "sticky"
	},
	top52px: {
			top: "52px"
	},
	z5: {
			zIndex: "5"
	},
	mx2: {
			marginInline: "8px"
	},
	hidden: {
			display: "none"
	},
	h25: {
			height: "10px"
	},
	Mb25: {
			marginBottom: "-10px"
	},
	overflowClip: {
			overflow: "clip"
	},
	roundedTLg: {
			borderTopLeftRadius: "calc(14px * var(--rf))",
			borderTopRightRadius: "calc(14px * var(--rf))"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
});

/**
 * The floating review toolbar shared by branches with and without a pull
 * request. It stays edge to edge on phone and clears the standing workspace
 * summary on wide review canvases. The sticky outer surface masks code through
 * its inset; an opaque lower mask keeps scrolled code beneath pinned file headers.
 */
export function ReviewToolbar({
  children,
  compact,
}: {
  children: ReactNode;
  compact: boolean;
}) {
  const placement = compact
    ? `sticky top-0 z-20 desktop:mb-0 desktop:ml-2 desktop:pb-2 ${WS_SUMMARY_REVIEW_BAR_CLEARANCE}`
    : "desktop:mx-2 desktop:mb-2";

  return (
    <>
      <div
        className={`relative shrink-0 bg-surface desktop:pt-2.5 ${placement}`}
      >
        <div
          className={`relative bg-surface desktop:rounded-lg desktop:border desktop:border-line ${compact ? "desktop:overflow-hidden" : "desktop:overflow-visible"}`}
        >
          {children}
        </div>
      </div>
      {compact && (
        // File headers pin 61px below the scroll edge. Fill everything between
        // the toolbar and that edge so code cannot scroll above its own header.
        <div {...mergeStylexProps("desktop:block", sx.pointerEventsNone, sx.sticky, sx.top52px, sx.z5, sx.mx2, sx.hidden, sx.h25, sx.Mb25, sx.overflowClip, sx.roundedTLg, sx.bgSurface)}
          aria-hidden="true"
        />
      )}
    </>
  );
}
