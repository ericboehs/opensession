import { UNDO_SHORTCUT_KEYS } from "../../lib/undo";
import { Button } from "../../ui/button";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import { IconUndo } from "../icons";

/** The merge button's five-second inline result and its reversal. */
export function MergeUndoControl({
  onUndo,
  compact = false,
  className,
}: {
  onUndo: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-stretch whitespace-nowrap bg-fg/8 text-dim",
        compact
          ? "min-h-[22px] rounded-md text-label"
          : "min-h-[26px] rounded-control text-xs phone:min-h-[26px]",
        className,
      )}
    >
      <span
        aria-live="polite"
        className={cn(
          "flex items-center font-medium [text-box:trim-both_cap_alphabetic]",
          compact ? "px-2" : "px-2.5 phone:px-1.5",
        )}
      >
        PR merged
      </span>
      <Tooltip label="Undo" shortcut={UNDO_SHORTCUT_KEYS}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className={cn(
            "relative rounded-l-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-line",
            compact
              ? "min-h-[22px] rounded-r-md px-2 text-label"
              : "rounded-r-control phone:min-h-[26px] phone:px-1.5",
          )}
        >
          <IconUndo size={20} className="shrink-0 opacity-60 phone:hidden" />
          <span className="[text-box:trim-both_cap_alphabetic]">Undo</span>
        </Button>
      </Tooltip>
    </div>
  );
}
