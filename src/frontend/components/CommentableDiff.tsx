import React, { useMemo, useState, useRef, useCallback } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { SelectedLineRange, FileDiffMetadata, DiffLineAnnotation } from "@pierre/diffs";

export interface CommentTarget {
  path: string;
  startLine: number;
  endLine: number;
  side: "additions" | "deletions";
}

interface Props {
  patch: string;
  submitLabel: string;
  placeholder: string;
  disabled?: boolean;
  disabledHint?: string;
  onSubmit: (target: CommentTarget, text: string) => Promise<void>;
}

interface Draft {
  fileIndex: number;
  path: string;
  range: SelectedLineRange;
}

type Meta = { kind: "draft" };

const BASE_OPTIONS = {
  theme: "pierre-dark",
  themeType: "dark" as const,
  diffStyle: "unified" as const,
  stickyHeader: true,
  overflow: "scroll" as const,
  enableLineSelection: true,
};

/**
 * Renders a multi-file patch with @pierre/diffs, one FileDiff per file so
 * line selections carry their file context. Selecting lines opens an inline
 * comment form (the diffs annotation framework); submit is delegated to the
 * parent (session feedback or GitHub PR comment).
 */
export function CommentableDiff({
  patch,
  submitLabel,
  placeholder,
  disabled,
  disabledHint,
  onSubmit,
}: Props) {
  const files = useMemo<FileDiffMetadata[]>(() => {
    try {
      return parsePatchFiles(patch).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [patch]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const handleSelect = useCallback((fileIndex: number, path: string, range: SelectedLineRange | null) => {
    if (!range) return; // keep the draft on stray deselects; Cancel closes it
    const prev = draftRef.current;
    if (prev && (prev.fileIndex !== fileIndex || prev.range.start !== range.start || prev.range.end !== range.end)) {
      setText((t) => t); // keep typed text when adjusting the same comment
    }
    setConfirmation(null);
    setError(null);
    setDraft({ fileIndex, path, range });
  }, []);

  async function handleSubmit() {
    const d = draftRef.current;
    const body = text.trim();
    if (!d || !body || sending) return;

    const side: "additions" | "deletions" = d.range.side === "deletions" ? "deletions" : "additions";
    setSending(true);
    setError(null);
    try {
      await onSubmit(
        {
          path: d.path,
          startLine: Math.min(d.range.start, d.range.end),
          endLine: Math.max(d.range.start, d.range.end),
          side,
        },
        body
      );
      setDraft(null);
      setText("");
      setConfirmation(`${submitLabel} ✓`);
      setTimeout(() => setConfirmation(null), 4000);
    } catch (e: any) {
      setError(e.message || "Failed to submit");
    } finally {
      setSending(false);
    }
  }

  function renderAnnotation(): React.ReactNode {
    const d = draftRef.current;
    if (!d) return null;
    const lineLabel =
      d.range.start === d.range.end
        ? `line ${d.range.start}`
        : `lines ${Math.min(d.range.start, d.range.end)}–${Math.max(d.range.start, d.range.end)}`;

    return (
      <div className="diff-comment-form" onClick={(e) => e.stopPropagation()}>
        <div className="diff-comment-target">
          {d.path} · {lineLabel}
          {d.range.side === "deletions" ? " (removed)" : ""}
        </div>
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
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            {error && <div className="diff-comment-error">{error}</div>}
            <div className="diff-comment-actions">
              <button
                className="btn-delete-cancel"
                onClick={() => {
                  setDraft(null);
                  setText("");
                  setError(null);
                }}
                disabled={sending}
              >
                Cancel
              </button>
              <button className="btn-send" onClick={handleSubmit} disabled={sending || !text.trim()}>
                {sending ? "Sending…" : submitLabel}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (files.length === 0) {
    return <div className="panel-placeholder">Nothing to display</div>;
  }

  return (
    <div className="commentable-diff">
      {confirmation && <div className="diff-comment-confirmation">{confirmation}</div>}
      {files.map((file, i) => {
        const annotations: DiffLineAnnotation<Meta>[] =
          draft && draft.fileIndex === i
            ? [
                {
                  side: draft.range.side === "deletions" ? "deletions" : "additions",
                  lineNumber: Math.max(draft.range.start, draft.range.end),
                  metadata: { kind: "draft" },
                },
              ]
            : [];

        return (
          <FileDiffWithSelection
            key={`${file.name}-${i}`}
            file={file}
            fileIndex={i}
            annotations={annotations}
            selectedLines={draft && draft.fileIndex === i ? draft.range : null}
            onSelect={handleSelect}
            renderAnnotation={renderAnnotation}
          />
        );
      })}
      <div className="diff-comment-hint">Click a line number (drag for a range) to comment.</div>
    </div>
  );
}

function FileDiffWithSelection({
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
  renderAnnotation: () => React.ReactNode;
}) {
  const options = useMemo(
    () => ({
      ...BASE_OPTIONS,
      onLineSelected: (range: SelectedLineRange | null) => onSelect(fileIndex, file.name, range),
    }),
    [fileIndex, file.name, onSelect]
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
}
