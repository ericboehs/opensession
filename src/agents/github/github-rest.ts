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

/**
 * GraphQL request (the REST API can't resolve review threads). Same PAT/auth as
 * the REST helper. Returns the `data` object, or null on any error.
 */
export async function githubGraphQL<T = any>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  if (!GITHUB_TOKEN) return null;
  try {
    const resp = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const json: any = await resp.json().catch(() => null);
    if (!resp.ok || !json || json.errors) {
      const msg = json?.errors?.map((e: any) => e.message).join("; ") || `GitHub GraphQL ${resp.status}`;
      console.warn(`[github] graphql → ${resp.status}: ${msg}`);
      return null;
    }
    return json.data as T;
  } catch (e: any) {
    console.warn(`[github] graphql error:`, e);
    return null;
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

/**
 * Edit `reuseId` if given and still editable, else post a new comment. Returns the
 * comment id. Used so a run reuses its own progress comment within the run (and on
 * restart recovery) but a fresh trigger — which passes no reuseId — posts a new one.
 */
export async function postOrEditComment(
  prNumber: number,
  reuseId: number | undefined,
  body: string,
): Promise<number | null> {
  if (reuseId) {
    if (await editIssueComment(reuseId, body)) return reuseId;
  }
  return postIssueComment(prNumber, body);
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

// ── Review thread resolution (GraphQL) ───────────────────────

/** Hidden marker the auto-fixer stamps on its "Fixed in <sha>" thread replies. */
export const FIXED_REPLY_MARKER = "<!-- michael-fixed -->";

export interface ReviewThreadComment {
  login: string;
  body: string;
}

export interface ReviewThread {
  /** GraphQL node id — the handle `resolveReviewThread` needs. */
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  /** File the thread is anchored to (null for a file-level/detached thread). */
  path: string | null;
  /** Current head-side line the thread anchors to (null once outdated). */
  line: number | null;
  /** login of the thread's first (root) comment author. */
  rootAuthor: string;
  /** Every comment in the thread, oldest first (root + replies). */
  comments: ReviewThreadComment[];
}

/**
 * List a PR's review threads with their resolve/outdated state and comments — the
 * bridge REST doesn't expose. Used to find threads the fixer replied "Fixed in
 * <sha>" to (so we can resolve them) and to sweep stale outdated bot threads.
 */
export async function listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
  const data = await githubGraphQL<any>(
    `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){
          reviewThreads(first:100){
            nodes{
              id isResolved isOutdated path line
              comments(first:100){ nodes{ author{login} body } }
            }
          }
        }
      }
    }`,
    { owner: "tellahq", name: GITHUB_REPO.split("/")[1], number: prNumber },
  );
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map((t: any) => {
    const comments = (t.comments?.nodes || []).map((c: any) => ({
      login: c.author?.login || "",
      body: typeof c.body === "string" ? c.body : "",
    }));
    return {
      id: t.id,
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      path: typeof t.path === "string" ? t.path : null,
      line: typeof t.line === "number" ? t.line : null,
      rootAuthor: comments[0]?.login || "",
      comments,
    };
  });
}

/** Mark a single review thread resolved by its node id. */
export async function resolveReviewThread(threadId: string): Promise<boolean> {
  const data = await githubGraphQL<any>(
    `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`,
    { id: threadId },
  );
  return !!data?.resolveReviewThread?.thread?.isResolved;
}

/** A thread the auto-fixer addressed: it left a "Fixed in <sha>" reply (not the root). */
function threadWasFixed(t: ReviewThread): boolean {
  return t.comments.slice(1).some(
    (c) => c.login === BOT_LOGIN && (c.body.includes(FIXED_REPLY_MARKER) || /(^|\s)fixed in\b/i.test(c.body)),
  );
}

/**
 * Resolve the review threads the auto-fixer addressed — detected by its own "Fixed
 * in <sha>" reply left in the thread (which the fix prompt instructs it to post).
 * This ties resolution to a genuine fix reply, so "I intentionally didn't act" notes
 * (which don't say "Fixed in") are left open for a human. When `alsoOutdatedBotThreads`
 * is set, also resolves any still-open thread rooted by our own bot account that GitHub
 * already marked outdated (its finding moved/vanished with the diff) — safe cleanup
 * that never touches human threads. Idempotent: already-resolved threads are skipped.
 * Returns the number of threads resolved.
 */
export async function resolveAddressedThreads(
  prNumber: number,
  alsoOutdatedBotThreads = false,
): Promise<number> {
  const threads = await listReviewThreads(prNumber);
  if (!threads.length) return 0;
  let resolved = 0;
  for (const t of threads) {
    if (t.isResolved) continue;
    const staleBot = alsoOutdatedBotThreads && t.isOutdated && t.rootAuthor === BOT_LOGIN;
    if (!threadWasFixed(t) && !staleBot) continue;
    if (await resolveReviewThread(t.id)) resolved++;
  }
  return resolved;
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
