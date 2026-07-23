import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, FileMention, ProviderAccountOption } from "../lib/api";
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
  IconBolt,
  IconPlus,
  IconPaperclip,
  IconAtSign,
  IconCrosshair,
  IconStopSquare,
} from "./icons";
import { Tooltip } from "../ui/tooltip";
import { Modal } from "../ui/modal";
import {
  getSendKeyPref,
  onSendKeyChanged,
  isSendCombo,
  sendKeyLabel,
} from "../lib/send-key";
import { VoiceInput } from "./VoiceInput";
import { getVimModePref, onVimModeChanged } from "../lib/vim-pref";
import { useVimMode } from "../hooks/useVimMode";
import { useIsPhone } from "../hooks/useIsPhone";
import { motion, AnimatePresence } from "motion/react";
import { composerMorph, composerChipMotion } from "../ui/motion";
import { ModelEffortSelect, shortModelLabel } from "./ModelEffortSelect";
import { UsageMeter } from "./UsageMeter";
import type { SessionUsage } from "../lib/types";

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
  /** `steer` is set when the send should fold into the running turn right
   * away (⌘/Ctrl+Enter or Command/Ctrl-click while a run is busy) — the turn
   * keeps running. Plain busy sends queue for after the run fully finishes. */
  onSend: (text: string, opts?: { steer?: boolean }) => boolean | void;
  placeholder?: string;
  disabled?: boolean;
  /** Boolean, or a predicate on the current draft (for uncontrolled mode,
   * where the parent can't read the text). */
  sendDisabled?: boolean | ((text: string) => boolean);
  /** Shows on the send button tooltip when busy-queueing. */
  sendTitle?: string;
  busy?: boolean;
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
  /** Pinnable provider accounts + current pin for the model pill's account
   * submenu. Empty/omitted hides it. */
  accounts?: ProviderAccountOption[];
  accountId?: string;
  onAccountChange?: (accountId: string) => void;
  /**
   * Session goal (pinned via /goal, rides along with every prompt). When
   * `onSetGoal` is wired, a target button lets you set/clear it inline; it lights
   * up and grows a "Goal" label while a goal is pinned.
   */
  goal?: string | null;
  onSetGoal?: (goal: string | null) => void;
  /**
   * Live per-conversation usage (cost + context fill). When present, a compact
   * cost/ring meter rides the toolbar just right of the model pill on desktop;
   * on phones it's surfaced in the top-bar chat bar instead (won't fit here).
   */
  usage?: SessionUsage;
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

/** Set / update / clear the session goal — a centered dialog on the shared
 *  Modal primitive (Base UI, squircle shell, focus-trapped, exit-animated). */
function GoalModal({
  open,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (goal: string | null) => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Reseed the field to the current goal (and select it) each time we open.
  useEffect(() => {
    if (open) {
      setText(initial);
      queueMicrotask(() => inputRef.current?.select());
    }
  }, [open, initial]);

  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content initialFocus={inputRef}>
        <Modal.Header
          title="Session goal"
          description="Pinned to the session. It rides along with every prompt you send."
        />

        <textarea
          ref={inputRef}
          className="min-h-[120px] w-full resize-y rounded-md border border-line-strong bg-surface px-4 py-3.5 text-[15px] leading-relaxed text-fg outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Plain / ⌘/Ctrl+Enter submits; Shift+Enter newlines.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(text.trim() || null);
            }
          }}
          placeholder="e.g. Ship the onboarding redesign. Keep every reply focused on that."
        />

        <Modal.Footer>
          {initial && (
            <button
              type="button"
              className="rounded-md px-3 py-2 text-[13.5px] font-medium text-red hover:bg-red-soft"
              onClick={() => onSubmit(null)}
            >
              Clear goal
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            className="rounded-md bg-accent px-5 py-2 text-[13.5px] font-semibold text-white outline-none hover:brightness-105 disabled:cursor-default disabled:opacity-40"
            onClick={() => onSubmit(text.trim() || null)}
            disabled={text.trim() === initial.trim()}
          >
            {initial ? "Update goal" : "Set goal"}
          </button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
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
  usage,
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
  const [sendModifierHeld, setSendModifierHeld] = useState(false);
  useEffect(() => {
    const syncModifier = (e: KeyboardEvent) =>
      setSendModifierHeld(e.metaKey || e.ctrlKey);
    const clearModifier = () => setSendModifierHeld(false);
    window.addEventListener("keydown", syncModifier);
    window.addEventListener("keyup", syncModifier);
    window.addEventListener("blur", clearModifier);
    return () => {
      window.removeEventListener("keydown", syncModifier);
      window.removeEventListener("keyup", syncModifier);
      window.removeEventListener("blur", clearModifier);
    };
  }, []);
  // Vim mode preference (Settings → Composer, default off).
  const [vimEnabled, setVimEnabled] = useState(getVimModePref);
  useEffect(() => onVimModeChanged(() => setVimEnabled(getVimModePref())), []);
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
    handler: (t: string, opts?: { steer?: boolean }) => boolean | void,
    opts?: { steer?: boolean },
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
  // The open model menu also holds it expanded: the portaled popup takes focus
  // (blurring the textarea), and collapsing would unmount the pill trigger and
  // slam the menu shut mid-interaction.
  const [focused, setFocused] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const hasAttached = !!attached;
  const hasContent = !!text.trim() || imgs.length > 0 || fls.length > 0 || hasAttached;
  const minimized = isPhone && !focused && !hasContent && !modelMenuOpen;
  const showSend = !busy || hasContent;
  const steerSend = !!busy && sendModifierHeld;

  // Which toolbar popover is open ("add" menu or "goal" editor). Closed on an
  // outside click or after an action.
  const [menu, setMenu] = useState<null | "add" | "goal">(null);
  useEffect(() => {
    // The goal editor is a portaled Base UI dialog — it dismisses itself
    // (backdrop / Escape) and lives outside .composer-pop-wrap, so this
    // handler would wrongly close it on any click inside it. Only the anchored
    // "add" menu needs outside-click dismissal here.
    if (menu !== "add") return;
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

  // iOS focus-preserving taps: a tap's default continuation (touchend →
  // synthesized mousedown → textarea blur → keyboard dismiss → click) makes
  // toolbar taps close the keyboard and, on an empty draft, collapse the
  // composer mid-tap. Cancelling pointerdown does NOT stop that on iOS — the
  // only reliable point is touchend itself. tapProps(action) fires the action
  // on touchend and cancels the mouse synthesis; onClick stays for mouse/pen,
  // guarded by the shared timestamp against browsers that still send both.
  const touchFiredAt = useRef(0);
  function tapProps(action: () => void) {
    return {
      onTouchEnd: (e: React.TouchEvent) => {
        e.preventDefault();
        touchFiredAt.current = Date.now();
        action();
      },
      onClick: () => {
        if (Date.now() - touchFiredAt.current < 700) return;
        action();
      },
    };
  }

  // Modal editing on the draft (Settings → Composer → Vim mode). The engine
  // consumes keys in normal/visual modes; insert mode only claims Escape.
  const vim = useVimMode({
    enabled: vimEnabled,
    textareaRef,
    value: text,
    onChange: setText,
  });

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

  // Once the draft grows past the composer's max-height the textarea scrolls
  // internally; without help the clipped text ends in a hard horizontal cut at
  // the container edge. We fade the edge instead: a scroll-aware mask on the
  // input region that softens the top once you've scrolled down, and the bottom
  // while there's still text below. Only the active edges dim, so a resting
  // first line never fades. Phone-only — the tall desktop field rarely clips.
  //
  // Driven imperatively (write the mask straight onto the wrapper) rather than
  // through React state: a state-round-trip lags the scroll by a render, so the
  // mask is a frame stale during momentum scroll and reads as a flicker (or, if
  // a scroll event coalesces, never updates at all). The mask must track
  // scrollTop exactly, so we set it in the same handler that observes the scroll.
  const FADE_PX = 26;
  function updateFade(el: HTMLTextAreaElement) {
    const wrap = el.parentElement; // .composer-input-wrap (masks textarea + hl mirror as one)
    if (!wrap) return;
    const top = isPhone && el.scrollTop > 1;
    const bottom =
      isPhone && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    const mask =
      top || bottom
        ? `linear-gradient(to bottom, ${
            top ? "transparent 0, #000 " + FADE_PX + "px" : "#000 0"
          }, ${
            bottom
              ? "#000 calc(100% - " + FADE_PX + "px), transparent 100%"
              : "#000 100%"
          })`
        : "";
    wrap.style.setProperty("-webkit-mask-image", mask);
    wrap.style.setProperty("mask-image", mask);
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
    // Height (and thus clip state) just changed — re-evaluate the edge fades.
    updateFade(el);
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
    // Vim mode gets the key before the send/stop logic: in insert mode it only
    // claims Escape (drop to normal mode — a second, bare Escape in normal mode
    // falls through here to the busy-stop below), and Enter is never consumed,
    // so the send combos keep working in any mode.
    if (vim.handleKeyDown(e)) return;
    // Esc while a run is busy = the stop button: interrupt the current turn.
    if (e.key === "Escape" && busy && onStop && !disabled) {
      e.preventDefault();
      onStop();
      return;
    }
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
    // While a run is busy, ⌘/Ctrl+Enter steers: fold this send into the
    // running turn now, WITHOUT stopping it. Plain Enter queues for after the
    // run fully finishes. (Only when plain Enter is the send key — otherwise
    // ⌘/Ctrl+Enter already means "send".)
    if (
      busy &&
      sendKey === "enter" &&
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      if (!disabled && !isSendDisabled) fireSend(onSend, { steer: true });
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
        // collapsed. Desktop rounds to 24px. initial={false}: adopt the
        // target radius instantly on mount — otherwise Motion animates from the
        // stylesheet value on load, a visible radius morph.
        initial={false}
        animate={{ borderRadius: minimized ? 999 : isPhone ? 28 : 24 }}
        transition={composerMorph}
        className={`composer ${disabled ? "composer-disabled" : ""} ${minimized ? "composer-min" : ""}`}
        onDrop={handleDrop}
        onDragOver={(e) => canAttach && e.preventDefault()}
      >
        {/* Vim mode indicator — only surfaces outside insert mode, so plain
            typing looks identical with the pref on. Sits above the input wrap's
            scroll-fade mask. */}
        {vimEnabled && vim.mode !== "insert" && (
          <div className="pointer-events-none absolute right-3 top-2 z-[2] select-none rounded-sm border border-line bg-surface px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-dim">
            {vim.mode === "normal"
              ? "NORMAL"
              : vim.mode === "visual"
                ? "VISUAL"
                : "V-LINE"}
          </div>
        )}
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
              updateFade(e.currentTarget);
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
        <div
          className="composer-toolbar"
          ref={toolbarRef}
          // Phones: a toolbar tap must not blur the textarea — the blur would
          // collapse the empty composer mid-tap (unmounting the model pill and
          // reflowing + / mic / send under the finger) and dismiss the
          // keyboard. Cancelling pointerdown covers pointer-event browsers,
          // but NOT iOS Safari — there the blur rides the touchend→mousedown
          // synthesis, which only touchend's own preventDefault stops. That's
          // what tapProps() on the individual buttons is for; this handler is
          // the non-iOS half.
          onPointerDown={(e) => {
            if (isPhone) e.preventDefault();
          }}
        >
          {canAttach && (
            <motion.div layout="position" transition={composerMorph} className="composer-pop-wrap">
              <Tooltip label="Add files or a file reference">
                <button
                  type="button"
                  className="palette-icon-btn composer-add-btn"
                  {...tapProps(() => setMenu(menu === "add" ? null : "add"))}
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
                    {...tapProps(() => {
                      setMenu(null);
                      fileInputRef.current?.click();
                    })}
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
                      {...tapProps(() => {
                        setMenu(null);
                        startMention();
                      })}
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
                    {...tapProps(() => setMenu(menu === "goal" ? null : "goal"))}
                    disabled={disabled}
                    aria-pressed={!!goal}
                  >
                    <IconCrosshair size={24} />
                    {goal && <span className="composer-goal-label">Goal</span>}
                  </button>
                </Tooltip>
                <GoalModal
                  open={menu === "goal"}
                  initial={goal || ""}
                  onOpenChange={(o) => setMenu(o ? "goal" : null)}
                  onSubmit={(g) => {
                    onSetGoal(g);
                    setMenu(null);
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {leftExtra}
          <div className="composer-spacer" />

          {/* Model + effort live together on the right edge (ChatGPT-style):
              one pill, effort levels up top, the model behind a submenu.
              Phones reorder it next to the + button via flex order (see the
              "Lightweight phone inputs" block in global.css). */}
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
                  onOpenChange={setModelMenuOpen}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Live cost + context ring, right of the model pill. Phones surface it
              in the top-bar chat bar instead (the toolbar is too cramped). */}
          <AnimatePresence initial={false}>
            {!minimized && !isPhone && usage && (
              <motion.div
                key="usage"
                layout="position"
                {...composerChipMotion}
                className="composer-pop-wrap"
              >
                <UsageMeter usage={usage} />
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
                {...tapProps(() => onStop())}
                disabled={disabled}
                aria-label="Stop current turn"
              >
                <IconStopSquare size={24} />
              </button>
            </Tooltip>
          )}
          {/* One busy-send button: queue by default, steer while Command/Ctrl is
              held. Niche actions such as scheduling live under the + menu. */}
          {showSend && (
            <motion.div
              layout="position"
              transition={composerMorph}
              className="composer-send-split"
            >
              <Tooltip
                label={
                  steerSend
                    ? "Steer — fold into the running turn now, without stopping it"
                    : sendTitle ||
                      (busy
                        ? `Queue — delivered when the agent fully finishes; hold ⌘/Ctrl to steer (${sendKeyLabel(sendKey)})`
                        : `Send (${sendKeyLabel(sendKey)})`)
                }
              >
                <button
                  className={`composer-send ${
                    steerSend
                      ? "composer-send-interrupt"
                      : busy
                        ? "composer-send-queue-main"
                        : ""
                  }`}
                  {...tapProps(() =>
                    fireSend(onSend, steerSend ? { steer: true } : undefined),
                  )}
                  disabled={disabled || isSendDisabled}
                  aria-label={
                    steerSend
                      ? "Steer into the running turn"
                      : busy
                        ? "Queue until the current turn finishes"
                        : "Send message"
                  }
                >
                  {steerSend ? (
                    <IconBolt size={24} />
                  ) : busy ? (
                    <IconArrowDownRight size={24} />
                  ) : (
                    <IconArrowUp size={24} />
                  )}
                </button>
              </Tooltip>
            </motion.div>
          )}
        </div>
        {/* Phone vim key bar — the on-screen keyboard has no Esc/Tab/arrow
            keys (and the native accessory bar is WebKit chrome we can't
            touch), so give vim users a Termius-style key row pinned above the
            keyboard. Software keys route through vim.injectKey: consumed by
            the engine in normal/visual mode, emulated on the textarea in
            insert mode.

            iOS tap handling is the load-bearing part: a tap's default
            continuation is touchend → synthesized mousedown (blurs the
            textarea, dismissing the keyboard) → click — and the blur flips
            `focused`, which would unmount this bar BEFORE the click fires
            (preventing pointerdown does NOT stop any of that on iOS; it lost
            us the whole bar on-device). So each key acts on touchend and
            cancels it, suppressing the entire mouse-synthesis chain; onClick
            stays for mouse/pen, with a recent-touch guard for browsers that
            fire both. The bar also stays mounted outside insert mode even if
            focus is lost, so it can never vanish mid-interaction. */}
        {vimEnabled && isPhone && !minimized && (focused || vim.mode !== "insert") && (
          <div
            className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5"
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
          >
            {(
              [
                ["esc", "Escape"],
                ["tab", "Tab"],
                ["←", "ArrowLeft"],
                ["↓", "ArrowDown"],
                ["↑", "ArrowUp"],
                ["→", "ArrowRight"],
              ] as const
            ).map(([label, key]) => (
              <button
                key={key}
                type="button"
                className={`h-8 flex-1 select-none rounded-md border border-line bg-surface text-[12px] font-semibold text-dim active:bg-panel ${
                  key === "Escape" && vim.mode !== "insert"
                    ? "border-accent text-fg"
                    : ""
                }`}
                {...tapProps(() => vim.injectKey(key))}
                aria-label={key}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </motion.div>
      {hint && <div className="composer-hint">{hint}</div>}
    </div>
  );
}
