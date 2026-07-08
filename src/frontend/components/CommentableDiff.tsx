import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { SelectedLineRange, FileDiffMetadata, DiffLineAnnotation } from "@pierre/diffs";
import { IconChevronRight, IconUndo } from "./icons";
import { Tooltip } from "../ui/tooltip";

export interface CommentTarget {
  path: string;
  startLine: number;
  endLine: number;
  side: "additions" | "deletions";
}

export interface PendingComment extends CommentTarget {
  id: string;
  text: string;
}

interface Props {
  patch: string;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  onSubmit: (target: CommentTarget, text: string) => Promise<void>;
  /**
   * Review-batching mode: when provided, already-added comments render inline as
   * pending cards (the parent owns the list and submits them as one review).
   * Without it the component stays single-shot (e.g. session feedback).
   */
  pendingComments?: PendingComment[];
  onRemovePending?: (id: string) => void;
  /**
   * When provided, each file row gets a hover-revealed "Discard" action that
   * resets the file to its base state (removing it from the diff). Only wired
   * where the diff maps to a live, editable worktree (the session Changes tab),
   * never in read-only PR previews. `oldPath` is set for renames.
   */
  onDiscard?: (path: string, oldPath?: string) => Promise<void>;
}

interface Draft {
  fileIndex: number;
  path: string;
  range: SelectedLineRange;
}

type Meta = { kind: "draft" } | { kind: "pending"; comment: PendingComment };

const BASE_OPTIONS = {
  theme: "pierre-dark",
  themeType: "dark" as const,
  diffStyle: "unified" as const,
  // Our own collapsible row owns the file header (name + stats + caret), so
  // suppress @pierre/diffs' built-in one to avoid a double header.
  disableFileHeader: true,
  overflow: "scroll" as const,
  enableLineSelection: true,
};

/** Per-file +/- counts, summed from the parsed hunks. */
function fileStats(file: FileDiffMetadata): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of file.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

// Stable empty-annotations reference so files with no comments keep prop identity
// across re-renders (lets the memoized row bail out instead of re-parsing).
const NO_ANNOTATIONS: DiffLineAnnotation<Meta>[] = [];

/**
 * Renders a multi-file patch with @pierre/diffs, one FileDiff per file so
 * line selections carry their file context. Selecting lines opens an inline
 * comment form (the diffs annotation framework); submit is delegated to the
 * parent (session feedback or GitHub PR comment).
 *
 * Perf: the comment-draft text lives in the inline `CommentForm` (local state),
 * NOT here — so typing re-renders only the open form, not every FileDiff. Each
 * row is memoized with stable props (annotations, onSelect, renderAnnotation),
 * so a selection change re-renders at most the two files it touches.
 */
export function CommentableDiff({
  patch,
  submitLabel,
  placeholder,
  disabled,
  disabledHint,
  onSubmit,
  pendingComments,
  onRemovePending,
  onDiscard,
}: Props) {
  const reviewMode = pendingComments !== undefined;
  const files = useMemo<FileDiffMetadata[]>(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patch]);

  // Files render collapsed by default (just the header row) — mounting a
  // FileDiff parses + highlights on the main thread, so a large change would
  // otherwise block the tab. `expanded` holds the indices the user opened.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);
  const allOpen = expanded.size >= files.length && files.length > 0;
  const toggleAll = useCallback(() => {
    setExpanded((prev) => (prev.size >= files.length ? new Set() : new Set(files.map((_, i) => i))));
  }, [files]);

  const stats = useMemo(() => files.map(fileStats), [files]);

  // Discard is destructive + irreversible, so it's a two-click arm/confirm:
  // the first click arms a row (button flips to "Discard changes?"), the second
  // within 4s performs it. `discarding` disables the row while the request runs.
  const [armed, setArmed] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarm = useCallback(() => {
    clearTimeout(disarmTimer.current);
    setArmed(null);
  }, []);
  const handleDiscard = useCallback(
    async (file: FileDiffMetadata) => {
      if (!onDiscard) return;
      const key = file.name;
      if (armed !== key) {
        setArmed(key);
        clearTimeout(disarmTimer.current);
        disarmTimer.current = setTimeout(() => setArmed(null), 4000);
        return;
      }
      clearTimeout(disarmTimer.current);
      setArmed(null);
      setDiscarding(key);
      try {
        await onDiscard(file.name, file.prevName);
      } finally {
        setDiscarding(null);
      }
    },
    [onDiscard, armed],
  );
  useEffect(() => () => clearTimeout(disarmTimer.current), []);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  // Draft text is held in a ref so it survives the form remounting when the
  // selection range is adjusted, without re-rendering the diff on each keystroke.
  const draftTextRef = useRef("");

  const handleSelect = useCallback((fileIndex: number, path: string, range: SelectedLineRange | null) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    setConfirmation(null);
    setDraft({ fileIndex, path, range });
  }, []);

  const closeDraft = useCallback(() => {
    draftTextRef.current = "";
    setDraft(null);
  }, []);

  const submitDraft = useCallback(
    async (body: string) => {
      const d = draftRef.current;
      if (!d) return;
      const side: "additions" | "deletions" = d.range.side === "deletions" ? "deletions" : "additions";
      await onSubmit(
        {
          path: d.path,
          startLine: Math.min(d.range.start, d.range.end),
          endLine: Math.max(d.range.start, d.range.end),
          side,
        },
        body,
      );
      draftTextRef.current = "";
      setDraft(null);
      // In review mode the pending card is the confirmation; skip the toast.
      if (!reviewMode) {
        setConfirmation(`${submitLabel} ✓`);
        setTimeout(() => setConfirmation(null), 4000);
      }
    },
    [onSubmit, reviewMode, submitLabel],
  );

  const renderPending = useCallback(
    (comment: PendingComment): React.ReactNode => {
      const lineLabel =
        comment.startLine === comment.endLine
          ? `line ${comment.startLine}`
          : `lines ${comment.startLine}–${comment.endLine}`;
      return (
        <div className="diff-pending-comment" onClick={(e) => e.stopPropagation()}>
          <div className="diff-pending-head">
            <span className="diff-comment-target">
              {comment.path} · {lineLabel}
              {comment.side === "deletions" ? " (removed)" : ""}
            </span>
            {onRemovePending && (
              <button
                className="diff-pending-remove"
                onClick={() => onRemovePending(comment.id)}
                title="Remove this pending comment"
              >
                Remove
              </button>
            )}
          </div>
          <div className="diff-pending-text">{comment.text}</div>
        </div>
      );
    },
    [onRemovePending],
  );

  // Stable across draft/text changes (reads the current draft from the ref), so
  // memoized rows keep their prop identity while the user selects and types.
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<Meta>): React.ReactNode => {
      if (annotation.metadata?.kind === "pending") {
        return renderPending(annotation.metadata.comment);
      }
      const d = draftRef.current;
      if (!d) return null;
      const lineLabel =
        d.range.start === d.range.end
          ? `line ${d.range.start}`
          : `lines ${Math.min(d.range.start, d.range.end)}–${Math.max(d.range.start, d.range.end)}`;
      const targetLabel = `${d.path} · ${lineLabel}${d.range.side === "deletions" ? " (removed)" : ""}`;
      return (
        <CommentForm
          targetLabel={targetLabel}
          disabled={disabled}
          disabledHint={disabledHint}
          placeholder={placeholder}
          submitLabel={submitLabel}
          textRef={draftTextRef}
          onCancel={closeDraft}
          onSubmit={submitDraft}
        />
      );
    },
    [renderPending, disabled, disabledHint, placeholder, submitLabel, closeDraft, submitDraft],
  );

  // Group pending comments by file once per change, so unaffected files reuse a
  // stable annotations array reference (and their memoized row bails out).
  const pendingByFile = useMemo(() => {
    const m = new Map<string, DiffLineAnnotation<Meta>[]>();
    for (const c of pendingComments || []) {
      const arr = m.get(c.path) || [];
      arr.push({
        side: c.side === "deletions" ? "deletions" : "additions",
        lineNumber: c.endLine,
        metadata: { kind: "pending", comment: c },
      });
      m.set(c.path, arr);
    }
    return m;
  }, [pendingComments]);

  if (files.length === 0) {
    return <div className="panel-placeholder">Nothing to display</div>;
  }

  return (
    <div className="commentable-diff">
      {confirmation && <div className="diff-comment-confirmation">{confirmation}</div>}
      <div className="diff-file-toolbar">
        <button type="button" className="diff-file-toggle-all" onClick={toggleAll}>
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>
      {files.map((file, i) => {
        const pend = pendingByFile.get(file.name) || NO_ANNOTATIONS;
        const isDraftFile = draft?.fileIndex === i;
        // Keep a file open while it holds a draft (the comment form lives inside
        // the diff) or already-added pending comments (so they stay visible).
        const isOpen = expanded.has(i) || isDraftFile || pend.length > 0;
        const s = stats[i];
        const slash = file.name.lastIndexOf("/");
        const dir = slash >= 0 ? file.name.slice(0, slash + 1) : "";
        const base = slash >= 0 ? file.name.slice(slash + 1) : file.name;
        const annotations = isDraftFile
          ? [
              ...pend,
              {
                side: (draft!.range.side === "deletions" ? "deletions" : "additions") as "additions" | "deletions",
                lineNumber: Math.max(draft!.range.start, draft!.range.end),
                metadata: { kind: "draft" as const },
              },
            ]
          : pend;

        return (
          <div className="diff-file" key={`${file.name}-${i}`}>
            <div
              className="diff-file-header"
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={() => {
                disarm();
                toggle(i);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  disarm();
                  toggle(i);
                }
              }}
            >
              <IconChevronRight
                size={16}
                className={`diff-file-caret ${isOpen ? "diff-file-caret-open" : ""}`}
              />
              <span className="diff-file-name">
                {dir && <span className="diff-file-dir">{dir}</span>}
                <span className="diff-file-base">{base}</span>
              </span>
              {pend.length > 0 && <span className="diff-file-comments">{pend.length}</span>}
              {onDiscard && (
                <Tooltip
                  label={
                    discarding === file.name
                      ? "Discarding…"
                      : armed === file.name
                        ? "Click again to discard"
                        : "Discard changes"
                  }
                >
                  <button
                    type="button"
                    className={`diff-file-discard ${armed === file.name ? "diff-file-discard-armed" : ""}`}
                    disabled={discarding === file.name}
                    aria-label="Discard this file's changes (reset to base)"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDiscard(file);
                    }}
                  >
                    <IconUndo size={20} />
                  </button>
                </Tooltip>
              )}
              <span className="diff-file-stats">
                {s.add > 0 && <span className="diff-add">+{s.add}</span>}
                {s.del > 0 && <span className="diff-del">−{s.del}</span>}
              </span>
            </div>
            {isOpen && (
              <FileDiffRow
                file={file}
                fileIndex={i}
                annotations={annotations}
                selectedLines={isDraftFile ? draft!.range : null}
                onSelect={handleSelect}
                renderAnnotation={renderAnnotation}
              />
            )}
          </div>
        );
      })}
      <div className="diff-comment-hint">
        {reviewMode
          ? "Click a line number (drag for a range) to add a comment. They stay pending until you finish the review."
          : "Click a line number (drag for a range) to comment."}
      </div>
    </div>
  );
}

/**
 * Inline comment form with its OWN text/sending/error state, so keystrokes
 * re-render just this form — not the parent diff. Seeds from `textRef` (which
 * the parent keeps) so text survives the form remounting on range changes.
 */
const CommentForm = React.memo(function CommentForm({
  targetLabel,
  disabled,
  disabledHint,
  placeholder,
  submitLabel,
  textRef,
  onCancel,
  onSubmit,
}: {
  targetLabel: string;
  disabled?: boolean;
  disabledHint?: string;
  placeholder: string;
  submitLabel: string;
  textRef: React.MutableRefObject<string>;
  onCancel: () => void;
  onSubmit: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState(textRef.current);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(body);
      // Success unmounts this form (parent clears the draft) — don't touch state.
    } catch (e: any) {
      setError(e.message || "Failed to submit");
      setSending(false);
    }
  }

  return (
    <div className="diff-comment-form" onClick={(e) => e.stopPropagation()}>
      <div className="diff-comment-target">{targetLabel}</div>
      {disabled ? (
        <div className="diff-comment-disabled">{disabledHint || "Unavailable right now"}</div>
      ) : (
        <>
          <textarea
            className="diff-comment-input"
            autoFocus
            rows={3}
            placeholder={placeholder}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              textRef.current = e.target.value;
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          {error && <div className="diff-comment-error">{error}</div>}
          <div className="diff-comment-actions">
            <button className="btn-delete-cancel" onClick={onCancel} disabled={sending}>
              Cancel
            </button>
            <button className="btn-send" onClick={submit} disabled={sending || !text.trim()}>
              {sending ? "Sending…" : submitLabel}
            </button>
          </div>
        </>
      )}
    </div>
  );
});

/**
 * One file's diff. Memoized so an unrelated re-render (another file's selection,
 * typing in the comment form) doesn't re-parse/re-render this file.
 */
const FileDiffRow = React.memo(function FileDiffRow({
  file,
  fileIndex,
  annotations,
  selectedLines,
  onSelect,
  renderAnnotation,
}: {
  file: FileDiffMetadata;
  fileIndex: number;
  annotations: DiffLineAnnotation<Meta>[];
  selectedLines: SelectedLineRange | null;
  onSelect: (fileIndex: number, path: string, range: SelectedLineRange | null) => void;
  renderAnnotation: (annotation: DiffLineAnnotation<Meta>) => React.ReactNode;
}) {
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      onLineSelected: (range: SelectedLineRange | null) => onSelect(fileIndex, file.name, range),
    }),
    [fileIndex, file.name, onSelect],
  );

  return (
    <FileDiff<Meta>
      fileDiff={file}
      options={options}
      lineAnnotations={annotations}
      selectedLines={selectedLines}
      renderAnnotation={renderAnnotation}
      disableWorkerPool
    />
  );
});
