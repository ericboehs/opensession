import React, { useEffect, useState, useCallback, startTransition } from "react";
import type { RepoDiff } from "../lib/types";
import { fetchDiff } from "../lib/api";
import { CommentableDiff, type CommentTarget } from "./CommentableDiff";
import { getCurrentUser } from "./UserPicker";
import { Tooltip } from "./Tooltip";

interface Props {
  sessionId: string;
  isRunning: boolean;
  canSend: boolean;
  send: (msg: any) => void;
}

export function DiffPanel({ sessionId, isRunning, canSend, send }: Props) {
  const [repos, setRepos] = useState<RepoDiff[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchDiff(sessionId);
      if (data.error) throw new Error(data.error);
      // @pierre/diffs renders on the main thread (disableWorkerPool) and
      // parsePatchFiles runs during render, so committing a large diff is a long,
      // uninterruptible task. Commit it as a transition so an urgent interaction —
      // e.g. clicking the panel toggle to close — preempts it instead of waiting
      // for the whole diff to parse and paint. If the user closes the panel before
      // this render commits, React discards it and the panel closes instantly.
      startTransition(() => {
        setRepos(data.repos || []);
        setError(null);
        setLoading(false);
      });
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    // Keep the diff fresh while the agent is working
    const interval = setInterval(load, isRunning ? 8000 : 30000);
    return () => clearInterval(interval);
  }, [load, isRunning]);

  async function handleComment(repo: string, target: CommentTarget, text: string) {
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
        `${target.side === "deletions" ? ", removed lines" : ""}) in the **${repo}** repo's current diff:\n\n` +
        `${text}\n\n` +
        `Please address this in the ${repo} worktree on the current branch.`,
    });
  }

  if (loading) return <div className="panel-placeholder">Loading diff…</div>;
  if (error) return <div className="panel-placeholder panel-error">{error}</div>;
  if (!repos || !repos.length) return <div className="panel-placeholder">No changes yet</div>;

  // Repos that actually have changes; if none, show "No changes yet".
  const changed = repos.filter((r) => r.diff.rawPatch?.trim() || r.diff.files.length > 0);
  if (!changed.length) return <div className="panel-placeholder">No changes yet</div>;

  const multi = changed.length > 1;
  const cur = changed[Math.min(active, changed.length - 1)] || changed[0];
  const d = cur.diff;

  return (
    <div className="diff-panel">
      {multi && (
        <div className="diff-repo-tabs">
          {changed.map((r, i) => {
            const n = r.diff.totalAdditions + r.diff.totalDeletions;
            return (
              <button
                key={r.repo}
                className={`diff-repo-tab ${i === active ? "diff-repo-tab-active" : ""}`}
                onClick={() => setActive(i)}
                title={r.primary ? "Primary repo" : "Attached repo"}
              >
                {r.repo}
                <span className="diff-repo-tab-count">{r.diff.files.length}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="diff-summary">
        <span className="diff-summary-files">
          {d.files.length} file{d.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="diff-add">+{d.totalAdditions}</span>
        <span className="diff-del">−{d.totalDeletions}</span>
        {d.truncated && <span className="diff-truncated">truncated</span>}
        <Tooltip label="Refresh diff">
          <button className="btn-icon" onClick={load}>↻</button>
        </Tooltip>
      </div>

      <div className="diff-render">
        <CommentableDiff
          key={cur.repo}
          patch={d.rawPatch || ""}
          submitLabel="Send to Michael"
          placeholder={`Leave feedback on these lines — Michael picks it up in this session…`}
          disabled={!canSend}
          disabledHint="Michael is working — feedback can be sent when the current run finishes."
          onSubmit={(target, text) => handleComment(cur.repo, target, text)}
        />
      </div>
    </div>
  );
}
