/**
 * PR details for a session branch via the gh CLI, Devin-style "PR" tab.
 * Cached per branch for 30s to keep the UI snappy without hammering GitHub.
 */
import { defaultRepo } from "./config";
import { $ } from "bun";
import { audited } from "./audit";

export interface PrCheck {
  name: string;
  status: string; // COMPLETED, IN_PROGRESS, QUEUED…
  conclusion: string; // SUCCESS, FAILURE, NEUTRAL, ""…
  url?: string;
  startedAt?: string;
  completedAt?: string;
  /** CheckRun workflow (e.g. "CI") — StatusContexts (Vercel deploys) have none. */
  workflowName?: string;
}

export interface PrComment {
  author: string;
  body: string;
  url?: string;
  createdAt?: string;
}

export interface PrStaging {
  /** Vercel branch-alias preview, e.g. https://tella-git-<branch>.tella.dev */
  url: string;
  /** Deploy status from the butler table, verbatim: Building | Ready | Error… */
  status: string;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * A person on the PR's reviewer list. `state` is the review outcome
 * (APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED) or PENDING for a
 * requested-but-not-yet-submitted review. `isTeam` marks a requested team
 * (login is the team slug) rather than an individual.
 */
export interface PrReviewer {
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  isTeam?: boolean;
}

export interface PrCommit {
  oid: string;
  messageHeadline: string;
  messageBody?: string;
  authoredDate?: string;
  author: string;
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  /** Current head commit, used by correctness-sensitive callers to reject stale data. */
  headRefOid?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
  comments: PrComment[];
  commits: PrCommit[];
  /** Per-file line stats, sorted by churn (biggest first). */
  files: PrFile[];
  /** People/teams on the reviewer list, with their latest review state. */
  reviewers: PrReviewer[];
  /** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
  mergeable: string;
  /** CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state. */
  mergeStateStatus: string;
  /** The PR's webapp staging deploy (Vercel preview), when one exists. */
  staging: PrStaging | null;
}

/**
 * tella-butler maintains one "tella-vercel-preview" table comment per fusion PR
 * (add-pr-comment replaces it in place as the deploy progresses); the `tella`
 * row is the webapp preview — the URL a human opens to test the PR on staging.
 * PRs that don't touch the webapp never get the comment → null.
 */
function parseStaging(comments: Array<{ body?: string }> | undefined): PrStaging | null {
  for (const c of comments || []) {
    if (!c.body?.includes("add-pr-comment:tella-vercel-preview")) continue;
    const m = c.body.match(
      /^\|\s*tella\s*\|\s*([^|]+?)\s*\|\s*\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/m
    );
    if (m) return { status: m[1], url: m[2] };
  }
  return null;
}

/** Changed files, biggest churn first, so the panel leads with the meat. */
function buildFiles(files: Array<{ path?: string; additions?: number; deletions?: number }> | undefined): PrFile[] {
  return (files || [])
    .filter((f) => f.path)
    .map((f) => ({
      path: f.path as string,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
}

/**
 * Merge the provider's `latestReviews` (people who submitted a review) with
 * `reviewRequests` (requested but not yet reviewed → PENDING) into one list.
 * A submitted review wins over a pending request for the same person. Requested
 * teams have no `login`, only a `name`/`slug`, and are flagged `isTeam`.
 */
function buildReviewers(
  latest: Array<{ author?: { login?: string }; state?: string }> | undefined,
  requests: Array<{ login?: string; slug?: string; name?: string }> | undefined,
): PrReviewer[] {
  const byLogin = new Map<string, PrReviewer>();
  for (const r of latest || []) {
    const login = r.author?.login;
    const state = r.state as PrReviewer["state"] | undefined;
    // DISMISSED/PENDING sneak in via the API; only surface real outcomes here.
    if (!login || !state) continue;
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "COMMENTED") continue;
    const prev = byLogin.get(login);
    // Keep the strongest signal if someone appears twice (approve > changes > comment).
    const rank = (s: string) => (s === "CHANGES_REQUESTED" ? 3 : s === "APPROVED" ? 2 : 1);
    if (!prev || rank(state) > rank(prev.state)) byLogin.set(login, { login, state });
  }
  for (const r of requests || []) {
    const login = r.login || r.slug || r.name;
    if (!login) continue;
    if (byLogin.has(login)) continue;
    byLogin.set(login, { login, state: "PENDING", isTeam: !r.login });
  }
  // Requesters/blockers first (they gate the merge), approvers next.
  const rank = (s: string) =>
    s === "CHANGES_REQUESTED" ? 0 : s === "PENDING" ? 1 : s === "COMMENTED" ? 2 : 3;
  return [...byLogin.values()].sort((a, b) => rank(a.state) - rank(b.state));
}

const DEFAULT_REPO = () => defaultRepo().ghRepo;
const cache = new Map<string, { data: PrDetails | null; ts: number }>();
const TTL = 30_000;

// Caches are keyed by `<repo>\0<branch>` so the same branch name in different
// repos (multi-repo sessions share a branch name) never collides.
const cacheKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;

export interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
}

const diffCache = new Map<string, { data: PrDiffData | null; ts: number }>();

export async function getPrDiff(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDiffData | null> {
  const key = cacheKey(repo, branch);
  const hit = diffCache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let data: PrDiffData | null = null;
  try {
    const metaRaw = await $`gh pr view ${branch} --repo ${repo} --json number,headRefOid`
      .quiet()
      .text();
    const meta = JSON.parse(metaRaw);
    const patch = await $`gh pr diff ${meta.number} --repo ${repo}`.quiet().text();
    data = { number: meta.number, headRefOid: meta.headRefOid, patch };
  } catch {
    data = null;
  }

  diffCache.set(key, { data, ts: Date.now() });
  return data;
}

export interface PrCommentInput {
  body: string;
  path?: string;
  line?: number;
  startLine?: number;
  side?: "RIGHT" | "LEFT";
  startSide?: "RIGHT" | "LEFT";
}

/** Post a PR comment — inline review comment when path+line given, else a general comment. */
export async function postPrComment(
  branch: string,
  input: PrCommentInput,
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true; url?: string } | { error: string }> {
  const diff = await getPrDiff(branch, repo);
  if (!diff) return { error: "No PR found for this branch" };

  try {
    if (input.path && input.line) {
      const args = [
        "api", "-X", "POST", `repos/${repo}/pulls/${diff.number}/comments`,
        "-f", `body=${input.body}`,
        "-f", `commit_id=${diff.headRefOid}`,
        "-f", `path=${input.path}`,
        "-F", `line=${input.line}`,
        "-f", `side=${input.side || "RIGHT"}`,
      ];
      if (input.startLine && input.startLine !== input.line) {
        args.push("-F", `start_line=${input.startLine}`);
        args.push("-f", `start_side=${input.startSide || input.side || "RIGHT"}`);
      }
      const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh api failed").slice(0, 300) };
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      return { ok: true, url };
    }

    const proc = Bun.spawn(
      ["gh", "pr", "comment", String(diff.number), "--repo", repo, "--body", input.body],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || "gh pr comment failed").slice(0, 300) };
    return { ok: true, url: out.trim() || undefined };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

export interface PrReviewComment {
  path: string;
  /** Line in the file the comment anchors to (end line of a range). */
  line: number;
  side?: "RIGHT" | "LEFT";
  startLine?: number;
  startSide?: "RIGHT" | "LEFT";
  body: string;
}

export type PrReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface PrReviewInput {
  event: PrReviewEvent;
  body?: string;
  comments: PrReviewComment[];
}

/**
 * Submit a single GitHub review bundling all pending inline comments, GitHub's
 * native review flow (POST .../pulls/{n}/reviews). The whole batch posts at once
 * with one event (comment / approve / request changes) instead of each inline
 * comment landing as a loose standalone comment. Audited since approving or
 * requesting changes affects the PR's merge state.
 */
export async function submitPrReview(
  branch: string,
  input: PrReviewInput,
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true; url?: string } | { error: string }> {
  const diff = await getPrDiff(branch, repo);
  if (!diff) return { error: "No PR found for this branch" };
  if (!input.comments.length && !input.body?.trim()) {
    return { error: "Nothing to submit" };
  }

  const payload = {
    commit_id: diff.headRefOid,
    event: input.event,
    ...(input.body?.trim() ? { body: input.body.trim() } : {}),
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side || "RIGHT",
      ...(c.startLine && c.startLine !== c.line
        ? { start_line: c.startLine, start_side: c.startSide || c.side || "RIGHT" }
        : {}),
      body: c.body,
    })),
  };

  return audited(
    {
      context: "reviews",
      action: "pr_review",
      args: { branch, number: diff.number, event: input.event, comments: input.comments.length },
    },
    async () => {
      const proc = Bun.spawn(
        ["gh", "api", "-X", "POST", `repos/${repo}/pulls/${diff.number}/reviews`, "--input", "-"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
      );
      proc.stdin.write(JSON.stringify(payload));
      await proc.stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh api failed").slice(0, 300) } as const;
      const url = (() => {
        try {
          return JSON.parse(out).html_url as string;
        } catch {
          return undefined;
        }
      })();
      return { ok: true, url } as const;
    }
  );
}

export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * Merge a branch's PR via the gh CLI — human-triggered from the Reviews view
 * (Michael never merges on its own; this is a UI affordance for the operator).
 * Defaults to squash. Audited as `reviews/pr_merge` since it mutates the repo.
 */
export async function mergePr(
  branch: string,
  opts: { method?: MergeMethod; deleteBranch?: boolean } = {},
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true; url?: string } | { error: string }> {
  const pr = await getPrDetails(branch, repo);
  if (!pr) return { error: "No PR found for this branch" };
  if (pr.state !== "OPEN") return { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` };
  if (pr.isDraft) return { error: `PR #${pr.number} is a draft — mark it ready first` };

  const method = opts.method || "squash";
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";

  return audited(
    {
      context: "reviews",
      action: "pr_merge",
      args: { branch, number: pr.number, method, deleteBranch: !!opts.deleteBranch },
    },
    async () => {
      const args = ["pr", "merge", String(pr.number), "--repo", repo, flag];
      if (opts.deleteBranch) args.push("--delete-branch");
      const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
      const [, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) return { error: (err || "gh pr merge failed").slice(0, 300) } as const;
      // Drop cached PR/diff so the UI reflects the merge on the next poll.
      cache.delete(cacheKey(repo, branch));
      diffCache.delete(cacheKey(repo, branch));
      return { ok: true, url: pr.url } as const;
    }
  );
}

/**
 * Add and/or remove GitHub reviewers on the PR for `branch` (best-effort — the
 * caller ignores the result on failure). Mirrors the Backstage review-request
 * chip onto GitHub's own Reviewers list: setting a reviewer in the info panel
 * also `--add-reviewer`s them, re-assigning removes the old and adds the new,
 * and clearing removes them. `gh pr edit` takes the branch as the PR selector,
 * so no separate lookup is needed; a branch with no open PR just errors.
 */
export async function editPrReviewers(
  branch: string,
  opts: { add?: string | null; remove?: string | null },
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true } | { error: string }> {
  const args = ["pr", "edit", branch, "--repo", repo];
  if (opts.add) args.push("--add-reviewer", opts.add);
  if (opts.remove && opts.remove !== opts.add)
    args.push("--remove-reviewer", opts.remove);
  if (args.length === 4) return { ok: true }; // nothing to do
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || "gh pr edit failed").slice(0, 300) };
    cache.delete(cacheKey(repo, branch)); // reviewRequests changed
    return { ok: true };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

/**
 * Rewrite the PR description through a mutator over the current body — used by
 * the walkthrough mirror to splice its managed section in place. Reads the
 * live body first (never a cached one: humans edit descriptions) and writes
 * via --body-file so markdown/quotes/newlines survive shell-free.
 */
export async function updatePrBody(
  branch: string,
  mutate: (body: string) => string,
  repo: string = DEFAULT_REPO()
): Promise<{ ok: true; number: number; url: string } | { error: string }> {
  try {
    const view = Bun.spawn(
      ["gh", "pr", "view", branch, "--repo", repo, "--json", "body,number,url"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const [out, viewErr, viewCode] = await Promise.all([
      new Response(view.stdout).text(),
      new Response(view.stderr).text(),
      view.exited,
    ]);
    if (viewCode !== 0)
      return { error: (viewErr || "gh pr view failed").slice(0, 300) };
    const pr = JSON.parse(out) as { body: string; number: number; url: string };
    const next = mutate(pr.body || "");
    if (next === (pr.body || "")) return { ok: true, number: pr.number, url: pr.url };
    const tmp = `/tmp/opensession-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
    await Bun.write(tmp, next);
    try {
      const edit = Bun.spawn(
        ["gh", "pr", "edit", branch, "--repo", repo, "--body-file", tmp],
        { stdout: "pipe", stderr: "pipe" }
      );
      const [, editErr, editCode] = await Promise.all([
        new Response(edit.stdout).text(),
        new Response(edit.stderr).text(),
        edit.exited,
      ]);
      if (editCode !== 0)
        return { error: (editErr || "gh pr edit failed").slice(0, 300) };
    } finally {
      await Bun.file(tmp).unlink().catch(() => {});
    }
    cache.delete(cacheKey(repo, branch)); // body changed
    return { ok: true, number: pr.number, url: pr.url };
  } catch (e: any) {
    return { error: e.message || String(e) };
  }
}

// One in-flight `gh pr view` per branch — concurrent panels share the promise
// instead of stacking subprocesses.
const inflight = new Map<string, Promise<PrDetails | null>>();

/**
 * Stale-while-revalidate: a fresh cache entry answers directly; an EXPIRED one
 * still answers immediately (the status header shouldn't block ~1s on a GitHub
 * round-trip every 30s) while the refresh runs in the background and lands for
 * the next poll. Only a branch with no cache at all waits on gh.
 */
export async function getPrDetails(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDetails | null> {
  const key = cacheKey(repo, branch);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let refresh = inflight.get(key);
  if (!refresh) {
    refresh = fetchPrDetails(branch, repo)
      .then((data) => {
        cache.set(key, { data, ts: Date.now() });
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, refresh);
  }
  if (hit) return hit.data;
  return refresh;
}

/** Bypass the UI's stale-while-revalidate cache for action completion gates. */
export async function getPrDetailsFresh(
  branch: string,
  repo: string = DEFAULT_REPO()
): Promise<PrDetails | null> {
  const data = await fetchPrDetails(branch, repo);
  cache.set(cacheKey(repo, branch), { data, ts: Date.now() });
  return data;
}

/** True for "this branch/number has no PR" — a real answer, not a failure. */
function isNoPrError(msg: string): boolean {
  return /no pull requests found|Could not resolve/i.test(msg);
}

async function fetchPrDetails(
  branch: string,
  repo: string
): Promise<PrDetails | null> {
  let data: PrDetails | null = null;
  try {
    // Under load GitHub sporadically aborts the GraphQL response mid-stream
    // ("stream error: … CANCEL; received from peer") — that's transient, and
    // treating it as "no PR" broke PR actions (PR #4910). Retry transient
    // failures; a genuine "no pull requests found" stays a fast null.
    let raw = "";
    for (let attempt = 1; ; attempt++) {
      try {
        raw = await $`gh pr view ${branch} --repo ${repo} --json number,title,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,author,body,statusCheckRollup,mergeable,mergeStateStatus,comments,commits,files,latestReviews,reviewRequests`
          .quiet()
          .text();
        break;
      } catch (e: any) {
        const msg = String(e?.stderr || e?.message || e).slice(0, 300);
        if (isNoPrError(msg) || attempt >= 3) throw e;
        console.warn(`[pr-info] gh pr view ${branch} (${repo}) attempt ${attempt} failed, retrying: ${msg}`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
    const pr = JSON.parse(raw);
    data = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      reviewDecision: pr.reviewDecision || "",
      author: pr.author?.login || "",
      body: pr.body || "",
      checks: (pr.statusCheckRollup || []).map((c: any) => ({
        name: c.name || c.context || "check",
        status: c.status || (c.state ? "COMPLETED" : ""),
        conclusion: c.conclusion || c.state || "",
        url: c.detailsUrl || c.targetUrl || undefined,
        startedAt: c.startedAt || undefined,
        completedAt: c.completedAt || undefined,
        workflowName: c.workflowName || undefined,
      })),
      comments: (pr.comments || [])
        .filter((c: any) => String(c.body || "").trim())
        .map((c: any) => ({
          author: c.author?.login || c.author?.name || "",
          body: String(c.body || ""),
          url: c.url || undefined,
          createdAt: c.createdAt || undefined,
        })),
      commits: (pr.commits || []).map((commit: any) => ({
        oid: commit.oid || "",
        messageHeadline: commit.messageHeadline || "Commit",
        messageBody: commit.messageBody || undefined,
        authoredDate: commit.authoredDate || commit.committedDate || undefined,
        author:
          commit.authors?.[0]?.login ||
          commit.authors?.[0]?.name ||
          commit.author?.login ||
          commit.author?.name ||
          "Unknown",
      })),
      files: buildFiles(pr.files),
      reviewers: buildReviewers(pr.latestReviews, pr.reviewRequests),
      mergeable: pr.mergeable || "UNKNOWN",
      mergeStateStatus: pr.mergeStateStatus || "",
      staging: parseStaging(pr.comments),
    };
  } catch (e: any) {
    // No PR for this branch, or a gh failure — both fine to cache briefly. But
    // say which: the silent version hid a real failure as "no PR" (PR #4910).
    const msg = String(e?.stderr || e?.message || e).slice(0, 300);
    if (!isNoPrError(msg))
      console.warn(`[pr-info] gh pr view ${branch} (${repo}) failed: ${msg}`);
    data = null;
  }

  return data;
}
