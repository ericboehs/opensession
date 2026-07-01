import React from "react";
import { createPortal } from "react-dom";

/**
 * Lightweight hover tooltip, styled after tella-fusion's `UI__Tooltip3`
 * (near-black rounded popup, small medium-weight white text, subtle ring +
 * shadow, fade-and-slide in). tella-fusion builds on Base UI + Tailwind; here
 * we have neither, so this is a self-contained portal tooltip that clones its
 * single child to attach hover/focus handlers — no DOM wrapper, so it never
 * disturbs the flex toolbars these icon buttons live in.
 *
 * Like Tella's provider (delay 200ms, group timeout 300ms) tooltips open after
 * a short delay, but once one has shown, moving to an adjacent trigger within
 * the group window shows the next one instantly.
 */

type Side = "top" | "bottom" | "left" | "right";

// Module-level group state, shared across every Tooltip instance — mirrors
// Tella's Tooltip.Provider so hovering between neighbouring icons feels snappy.
const OPEN_DELAY = 200;
const GROUP_WINDOW = 300;
let groupOpen = false;
let lastCloseAt = 0;

export function Tooltip({
  label,
  side = "top",
  offset = 8,
  shortcut,
  children,
}: {
  label: React.ReactNode;
  side?: Side;
  offset?: number;
  /** Optional keyboard-shortcut badges, e.g. ["⌘", "S"]. */
  shortcut?: string[];
  children: React.ReactElement;
}) {
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = React.useState(false);
  const [place, setPlace] = React.useState<{
    left: number;
    top: number;
    side: Side;
  } | null>(null);

  // Position the popup relative to its trigger, flipping to the opposite side
  // when the preferred side has no room in the viewport (e.g. a `top` tooltip on
  // a button pinned to the very top edge → render below instead), and clamping
  // the cross-axis so it never spills off-screen. Popup size is only known once
  // it's mounted, so this runs again in a layout effect with the real box.
  const position = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const t = el.getBoundingClientRect();
    const p = popupRef.current;
    const pw = p ? p.offsetWidth : 0;
    const ph = p ? p.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 6; // keep at least this far from the viewport edge

    let s: Side = side;
    if (p) {
      if (s === "top" && t.top - offset - ph < M && t.bottom + offset + ph <= vh - M) s = "bottom";
      else if (s === "bottom" && t.bottom + offset + ph > vh - M && t.top - offset - ph >= M) s = "top";
      else if (s === "left" && t.left - offset - pw < M && t.right + offset + pw <= vw - M) s = "right";
      else if (s === "right" && t.right + offset + pw > vw - M && t.left - offset - pw >= M) s = "left";
    }

    let left: number;
    let top: number;
    if (s === "top" || s === "bottom") {
      left = t.left + t.width / 2; // centered via translateX(-50%)
      top = s === "top" ? t.top - offset : t.bottom + offset;
      if (p) {
        const half = pw / 2;
        left = Math.min(Math.max(left, M + half), vw - M - half);
      }
    } else {
      top = t.top + t.height / 2; // centered via translateY(-50%)
      left = s === "left" ? t.left - offset : t.right + offset;
      if (p) {
        const half = ph / 2;
        top = Math.min(Math.max(top, M + half), vh - M - half);
      }
    }
    setPlace({ left, top, side: s });
  }, [side, offset]);

  const show = React.useCallback(() => {
    position(); // provisional (preferred side); refined in the layout effect
    setOpen(true);
    groupOpen = true;
  }, [position]);

  // Once the popup is in the DOM we can measure it and flip/clamp; running in a
  // layout effect keeps this before paint, so there's no visible reposition.
  React.useLayoutEffect(() => {
    if (!open) return;
    position();
    const onScrollOrResize = () => position();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, position]);

  const clearOpenTimer = () => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  const onEnter = () => {
    clearOpenTimer();
    // Instant if a sibling tooltip is (or was just) open — otherwise delay.
    if (groupOpen || Date.now() - lastCloseAt < GROUP_WINDOW) {
      show();
    } else {
      openTimer.current = setTimeout(show, OPEN_DELAY);
    }
  };

  const hide = () => {
    clearOpenTimer();
    if (open) {
      groupOpen = false;
      lastCloseAt = Date.now();
    }
    setOpen(false);
  };

  React.useEffect(() => () => clearOpenTimer(), []);

  if (!label) return children;

  const child = React.Children.only(children) as React.ReactElement<any>;
  const prev = child.props;
  const setRef = (node: HTMLElement | null) => {
    triggerRef.current = node;
    // React 19 exposes a passed `ref` as a normal prop; chain to it so callers
    // that need the node (e.g. popover anchors) keep working.
    const r = prev.ref;
    if (typeof r === "function") r(node);
    else if (r && typeof r === "object") r.current = node;
  };

  const trigger = React.cloneElement(child, {
    ref: setRef,
    onMouseEnter: (e: any) => {
      prev.onMouseEnter?.(e);
      onEnter();
    },
    onMouseLeave: (e: any) => {
      prev.onMouseLeave?.(e);
      hide();
    },
    onFocus: (e: any) => {
      prev.onFocus?.(e);
      onEnter();
    },
    onBlur: (e: any) => {
      prev.onBlur?.(e);
      hide();
    },
    // Suppress the native browser tooltip so it doesn't double up.
    title: undefined,
  });

  return (
    <>
      {trigger}
      {open &&
        place &&
        createPortal(
          <div
            ref={popupRef}
            className="tt-popup"
            role="tooltip"
            data-side={place.side}
            style={{ left: place.left, top: place.top }}
          >
            <span className="tt-label">{label}</span>
            {shortcut && shortcut.length > 0 && (
              <span className="tt-keys">
                {shortcut.map((k, i) => (
                  <kbd key={i} className="tt-key">
                    {k}
                  </kbd>
                ))}
              </span>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
