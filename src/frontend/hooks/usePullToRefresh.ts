import { useEffect } from "react";

/**
 * iOS-style pull-to-refresh for the mobile app. An installed PWA has NO native
 * pull-to-refresh (and we deliberately kill rubber-band overscroll — body is
 * `position: fixed; overscroll-behavior: none`), so a stale view after a network
 * blip had no gesture to recover it. This adds one: at the TOP of the visible
 * scroller, a downward drag past a threshold fires `onTrigger` (default: reload).
 *
 * Pattern mirrors useBackSwipe — document-level touch listeners, phone widths
 * only, and the drag is driven straight onto the indicator element via CSS vars
 * (no per-frame React state). It stays out of the way of everything else:
 *  - only engages when the drag's vertical scroller is at scrollTop 0,
 *  - vertical-dominant + downward only (horizontal / upward moves abort, leaving
 *    scrolling and the left-edge back-swipe alone),
 *  - never starts inside an input/textarea/contenteditable (typing).
 */
const MOBILE = "(max-width: 720px)";
const TRIGGER = 72; // px pulled past the top to commit a refresh
const MAX_PULL = 110; // clamp so a long drag can't fling the badge off-screen
const SLOP = 6; // px before we commit to the gesture

/** Nearest scrollable-in-Y ancestor of the touch target, or null. */
function scrollableAncestor(start: EventTarget | null): HTMLElement | null {
  let el = start as HTMLElement | null;
  while (el && el !== document.body) {
    if (el.scrollHeight > el.clientHeight) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
    el = el.parentElement;
  }
  return null;
}

interface Opts {
  indicatorRef: React.RefObject<HTMLElement | null>;
  /** Refresh in progress — pulls are ignored until it clears. */
  refreshing: boolean;
  /** Fire the refresh (already past the threshold on release). */
  onTrigger: () => void;
}

export function usePullToRefresh({ indicatorRef, refreshing, onTrigger }: Opts) {
  useEffect(() => {
    const mq = window.matchMedia(MOBILE);

    let startY = 0;
    let scroller: HTMLElement | null = null;
    let candidate = false; // touch began at the top of a scroller
    let pulling = false; // committed to a downward pull

    const setPull = (px: number, animate = false) => {
      const el = indicatorRef.current;
      if (!el) return;
      el.style.transition = animate
        ? "transform 200ms ease, opacity 200ms ease"
        : "none";
      el.style.setProperty("--ptr", String(px));
      el.style.setProperty("--ptr-progress", String(Math.min(1, px / TRIGGER)));
    };

    const onStart = (e: TouchEvent) => {
      candidate = false;
      pulling = false;
      if (refreshing || !mq.matches || e.touches.length !== 1) return;
      const tgt = e.target as HTMLElement | null;
      // Don't hijack drags that begin in a text field (selection / keyboard).
      if (tgt?.closest('input, textarea, [contenteditable="true"]')) return;
      scroller = scrollableAncestor(tgt);
      // Only a candidate when the vertical scroller is already at the top (a
      // non-scrolling area — null scroller — counts as "at the top").
      if (scroller && scroller.scrollTop > 0) return;
      startY = e.touches[0].clientY;
      candidate = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!candidate || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      if (!pulling) {
        if (dy < SLOP) {
          if (dy < -SLOP) candidate = false; // upward move — not our gesture
          return;
        }
        // Momentum may have scrolled the container down since touchstart.
        if (scroller && scroller.scrollTop > 0) {
          candidate = false;
          return;
        }
        pulling = true;
      }
      if (dy <= 0) {
        setPull(0);
        return;
      }
      // We own this gesture now — stop the scroller from moving under it.
      e.preventDefault();
      // Full sensitivity up to the trigger, then rubber-band resistance.
      const pull = dy < TRIGGER ? dy : TRIGGER + (dy - TRIGGER) * 0.4;
      setPull(Math.min(pull, MAX_PULL));
    };

    const onEnd = () => {
      if (!candidate) return;
      const wasPulling = pulling;
      candidate = false;
      pulling = false;
      if (!wasPulling) return;
      const el = indicatorRef.current;
      const px = el ? parseFloat(el.style.getPropertyValue("--ptr") || "0") : 0;
      if (px >= TRIGGER) {
        setPull(TRIGGER, true); // hold at the resting spot while it refreshes
        onTrigger();
      } else {
        setPull(0, true); // snap back
      }
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [indicatorRef, refreshing, onTrigger]);
}
