import React, { useEffect, useState, useCallback } from "react";
import type { PrDetails } from "../lib/types";
import { fetchPr, fetchPrDiff, postPrCommentApi, mergePrApi } from "../lib/api";
import { CommentableDiff, type CommentTarget } from "./CommentableDiff";
import { getCurrentUser } from "./UserPicker";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open session →" action (used by the Reviews view). */
  onOpenSession?: () => void;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

export function PrPanel({ sessionId, onOpenSession }: Props) {
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [diff, setDiff] = useState<PrDiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastCommentUrl, setLastCommentUrl] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [prData, diffData] = await Promise.all([
        fetchPr(sessionId),
        fetchPrDiff(sessionId).catch(() => null),
      ]);
      setPr(prData);
      setDiff(diffData);
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  async function handlePrComment(target: CommentTarget, text: string) {
    const result = await postPrCommentApi(sessionId, {
      text,
      user: getCurrentUser(),
      path: target.path,
      line: target.endLine,
      startLine: target.startLine !== target.endLine ? target.startLine : undefined,
      side: target.side === "deletions" ? "LEFT" : "RIGHT",
    });
    setLastCommentUrl(result.url || null);
  }

  // Two-click confirm guards against accidental merges (this mutates the repo).
  async function handleMerge() {
    if (!confirmMerge) {
      setConfirmMerge(true);
      setMergeError(null);
      setTimeout(() => setConfirmMerge(false), 4000);
      return;
    }
    setConfirmMerge(false);
    setMerging(true);
    setMergeError(null);
    try {
      await mergePrApi(sessionId, "squash");
      await load();
    } catch (e: any) {
      setMergeError(e.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  if (loading) return <div className="panel-placeholder">Loading PR…</div>;
  if (!pr) return <div className="panel-placeholder">No pull request for this branch yet</div>;

  const stateClass =
    pr.state === "MERGED" ? "pr-pill-merged" : pr.state === "CLOSED" ? "pr-pill-closed" : pr.isDraft ? "pr-pill-draft" : "pr-pill-open";
  const stateLabel = pr.state === "OPEN" && pr.isDraft ? "Draft" : pr.state.charAt(0) + pr.state.slice(1).toLowerCase();

  return (
    <div className="pr-panel">
      <div className="pr-head">
        <span className={`pr-pill ${stateClass}`}>{stateLabel}</span>
        <a className="pr-number" href={pr.url} target="_blank" rel="noopener">
          #{pr.number}
        </a>
        <button className="btn-icon" onClick={load} title="Refresh">↻</button>
      </div>

      <a className="pr-title" href={pr.url} target="_blank" rel="noopener">
        {pr.title}
      </a>

      <div className="pr-meta">
        <span className="pr-branch">
          {pr.headRefName} → {pr.baseRefName}
        </span>
        <span>
          {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
          {" "}<span className="diff-add">+{pr.additions}</span>{" "}
          <span className="diff-del">−{pr.deletions}</span>
        </span>
        {pr.reviewDecision && (
          <span className={`pr-review pr-review-${pr.reviewDecision.toLowerCase()}`}>
            {pr.reviewDecision.replaceAll("_", " ").toLowerCase()}
          </span>
        )}
      </div>

      {pr.checks.length > 0 && (
        <div className="pr-checks">
          <div className="pr-checks-title">Checks</div>
          {pr.checks.map((check, i) => (
            <a
              key={i}
              className="pr-check"
              href={check.url}
              target="_blank"
              rel="noopener"
            >
              <span className={`pr-check-dot ${checkClass(check.status, check.conclusion)}`} />
              <span className="pr-check-name">{check.name}</span>
              <span className="pr-check-state">
                {(check.conclusion || check.status).toLowerCase()}
              </span>
            </a>
          ))}
        </div>
      )}

      {pr.body && (
        <div className="pr-body">
          <div className="pr-checks-title">Description</div>
          <pre className="pr-body-text">{pr.body.slice(0, 3000)}</pre>
        </div>
      )}

      <div className="pr-actions">
        <a className="btn-open-pr" href={pr.url} target="_blank" rel="noopener">
          Open on GitHub ↗
        </a>
        {pr.state === "OPEN" && !pr.isDraft && (
          <button
            className={`btn-merge-pr ${confirmMerge ? "btn-merge-confirm" : ""}`}
            onClick={handleMerge}
            disabled={merging}
            title="Squash and merge this PR into its base branch"
          >
            {merging ? "Merging…" : confirmMerge ? "Confirm squash & merge" : "Squash & merge"}
          </button>
        )}
        {onOpenSession && (
          <button className="btn-open-session" onClick={onOpenSession}>
            Open session →
          </button>
        )}
      </div>
      {mergeError && <div className="pr-merge-error">{mergeError}</div>}

      {diff?.patch && (
        <div className="pr-diff-section">
          <div className="pr-checks-title">
            Review — comments land on the PR
            {lastCommentUrl && (
              <a className="pr-comment-link" href={lastCommentUrl} target="_blank" rel="noopener">
                last comment ↗
              </a>
            )}
          </div>
          <CommentableDiff
            patch={diff.patch}
            submitLabel="Comment on PR"
            placeholder={`Review comment — posts on #${diff.number} as an inline comment…`}
            onSubmit={handlePrComment}
          />
        </div>
      )}
    </div>
  );
}

function checkClass(status: string, conclusion: string): string {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  switch (conclusion) {
    case "SUCCESS":
      return "check-success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ERROR":
      return "check-failure";
    default:
      return "check-neutral";
  }
}
