import { useCallback, useRef, useState } from "react";
import { usePullToRefresh } from "../hooks/usePullToRefresh";

/**
 * Mobile pull-to-refresh badge. Mounted once at the app root; invisible until a
 * downward pull at the top of the visible scroller drags it into view (see
 * usePullToRefresh + the `.ptr` rules in global.css). Past the threshold it
 * spins and runs `onRefresh` — a full reload by default (the app's refresh
 * convention, matching RestartOverlay / UpdatePill), which reconnects the
 * WebSocket and re-fetches everything.
 */
export function PullToRefresh({
  onRefresh,
}: {
  onRefresh?: () => void | Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [refreshing, setRefreshing] = useState(false);

  const onTrigger = useCallback(() => {
    setRefreshing(true);
    Promise.resolve((onRefresh ?? (() => location.reload()))()).finally(() => {
      // A reload navigates away before this runs; a soft refresh retracts here.
      setRefreshing(false);
      const el = ref.current;
      if (el) {
        el.style.transition = "transform 220ms ease, opacity 220ms ease";
        el.style.setProperty("--ptr", "0");
        el.style.setProperty("--ptr-progress", "0");
      }
    });
  }, [onRefresh]);

  usePullToRefresh({ indicatorRef: ref, refreshing, onTrigger });

  return (
    <div
      ref={ref}
      className={`ptr${refreshing ? " ptr-refreshing" : ""}`}
      aria-hidden="true"
    >
      <svg
        className="ptr-arrow"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="M8 3v9M4.5 8.5 8 12l3.5-3.5"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <svg
        className="ptr-spinner"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeOpacity="0.25"
        />
        <path
          d="M8 2a6 6 0 0 1 6 6"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
