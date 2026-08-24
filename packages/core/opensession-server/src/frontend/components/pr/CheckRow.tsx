import { checkClass, formatCheckDuration } from "../../lib/pr-status-derive";
import { CHECK_TEXT } from "../../lib/pr-tone-classes";
import type { PrCheck } from "../../lib/types";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../../styles/typography.stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	roundedRow: {
			borderRadius: "calc(12px * var(--rf))"
	},
	px15: {
			paddingInline: "6px"
	},
	py1: {
			paddingBlock: "4px"
	},
	textFg: {
			color: "var(--text)"
	},
	transitionBackground: {
			transitionProperty: "background",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	textInherit: {
			color: "inherit"
	},
	noUnderline: {
			textDecorationLine: "none"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
});

/** `pr-check-mark-pending` styles nothing — it is base.css's hook for keeping
 *  this pulse alive under prefers-reduced-motion, which it does with
 *  !important and a utility therefore cannot. */
export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark = cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div className="group hover:bg-hover" {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2, sx.roundedRow, sx.px15, sx.py1, sx.textFg, sx.transitionBackground, typography.label)}>
      <a
        {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2, sx.textInherit, sx.noUnderline)}
        href={check.url}
        target="_blank"
        rel="noopener"
      >
        <span
          className={`w-3.5 shrink-0 text-center text-label ${CHECK_TEXT[cls]} ${
            cls === "check-pending" ? "pr-check-mark-pending animate-[pulse_1.4s_infinite]" : ""
          }`}
        >
          {mark}
        </span>
        <span {...stylex.props(sx.flex1, sx.truncate)}>{check.name}</span>
        {duration && <span className="tabular-nums" {...stylex.props(sx.textFaint, typography.meta)}>{duration}</span>}
        {check.url && (
          <span className="group-hover:text-fg" {...stylex.props(sx.textFaint, typography.itemTitle)}>↗</span>
        )}
      </a>
    </div>
  );
}
