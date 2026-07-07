import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { cn } from "./cn";

/**
 * A plain-text `contenteditable` that behaves like a lightweight `<textarea>`.
 *
 * Why it exists: iOS Safari/WebKit renders a native "form accessory bar" (the
 * previous/next-field chevrons + Done checkmark) above the keyboard for every
 * focused `<input>`/`<textarea>`/`<select>`, eating a strip of screen. WebKit
 * does NOT draw that bar for `contenteditable` regions, so swapping the input
 * type reclaims the space. This is the spike venue for that (Watercooler chat);
 * if it pans out on-device we can migrate the main Composer to it too.
 *
 * Design constraints that keep it textarea-shaped and desync-free:
 *  - Content is kept as a flat run of text nodes (no `<div>`/`<br>` soup): we
 *    intercept Enter (always preventDefault so the browser can't inject a block)
 *    and paste (insert plain text only). That makes `textContent` an exact,
 *    reliable mirror of the value — caret math via Range.toString().length works.
 *  - It's value-controlled but the DOM is only rewritten when `value` actually
 *    diverges from `textContent` (programmatic edits: mention insert, clear,
 *    prefill) — never on the user's own keystrokes — so the caret never jumps.
 *  - Placeholder rides a `data-empty` attr + CSS `::before` (see global.css).
 */

export interface PlainCEHandle {
  focus(): void;
  /** Live plain-text value straight from the DOM (avoids stale React state). */
  getText(): string;
  /** Plain-text caret offset (end of selection), 0 when unfocused/empty. */
  getCaret(): number;
  /** Place the caret at a plain-text offset (clamped to length). */
  setCaret(offset: number): void;
  el: HTMLDivElement | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onClick?: (e: React.MouseEvent) => void;
  onKeyUp?: (e: React.KeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onPaste?: (e: React.ClipboardEvent) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
}

/** Flatten the editor to plain text — DOM is text-nodes-only, so textContent is exact. */
function readText(el: HTMLElement): string {
  return el.textContent ?? "";
}

/** Plain-text offset of the current selection end within `el`. */
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

/** Walk text nodes to place the caret at a plain-text offset. */
function placeCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  let last: Text | null = null;
  while (node) {
    last = node;
    const len = node.textContent?.length ?? 0;
    if (remaining <= len) {
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  // Past the end (or empty): drop the caret at the very end.
  if (last) {
    range.setStart(last, last.textContent?.length ?? 0);
  } else {
    range.setStart(el, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Replace the current selection with plain text and leave the caret after it. */
function insertPlainText(el: HTMLElement, text: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    // No selection (e.g. programmatic): append at the end.
    el.appendChild(document.createTextNode(text));
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export const PlainContentEditable = forwardRef<PlainCEHandle, Props>(
  function PlainContentEditable(
    {
      value,
      onChange,
      onKeyDown,
      onClick,
      onKeyUp,
      onFocus,
      onBlur,
      onPaste,
      placeholder,
      className,
      disabled,
      autoFocus,
      ...rest
    },
    ref,
  ) {
    const divRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => divRef.current?.focus(),
      getText: () => (divRef.current ? readText(divRef.current) : ""),
      getCaret: () => (divRef.current ? caretOffset(divRef.current) : 0),
      setCaret: (offset: number) =>
        divRef.current && placeCaret(divRef.current, offset),
      get el() {
        return divRef.current;
      },
    }));

    // Mirror `value` into the DOM only when it diverges (programmatic edits),
    // never on the user's own keystrokes — so the caret never jumps.
    useEffect(() => {
      const el = divRef.current;
      if (el && readText(el) !== value) el.textContent = value;
    }, [value]);

    useEffect(() => {
      if (autoFocus) divRef.current?.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function emit() {
      const el = divRef.current;
      if (el) onChange(readText(el));
    }

    return (
      <div
        {...rest}
        ref={divRef}
        role="textbox"
        aria-multiline="true"
        contentEditable={!disabled}
        suppressContentEditableWarning
        data-empty={value.length === 0 ? "" : undefined}
        data-placeholder={placeholder}
        className={cn("plain-ce", className)}
        onInput={emit}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          // Always own Enter so the browser can't inject a <div>/<br> block:
          // the consumer handles plain Enter (send) via preventDefault above;
          // anything reaching here (e.g. Shift+Enter) inserts a literal newline.
          if (e.key === "Enter") {
            e.preventDefault();
            if (divRef.current) {
              insertPlainText(divRef.current, "\n");
              emit();
            }
          }
        }}
        onKeyUp={onKeyUp}
        onClick={onClick}
        onFocus={onFocus}
        onBlur={onBlur}
        onPaste={(e) => {
          onPaste?.(e);
          if (e.defaultPrevented) return;
          // Keep the DOM plain-text only: never let the browser paste rich HTML.
          const text = e.clipboardData.getData("text/plain");
          e.preventDefault();
          if (divRef.current) {
            insertPlainText(divRef.current, text);
            emit();
          }
        }}
      />
    );
  },
);
