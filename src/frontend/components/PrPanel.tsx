import React, { useEffect, useState, useCallback } from "react";
import type { PrDetails } from "../lib/types";
import { fetchPr } from "../lib/api";

interface Props {
  sessionId: string;
}

export function PrPanel({ sessionId }: Props) {
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setPr(await fetchPr(sessionId));
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

      <a className="btn-open-pr" href={pr.url} target="_blank" rel="noopener">
        Open on GitHub ↗
      </a>
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
