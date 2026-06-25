import { useEffect } from "react";

/**
 * iOS-style edge swipe for the mobile sidebar. Drags the `.sidebar-container`
 * panel under the finger and snaps open/closed on release.
 *
 * - Closed: a drag must START within EDGE px of the left edge (so it doesn't
 *   hijack horizontal scrolling inside diffs/code).
 * - Open: a drag anywhere can pull it back closed.
 * - Vertical-dominant moves abort immediately, leaving normal scrolling alone.
 *
 * Only active at mobile widths (the panel is statically visible above that).
 */
interface Opts {
  open: boolean;
  setOpen: (v: boolean) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}

const MOBILE = "(max-width: 720px)";
const EDGE = 28; // px from the left that may begin an opening drag
const SLOP = 8; // px of movement before committing to an axis
const SNAP_MS = 180; // matches the CSS transition

export function useSidebarSwipe({ open, setOpen, panelRef }: Opts) {
  useEffect(() => {
    const mq = window.matchMedia(MOBILE);

    let startX = 0;
    let startY = 0;
    let width = 300;
    let candidate = false; // touch began in a zone that can drive the panel
    let dragging = false; // committed to a horizontal drag

    const setTransform = (px: number) => {
      const el = panelRef.current;
      if (!el) return;
      el.style.transition = "none";
      el.style.transform = `translateX(${px}px)`;
    };

    // Animate to the target edge, then hand control back to the CSS class so
    // the inline styles don't linger and fight future layout.
    const settle = (toOpen: boolean) => {
      const el = panelRef.current;
      if (!el) {
        setOpen(toOpen);
        return;
      }
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        el.style.transition = "";
        el.style.transform = "";
        el.removeEventListener("transitionend", done);
        setOpen(toOpen);
      };
      el.style.transition = `transform ${SNAP_MS}ms ease`;
      el.style.transform = `translateX(${toOpen ? 0 : -width}px)`;
      el.addEventListener("transitionend", done);
      setTimeout(done, SNAP_MS + 60);
    };

    const onStart = (e: TouchEvent) => {
      if (!mq.matches || e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      dragging = false;
      candidate = open ? true : startX <= EDGE;
      const el = panelRef.current;
      width = el ? el.getBoundingClientRect().width || 300 : 300;
    };

    const onMove = (e: TouchEvent) => {
      if (!candidate || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          candidate = false; // vertical scroll — let it be
          return;
        }
        dragging = true;
      }
      e.preventDefault(); // we own this gesture now; stop scrolling
      const base = open ? 0 : -width;
      const px = Math.max(-width, Math.min(0, base + dx));
      setTransform(px);
    };

    const onEnd = () => {
      if (!candidate) return;
      const wasDragging = dragging;
      candidate = false;
      dragging = false;
      const el = panelRef.current;
      if (!wasDragging || !el) {
        if (el) {
          el.style.transition = "";
          el.style.transform = "";
        }
        return;
      }
      const m = /translateX\(([-0-9.]+)px\)/.exec(el.style.transform);
      const px = m ? parseFloat(m[1]) : open ? 0 : -width;
      settle(px > -width / 2);
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
  }, [open, setOpen, panelRef]);
}
