import React from "react";
import { extBadge, type FileAttachment } from "../lib/images";
import {
  fileChipCard,
  fileChipCardPaddingRemovable,
  fileChipMeta,
  fileChipName,
  fileChipRow,
  fileChipSub,
  fileChipThumb,
} from "../lib/composer-classes";
import { cn, mergeStylexProps } from "../ui/cn";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	absolute: {
			position: "absolute"
	},
	top1: {
			top: "4px"
	},
	right5px: {
			right: "5px"
	},
	shrink0: {
			flexShrink: "0"
	},
	text15px: {
			fontSize: "15px"
	},
	leadingNone: {
			lineHeight: "1"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	h3: {
			height: "12px"
	},
	w92px: {
			width: "92px"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	},
	bgHover: {
			backgroundColor: "var(--hover)"
	},
	h25: {
			height: "10px"
	},
	w46px: {
			width: "46px"
	},
});

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  /** Files still on their way to disk: a ghost card each, in the row where
   *  they will land. See ImageThumbs for why they are shown at all. */
  pending?: number;
}

/** Removable preview cards for non-image file attachments (staged to disk server-side). */
export function FileChips({ files, onRemove, disabled, pending = 0 }: Props) {
  if (files.length === 0 && pending < 1) return null;
  return (
    <div className={fileChipRow}>
      {files.map((f, i) => (
        <div
          key={i}
          className={cn(fileChipCard, fileChipCardPaddingRemovable)}
          title={f.name}
        >
          <span className={fileChipThumb}>{extBadge(f.name)}</span>
          <span className={fileChipMeta}>
            <span className={fileChipName}>{f.name}</span>
            <span className={fileChipSub}>Attachment</span>
          </span>
          <button
            type="button" {...mergeStylexProps("enabled:hover:text-fg disabled:cursor-default disabled:opacity-50", sx.absolute, sx.top1, sx.right5px, sx.shrink0, sx.text15px, sx.leadingNone, sx.textFaint)}
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove file"
          >
            ×
          </button>
        </div>
      ))}
      {/* The card it will become: same badge, same two lines of text, none of
          it known yet. */}
      {Array.from({ length: pending }, (_, i) => (
        <div
          key={`staging-${i}`}
          className={cn(fileChipCard, fileChipCardPaddingRemovable, "animate-pulse")}
        >
          <span className={cn(fileChipThumb, "bg-hover")} />
          <span className={fileChipMeta}>
            <span {...stylex.props(sx.h3, sx.w92px, sx.roundedSm, sx.bgHover)} />
            <span {...stylex.props(sx.h25, sx.w46px, sx.roundedSm, sx.bgHover)} />
          </span>
        </div>
      ))}
    </div>
  );
}
