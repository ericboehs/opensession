import { useEffect } from "react";

/**
 * iOS-style edge-swipe-to-go-back for the mobile page stack. On phones the
 * sidebar is the root page and a session/view is pushed over it (see the
 * `.mobile-detail` rules in global.css). A drag that STARTS near the left edge
 * pulls the pushed detail pane to the right under the finger and, past the
 * halfway point, pops back to the root (calls `onBack`).
 *
 * - Only active while a detail page is showing (`active`) and at mobile widths.
 * - Must start within EDGE px of the left edge, so it doesn't hijack horizontal
 *   scrolling inside diffs/code.
 * - Vertical-dominant (or leftward) moves abort immediately, leaving normal
 *   scrolling alone.
 */
interface Opts {
  /** A detail page is currently pushed over the root (sidebar). */
  active: boolean;
  /** Pop back to the root — navigate home. */
  onBack: () => void;
  paneRef: React.RefObject<HTMLElement | null>;
}

const MOBILE = "(max-width: 720px)";
const EDGE = 28; // px from the left that may begin a back drag
const SLOP = 8; // px of movement before committing to an axis
const SNAP_MS = 260; // matches the CSS page transition

export function useBackSwipe({ active, onBack, paneRef }: Opts) {
  useEffect(() => {
    if (!active) return;
    const mq = window.matchMedia(MOBILE);

    let startX = 0;
    let startY = 0;
    let width = 0;
    let candidate = false; // touch began in the left-edge zone
    let dragging = false; // committed to a horizontal drag
    let startTarget: EventTarget | null = null;

    const setTransform = (px: number) => {
      const el = paneRef.current;
      if (!el) return;
      el.style.transition = "none";
      el.style.transform = `translateX(${px}px)`;
    };

    // Animate the pane to its resting edge, then hand control back to the CSS
    // class so the inline styles don't linger and fight future layout.
    const settle = (toBack: boolean) => {
      const el = paneRef.current;
      if (!el) {
        if (toBack) onBack();
        return;
      }
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", done);
        if (toBack) onBack();
      };
      el.style.transition = `transform ${SNAP_MS}ms ease`;
      el.style.transform = `translateX(${toBack ? width : 0}px)`;
      el.addEventListener("transitionend", done);
      setTimeout(done, SNAP_MS + 60);
    };

    const onStart = (e: TouchEvent) => {
      if (!mq.matches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dragging = false;
      candidate = startX <= EDGE;
      startTarget = candidate ? e.target : null;
      // The edge zone is app-owned gesture territory: preventDefault here is
      // what stops the browser's native back-swipe (iOS Safari) from starting
      // a real history navigation and racing our pane drag. It also swallows
      // the tap→click synthesis for touches starting in the zone, so onEnd
      // re-dispatches a click when the touch turns out to be a plain tap.
      if (candidate && e.cancelable) e.preventDefault();
      const el = paneRef.current;
      width = el
        ? el.getBoundingClientRect().width || window.innerWidth
        : window.innerWidth;
    };

    const onMove = (e: TouchEvent) => {
      if (!candidate || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Only a rightward, horizontal-dominant move drives the back gesture.
        if (Math.abs(dy) > Math.abs(dx) || dx < 0) {
          candidate = false;
          return;
        }
        dragging = true;
      }
      e.preventDefault(); // we own this gesture now; stop scrolling
      const px = Math.max(0, Math.min(width, dx));
      setTransform(px);
    };

    const onEnd = (e: TouchEvent) => {
      if (!candidate) return;
      const wasDragging = dragging;
      const target = startTarget;
      candidate = false;
      dragging = false;
      startTarget = null;
      const el = paneRef.current;
      if (!wasDragging || !el) {
        if (el) {
          el.style.transition = "";
          el.style.transform = "";
        }
        // preventDefault on touchstart suppressed the browser's own tap→click,
        // so a touch that never became a drag and barely moved is a tap we
        // must complete ourselves.
        const t = e.changedTouches?.[0];
        if (
          e.type === "touchend" &&
          t &&
          Math.abs(t.clientX - startX) < SLOP &&
          Math.abs(t.clientY - startY) < SLOP &&
          target instanceof HTMLElement
        ) {
          target.click();
        }
        return;
      }
      const m = /translateX\(([-0-9.]+)px\)/.exec(el.style.transform);
      const px = m ? parseFloat(m[1]) : 0;
      settle(px > width / 2);
    };

    document.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [active, onBack, paneRef]);
}
