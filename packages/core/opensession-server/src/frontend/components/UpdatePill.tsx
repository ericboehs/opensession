import React, { useEffect, useState } from "react";
import type { WSServerMessage } from "../lib/types";
import { PRODUCT_NAME } from "../lib/brand";
import { subscribeFrontendVersion } from "../lib/frontend-version";
import { PERSISTENT_NOTICE_CARD } from "../lib/notification-classes";
import { Tooltip } from "../ui/tooltip";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	flex: {
			display: "flex"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	flexCol: {
			flexDirection: "column"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	gap05: {
			gap: "2px"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	leading13: {
			lineHeight: "1.3"
	},
	textFg: {
			color: "var(--text)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	shrink0: {
			flexShrink: "0"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap1: {
			gap: "4px"
	},

	inlineFlex: {
		"display": "inline-flex"
	},
	h7: {
		"height": "28px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	},
	CornerShapeSquircle: {
		"cornerShape": "squircle"
	},
	px13px: {
		"paddingInline": "13px"
	},
	cursorPointer: {
		"cursor": "pointer"
	},
	borderNone: {
		"--tw-border-style": "none",
		"borderStyle": "none"
	},
	bgRed: {
		"backgroundColor": "var(--red)"
	},
	fontSemibold: {
		"--tw-font-weight": "var(--font-weight-semibold)",
		"fontWeight": "var(--font-weight-semibold)"
	},
	leadingNone: {
		"--tw-leading": "1",
		"lineHeight": "1"
	},
	textWhite: {
		"color": "var(--color-white)"
	},
	transitionBackground: {
		"transitionProperty": "background",
		"transitionTimingFunction": "var(--tw-ease,var(--ease))",
		"transitionDuration": "var(--tw-duration,var(--dur-micro))"
	},
	durationVarDurMicro: {
		"--tw-duration": "var(--dur-micro)",
		"transitionDuration": "var(--dur-micro)"
	},
	easeVarEase: {
		"--tw-ease": "var(--ease)",
		"transitionTimingFunction": "var(--ease)"
	},
	disabledCursorWait: {
		":disabled": {
			"cursor": "wait"
		}
	},
	disabledOpacity75: {
		":disabled": {
			"opacity": ".75"
		}
	},
	animateUpdateToastInVarDurLgVarEase: {
		"animation": "update-toast-in var(--dur-lg) var(--ease)"
	},
	motionReduceAnimateNone: {
		"@media (prefers-reduced-motion: reduce)": {
			"animation": "none"
		}
	},
	roundedControl: {
		"borderRadius": "calc(12px * var(--rf))"
	},
	px3: {
		"paddingInline": "12px"
	},

	hoverBgColorMixInSrgbVarRed85Black: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--red)"
			},
			"@supports (color: color-mix(in lab, red, red))": {
				":hover": {
					"backgroundColor": "color-mix(in srgb,var(--red) 85%,black)"
				}
			}
		}
	},
});

interface Props {
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  // "card" lives in the persistent desktop shelf. "pill" is the compact
  // topbar variant that sits next to the brand logo on phones.
  variant?: "card" | "pill";
}

/** Grace before a forced update reloads a VISIBLE tab (hidden tabs reload
 *  immediately) — long enough to finish a thought, short enough that a
 *  protocol-break deploy converges in under a minute. */
const FORCE_GRACE_MS = 20_000;

type ShellUpdateState = {
  state: "idle" | "available" | "downloaded";
  version?: string | null;
};

/** The mac shell's updater bridge — absent in a browser. `onState` replays the
 *  current state on subscribe, so a reload re-surfaces a staged update. */
function os1Updates():
  | {
      onState: (cb: (s: ShellUpdateState) => void) => (() => void) | void;
      install: () => void;
    }
  | undefined {
  return (
    window as {
      os1?: {
        updates?: {
          onState: (cb: (s: ShellUpdateState) => void) => (() => void) | void;
          install: () => void;
        };
      };
    }
  ).os1?.updates;
}

/**
 * The one "a new version is available" nudge, for both kinds of update:
 *
 *  - The **web bundle**, from the server's `frontend_updated` broadcast after
 *    an in-process rebuild (no restart, so running sessions are untouched) —
 *    a page refresh picks it up.
 *  - The **mac shell binary**, from the Squirrel updater behind
 *    `window.os1.updates` (packages/clients/mac/src/preload.js) — a relaunch installs it.
 *    We stay quiet through its "available" (still downloading) state: there is
 *    nothing to act on until it reports "downloaded".
 *
 * A staged shell update wins, because relaunching also loads the newest
 * frontend — so there is never more than one update message on screen.
 *
 * Acting is normally optional — new page loads already get the new build; this
 * just nudges already-open tabs — so it's non-blocking (it never covers the
 * composer). Desktop shows a toast over the sidebar bottom; phones show a
 * compact pill in the top bar, right after the brand logo.
 *
 * `force: true` broadcasts (POST /api/admin/frontend-reload — sent before a
 * server-side protocol change that old bundles can't follow) auto-reload
 * instead: hidden tabs immediately, visible tabs after a counted-down grace
 * shown on the pill/toast, or the moment the tab is hidden mid-countdown.
 */
export function UpdatePill({ addHandler, variant = "card" }: Props) {
  const [show, setShow] = useState(false);
  const [by, setBy] = useState<string | null>(null);
  const [forceAt, setForceAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  const [shellReady, setShellReady] = useState(false);

  function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    if (shellReady) {
      os1Updates()?.install();
      return;
    }
    // Let feedback paint before a potentially slow network-first navigation.
    setTimeout(() => location.reload(), 50);
  }

  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type !== "frontend_updated") return;
        setShow(true);
        if (msg.by) setBy(msg.by);
        if (msg.force) {
          if (document.hidden) {
            location.reload();
            return;
          }
          // Repeat broadcasts keep the EARLIEST deadline (no countdown resets).
          setForceAt((prev) => prev ?? Date.now() + FORCE_GRACE_MS);
        }
      }),
    [addHandler]
  );

  // Backstop for a window that missed the broadcast (an Electron renderer
  // asleep through the rebuild, a socket that reconnected across it): poll the
  // build version and nudge. Never forces — same non-blocking nudge as above.
  useEffect(() => subscribeFrontendVersion(() => setShow(true)), []);

  useEffect(() => {
    const updates = os1Updates();
    if (!updates?.onState) return;
    const off = updates.onState((s) => {
      setShellReady(s.state === "downloaded");
      setShellVersion(s.version ?? null);
    });
    return typeof off === "function" ? off : undefined;
  }, []);

  useEffect(() => {
    if (forceAt == null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((forceAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) location.reload();
    };
    tick();
    const iv = setInterval(tick, 500);
    // A tab backgrounded mid-countdown reloads right away — nobody's looking.
    const onVis = () => {
      if (document.hidden) location.reload();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [forceAt]);

  if (!show && !shellReady) return null;

  const forced = secondsLeft != null;
  // A staged shell update replaces the refresh with a relaunch, which installs
  // the binary AND loads the newest frontend. Forced reloads still win: they
  // exist because the open bundle can no longer talk to the server.
  const restart = shellReady && !forced;
  const action = refreshing
    ? restart
      ? "Restarting…"
      : "Refreshing…"
    : forced
      ? "Refresh now"
      : restart
        ? "Restart"
        : "Refresh";
  const detail = restart ? shellVersion : by;

  if (variant === "pill") {
    return (
      <button
        // The pill keeps a squircle at a pill radius on purpose; base.css
        // exempts rounded-full from its generic squircle rule.
        className={
          mergeStylexClassName("", sx.inlineFlex, sx.h7, sx.shrink0, sx.itemsCenter, sx.roundedFull, sx.CornerShapeSquircle, sx.px13px) +
          mergeStylexClassName("", sx.hoverBgColorMixInSrgbVarRed85Black, sx.cursorPointer, sx.borderNone, sx.bgRed, typography.label, sx.fontSemibold, sx.leadingNone, sx.textWhite, sx.transitionBackground, sx.durationVarDurMicro, sx.easeVarEase, sx.disabledCursorWait, sx.disabledOpacity75) +
          mergeStylexClassName("", sx.animateUpdateToastInVarDurLgVarEase, sx.motionReduceAnimateNone) +
          // Phone: keep the visible pill compact while a pseudo-element grows
          // its tap target to the full 44px header row.
          "phone:[.app-brand_&]:relative phone:[.app-brand_&]:order-3 " +
          "phone:[.app-brand_&]:h-7 phone:[.app-brand_&]:px-3 phone:[.app-brand_&]:text-supporting " +
          "phone:[.app-brand_&]:after:absolute phone:[.app-brand_&]:after:inset-x-0 " +
          "phone:[.app-brand_&]:after:top-1/2 phone:[.app-brand_&]:after:h-11 " +
          "phone:[.app-brand_&]:after:-translate-y-1/2 phone:[.app-brand_&]:after:content-['']"
        }
        onClick={refresh}
        disabled={refreshing}
        role="status"
        aria-live="polite"
        title={
          forced
            ? `Updating in ${secondsLeft}s. Tap to refresh now.`
            : restart
              ? `${PRODUCT_NAME} ${shellVersion ?? "update"} is ready. Tap to restart and install it.`
              : `A new update is available${by ? ` (${by})` : ""}. Tap to refresh.`
        }
      >
        {refreshing
          ? restart
            ? "Restarting…"
            : "Refreshing…"
          : forced
            ? `Update ${secondsLeft}s`
            : "Update"}
      </button>
    );
  }

  return (
    <div
      className={PERSISTENT_NOTICE_CARD}
      role="status"
      aria-live="polite"
    >
      <div {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.flexCol, sx.itemsStart, sx.gap05)}>
        <span {...stylex.props(sx.maxWFull, sx.truncate, sx.fontMedium, sx.leading13, sx.textFg, typography.supporting)}>
          {forced
            ? `Updating in ${secondsLeft}s…`
            : restart
              ? "Update ready"
              : "New update available"}
        </span>
        {detail && (
          <Tooltip label={detail} side="top" multiline>
            <span {...stylex.props(sx.maxWFull, sx.truncate, sx.fontMedium, sx.leading13, sx.textDim, typography.meta)}>{detail}</span>
          </Tooltip>
        )}
      </div>
      <div {...stylex.props(sx.flex, sx.shrink0, sx.itemsCenter, sx.gap1)}>
        <button
          className={mergeStylexClassName("", sx.hoverBgColorMixInSrgbVarRed85Black, sx.inlineFlex, sx.h7, sx.itemsCenter, sx.roundedControl, sx.px3, sx.cursorPointer, sx.borderNone, sx.bgRed, typography.supporting, sx.fontSemibold, sx.leadingNone, sx.textWhite, sx.transitionBackground, sx.durationVarDurMicro, sx.easeVarEase, sx.disabledCursorWait, sx.disabledOpacity75)}
          onClick={refresh}
          disabled={refreshing}
        >
          {action}
        </button>
      </div>
    </div>
  );
}
