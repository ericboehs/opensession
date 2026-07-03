import { useCallback, useRef, useState } from "react";

// Scroll engineering for the transcript. The guiding rule: never move the reader
// against their intent. The reader's own scroll position is the source of truth
// for whether we keep them glued to the live edge ("following"). We only stick to
// the bottom while they're actually there; the moment they scroll up — or select
// text, which is also intent — we leave them where they are and surface a
// "Jump to latest" affordance instead.
//
// New turns are pinned near the top of the viewport so their reply can stream into
// the space below while earlier context stays visible (principles 4–6). That needs
// a bottom spacer: a freshly-sent message is the last element, so without reserved
// space below it the browser can't scroll it up to the top. The spacer is sized to
// exactly the room the latest turn needs and shrinks to nothing as the reply fills
// it — so once the answer is long enough the spacer vanishes and scrolling is normal.

// Distance from the bottom (px) that still counts as "at the live edge".
const STICK_THRESHOLD = 90;
// Gap left above a pinned turn so a little previous context stays visible.
const TOP_GAP = 20;

export interface ChatScroll {
  /** Attach to the scrollable transcript container. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to a zero-content div rendered as the last child of the container. */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** True while the reader is pinned to the live edge and we may auto-advance. */
  following: boolean;
  /** True when content has streamed in below the fold while not following. */
  newBelow: boolean;
  /** True when the latest message is out of view and the return control should show. */
  showScrollToBottom: boolean;
  /** Bring the reader back to the latest reply and resume following. */
  scrollToLatest: (behavior?: ScrollBehavior) => void;
  /** Pin a turn near the top of the viewport (used for reopening at the last turn). */
  anchorToTop: (target: HTMLElement | null) => void;
  /** Mark that the local reader just sent a turn — pin it to the top next paint. */
  beginTurn: () => void;
  /** The turn finished; release the spacer so the layout settles. */
  endTurn: () => void;
  /** Call after each content change (run in a layout effect) to keep things in place. */
  relayout: () => void;
  /** Wire to the container's onScroll to track the live edge. */
  onScroll: () => void;
}

function selectionWithin(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

function lastUserEl(container: HTMLElement): HTMLElement | null {
  const els = container.querySelectorAll<HTMLElement>(".msg-user");
  return els[els.length - 1] ?? null;
}

function latestMessageVisible(container: HTMLElement): boolean {
  const els = container.querySelectorAll<HTMLElement>(".msg");
  const latest = els[els.length - 1];
  if (!latest) return true;
  const containerRect = container.getBoundingClientRect();
  const latestRect = latest.getBoundingClientRect();
  return latestRect.bottom > containerRect.top && latestRect.top < containerRect.bottom;
}

export function useChatScroll(): ChatScroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  // followingRef is the live value read inside handlers; `following` mirrors it for
  // rendering. Default true so a fresh, running session tracks the stream.
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const [newBelow, setNewBelow] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Whether the latest turn is currently pinned to the top (spacer active).
  const pinnedRef = useRef(false);
  // Set on send; consumed once to perform the one-time scroll-to-top.
  const needAnchorRef = useRef(false);

  const distanceFromBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const clearSpacer = useCallback(() => {
    pinnedRef.current = false;
    needAnchorRef.current = false;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
  }, []);

  const setFollowing = useCallback((v: boolean) => {
    followingRef.current = v;
    setFollowingState(v);
    if (v) {
      // Returning to the live edge ends any pinned turn and clears the unread flag.
      setNewBelow(false);
      setShowScrollToBottom(false);
      clearSpacer();
    }
  }, [clearSpacer]);

  const updateScrollToBottomVisibility = useCallback((isFollowing = followingRef.current) => {
    const el = containerRef.current;
    setShowScrollToBottom(Boolean(el && !isFollowing && !latestMessageVisible(el)));
  }, []);

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const el = containerRef.current;
      if (!el) return;
      clearSpacer();
      el.scrollTo({ top: el.scrollHeight, behavior });
      setFollowing(true);
    },
    [clearSpacer, setFollowing]
  );

  const anchorToTop = useCallback((target: HTMLElement | null) => {
    const el = containerRef.current;
    if (!el || !target) return;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top - TOP_GAP;
    if (delta <= 0) return; // already at or above the target — don't scroll up
    el.scrollTo({ top: el.scrollTop + delta, behavior: "smooth" });
    // Leaving the live edge to read from the top is intent: stop following so the
    // streaming reply fills the space below instead of yanking us back down.
    setFollowing(false);
    updateScrollToBottomVisibility(false);
  }, [setFollowing, updateScrollToBottomVisibility]);

  // Size the bottom spacer to exactly the room the pinned turn needs to sit near the
  // top. Resizing a spacer that's below the fold doesn't move what the reader sees.
  const sizeSpacer = useCallback(() => {
    const el = containerRef.current;
    const sp = spacerRef.current;
    if (!el || !sp) return;
    if (!pinnedRef.current) { sp.style.height = "0px"; return; }
    const target = lastUserEl(el);
    if (!target) { sp.style.height = "0px"; return; }
    const current = sp.offsetHeight;
    const contentHeight = el.scrollHeight - current; // exclude the spacer itself
    const targetTop =
      target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const below = contentHeight - targetTop; // content height beneath the pinned turn
    sp.style.height = `${Math.max(0, el.clientHeight - below - TOP_GAP)}px`;
  }, []);

  const beginTurn = useCallback(() => {
    pinnedRef.current = true;
    needAnchorRef.current = true;
  }, []);

  const endTurn = useCallback(() => { clearSpacer(); }, [clearSpacer]);

  // Run from a layout effect after content changes. Two jobs: keep a following
  // reader glued to the live edge, and maintain the pinned-turn spacer.
  const relayout = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      sizeSpacer();
      if (needAnchorRef.current) {
        // First paint after a send: now that the spacer reserves room, scroll the
        // new turn to the top. Re-measure afterwards so the spacer is exact.
        const target = lastUserEl(el);
        if (target) {
          anchorToTop(target);
          needAnchorRef.current = false;
          sizeSpacer();
        }
      }
      updateScrollToBottomVisibility(false);
      return;
    }
    // Stick to the bottom only while following — and never mid-selection, since a
    // selection is the reader actively working with the text (principle 3).
    if (followingRef.current && !selectionWithin(el)) {
      el.scrollTop = el.scrollHeight; // instant: a smooth animation per token janks
    } else if (!followingRef.current && distanceFromBottom() > STICK_THRESHOLD) {
      setNewBelow(true); // content arrived out of view — let the UI announce it
    }
    updateScrollToBottomVisibility();
  }, [sizeSpacer, anchorToTop, distanceFromBottom, updateScrollToBottomVisibility]);

  // The reader's scroll is the source of truth for following. Reaching the live
  // edge re-engages it; scrolling away disengages it.
  const onScroll = useCallback(() => {
    const atEdge = distanceFromBottom() < STICK_THRESHOLD;
    if (atEdge !== followingRef.current) setFollowing(atEdge);
    updateScrollToBottomVisibility(atEdge);
  }, [distanceFromBottom, setFollowing, updateScrollToBottomVisibility]);

  return {
    containerRef,
    spacerRef,
    following,
    newBelow,
    showScrollToBottom,
    scrollToLatest,
    anchorToTop,
    beginTurn,
    endTurn,
    relayout,
    onScroll,
  };
}
