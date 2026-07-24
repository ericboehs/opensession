import { useEffect, useRef } from "react";

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
const EDGE = 32; // px from the left that may begin a back drag
const SLOP = 8; // px of movement before committing to an axis
const SNAP_MS = 260; // matches the CSS page transition
const FLICK_VX = 0.35; // px/ms rightward at release that pops even a short drag

export function useBackSwipe({ active, onBack, paneRef }: Opts) {
  // Callers pass a fresh `onBack` closure every render. Going through a ref
  // keeps it out of the effect deps: if the effect re-ran mid-gesture (any
  // re-render, e.g. a WebSocket session update), the replacement listeners
  // would start with `dragging = false`, the touchend would be ignored, and
  // the pane would be stranded on its inline mid-drag transform.
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!active) return;
    const onBack = () => onBackRef.current();
    const mq = window.matchMedia(MOBILE);

    let startX = 0;
    let startY = 0;
    let width = 0;
    let candidate = false; // touch began in the left-edge zone
    let dragging = false; // committed to a horizontal drag
    let startTarget: EventTarget | null = null;
    let lastX = 0;
    let lastT = 0;
    let vx = 0; // smoothed horizontal velocity, px/ms (+ = rightward)

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
      lastX = t.clientX;
      lastT = performance.now();
      vx = 0;
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
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax < SLOP && ay < SLOP) return;
        // Commit on a rightward move within ~50° of horizontal. Only a clearly
        // vertical (or leftward) move aborts; an ambiguous diagonal keeps
        // watching instead of giving up forever on the first sample — the old
        // strict dy>dx test killed any thumb arc that dipped a few px first.
        if (dx > 0 && ax >= ay * 0.8) {
          dragging = true;
        } else if (dx < -SLOP || ay > ax * 1.4) {
          candidate = false;
          return;
        } else {
          return;
        }
      }
      e.preventDefault(); // we own this gesture now; stop scrolling
      const now = performance.now();
      if (now > lastT) {
        // Exponentially smoothed so the release reads intent, not one sample.
        vx = 0.6 * vx + (0.4 * (t.clientX - lastX)) / (now - lastT);
      }
      lastX = t.clientX;
      lastT = now;
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
      // A rightward flick pops even a short drag (and a leftward flick cancels
      // even a long one); a slow release falls back to the halfway rule.
      const pop =
        vx > FLICK_VX ? px > 24 : vx < -FLICK_VX ? false : px > width / 2;
      settle(pop);
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
      // If teardown still lands mid-drag (route change, unmount), hand the
      // pane back to the CSS class instead of leaving it stuck halfway.
      // An in-flight settle() is untouched: onEnd resets `dragging` first.
      if (candidate || dragging) {
        const el = paneRef.current;
        if (el) {
          el.style.transition = "";
          el.style.transform = "";
        }
      }
    };
  }, [active, paneRef]);
}
