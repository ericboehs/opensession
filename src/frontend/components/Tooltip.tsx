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
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  const compute = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = 0;
    let top = 0;
    switch (side) {
      case "top":
        left = r.left + r.width / 2;
        top = r.top - offset;
        break;
      case "bottom":
        left = r.left + r.width / 2;
        top = r.bottom + offset;
        break;
      case "left":
        left = r.left - offset;
        top = r.top + r.height / 2;
        break;
      case "right":
        left = r.right + offset;
        top = r.top + r.height / 2;
        break;
    }
    setPos({ left, top });
  }, [side, offset]);

  const show = React.useCallback(() => {
    compute();
    setOpen(true);
    groupOpen = true;
  }, [compute]);

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
        pos &&
        createPortal(
          <div
            className="tt-popup"
            role="tooltip"
            data-side={side}
            style={{ left: pos.left, top: pos.top }}
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
