import React, { useEffect, useRef, useState } from "react";
import type { ModelOption, FileMention } from "../lib/api";
import { filesToDataUrls, imageFilesFromPaste } from "../lib/images";
import { ImageThumbs } from "./ImageThumbs";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder?: string;
  disabled?: boolean;
  sendDisabled?: boolean;
  /** Shows on the send button tooltip when busy-queueing. */
  sendTitle?: string;
  busy?: boolean;
  models: ModelOption[];
  defaultModel: string;
  /** Current model id; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  modelDisabled?: boolean;
  modelTitle?: string;
  /** Extra control rendered in the toolbar, left of the send button. */
  leftExtra?: React.ReactNode;
  /**
   * When set and busy, renders an extra "fold in" send button — the gentle
   * option that queues the message for Michael's next stopping point instead of
   * interrupting (the main send button interrupts immediately when busy).
   */
  onSteerSend?: () => void;
  hint?: string;
  autoFocus?: boolean;
  /** Exposes the textarea so parents can focus it (e.g. keyboard shortcuts). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Attached images as `data:` URLs. When `onImagesChange` is provided, the
   * composer accepts pasted/dropped screenshots and renders thumbnails.
   */
  images?: string[];
  onImagesChange?: (images: string[]) => void;
  /**
   * Enables "@"-mention file autocomplete. Given the text typed after the "@",
   * returns matching files (primary repo + any attached repos). When omitted,
   * "@" is inert.
   */
  mentionFetch?: (query: string) => Promise<FileMention[]>;
}

function modelShortLabel(id: string, models: ModelOption[]): string {
  const m = models.find((x) => x.id === id);
  return m ? m.label : id;
}

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

/**
 * Shared chat composer (Claude/Codex-style): rounded container with an
 * auto-growing textarea and a bottom toolbar carrying the model pill and a
 * circular send button. Enter sends, Shift+Enter newlines. With `mentionFetch`,
 * typing "@" opens a file-path autocomplete (arrows to move, Enter/Tab to pick).
 */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  disabled,
  sendDisabled,
  sendTitle,
  busy,
  models,
  defaultModel,
  model,
  onModelChange,
  modelDisabled,
  modelTitle,
  leftExtra,
  onSteerSend,
  hint,
  autoFocus,
  textareaRef: externalRef,
  images,
  onImagesChange,
  mentionFetch,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const imgs = images || [];

  // ── "@"-mention autocomplete state ──
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [suggestions, setSuggestions] = useState<FileMention[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  // Caret-target to apply after a programmatic value change (insertion).
  const pendingCaret = useRef<number | null>(null);
  // Guards against a stale async fetch overwriting a newer query's results.
  const fetchSeq = useRef(0);

  async function addFiles(files: FileList | File[]) {
    if (!onImagesChange) return;
    const urls = await filesToDataUrls(files);
    if (urls.length) onImagesChange([...imgs, ...urls]);
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (!onImagesChange) return;
    const files = imageFilesFromPaste(e);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!onImagesChange || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    void addFiles(e.dataTransfer.files);
  }

  function removeImage(i: number) {
    onImagesChange?.(imgs.filter((_, idx) => idx !== i));
  }

  // Auto-grow up to the CSS max-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

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

  // Re-evaluate the mention context whenever value or caret could have changed.
  function syncMention() {
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

  const mentionOpen = !!mention && suggestions.length > 0;

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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySuggestion(suggestions[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        setSuggestions([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      e.preventDefault();
      onSend();
    }
  }

  const effectiveModel = model || defaultModel;

  return (
    <div className="composer-wrap">
      <div
        className={`composer ${disabled ? "composer-disabled" : ""}`}
        onDrop={handleDrop}
        onDragOver={(e) => onImagesChange && e.preventDefault()}
      >
        <ImageThumbs images={imgs} onRemove={removeImage} disabled={disabled} />
        <div className="composer-input-wrap">
          {mentionOpen && (
            <div className="mention-popup" role="listbox">
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
          )}
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              // Caret has moved to the new value; re-evaluate after React commits.
              queueMicrotask(syncMention);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={syncMention}
            onClick={syncMention}
            onBlur={() => {
              // Let a click on a suggestion (mousedown) win the race first.
              setTimeout(() => setMention(null), 120);
            }}
            onPaste={handlePaste}
            disabled={disabled}
            rows={1}
            autoFocus={autoFocus}
          />
        </div>
        <div className="composer-toolbar">
          <div className="composer-model" title={modelTitle || "Model for this session"}>
            <span className={`composer-model-dot ${effectiveModel.startsWith("gpt") || effectiveModel.startsWith("codex") ? "dot-codex" : "dot-claude"}`} />
            <select
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              disabled={disabled || modelDisabled}
              aria-label="Model"
            >
              <option value="">{modelShortLabel(defaultModel, models)}</option>
              {models
                .filter((m) => m.id !== defaultModel)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
            </select>
            <span className="composer-model-chevron">▾</span>
          </div>
          {leftExtra}
          <div className="composer-spacer" />
          {busy && onSteerSend && (
            <button
              className="composer-send composer-send-queue"
              onClick={onSteerSend}
              disabled={disabled || sendDisabled}
              title="Fold in at Michael's next stopping point — don't interrupt the current turn"
            >
              +
            </button>
          )}
          <button
            className={`composer-send ${busy ? "composer-send-interrupt" : ""}`}
            onClick={onSend}
            disabled={disabled || sendDisabled}
            title={
              sendTitle ||
              (busy ? "Send now — interrupts the current turn and redirects Michael (Enter)" : "Send (Enter)")
            }
          >
            {busy ? "⚡" : "↑"}
          </button>
        </div>
      </div>
      {hint && <div className="composer-hint">{hint}</div>}
    </div>
  );
}
