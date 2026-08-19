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
import { cn } from "../ui/cn";

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
            type="button"
            className="absolute top-1 right-[5px] shrink-0 text-[15px] leading-none text-faint enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
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
            <span className="h-3 w-[92px] rounded-sm bg-hover" />
            <span className="h-2.5 w-[46px] rounded-sm bg-hover" />
          </span>
        </div>
      ))}
    </div>
  );
}
