/**
 * PR Tinder — snappy one-at-a-time triage of tella-fusion's open PRs.
 *
 * The deck is every open PR with the rich fields the card needs (body, labels,
 * diffstat) — a separate gh query from the batched open-PRs cache, which stays
 * lean for the sidebar. "Kept" PRs are remembered per user for 14 days so a
 * resumed session doesn't re-deal them (the CLI's ~/.prtinder/state.json,
 * server-side so it follows you across devices).
 */
import { $ } from "bun";
import { readFileSync, existsSync } from "fs";
import { audited } from "./audit";
import { writeJsonAtomic } from "./shared/atomic-write";

const REPO = "tellahq/tella-fusion";
const HOME = process.env.HOME || "/home/ubuntu";
const STATE_PATH = `${HOME}/.backstage-prtinder.json`;
const SEEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface TinderPr {
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string; color: string }>;
  body: string;
  reviewDecision: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

// ── deck (open PRs with card fields) ────────────────────────────────────────

// statusCheckRollup at this scale 502s GitHub's GraphQL (the CLI hit the same
// wall) — CI status stays one click away on GitHub.
const PR_FIELDS =
  "number,title,url,author,isDraft,createdAt,updatedAt,labels,body,reviewDecision,additions,deletions,changedFiles";

let prCache: { data: TinderPr[]; ts: number } | null = null;
const PR_TTL = 60_000;

export async function listTinderPrs(): Promise<TinderPr[]> {
  if (prCache && Date.now() - prCache.ts < PR_TTL) return prCache.data;
  const raw =
    await $`gh pr list --repo ${REPO} --state open --limit 300 --json ${PR_FIELDS}`
      .quiet()
      .text();
  const data: TinderPr[] = JSON.parse(raw).map((pr: any) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || "unknown",
    isDraft: !!pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    labels: (pr.labels || []).map((l: any) => ({
      name: l.name,
      color: l.color || "",
    })),
    body: pr.body || "",
    reviewDecision: pr.reviewDecision || "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
  }));
  prCache = { data, ts: Date.now() };
  return data;
}

let labelCache: { data: Array<{ name: string; color: string }>; ts: number } | null =
  null;
const LABEL_TTL = 10 * 60_000;

export async function listTinderLabels(): Promise<Array<{ name: string; color: string }>> {
  if (labelCache && Date.now() - labelCache.ts < LABEL_TTL) return labelCache.data;
  try {
    const raw = await $`gh label list --repo ${REPO} --limit 200 --json name,color`
      .quiet()
      .text();
    const data = (JSON.parse(raw) as Array<{ name: string; color: string }>).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    labelCache = { data, ts: Date.now() };
  } catch {
    labelCache = { data: [], ts: Date.now() };
  }
  return labelCache.data;
}

// ── per-user "kept" state ───────────────────────────────────────────────────

/** user (lowercased) → PR number → ISO timestamp it was kept. */
type SeenState = Record<string, Record<string, string>>;

function loadSeen(): SeenState {
  let state: SeenState = {};
  try {
    if (existsSync(STATE_PATH))
      state = JSON.parse(readFileSync(STATE_PATH, "utf-8")).seen || {};
  } catch {
    state = {};
  }
  // Prune expired entries so a kept PR resurfaces after the TTL.
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const user of Object.keys(state)) {
    for (const [num, ts] of Object.entries(state[user])) {
      if (new Date(ts).getTime() <= cutoff) delete state[user][num];
    }
  }
  return state;
}

export function getSeenPrs(user: string): number[] {
  const seen = loadSeen()[user.toLowerCase()] || {};
  return Object.keys(seen).map(Number);
}

export function markPrSeen(user: string, number: number): void {
  const state = loadSeen();
  const key = user.toLowerCase();
  state[key] = state[key] || {};
  state[key][String(number)] = new Date().toISOString();
  writeJsonAtomic(STATE_PATH, { seen: state });
}

/** Undo for a keep — the PR goes straight back into the user's deck. */
export function markPrUnseen(user: string, number: number): void {
  const state = loadSeen();
  delete state[user.toLowerCase()]?.[String(number)];
  writeJsonAtomic(STATE_PATH, { seen: state });
}

// ── actions (gh mutations, audited) ─────────────────────────────────────────

type ActionResult = { ok: true } | { error: string };

async function ghRun(args: string[]): Promise<ActionResult> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) return { error: (err || "gh failed").slice(0, 300) };
  return { ok: true };
}

/** Close a PR, posting the reason as a comment first when one is given. */
export async function closeTinderPr(
  number: number,
  reason?: string,
): Promise<ActionResult> {
  return audited(
    { context: "pr-tinder", action: "pr_close", args: { number, reason } },
    async () => {
      if (reason?.trim()) {
        const c = await ghRun([
          "pr", "comment", String(number), "--repo", REPO, "--body", reason.trim(),
        ]);
        if ("error" in c) return c;
      }
      const r = await ghRun(["pr", "close", String(number), "--repo", REPO]);
      if ("ok" in r) prCache = null;
      return r;
    },
  );
}

/** Undo for a close. */
export async function reopenTinderPr(number: number): Promise<ActionResult> {
  return audited(
    { context: "pr-tinder", action: "pr_reopen", args: { number } },
    async () => {
      const r = await ghRun(["pr", "reopen", String(number), "--repo", REPO]);
      if ("ok" in r) prCache = null;
      return r;
    },
  );
}

/**
 * Post a comment, returning the created comment's id so an accidental comment
 * can be undone (deleted) from the deck's undo stack.
 */
export async function commentTinderPr(
  number: number,
  body: string,
): Promise<{ ok: true; commentId?: number } | { error: string }> {
  if (!body.trim()) return { error: "Empty comment" };
  return audited(
    { context: "pr-tinder", action: "pr_comment", args: { number } },
    async () => {
      const proc = Bun.spawn(
        ["gh", "pr", "comment", String(number), "--repo", REPO, "--body", body.trim()],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0)
        return { error: (err || "gh pr comment failed").slice(0, 300) } as const;
      // gh prints the comment URL (…#issuecomment-<id>) on success.
      const id = out.match(/#issuecomment-(\d+)/)?.[1];
      return { ok: true, commentId: id ? Number(id) : undefined } as const;
    },
  );
}

/** Undo for a comment — deletes it (id from commentTinderPr's response). */
export async function deleteTinderComment(
  commentId: number,
): Promise<ActionResult> {
  return audited(
    { context: "pr-tinder", action: "pr_comment_delete", args: { commentId } },
    () =>
      ghRun([
        "api", "-X", "DELETE", `repos/${REPO}/issues/comments/${commentId}`,
      ]),
  );
}

export async function labelTinderPr(
  number: number,
  opts: { add?: string; remove?: string },
): Promise<ActionResult> {
  const flagged: string[] = [];
  if (opts.add) flagged.push("--add-label", opts.add);
  if (opts.remove) flagged.push("--remove-label", opts.remove);
  if (!flagged.length) return { error: "Nothing to change" };
  return audited(
    {
      context: "pr-tinder",
      action: "pr_label",
      args: { number, add: opts.add, remove: opts.remove },
    },
    async () => {
      const r = await ghRun(["pr", "edit", String(number), "--repo", REPO, ...flagged]);
      if ("ok" in r) prCache = null;
      return r;
    },
  );
}
