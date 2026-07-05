import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, FileMention, ClaudeAccountOption } from "../lib/api";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { loadDraft, saveDraft } from "../lib/drafts";
import {
  composerHighlightHtml,
  needsComposerHighlight,
} from "../lib/composer-highlight";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
import {
  IconArrowUp,
  IconArrowDownRight,
  IconPlus,
  IconPaperclip,
  IconAtSign,
  IconCrosshair,
  IconStopSquare,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import {
  getSendKeyPref,
  onSendKeyChanged,
  isSendCombo,
  sendKeyLabel,
  MOD_ENTER_GLYPH,
} from "../lib/send-key";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { motion, AnimatePresence } from "motion/react";
import { composerMorph, composerChipMotion } from "../ui/motion";
import { ModelEffortSelect, shortModelLabel } from "./ModelEffortSelect";

interface Props {
  /**
   * Controlled draft text. Omit it (with `onChange`) to let the Composer own
   * the draft internally — the parent then receives the text via `onSend` and
   * stops re-rendering on every keystroke (the CommentableDiff draft-text
   * lesson). In uncontrolled mode the draft clears when `onSend` returns true
   * (i.e. the message was actually consumed).
   */
  value?: string;
  onChange?: (value: string) => void;
  /**
   * Uncontrolled mode only: persist the text draft under this key (lib/drafts)
   * so it survives the component unmounting — switching to another chat,
   * workspace or view. Restored on mount; cleared when a send is consumed.
   * Controlled parents own their value and persist it themselves.
   */
  draftKey?: string;
  /** `interrupt` is set when the send should abort the current turn and
   * deliver right away (⌘/Ctrl+Enter while a run is busy). */
  onSend: (text: string, opts?: { interrupt?: boolean }) => boolean | void;
  placeholder?: string;
  disabled?: boolean;
  /** Boolean, or a predicate on the current draft (for uncontrolled mode,
   * where the parent can't read the text). */
  sendDisabled?: boolean | ((text: string) => boolean);
  /** Shows on the send button tooltip when busy-queueing. */
  sendTitle?: string;
  busy?: boolean;
  busySendMode?: "queue" | "steer";
  onStop?: () => void;
  models: ModelOption[];
  defaultModel: string;
  /** Current model id; "" = default. */
  model: string;
  onModelChange: (model: string) => void;
  modelDisabled?: boolean;
  modelTitle?: string;
  /**
   * Reasoning-effort control (stowed as a compact pill, mirroring the new-session
   * palette). Forward-compatible: threaded through but not yet consumed
   * server-side. When omitted, the effort pill is hidden.
   */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  /** Pinnable Claude subscriptions + current pin, for the model pill's
   *  Subscription submenu. Empty/omitted hides it (e.g. Codex sessions). */
  accounts?: ClaudeAccountOption[];
  accountId?: string;
  onAccountChange?: (accountId: string) => void;
  /**
   * Session goal (pinned via /goal, rides along with every prompt). When
   * `onSetGoal` is wired, a target button lets you set/clear it inline; it lights
   * up and grows a "Goal" label while a goal is pinned.
   */
  goal?: string | null;
  onSetGoal?: (goal: string | null) => void;
  /** Extra control rendered in the toolbar, left of the send button. */
  leftExtra?: React.ReactNode;
  /** Content visually attached to the composer above the draft field. */
  attached?: React.ReactNode;
  /**
   * One-shot draft injection (e.g. editing a queued message pulls its text
   * back into the composer). Applied when `seq` changes: appended to a
   * non-empty draft, otherwise it becomes the draft; the caret lands at the
   * end. Works in both controlled and uncontrolled modes.
   */
  prefill?: { seq: number; text: string } | null;
  /** Optional action rendered inside the "+" menu, e.g. "schedule message". */
  sendMenu?: (ctx: {
    text: string;
    disabled: boolean;
    onScheduled: () => void;
  }) => React.ReactNode;
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
  /**
   * Enables "/"-skill autocomplete when the draft starts with "/". Given the
   * text typed after the "/", returns matching skills/commands. When omitted,
   * "/" is inert.
   */
  skillsFetch?: (query: string) => Promise<FileMention[]>;
}

/** Inline set/clear editor for the session goal. */
function GoalPopover({
  initial,
  onSubmit,
  onClose,
}: {
  initial: string;
  onSubmit: (goal: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="composer-menu composer-goal-pop">
      <div className="composer-goal-pop-title">Session goal</div>
      <input
        ref={inputRef}
        className="composer-goal-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(text.trim() || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Pin a goal — rides along with every prompt…"
      />
      <div className="composer-goal-pop-actions">
        {initial && (
          <button
            type="button"
            className="composer-menu-item composer-goal-clear"
            onClick={() => onSubmit(null)}
          >
            Clear goal
          </button>
        )}
        <button
          type="button"
          className="composer-goal-set"
          onClick={() => onSubmit(text.trim() || null)}
          disabled={text.trim() === initial}
        >
          {initial ? "Update" : "Set goal"}
        </button>
      </div>
    </div>
  );
}

/**
 * Shared chat composer (Claude/Codex-style): rounded container with an
 * auto-growing textarea and a bottom toolbar carrying compact model/effort pills,
 * a Goal target, a "+" add menu and the send button. Enter sends, Shift+Enter
 * newlines. With `mentionFetch`, typing "@" opens a file-path autocomplete.
 */
export function Composer({
  value,
  onChange,
  draftKey,
  onSend,
  placeholder,
  disabled,
  sendDisabled,
  sendTitle,
  busy,
  busySendMode = "queue",
  onStop,
  models,
  defaultModel,
  model,
  onModelChange,
  modelDisabled,
  modelTitle,
  effort,
  onEffortChange,
  accounts,
  accountId,
  onAccountChange,
  goal,
  onSetGoal,
  leftExtra,
  attached,
  prefill,
  sendMenu,
  hint,
  autoFocus,
  textareaRef: externalRef,
  images,
  onImagesChange,
  files,
  onFilesChange,
  mentionFetch,
  skillsFetch,
}: Props) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalRef ?? internalRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Uncontrolled mode (no `value` prop): the draft lives here so keystrokes
  // re-render only the Composer, not the whole parent view. With a `draftKey`
  // it seeds from — and mirrors into — the draft store, so navigating away
  // and back doesn't lose typed work.
  const [innerValue, setInnerValue] = useState(() =>
    draftKey ? loadDraft(draftKey).text : "",
  );
  const isPhone = useIsPhone();
  // "Send messages with" preference (Settings → Composer): Enter or ⌘/Ctrl+Enter.
  const [sendKey, setSendKey] = useState(getSendKeyPref);
  useEffect(() => onSendKeyChanged(() => setSendKey(getSendKeyPref())), []);
  const isControlled = value !== undefined;
  const text = isControlled ? value : innerValue;
  const setText = isControlled ? onChange ?? (() => {}) : setInnerValue;
  useEffect(() => {
    if (!isControlled && draftKey) saveDraft(draftKey, { text: innerValue });
  }, [isControlled, draftKey, innerValue]);
  // One-shot prefill (see the prop doc): each new seq folds the given text
  // into the draft and focuses the field for immediate editing.
  const prefillSeqRef = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.seq === prefillSeqRef.current) return;
    prefillSeqRef.current = prefill.seq;
    const next = text.trim()
      ? `${text.replace(/\s+$/, "")}\n${prefill.text}`
      : prefill.text;
    setText(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = next.length;
      }
    });
  }, [prefill]);
  // Fire a send handler with the current draft; in uncontrolled mode a `true`
  // return means "consumed" — clear the draft (falsy keeps it, e.g. offline).
  function fireSend(
    handler: (t: string, opts?: { interrupt?: boolean }) => boolean | void,
    opts?: { interrupt?: boolean },
  ) {
    const consumed = handler(text, opts);
    if (!isControlled && consumed === true) setInnerValue("");
  }
  const isSendDisabled =
    typeof sendDisabled === "function" ? sendDisabled(text) : sendDisabled;
  const imgs = images || [];
  const fls = files || [];
  // Any attachment affordance (paste/drop/pick + thumbnails) is enabled when the
  // parent wired up either channel.
  const canAttach = !!onImagesChange || !!onFilesChange;

  // Phones get a ChatGPT-style resting state: while the field is empty and
  // unfocused, the composer collapses to a single-row pill ("+ · placeholder ·
  // mic · send"), hiding the model/effort/goal chips. Focusing the field or
  // adding any content (text or attachment) expands it to the full toolbar.
  const [focused, setFocused] = useState(false);
  const hasAttached = !!attached;
  const hasContent = !!text.trim() || imgs.length > 0 || fls.length > 0 || hasAttached;
  const minimized = isPhone && !focused && !hasContent;
  const showSend = !busy || hasContent;

  // Which toolbar popover is open ("add" menu or "goal" editor). Closed on an
  // outside click or after an action.
  const [menu, setMenu] = useState<null | "add" | "goal">(null);
  useEffect(() => {
    if (!menu) return;
    // Dismiss on a tap/click outside the popover. iOS doesn't reliably fire
    // `mousedown` on non-interactive elements, so listen for `touchstart` too —
    // otherwise the menu gets stuck open on mobile.
    function onDown(e: Event) {
      if (!(e.target as HTMLElement).closest(".composer-pop-wrap")) setMenu(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [menu]);

  // "@"-mention file autocomplete (shared with the New-session prompt field).
  const mentions = useFileMentions({
    value: text,
    onChange: setText,
    textareaRef,
    mentionFetch,
    skillsFetch,
  });

  async function addFiles(picked: FileList | File[]) {
    if (!canAttach) return;
    const { images: newImgs, files: newFls, rejected } = await splitAttachments(picked);
    // Images ride the vision channel; other files need a dedicated file channel
    // (if the parent only wired images, non-image files are simply ignored).
    if (newImgs.length) onImagesChange?.([...imgs, ...newImgs]);
    if (newFls.length && onFilesChange) onFilesChange([...fls, ...newFls]);
    // Fail loudly rather than dropping oversized/failed uploads silently.
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
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

  // Insert an "@" at the caret and focus the textarea, opening the mention popup.
  function startMention() {
    const el = textareaRef.current;
    const at = el ? el.selectionStart : text.length;
    const next = text.slice(0, at) + "@" + text.slice(at);
    setText(next);
    queueMicrotask(() => {
      const t = textareaRef.current;
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = at + 1;
      }
      mentions.sync();
    });
  }

  // Auto-grow between a resting floor and the CSS max-height. Phones get a
  // one-line floor (ChatGPT-style lightweight bar); desktop keeps the tall
  // inviting field.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Minimized (resting phone pill) hugs a single line so it centers against
    // the +/send circles; otherwise a phone one-line floor, desktop a tall field.
    const floor = minimized ? 0 : isPhone ? 44 : 120;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, floor), 320)}px`;
  }, [text, isPhone, minimized]);

  // Live code styling: when the draft contains a backtick, a metrics-identical
  // mirror div paints `inline` / ```fence``` tints behind a transparent-text
  // textarea (native caret/selection/undo stay). Plain drafts skip the mirror
  // entirely — the stock opaque textarea has zero desync risk.
  const hlRef = useRef<HTMLDivElement>(null);
  const hlActive = needsComposerHighlight(text);
  const hlHtml = useMemo(
    () => (hlActive ? composerHighlightHtml(text) : ""),
    [hlActive, text],
  );
  useEffect(() => {
    // The textarea scrolls internally at max-height; keep the mirror locked to it.
    const el = textareaRef.current;
    const hl = hlRef.current;
    if (el && hl) hl.scrollTop = el.scrollTop;
  }, [hlHtml, textareaRef]);

  // Dictated text lands at the end of the draft (with a joining space) and
  // focus returns to the textarea so you can touch it up and send.
  function insertDictation(t: string) {
    const next = text.trim() ? `${text.replace(/\s+$/, "")} ${t}` : t;
    setText(next);
    queueMicrotask(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = next.length;
      }
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (mentions.handleKeyDown(e)) return;
    if ((e.nativeEvent as any).isComposing) return;
    // Inside an unclosed ``` fence, plain Enter inserts a newline instead of
    // sending — you can't type a multi-line code block otherwise. Closing the
    // fence (or ⌘/Ctrl+Enter, or the send button) sends as usual.
    if (
      sendKey === "enter" &&
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      const caret = textareaRef.current?.selectionStart ?? text.length;
      const fences = text.slice(0, caret).match(/```/g);
      if (fences && fences.length % 2 === 1) return; // let the newline land
    }
    // While a run is busy, ⌘/Ctrl+Enter interrupts: abort the current turn and
    // deliver this send right away. (Only when plain Enter is the send key —
    // otherwise ⌘/Ctrl+Enter already means "send".)
    if (
      busy &&
      sendKey === "enter" &&
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      if (!disabled && !isSendDisabled) fireSend(onSend, { interrupt: true });
      return;
    }
    if (isSendCombo(e, sendKey)) {
      e.preventDefault();
      if (!disabled && !isSendDisabled) fireSend(onSend);
    }
  }

  const effectiveModel = model || defaultModel;

  return (
    <div className="composer-wrap">
      {/* Queued/steered messages fold out from behind the composer box —
          a sibling flap tucked under its top edge, not a box-in-box. */}
      {attached}
      <motion.div
        layout
        // Fuller rounding in the expanded state on phones so the box's corners
        // don't read as square against the iPhone's screen rounding; pill when
        // collapsed. Desktop keeps the tighter 16px. initial={false}: adopt the
        // target radius instantly on mount — otherwise Motion animates from the
        // stylesheet value on load, a visible radius morph.
        initial={false}
        animate={{ borderRadius: minimized ? 999 : isPhone ? 22 : 16 }}
        transition={composerMorph}
        className={`composer ${disabled ? "composer-disabled" : ""} ${minimized ? "composer-min" : ""}`}
        onDrop={handleDrop}
        onDragOver={(e) => canAttach && e.preventDefault()}
      >
        <ImageThumbs images={imgs} onRemove={removeImage} disabled={disabled} />
        <FileChips files={fls} onRemove={removeFile} disabled={disabled} />
        <motion.div
          layout="position"
          transition={composerMorph}
          className="composer-input-wrap"
          ref={mentions.inputWrapRef}
        >
          {mentions.popup}
          {hlActive && (
            <div
              ref={hlRef}
              className="composer-textarea composer-hl"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: hlHtml }}
            />
          )}
          <textarea
            ref={textareaRef}
            className={`composer-textarea ${hlActive ? "has-hl" : ""}`}
            // In the resting pill the full prompt would clip, so show a short
            // "Ask <model>" (ChatGPT-style) that fits the single row; the
            // descriptive placeholder returns once it expands.
            placeholder={
              minimized ? `Ask ${shortModelLabel(effectiveModel, models)}` : placeholder
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // Caret has moved to the new value; re-evaluate after React commits.
              queueMicrotask(mentions.sync);
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onScroll={(e) => {
              if (hlRef.current)
                hlRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Let a click on a suggestion (mousedown) win the race first.
              setTimeout(mentions.close, 120);
            }}
            onPaste={handlePaste}
            disabled={disabled}
            rows={1}
            autoFocus={autoFocus}
          />
        </motion.div>
        <div className="composer-toolbar" ref={toolbarRef}>
          {canAttach && (
            <motion.div layout="position" transition={composerMorph} className="composer-pop-wrap">
              <Tooltip label="Add files or a file reference">
                <button
                  type="button"
                  className="palette-icon-btn composer-add-btn"
                  onClick={() => setMenu(menu === "add" ? null : "add")}
                  disabled={disabled}
                  aria-label="Add"
                  aria-expanded={menu === "add"}
                >
                  <IconPlus size={24} />
                </button>
              </Tooltip>
              {menu === "add" && (
                <div className="composer-menu">
                  <button
                    type="button"
                    className="composer-menu-item"
                    onClick={() => {
                      setMenu(null);
                      fileInputRef.current?.click();
                    }}
                  >
                    <span className="composer-menu-icon">
                      <IconPaperclip size={22} />
                    </span>
                    {onFilesChange ? "Attach files" : "Attach an image"}
                  </button>
                  {mentionFetch && (
                    <button
                      type="button"
                      className="composer-menu-item"
                      onClick={() => {
                        setMenu(null);
                        startMention();
                      }}
                    >
                      <span className="composer-menu-icon">
                        <IconAtSign size={22} />
                      </span>
                      Reference a file
                    </button>
                  )}
                  {sendMenu?.({
                    text,
                    disabled: !!(disabled || isSendDisabled),
                    onScheduled: () => {
                      if (!isControlled) setInnerValue("");
                      setMenu(null);
                    },
                  })}
                </div>
              )}
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
            </motion.div>
          )}

          {/* The goal chip exists only in the expanded state; it fades + scales
              in as the composer grows. AnimatePresence(initial=false) skips the
              enter on first paint so it doesn't animate in on a fresh desktop
              load; the chips carry no `exit` (see composerChipMotion) so they're
              removed instantly on collapse rather than reflowing through the
              reordered pill row. */}
          <AnimatePresence initial={false}>
            {!minimized && onSetGoal && (
              <motion.div
                key="goal"
                layout="position"
                {...composerChipMotion}
                className="composer-pop-wrap"
              >
                <Tooltip label={goal ? `Goal: ${goal}` : "Pin a goal for this session"}>
                  <button
                    type="button"
                    className={`palette-icon-btn composer-goal-btn ${goal ? "is-on" : ""}`}
                    onClick={() => setMenu(menu === "goal" ? null : "goal")}
                    disabled={disabled}
                    aria-pressed={!!goal}
                  >
                    <IconCrosshair size={24} />
                    {goal && <span className="composer-goal-label">Goal</span>}
                  </button>
                </Tooltip>
                {menu === "goal" && (
                  <GoalPopover
                    initial={goal || ""}
                    onClose={() => setMenu(null)}
                    onSubmit={(g) => {
                      onSetGoal(g);
                      setMenu(null);
                    }}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {leftExtra}
          <div className="composer-spacer" />

          {/* Model + effort live together on the right edge (ChatGPT-style):
              one pill, effort levels up top, the model behind a submenu. */}
          <AnimatePresence initial={false}>
            {!minimized && (
              <motion.div
                key="model-effort"
                layout="position"
                {...composerChipMotion}
                className="palette-select-motion"
              >
                <ModelEffortSelect
                  className="palette-pill"
                  title={modelTitle || "Model and reasoning effort for this session"}
                  models={models}
                  defaultModel={defaultModel}
                  model={model}
                  onModelChange={onModelChange}
                  modelDisabled={modelDisabled}
                  modelTitle={modelTitle}
                  effort={effort}
                  onEffortChange={onEffortChange}
                  accounts={accounts}
                  accountId={accountId}
                  onAccountChange={onAccountChange}
                  disabled={disabled}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div layout="position" transition={composerMorph} className="composer-voice-wrap">
            <VoiceInput onText={insertDictation} disabled={disabled} />
          </motion.div>

          {busy && onStop && (
            <Tooltip label="Stop — interrupts the current turn; the session stays ready">
              <button
                type="button"
                className="composer-send composer-stop"
                onClick={onStop}
                disabled={disabled}
                aria-label="Stop current turn"
              >
                <IconStopSquare size={24} />
              </button>
            </Tooltip>
          )}
          {/* Keep the right edge clean: stop (while busy) and send only. Niche
              actions such as scheduling live under the + menu. */}
          {showSend && (
            <motion.div
              layout="position"
              transition={composerMorph}
              className={`composer-send-split ${busy && busySendMode === "steer" ? "is-interrupt" : ""}`}
            >
              <Tooltip
                label={
                  sendTitle ||
                  (busy
                    ? busySendMode === "steer"
                      ? `Steer into the current run (${sendKeyLabel(sendKey)})${
                          sendKey === "enter" ? ` — ${MOD_ENTER_GLYPH} interrupts` : ""
                        }`
                      : `Queue for the next turn (${sendKeyLabel(sendKey)})${
                          sendKey === "enter" ? ` — ${MOD_ENTER_GLYPH} interrupts` : ""
                        }`
                    : `Send (${sendKeyLabel(sendKey)})`)
                }
              >
                <button
                  className={`composer-send ${busy && busySendMode === "steer" ? "composer-send-interrupt" : busy ? "composer-send-queue-main" : ""}`}
                  onClick={() => fireSend(onSend)}
                  disabled={disabled || isSendDisabled}
                >
                  {busy ? (
                    busySendMode === "steer" ? (
                      <IconCrosshair size={24} />
                    ) : (
                      <IconArrowDownRight size={24} />
                    )
                  ) : (
                    <IconArrowUp size={24} />
                  )}
                </button>
              </Tooltip>
            </motion.div>
          )}
        </div>
      </motion.div>
      {hint && <div className="composer-hint">{hint}</div>}
    </div>
  );
}
