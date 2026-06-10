/**
 * PR details for a session branch via the gh CLI, Devin-style "PR" tab.
 * Cached per branch for 30s to keep the UI snappy without hammering GitHub.
 */
import { $ } from "bun";

export interface PrCheck {
  name: string;
  status: string; // COMPLETED, IN_PROGRESS, QUEUED…
  conclusion: string; // SUCCESS, FAILURE, NEUTRAL, ""…
  url?: string;
}

export interface PrDetails {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  body: string;
  checks: PrCheck[];
}

const REPO = "tellahq/tella-fusion";
const cache = new Map<string, { data: PrDetails | null; ts: number }>();
const TTL = 30_000;

export async function getPrDetails(branch: string): Promise<PrDetails | null> {
  const hit = cache.get(branch);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let data: PrDetails | null = null;
  try {
    const raw = await $`gh pr view ${branch} --repo ${REPO} --json number,title,url,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,author,body,statusCheckRollup`
      .quiet()
      .text();
    const pr = JSON.parse(raw);
    data = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      baseRefName: pr.baseRefName,
      headRefName: pr.headRefName,
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
      })),
    };
  } catch {
    data = null; // no PR for this branch (or gh failure) — both fine to cache briefly
  }

  cache.set(branch, { data, ts: Date.now() });
  return data;
}
