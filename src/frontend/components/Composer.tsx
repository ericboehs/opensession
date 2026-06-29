import React, { useEffect, useRef } from "react";
import type { ModelOption } from "../lib/api";
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
}

function modelShortLabel(id: string, models: ModelOption[]): string {
  const m = models.find((x) => x.id === id);
  return m ? m.label : id;
}

/**
 * Shared chat composer (Claude/Codex-style): rounded container with an
 * auto-growing textarea and a bottom toolbar carrying the model pill and a
 * circular send button. Enter sends, Shift+Enter newlines.
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
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const imgs = images || [];

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

  function handleKeyDown(e: React.KeyboardEvent) {
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
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
          rows={1}
          autoFocus={autoFocus}
        />
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
