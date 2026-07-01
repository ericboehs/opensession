import React, { useEffect, useRef } from "react";
import type { ModelOption, FileMention } from "../lib/api";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";

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
   * Non-image attachments (staged to disk server-side). When `onFilesChange` is
   * provided, the composer accepts any dropped/picked file, not just images.
   */
  files?: FileAttachment[];
  onFilesChange?: (files: FileAttachment[]) => void;
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
  files,
  onFilesChange,
  mentionFetch,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgs = images || [];
  const fls = files || [];
  // Any attachment affordance (paste/drop/pick + thumbnails) is enabled when the
  // parent wired up either channel.
  const canAttach = !!onImagesChange || !!onFilesChange;

  // "@"-mention file autocomplete (shared with the New-session prompt field).
  const mentions = useFileMentions({ value, onChange, textareaRef, mentionFetch });

  async function addFiles(picked: FileList | File[]) {
    if (!canAttach) return;
    const { images: newImgs, files: newFls } = await splitAttachments(picked);
    // Images ride the vision channel; other files need a dedicated file channel
    // (if the parent only wired images, non-image files are simply ignored).
    if (newImgs.length) onImagesChange?.([...imgs, ...newImgs]);
    if (newFls.length && onFilesChange) onFilesChange([...fls, ...newFls]);
  }

  function handlePaste(e: React.ClipboardEvent) {
    if (!canAttach) return;
    const pasted = imageFilesFromPaste(e);
    if (pasted.length) {
      e.preventDefault();
      void addFiles(pasted);
    }
  }

  function handleDrop(e: React.DragEvent) {
    if (!canAttach || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    void addFiles(e.dataTransfer.files);
  }

  function removeImage(i: number) {
    onImagesChange?.(imgs.filter((_, idx) => idx !== i));
  }

  function removeFile(i: number) {
    onFilesChange?.(fls.filter((_, idx) => idx !== i));
  }

  // Auto-grow up to the CSS max-height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (mentions.handleKeyDown(e)) return;
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
        onDragOver={(e) => canAttach && e.preventDefault()}
      >
        <ImageThumbs images={imgs} onRemove={removeImage} disabled={disabled} />
        <FileChips files={fls} onRemove={removeFile} disabled={disabled} />
        <div className="composer-input-wrap" ref={mentions.inputWrapRef}>
          {mentions.popup}
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              // Caret has moved to the new value; re-evaluate after React commits.
              queueMicrotask(mentions.sync);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onBlur={() => {
              // Let a click on a suggestion (mousedown) win the race first.
              setTimeout(mentions.close, 120);
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
          {canAttach && (
            <>
              <button
                type="button"
                className="composer-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                title={onFilesChange ? "Attach a file" : "Attach an image"}
                aria-label={onFilesChange ? "Attach a file" : "Attach an image"}
              >
                📎
              </button>
              <input
                ref={fileInputRef}
                type="file"
                {...(onFilesChange ? {} : { accept: "image/*" })}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  // Reset so picking the same file again still fires onChange.
                  e.target.value = "";
                }}
              />
            </>
          )}
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
