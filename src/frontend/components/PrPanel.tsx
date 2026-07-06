import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type { GitStatusInfo, PrCheck, PrComment, PrDetails } from "../lib/types";
import {
  fetchPr,
  fetchPrDiff,
  fetchGitStatus,
  gitPushApi,
  submitPrReviewApi,
  mergePrApi,
} from "../lib/api";
import { CommentableDiff, type CommentTarget, type PendingComment } from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open session →" action (used by the Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /** Side-by-side info|diff layout for wide containers (the Reviews drawer). */
  split?: boolean;
  /**
   * Repos in this session (primary + attached). When more than one, a repo
   * switcher selects which repo's PR to show. Omit for single-repo callers
   * (e.g. the Reviews drawer) — they target the primary branch as before.
   */
  repos?: Array<{ repo: string; primary: boolean }>;
  /**
   * WebSocket sender. When provided, selecting text in the PR info column shows a
   * "Send to session" popover that delivers the selection + a message to this PR's
   * session (via a `prompt` message — the server steers/queues if it's busy).
   */
  send?: (msg: any) => void;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

export function PrPanel({ sessionId, onOpenSession, onAddToInput, split, repos, send }: Props) {
  const repoList = repos && repos.length > 1 ? repos : null;
  const [activeRepo, setActiveRepo] = useState<string | undefined>(
    repoList ? (repoList.find((r) => r.primary)?.repo ?? repoList[0].repo) : undefined,
  );
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [diff, setDiff] = useState<PrDiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("COMMENT");
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [checksOpen, setChecksOpen] = useState(true);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [prData, diffData, gitData] = await Promise.all([
        fetchPr(sessionId, activeRepo),
        fetchPrDiff(sessionId, activeRepo).catch(() => null),
        fetchGitStatus(sessionId, activeRepo).catch(() => null),
      ]);
      setPr(prData);
      setDiff(diffData);
      setGit(gitData);
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId, activeRepo]);

  useEffect(() => {
    setLoading(true);
    setPending([]);
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (GitHub's native flow).
  async function handleAddPending(target: CommentTarget, text: string) {
    setPending((prev) => [
      ...prev,
      { ...target, text, id: crypto.randomUUID() },
    ]);
    setReviewDone(null);
  }

  function handleRemovePending(id: string) {
    setPending((prev) => prev.filter((c) => c.id !== id));
  }

  async function handleSubmitReview() {
    if (submitting) return;
    if (pending.length === 0 && !summary.trim()) {
      setReviewError("Add a comment or a summary first");
      return;
    }
    setSubmitting(true);
    setReviewError(null);
    try {
      const result = await submitPrReviewApi(sessionId, {
        user: getCurrentUser(),
        event: reviewEvent,
        summary: summary.trim() || undefined,
        repo: activeRepo,
        comments: pending.map((c) => ({
          text: c.text,
          path: c.path,
          line: c.endLine,
          startLine: c.startLine !== c.endLine ? c.startLine : undefined,
          side: c.side === "deletions" ? "LEFT" : "RIGHT",
        })),
      });
      setPending([]);
      setSummary("");
      setReviewOpen(false);
      setReviewEvent("COMMENT");
      setReviewDone(result.url || "submitted");
      setTimeout(() => setReviewDone(null), 6000);
      await load();
    } catch (e: any) {
      setReviewError(e.message || "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
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
      await mergePrApi(sessionId, "squash", activeRepo);
      await load();
    } catch (e: any) {
      setMergeError(e.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  // Roll the per-check list up into headline counts, and split deployments
  // (Vercel previews & friends) from CI checks, Conductor-style — failing and
  // running entries sort first within each group.
  const checkSummary = useMemo(() => {
    const checks = pr?.checks || [];
    let passed = 0,
      failed = 0,
      pending = 0;
    for (const c of checks) {
      const cls = checkClass(c.status, c.conclusion);
      if (cls === "check-success") passed++;
      else if (cls === "check-failure") failed++;
      else if (cls === "check-pending") pending++;
    }
    const rank = (c: PrCheck) => {
      const cls = checkClass(c.status, c.conclusion);
      return cls === "check-failure" ? 0 : cls === "check-pending" ? 1 : cls === "check-success" ? 3 : 2;
    };
    const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
    return {
      passed,
      failed,
      pending,
      total: checks.length,
      deployments: sorted.filter(isDeployment),
      checks: sorted.filter((c) => !isDeployment(c)),
    };
  }, [pr]);

  const bodyHtml = useMemo(() => (pr?.body ? renderMarkdown(pr.body) : ""), [pr?.body]);

  // Only offer the expand toggle when the clamped description is actually taller
  // than its collapsed height — a two-line PR body shouldn't get a "Show more".
  useEffect(() => {
    // Measure against the clamped height; when expanded the toggle must stay
    // visible to collapse again, so only recompute while collapsed.
    if (bodyOpen) return;
    const el = bodyRef.current;
    setBodyOverflows(!!el && el.scrollHeight - el.clientHeight > 4);
  }, [bodyHtml, bodyOpen]);

  const switcher = repoList ? (
    <div className="pr-repo-tabs">
      {repoList.map((r) => (
        <button
          key={r.repo}
          className={`pr-repo-tab ${r.repo === activeRepo ? "pr-repo-tab-active" : ""}`}
          onClick={() => setActiveRepo(r.repo)}
          title={r.primary ? "Primary repo" : "Attached repo"}
        >
          {r.repo}
        </button>
      ))}
    </div>
  ) : null;

  if (loading)
    return (
      <div className="pr-panel">
        {switcher}
        <div className="panel-placeholder">Loading PR…</div>
      </div>
    );
  if (!pr)
    return (
      <div className="pr-panel">
        {switcher}
        <div className="pr-panel-info">
          <div className="pr-no-pr-title">PR title</div>
          <div className="pr-no-pr-desc">PR description</div>
          <GitStatusSection
            git={git}
            pr={null}
            sessionId={sessionId}
            repo={activeRepo}
            send={send}
            onRefresh={load}
          />
        </div>
      </div>
    );

  return (
    <div className={`pr-panel ${split ? "pr-panel-split" : ""}`}>
      {switcher}
      <SelectionToSession sessionId={sessionId} label={`PR #${pr.number}`} send={send}>
      <div className="pr-panel-info">
      <a className="pr-title" href={pr.url} target="_blank" rel="noopener">
        {pr.title}
      </a>

      {pr.body && (
        <div className="pr-body pr-body-top">
          <div
            ref={bodyRef}
            className={`pr-body-md markdown ${bodyOpen ? "" : "pr-body-clamped"}`}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          {(bodyOverflows || bodyOpen) && (
            <button className="pr-body-toggle" onClick={() => setBodyOpen((o) => !o)}>
              {bodyOpen ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      <GitStatusSection
        git={git}
        pr={pr}
        sessionId={sessionId}
        repo={activeRepo}
        send={send}
        onRefresh={load}
      />

      {pr.checks.length > 0 && (
        <div className="pr-checks">
          <button
            className="pr-checks-summary"
            onClick={() => setChecksOpen((o) => !o)}
            aria-expanded={checksOpen}
          >
            <span
              className={`pr-checks-status ${
                checkSummary.failed > 0
                  ? "pr-sum-fail"
                  : checkSummary.pending > 0
                    ? "pr-sum-pending"
                    : "pr-sum-pass"
              }`}
            >
              {checkSummary.failed > 0
                ? "Some checks failed"
                : checkSummary.pending > 0
                  ? "Checks running"
                  : "All checks passed"}
            </span>
            <span className="pr-checks-counts">
              {checkSummary.passed > 0 && (
                <span className="pr-count check-success-text">✓ {checkSummary.passed}</span>
              )}
              {checkSummary.failed > 0 && (
                <span className="pr-count check-failure-text">✕ {checkSummary.failed}</span>
              )}
              {checkSummary.pending > 0 && (
                <span className="pr-count check-pending-text">● {checkSummary.pending}</span>
              )}
            </span>
            <span className="pr-checks-chevron">{checksOpen ? "▾" : "▸"}</span>
          </button>
          {checksOpen && checkSummary.deployments.length > 0 && (
            <>
              <div className="pr-checks-group">Deployments</div>
              {checkSummary.deployments.map((check, i) => (
                <CheckRow key={`d${i}`} check={check} />
              ))}
            </>
          )}
          {checksOpen && checkSummary.checks.length > 0 && (
            <>
              {checkSummary.deployments.length > 0 && (
                <div className="pr-checks-group">Checks</div>
              )}
              {checkSummary.checks.map((check, i) => (
                <CheckRow key={`c${i}`} check={check} />
              ))}
            </>
          )}
        </div>
      )}

      {(pr.comments?.length || 0) > 0 && (
        <div className="pr-comments">
          <div className="pr-comments-head">
            <span className="pr-checks-title pr-comments-title">Comments</span>
            {onAddToInput && (
              <button
                className="pr-comments-add-all"
                onClick={() => onAddToInput(formatPrCommentsPrompt(pr.comments || [], pr))}
              >
                Add all to chat
              </button>
            )}
          </div>
          {(pr.comments || []).map((comment, i) => (
            <div className="pr-comment-row" key={`${comment.url || comment.createdAt || i}`}>
              <span className="pr-comment-select" aria-hidden />
              <div className="pr-comment-meta">
                <span className="pr-comment-author">{comment.author || "comment"}</span>
              </div>
              <div className="pr-comment-body">{comment.body}</div>
              {comment.url && (
                <a className="pr-comment-link" href={comment.url} target="_blank" rel="noopener">
                  ↗
                </a>
              )}
              {onAddToInput && (
                <button
                  className="pr-comment-add"
                  onClick={() => onAddToInput(formatPrCommentPrompt(comment, pr))}
                >
                  Add to chat
                </button>
              )}
            </div>
          ))}
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
      </div>
      </SelectionToSession>

      {diff?.patch && (
        <div className="pr-panel-diff">
        <div className="pr-diff-section">
          <div className="pr-checks-title">
            Review — comments stay pending until you submit
            {reviewDone && (
              reviewDone === "submitted" ? (
                <span className="pr-comment-link">review submitted ✓</span>
              ) : (
                <a className="pr-comment-link" href={reviewDone} target="_blank" rel="noopener">
                  review submitted ↗
                </a>
              )
            )}
          </div>
          <CommentableDiff
            patch={diff.patch}
            submitLabel="Add comment"
            placeholder={`Comment on #${diff.number} — added to your pending review…`}
            pendingComments={pending}
            onRemovePending={handleRemovePending}
            onSubmit={handleAddPending}
          />
        </div>

        {pending.length > 0 && (
          <div className="pr-review-bar">
            <div className="pr-review-bar-row">
              <span className="pr-review-count">
                {pending.length} pending comment{pending.length === 1 ? "" : "s"}
              </span>
              <button
                className="pr-review-toggle"
                onClick={() => setReviewOpen((o) => !o)}
              >
                {reviewOpen ? "Hide" : "Finish review"}
              </button>
              {onAddToInput && (
                <button
                  className="pr-review-toggle"
                  onClick={() => onAddToInput(formatPendingCommentsPrompt(pending, pr))}
                >
                  Add to chat
                </button>
              )}
            </div>

            {reviewOpen && (
              <div className="pr-review-form">
                <textarea
                  className="pr-review-summary"
                  rows={3}
                  placeholder="Overall review summary (optional)…"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                />
                <div className="pr-review-events">
                  {([
                    ["COMMENT", "Comment"],
                    ["APPROVE", "Approve"],
                    ["REQUEST_CHANGES", "Request changes"],
                  ] as Array<[ReviewEvent, string]>).map(([key, label]) => (
                    <button
                      key={key}
                      className={`pr-review-event ${reviewEvent === key ? "active" : ""}`}
                      onClick={() => setReviewEvent(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {reviewError && <div className="diff-comment-error">{reviewError}</div>}
                <button
                  className="pr-review-submit"
                  onClick={handleSubmitReview}
                  disabled={submitting}
                >
                  {submitting
                    ? "Submitting…"
                    : `Submit review (${pending.length})`}
                </button>
              </div>
            )}
          </div>
        )}
        </div>
      )}
    </div>
  );
}

type PrCheckRank = "check-success" | "check-failure" | "check-pending" | "check-neutral";

export function checkClass(status: string, conclusion: string): PrCheckRank {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  // StatusContexts (Vercel deploys) report a state, not a status — a pending
  // deploy is "COMPLETED"/PENDING here and must not read as neutral.
  if (conclusion === "PENDING" || conclusion === "EXPECTED") return "check-pending";
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

// Vercel previews arrive as StatusContexts named "Preview – <project>" (no
// workflow); everything with a workflow is CI.
export function isDeployment(check: PrCheck): boolean {
  return (
    !check.workflowName &&
    (/^preview\b/i.test(check.name) || /vercel|deploy/i.test(check.name))
  );
}

function formatCheckDuration(check: PrCheck): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const secs = Math.round(
    (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000,
  );
  if (secs <= 0) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

function formatPendingCommentsPrompt(comments: PendingComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const range =
        c.startLine && c.startLine !== c.endLine
          ? `${c.startLine}-${c.endLine}`
          : String(c.endLine);
      return `${i + 1}. ${c.path}:${range}\n${c.text}`;
    })
    .join("\n\n");
  return `Please address these pending review comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

function trimCommentBody(body: string): string {
  return body.trim().replace(/\n{3,}/g, "\n\n");
}

export function formatPrCommentPrompt(comment: PrComment, pr: PrDetails): string {
  const author = comment.author ? ` from ${comment.author}` : "";
  const link = comment.url ? `\nURL: ${comment.url}` : "";
  return `Please address this PR comment${author} on PR #${pr.number} (${pr.title}).${link}\n\n${trimCommentBody(comment.body)}`;
}

function formatPrCommentsPrompt(comments: PrComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const by = c.author ? ` by ${c.author}` : "";
      const link = c.url ? `\n${c.url}` : "";
      return `${i + 1}. Comment${by}${link}\n${trimCommentBody(c.body)}`;
    })
    .join("\n\n");
  return `Please review these PR comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark = cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div className="pr-check pr-check-row">
      <a className="pr-check-main" href={check.url} target="_blank" rel="noopener">
        <span className={`pr-check-mark ${cls}-text ${cls === "check-pending" ? "pr-check-mark-pending" : ""}`}>
          {mark}
        </span>
        <span className="pr-check-name">{check.name}</span>
        {duration && <span className="pr-check-duration">{duration}</span>}
        {check.url && <span className="pr-check-open">↗</span>}
      </a>
    </div>
  );
}

/**
 * Conductor-style "Git status" rows: each local/remote discrepancy gets a line
 * with one action on the right. Push is a direct server-side `git push`; the
 * judgment calls (create the PR, resolve conflicts, update from main, commit
 * stray changes) prompt the session — Michael does the work, not a bare button.
 */
function GitStatusSection({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
}: {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [pushing, setPushing] = useState(false);
  const [prompted, setPrompted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = pr?.baseRefName || git?.baseBranch || "main";

  function promptSession(label: string, content: string) {
    if (!send) return;
    send({ type: "prompt", sessionId, user: getCurrentUser(), content });
    setPrompted(label);
    setTimeout(() => setPrompted(null), 6000);
  }

  async function handlePush() {
    if (pushing) return;
    setPushing(true);
    setError(null);
    try {
      await gitPushApi(sessionId, repo);
      await onRefresh();
    } catch (e: any) {
      setError(e.message || "Push failed");
    } finally {
      setPushing(false);
    }
  }

  const rows: Array<{ key: string; label: string; action?: React.ReactNode }> = [];

  if (!pr && git) {
    rows.push({
      key: "no-pr",
      label: "No PR open",
      action: send && (
        <button
          className="pr-git-action"
          onClick={() =>
            promptSession(
              "create a PR",
              "Commit any remaining work, push the branch, and open a PR for it.",
            )
          }
        >
          Create PR
        </button>
      ),
    });
  }
  if (git && git.ahead > 0) {
    rows.push({
      key: "ahead",
      label: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of remote`,
      action: (
        <button className="pr-git-action" onClick={handlePush} disabled={pushing}>
          {pushing ? "Pushing…" : "Push"}
        </button>
      ),
    });
  }
  if (git && git.uncommittedFiles > 0) {
    rows.push({
      key: "dirty",
      label: `${git.uncommittedFiles} uncommitted file${git.uncommittedFiles === 1 ? "" : "s"}`,
      action: send && (
        <button
          className="pr-git-action"
          onClick={() =>
            promptSession("commit the changes", "Commit and push the current work in the worktree.")
          }
        >
          Commit
        </button>
      ),
    });
  }
  if (pr?.mergeable === "CONFLICTING") {
    rows.push({
      key: "conflicts",
      label: "Merge conflicts detected",
      action: send && (
        <button
          className="pr-git-action"
          onClick={() =>
            promptSession(
              "resolve the conflicts",
              `The PR has merge conflicts with ${base}. Rebase this branch on the latest origin/${base}, resolve the conflicts, and push.`,
            )
          }
        >
          Resolve
        </button>
      ),
    });
  }
  if (git && git.behindBase > 0 && pr?.state !== "MERGED") {
    rows.push({
      key: "behind",
      label: `${git.behindBase} commit${git.behindBase === 1 ? "" : "s"} behind ${base}`,
      action: send && (
        <button
          className="pr-git-action"
          onClick={() =>
            promptSession(
              "update from " + base,
              `Update this branch with the latest origin/${base} (rebase preferred), resolve any conflicts, and push.`,
            )
          }
        >
          Update
        </button>
      ),
    });
  }

  if (rows.length === 0) return null;

  return (
    <div className="pr-git">
      <div className="pr-checks-title">Git status</div>
      {rows.map((row) => (
        <div key={row.key} className="pr-git-row">
          <span className="pr-git-dot" />
          <span className="pr-git-label">{row.label}</span>
          {row.action}
        </div>
      ))}
      {prompted && <div className="pr-git-note">Asked Michael to {prompted} ✓</div>}
      {error && <div className="pr-git-note pr-git-note-error">{error}</div>}
    </div>
  );
}
