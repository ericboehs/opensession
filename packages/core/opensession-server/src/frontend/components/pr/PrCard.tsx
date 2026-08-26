import type React from "react";

/** A titled card: a label row over a body of rows.
 *
 * No frame: the card sits on the review canvas's `bg-surface` with a fill of
 * its own, so a hairline round it would be a second edge. The rule under the
 * label stays: that one is a divider between the title and the rows, which is
 * genuinely a line. */
export function PrCard({
  title,
  headExtra,
  children,
}: {
  title: string;
  headExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-divider px-4 py-3 sm:px-5">
        <span className="text-label font-semibold text-faint">{title}</span>
        {headExtra}
      </div>
      <div className="flex flex-col gap-2 px-4 py-3 sm:px-5">{children}</div>
    </div>
  );
}
