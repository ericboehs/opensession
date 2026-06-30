import React, { useEffect, useRef, useState } from "react";
import type { FileMention } from "../lib/api";

/**
 * Find the active "@"-mention being typed at the caret. Returns the index of
 * the "@" and the query typed after it, or null when the caret isn't inside a
 * mention token. A mention starts at "@" that is at the start of the text or
 * preceded by whitespace, and runs until the first whitespace.
 */
function mentionContextAt(value: string, caret: number): { start: number; query: string } | null {
  // Walk back from the caret to the "@", bailing on whitespace.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i > 0 ? value[i - 1] : " ";
      if (prev === " " || prev === "\n" || prev === "\t") {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i--;
  }
  return null;
}

interface Options {
  value: string;
  onChange: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Enables "@"-mention file autocomplete. Given the text typed after the "@",
   * returns matching files. When omitted, the hook is inert.
   */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
}

interface FileMentions {
  /** Ref for the positioned wrapper the popup anchors against (needs position:relative). */
  inputWrapRef: React.RefObject<HTMLDivElement | null>;
  /** The suggestion popup to render inside the wrapper, or null when closed. */
  popup: React.ReactNode;
  /** True while the popup is open (suggestions visible). */
  open: boolean;
  /** Re-evaluate the mention context; call on keyup/click and after value changes. */
  sync: () => void;
  /**
   * Handle a keydown while the popup is open (arrows/enter/tab/escape). Returns
   * true when it consumed the key — callers should then `return` from their own
   * keydown handler so it doesn't also send/newline.
   */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** Close the popup (e.g. on blur, after letting a click win the race). */
  close: () => void;
}

/**
 * Shared "@"-mention file-path autocomplete for textareas. Manages the popup
 * state, debounced fetching, keyboard navigation and insertion, and returns a
 * popup node plus handlers to wire into a host textarea. Used by both the chat
 * Composer and the New-session prompt field so they behave identically.
 */
export function useFileMentions({ value, onChange, textareaRef, mentionFetch }: Options): FileMentions {
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [suggestions, setSuggestions] = useState<FileMention[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  // Caret-target to apply after a programmatic value change (insertion).
  const pendingCaret = useRef<number | null>(null);
  // Guards against a stale async fetch overwriting a newer query's results.
  const fetchSeq = useRef(0);
  // Whether the popup opens downward instead of upward — decided by available
  // space so it never clips against the top of the viewport.
  const inputWrapRef = useRef<HTMLDivElement>(null);
  const [dropDown, setDropDown] = useState(false);

  // Apply a pending caret position after a programmatic value change.
  useEffect(() => {
    if (pendingCaret.current == null) return;
    const el = textareaRef.current;
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [value]);

  function sync() {
    if (!mentionFetch) return;
    const el = textareaRef.current;
    if (!el) return;
    const ctx = mentionContextAt(el.value, el.selectionStart ?? el.value.length);
    setMention(ctx);
    if (!ctx) setSuggestions([]);
  }

  // Debounced fetch of suggestions for the active mention query.
  useEffect(() => {
    if (!mention || !mentionFetch) {
      setSuggestions([]);
      return;
    }
    const seq = ++fetchSeq.current;
    const t = setTimeout(async () => {
      const files = await mentionFetch(mention.query);
      if (seq === fetchSeq.current) {
        setSuggestions(files);
        setActiveIdx(0);
      }
    }, 70);
    return () => clearTimeout(t);
  }, [mention?.query, mention?.start, mentionFetch]);

  const open = !!mention && suggestions.length > 0;

  // Pick the popup direction from available space: open upward by default, but
  // flip downward when there isn't room above (e.g. centered home composer).
  useEffect(() => {
    if (!open) return;
    const el = inputWrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const POPUP_MAX = 240;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    setDropDown(spaceAbove < POPUP_MAX && spaceBelow > spaceAbove);
  }, [open, suggestions.length]);

  function applySuggestion(item: FileMention) {
    if (!mention) return;
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, mention.start);
    const after = value.slice(caret);
    const insert = `@${item.insert} `;
    const next = before + insert + after;
    pendingCaret.current = before.length + insert.length;
    setMention(null);
    setSuggestions([]);
    onChange(next);
  }

  function handleKeyDown(e: React.KeyboardEvent): boolean {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % suggestions.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applySuggestion(suggestions[activeIdx]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setMention(null);
      setSuggestions([]);
      return true;
    }
    return false;
  }

  function close() {
    setMention(null);
  }

  const popup = open ? (
    <div className={`mention-popup ${dropDown ? "mention-popup-down" : ""}`} role="listbox">
      {suggestions.map((item, i) => {
        const path = item.display;
        const slash = path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        return (
          <div
            key={`${item.insert}-${i}`}
            role="option"
            aria-selected={i === activeIdx}
            className={`mention-item ${i === activeIdx ? "mention-item-active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              applySuggestion(item);
            }}
            onMouseEnter={() => setActiveIdx(i)}
          >
            {item.repo && <span className="mention-repo">{item.repo}</span>}
            <span className="mention-base">{base}</span>
            {dir && <span className="mention-dir">{dir}</span>}
          </div>
        );
      })}
    </div>
  ) : null;

  return { inputWrapRef, popup, open, sync, handleKeyDown, close };
}
