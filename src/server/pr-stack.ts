/**
 * GitHub stacked pull requests (public preview, 2026-07-30).
 *
 * A stack is an ordered chain of PRs where each layer targets the one below it
 * and the bottom targets the trunk. GitHub models it as a first-class object
 * (`PullRequest.stackEntry.stack`), so membership is authoritative — it is NOT
 * inferred from `baseRefName` chains, and two PRs that happen to target each
 * other are not a stack until they are linked.
 *
 * Read path: GraphQL only. `gh pr view --json` has no `stack` field (gh 2.83),
 * so this module shells `gh api graphql`. Every read is best-effort: a repo or
 * GHES that predates the preview answers with an "unknown field" error, which
 * disables the query process-wide (see `stackApiUnavailable`) rather than
 * failing PR fetches that would otherwise succeed.
 *
 * Write path: the `github/gh-stack` CLI extension. `gh stack link` is the one
 * command that needs no local stack-tracking state, which suits us — sessions
 * already own their branches and worktrees. There are no stack mutations in
 * the GraphQL schema, so the extension is the only write surface.
 */
import { serviceGithubCredential, type GithubCredential } from "./github-auth";
import { ghRateLimited, noteGhRateLimited, isGhRateLimitMsg } from "./github-limit";
import { audited } from "./audit";

/** One PR in a stack, ordered from the trunk upward. */
export interface PrStackLayer {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  /** GitHub's position within the stack; 1 is the layer closest to the trunk. */
  position: number;
  /** True for the PR this stack was fetched for. */
  current?: boolean;
}

export interface PrStack {
  /** The stack number GitHub shows in its UI — also what `gh stack link` takes. */
  number: number;
  /** Branch the bottom layer targets (the trunk the stack sits on). */
  baseRefName: string;
  size: number;
  /** Position of the PR this stack was fetched for. */
  position: number;
  /** Every layer, bottom (trunk-most) first. */
  layers: PrStackLayer[];
}

const STACK_QUERY = `
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      stackEntry {
        position
        stack {
          number
          size
          baseRefName
          entries(first:50){
            nodes {
              position
              pullRequest { number title url state isDraft headRefName baseRefName }
            }
          }
        }
      }
    }
  }
}`;

// Set once the API answers "field doesn't exist" — a deployment without the
// preview must not pay a doomed GraphQL call on every PR fetch. Resets on
// restart, which is the same escape hatch pr-info uses for statusCheckRollup.
let stackApiUnavailable = false;

/** True when a stack read was refused as an unknown field rather than failing. */
export function stackApiDisabled(): boolean {
  return stackApiUnavailable;
}

function isUnknownFieldMsg(msg: string): boolean {
  return /doesn't exist on type|Field '(stack|stackEntry)'|Unknown field/i.test(msg);
}

function splitRepo(ghRepo: string): { owner: string; name: string } | null {
  const [owner, name] = ghRepo.split("/");
  return owner && name ? { owner, name } : null;
}

async function runGh(
  args: string[],
  credential: GithubCredential,
  cwd?: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["gh", ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...credential.env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

/**
 * The stack a PR belongs to, or null when it belongs to none (the common case
 * — most PRs are standalone). Never throws: a stack is decoration on top of
 * the PR, and losing it must not take the PR panel down with it.
 */
export async function getPrStack(
  ghRepo: string,
  prNumber: number,
  credential: GithubCredential = serviceGithubCredential,
): Promise<PrStack | null> {
  if (stackApiUnavailable) return null;
  // A known rate-limit window: skip the call entirely rather than spend the
  // retry budget of a request we already expect to be refused.
  if (ghRateLimited()) return null;
  const repo = splitRepo(ghRepo);
  if (!repo) return null;

  const { code, out, err } = await runGh(
    [
      "api",
      "graphql",
      "-f",
      `query=${STACK_QUERY}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      "-F",
      `number=${prNumber}`,
    ],
    credential,
  );
  if (code !== 0) {
    const msg = String(err || "gh api graphql failed").slice(0, 300);
    if (isUnknownFieldMsg(msg)) {
      stackApiUnavailable = true;
      console.warn(`[pr-stack] stack API unavailable — skipping stack reads until restart: ${msg.slice(0, 120)}`);
      return null;
    }
    if (isGhRateLimitMsg(msg)) noteGhRateLimited("pr-stack");
    console.warn(`[pr-stack] stack query for ${ghRepo}#${prNumber} failed: ${msg}`);
    return null;
  }

  try {
    return parseStackResponse(JSON.parse(out), prNumber);
  } catch (e: any) {
    console.warn(`[pr-stack] unparseable stack response for ${ghRepo}#${prNumber}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

/**
 * Shape a GraphQL stack response into a PrStack. Exported for tests — the live
 * query needs a repo with an actual stack on it, which no test can conjure.
 * Returns null for every "no stack here" case, including a partial response
 * that carries GraphQL errors instead of data.
 */
export function parseStackResponse(parsed: any, prNumber: number): PrStack | null {
  // A partial GraphQL response still carries `data`; on some gh versions an
  // unknown field surfaces here rather than as a non-zero exit.
  const errors = parsed?.errors;
  if (Array.isArray(errors) && errors.length) {
    const msg = String(errors[0]?.message || "").slice(0, 300);
    if (isUnknownFieldMsg(msg)) {
      stackApiUnavailable = true;
      console.warn(`[pr-stack] stack API unavailable — skipping stack reads until restart: ${msg.slice(0, 120)}`);
    }
    return null;
  }
  const entry = parsed?.data?.repository?.pullRequest?.stackEntry;
  const stack = entry?.stack;
  if (!stack || typeof stack.number !== "number") return null;

  const layers: PrStackLayer[] = (stack.entries?.nodes || [])
    .filter((node: any) => node?.pullRequest?.number != null)
    .map((node: any) => ({
      number: node.pullRequest.number,
      title: node.pullRequest.title || `PR #${node.pullRequest.number}`,
      url: node.pullRequest.url || "",
      state: node.pullRequest.state || "OPEN",
      isDraft: !!node.pullRequest.isDraft,
      headRefName: node.pullRequest.headRefName || "",
      baseRefName: node.pullRequest.baseRefName || "",
      position: typeof node.position === "number" ? node.position : 0,
      current: node.pullRequest.number === prNumber || undefined,
    }))
    .sort((a: PrStackLayer, b: PrStackLayer) => a.position - b.position);
  if (!layers.length) return null;

  return {
    number: stack.number,
    baseRefName: stack.baseRefName || "",
    size: typeof stack.size === "number" ? stack.size : layers.length,
    // A stack we can see but whose entry position is missing would read as
    // position 0 — below every layer — which silently disables the merge
    // guard. Fall back to where this PR actually sits.
    position:
      typeof entry.position === "number"
        ? entry.position
        : layers.find((l) => l.number === prNumber)?.position || 0,
    layers,
  };
}

/**
 * Layers below `stack.position` that are still open. Merging a layer while one
 * of these is unmerged would land its commits into the trunk out of order, so
 * the merge routes refuse it (GitHub's own stack merge is the way to take
 * several layers at once).
 */
export function unmergedLayersBelow(stack: PrStack): PrStackLayer[] {
  return stack.layers.filter(
    (layer) => layer.position < stack.position && layer.state === "OPEN",
  );
}

/**
 * Link PRs into a stack on GitHub, bottom first. Takes PR *URLs* rather than
 * branch names on purpose: `gh stack link` pushes branch arguments and opens
 * PRs for any that lack one, which is far too much to do behind a UI button —
 * URLs only ever link PRs that already exist, and they name the repo
 * unambiguously (the command has no `--repo` flag and reads its remote from
 * `cwd`).
 */
export async function linkPrStack(
  prUrls: string[],
  cwd: string,
  credential: GithubCredential = serviceGithubCredential,
): Promise<{ ok: true } | { error: string }> {
  if (prUrls.length < 2)
    return { error: "A stack needs at least two pull requests" };

  return audited(
    {
      context: "reviews",
      action: "pr_stack_link",
      args: { prUrls, cwd, credential: credential.principal },
    },
    async () => {
      const { code, err } = await runGh(["stack", "link", ...prUrls], credential, cwd);
      if (code !== 0) {
        const msg = String(err || "gh stack link failed").slice(0, 300);
        if (/unknown command|extension|not installed/i.test(msg))
          return {
            error:
              "The gh-stack extension isn't installed on this server (`gh extension install github/gh-stack`).",
          } as const;
        return { error: msg } as const;
      }
      return { ok: true } as const;
    },
  );
}
