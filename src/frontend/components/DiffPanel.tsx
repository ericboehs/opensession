import React, { useEffect, useState, useCallback } from "react";
import type { SessionDiff } from "../lib/types";
import { fetchDiff } from "../lib/api";
import { CommentableDiff, type CommentTarget } from "./CommentableDiff";
import { getCurrentUser } from "./UserPicker";

interface Props {
  sessionId: string;
  isRunning: boolean;
  canSend: boolean;
  send: (msg: any) => void;
}

export function DiffPanel({ sessionId, isRunning, canSend, send }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchDiff(sessionId);
      if (data.error) throw new Error(data.error);
      setDiff(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    // Keep the diff fresh while the agent is working
    const interval = setInterval(load, isRunning ? 8000 : 30000);
    return () => clearInterval(interval);
  }, [load, isRunning]);

  async function handleComment(target: CommentTarget, text: string) {
    if (!canSend) throw new Error("Michael is busy — wait for the current run to finish");
    const lines =
      target.startLine === target.endLine
        ? `line ${target.startLine}`
        : `lines ${target.startLine}–${target.endLine}`;
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `Diff feedback from ${getCurrentUser()} on \`${target.path}\` (${lines}` +
        `${target.side === "deletions" ? ", removed lines" : ""} in the current uncommitted diff):\n\n` +
        `${text}\n\n` +
        `Please address this feedback on the current branch.`,
    });
  }

  if (loading) return <div className="panel-placeholder">Loading diff…</div>;
  if (error) return <div className="panel-placeholder panel-error">{error}</div>;
  if (!diff || (!diff.rawPatch?.trim() && diff.files.length === 0)) {
    return <div className="panel-placeholder">No changes yet</div>;
  }

  return (
    <div className="diff-panel">
      <div className="diff-summary">
        <span className="diff-summary-files">
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="diff-add">+{diff.totalAdditions}</span>
        <span className="diff-del">−{diff.totalDeletions}</span>
        {diff.truncated && <span className="diff-truncated">truncated</span>}
        <button className="btn-icon" onClick={load} title="Refresh diff">↻</button>
      </div>

      <div className="diff-render">
        <CommentableDiff
          patch={diff.rawPatch || ""}
          submitLabel="Send to Michael"
          placeholder="Leave feedback on these lines — Michael picks it up in this session…"
          disabled={!canSend}
          disabledHint="Michael is working — feedback can be sent when the current run finishes."
          onSubmit={handleComment}
        />
      </div>
    </div>
  );
}
