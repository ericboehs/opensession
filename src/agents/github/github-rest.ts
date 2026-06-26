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
/** Hidden marker on the single review summary comment, so we can re-find it if state is lost. */
export const REVIEW_MARKER = "<!-- michael-review -->";

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

/**
 * Maintain ONE summary comment on the PR, edited in place. Tries the known id,
 * then re-discovers our comment by the hidden marker (so a lost id never spawns a
 * duplicate), else creates a new one. Returns the comment id to persist.
 */
export async function upsertSummaryComment(
  prNumber: number,
  knownId: number | undefined,
  body: string
): Promise<number | null> {
  const withMarker = body.startsWith(REVIEW_MARKER) ? body : `${REVIEW_MARKER}\n${body}`;

  if (knownId) {
    const patched = await githubRequest(
      "PATCH",
      `/repos/${GITHUB_REPO}/issues/comments/${knownId}`,
      { body: withMarker }
    );
    if (patched.ok) return knownId;
    // 404 → comment was deleted; fall through to re-discover/create.
  }

  // Re-discover by marker (primary) — robust even if the token account differs.
  const list = await githubRequest<IssueComment[]>(
    "GET",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments?per_page=100`
  );
  if (list.ok && Array.isArray(list.data)) {
    const mine = list.data.find((c) => typeof c.body === "string" && c.body.startsWith(REVIEW_MARKER));
    if (mine) {
      const patched = await githubRequest(
        "PATCH",
        `/repos/${GITHUB_REPO}/issues/comments/${mine.id}`,
        { body: withMarker }
      );
      if (patched.ok) return mine.id;
    }
  }

  const created = await githubRequest<IssueComment>(
    "POST",
    `/repos/${GITHUB_REPO}/issues/${prNumber}/comments`,
    { body: withMarker }
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
