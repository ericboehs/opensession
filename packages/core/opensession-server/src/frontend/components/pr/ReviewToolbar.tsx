import type { ReactNode } from "react";
import { WS_SUMMARY_REVIEW_BAR_CLEARANCE } from "../../lib/workspace-summary-classes";

/**
 * The floating review toolbar shared by branches with and without a pull
 * request. It stays edge to edge on phone and clears the standing workspace
 * summary on wide review canvases. The sticky outer surface masks code through
 * its insets; a lower layer softens the edge without fading pinned file borders.
 */
export function ReviewToolbar({
  children,
  compact,
  flushTop = false,
}: {
  children: ReactNode;
  compact: boolean;
  /** A lone workspace tab has no strip between the pane header and Review. */
  flushTop?: boolean;
}) {
  const placement = compact
    ? `sticky top-0 z-20 desktop:mb-0 desktop:ml-2 desktop:pb-2 ${WS_SUMMARY_REVIEW_BAR_CLEARANCE}`
    : "desktop:mx-2 desktop:mb-2";

  return (
    <>
      <div className={`relative shrink-0 bg-surface ${placement}`}>
        <div
          className={`relative bg-surface ${flushTop ? "" : "desktop:mt-2.5"} desktop:rounded-lg desktop:border desktop:border-line ${compact ? "desktop:overflow-hidden" : "desktop:overflow-visible"}`}
        >
          {children}
        </div>
      </div>
      {compact && (
        <div
          className="pointer-events-none sticky top-[60px] z-[5] mx-2 hidden h-3 -mb-3 overflow-clip rounded-t-lg bg-[linear-gradient(to_bottom,var(--bg),transparent)] desktop:block"
          aria-hidden="true"
        />
      )}
    </>
  );
}
