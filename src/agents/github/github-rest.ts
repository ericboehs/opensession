/**
 * Write-capable GitHub REST helpers for the github PR agent. The Slack agent's
 * `githubApi` is read-shaped (GET only); these add method + body and the specific
 * calls the review/fix/simplify behaviors need: the single updating summary
 * comment, formal reviews with inline comments, and label removal.
 *
 * Auth: the same `GITHUB_API_TOKEN` PAT the Slack agent uses (Bearer).
 */

const GITHUB_TOKEN = process.env.GITHUB_API_TOKEN;
export const GITHUB_REPO = "tellahq/tella-fusion";
/** The bot account our token posts as — used to recognise our own comments/events. */
export const BOT_LOGIN = process.env.GITHUB_BOT_LOGIN || "tella-butler";
/** Hidden markers Michael stamps on the comments it posts (one per behavior). */
export const REVIEW_MARKER = "<!-- michael-review -->";
export const REVIEW_OUTDATED_MARKER = "<!-- michael-review-outdated -->";
export const REPLY_MARKER = "<!-- michael-reply -->";
export const AUTOFIX_MARKER = "<!-- michael-autofix -->";
export const SIMPLIFY_MARKER = "<!-- michael-simplify -->";
export const ADVERSARIAL_MARKER = "<!-- michael-adversarial -->";
/** Every marker — used to skip our own comments (no self-trigger loop). */
export const MICHAEL_MARKERS = [
  REVIEW_MARKER,
  REVIEW_OUTDATED_MARKER,
  REPLY_MARKER,
  AUTOFIX_MARKER,
  SIMPLIFY_MARKER,
  ADVERSARIAL_MARKER,
];

export function githubConfigured(): boolean {
  return !!GITHUB_TOKEN;
}

interface GithubResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

export async function githubRequest<T = any>(
  method: string,
  path: string,
  body?: unknown
): Promise<GithubResult<T>> {
  if (!GITHUB_TOKEN) return { ok: false, status: 0, data: null, error: "GITHUB_API_TOKEN unset" };
  try {
    const resp = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    const text = await resp.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!resp.ok) {
      const error = (data && (data.message || data.error)) || `GitHub ${resp.status}`;
      console.warn(`[github] ${method} ${path} → ${resp.status}: ${error}`);
      return { ok: false, status: resp.status, data, error };
    }
    return { ok: true, status: resp.status, data };
  } catch (e: any) {
    console.warn(`[github] ${method} ${path} error:`, e);
    return { ok: false, status: 0, data: null, error: e.message || String(e) };
  }
}

// ── Single updating summary comment ──────────────────────────

interface IssueComment {
  id: number;
  body: string;
  user: { login: string };
}

/** Fetch a single issue comment's body. */
export async function getComment(commentId: number): Promise<IssueComment | null> {
  const r = await githubRequest<IssueComment>("GET", `/repos/${GITHUB_REPO}/issues/comments/${commentId}`);
  return r.ok && r.data ? r.data : null;
}

/** Find the current (active, not-outdated) Michael review comment id, if any. */
export async function findActiveReviewComment(prNumber: number): Promise<number | null> {
  const list = await githubRequest<IssueComment[]>(
    "GET",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments?per_page=100`,
  );
  if (!list.ok || !Array.isArray(list.data)) return null;
  // Newest first — supersede the most recent active one.
  const mine = list.data.reverse().find((c) => typeof c.body === "string" && c.body.startsWith(REVIEW_MARKER));
  return mine ? mine.id : null;
}

/** Collapse a prior review comment under a "Outdated review" <details> and re-mark it. */
export async function supersedeReviewComment(commentId: number): Promise<void> {
  const old = await getComment(commentId);
  if (!old?.body) return;
  // Strip the active marker and any previous outdated wrapper, then re-collapse.
  let inner = old.body.replace(REVIEW_MARKER, "").replace(REVIEW_OUTDATED_MARKER, "").trim();
  const detailsMatch = inner.match(/<details>[\s\S]*?<summary>[\s\S]*?<\/summary>\s*([\s\S]*?)<\/details>/i);
  if (detailsMatch) inner = detailsMatch[1].trim(); // avoid nesting details on re-supersede
  const collapsed = `${REVIEW_OUTDATED_MARKER}\n<details>\n<summary>🕙 Outdated review — superseded by a newer review below</summary>\n\n${inner}\n\n</details>`;
  await githubRequest("PATCH", `/repos/${GITHUB_REPO}/issues/comments/${commentId}`, { body: collapsed });
}

export interface ReviewCommentInfo {
  id: number;
  path: string;
  line: number | null;
  body: string;
  login: string;
  outdated: boolean;
}

/** List the inline review comments on a PR (for auto-fix to address + reply to). Newest first. */
export async function listReviewComments(prNumber: number): Promise<ReviewCommentInfo[]> {
  const r = await githubRequest<any[]>(
    "GET",
    `/repos/${GITHUB_REPO}/pulls/${prNumber}/comments?per_page=100`,
  );
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data
    .map((c) => ({
      id: c.id,
      path: c.path,
      // `line` is null once a comment goes outdated (the line changed/disappeared).
      line: typeof c.line === "number" ? c.line : null,
      body: typeof c.body === "string" ? c.body : "",
      login: c.user?.login || "",
      outdated: c.line == null && c.original_line != null,
    }))
    .reverse();
}

export interface ReviewInfo {
  login: string;
  body: string;
  state: string;
}

/** List the formal reviews on a PR that carry a summary body (Greptile/human/Michael). */
export async function listReviews(prNumber: number): Promise<ReviewInfo[]> {
  const r = await githubRequest<any[]>("GET", `/repos/${GITHUB_REPO}/pulls/${prNumber}/reviews?per_page=100`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data
    .filter((rv) => typeof rv.body === "string" && rv.body.trim())
    .map((rv) => ({ login: rv.user?.login || "", body: rv.body, state: rv.state || "" }));
}

/** Reply within a review-comment thread (inline @mention replies). */
export async function replyToReviewComment(
  prNumber: number,
  commentId: number,
  body: string
): Promise<boolean> {
  const r = await githubRequest(
    "POST",
    `/repos/${GITHUB_REPO}/pulls/${prNumber}/comments/${commentId}/replies`,
    { body }
  );
  return r.ok;
}

/**
 * Maintain ONE comment per marker on a PR: PATCH the existing comment whose body
 * starts with `marker`, else create one. Keeps simplify/adversarial/status to a
 * single comment that's reused across re-runs (so a restart-interrupted run that's
 * re-triggered updates the stale placeholder instead of leaving a duplicate).
 */
export async function upsertMarkedComment(
  prNumber: number,
  marker: string,
  body: string,
): Promise<number | null> {
  const withMarker = body.startsWith(marker) ? body : `${marker}\n${body}`;
  const list = await githubRequest<IssueComment[]>(
    "GET",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments?per_page=100`,
  );
  if (list.ok && Array.isArray(list.data)) {
    const mine = list.data.find((c) => typeof c.body === "string" && c.body.startsWith(marker));
    if (mine) {
      const patched = await githubRequest("PATCH", `/repos/${GITHUB_REPO}/issues/comments/${mine.id}`, {
        body: withMarker,
      });
      if (patched.ok) return mine.id;
    }
  }
  const created = await githubRequest<IssueComment>(
    "POST",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments`,
    { body: withMarker },
  );
  return created.ok && created.data ? created.data.id : null;
}

/** Post a plain (non-marker) comment on the PR — used for fix/simplify status. */
export async function postIssueComment(prNumber: number, body: string): Promise<number | null> {
  const created = await githubRequest<IssueComment>(
    "POST",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments`,
    { body }
  );
  return created.ok && created.data ? created.data.id : null;
}

/** Edit an existing comment (status comments edited in place across fix iterations). */
export async function editIssueComment(commentId: number, body: string): Promise<boolean> {
  const r = await githubRequest("PATCH", `/repos/${GITHUB_REPO}/issues/comments/${commentId}`, { body });
  return r.ok;
}

// ── Formal review with inline comments ───────────────────────

export interface ReviewInlineComment {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  body: string;
}

/**
 * Submit a formal PR review (event COMMENT) carrying inline comments anchored to
 * diff lines. GitHub auto-outdates these as the code changes — no manual cleanup.
 * Comments whose path/line aren't on the diff make the whole call fail, so callers
 * should pre-validate against the patch; we also retry without comments on failure
 * so the summary review still posts.
 */
export async function submitReview(
  prNumber: number,
  commitId: string,
  body: string,
  comments: ReviewInlineComment[]
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    commit_id: commitId,
    event: "COMMENT",
    body,
    comments: comments.map((c) => ({ path: c.path, line: c.line, side: c.side || "RIGHT", body: c.body })),
  };
  const r = await githubRequest("POST", `/repos/${GITHUB_REPO}/pulls/${prNumber}/reviews`, payload);
  if (r.ok) return true;
  if (comments.length) {
    // Inline anchors can be rejected (line not in diff) — fall back to a body-only review.
    const r2 = await githubRequest("POST", `/repos/${GITHUB_REPO}/pulls/${prNumber}/reviews`, {
      commit_id: commitId,
      event: "COMMENT",
      body,
    });
    return r2.ok;
  }
  return false;
}

// ── Labels ───────────────────────────────────────────────────

/** Remove a label from a PR (action labels are cleared when the action completes). */
export async function removeLabel(prNumber: number, label: string): Promise<boolean> {
  const r = await githubRequest(
    "DELETE",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/labels/${encodeURIComponent(label)}`
  );
  // 404 = label already gone; treat as success.
  return r.ok || r.status === 404;
}
