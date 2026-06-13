import React, { useEffect, useRef } from "react";
import type { ModelOption } from "../lib/api";

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
   * When set and busy, renders an extra "interrupt" send button that stops
   * the current turn and redirects with the typed message immediately.
   */
  onInterruptSend?: () => void;
  hint?: string;
  autoFocus?: boolean;
  /** Exposes the textarea so parents can focus it (e.g. keyboard shortcuts). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
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
  onInterruptSend,
  hint,
  autoFocus,
  textareaRef: externalRef,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;

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
      <div className={`composer ${disabled ? "composer-disabled" : ""}`}>
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
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
          {busy && onInterruptSend && (
            <button
              className="composer-send composer-send-interrupt"
              onClick={onInterruptSend}
              disabled={disabled || sendDisabled}
              title="Interrupt — stop the current turn and redirect with this message now"
            >
              ⚡
            </button>
          )}
          <button
            className={`composer-send ${busy ? "composer-send-queue" : ""}`}
            onClick={onSend}
            disabled={disabled || sendDisabled}
            title={sendTitle || (busy ? "Send — Michael folds it in at the next stopping point" : "Send (Enter)")}
          >
            {busy ? "+" : "↑"}
          </button>
        </div>
      </div>
      {hint && <div className="composer-hint">{hint}</div>}
    </div>
  );
}
