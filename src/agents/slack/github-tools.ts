/**
 * michael-github — an in-process MCP server that lets Michael trigger the GitHub
 * PR behaviors (the same review / auto-fix / simplify / adversarial actions the PR
 * labels fire) from Slack. So "review PR 4296", "auto-fix PR 4296", "adversarial
 * review PR 4296" work conversationally.
 *
 * Created per interactive Slack message in handlers.ts and added to the Claude
 * run's mcpServers (in-process SDK MCP, like michael-admin — Claude path only).
 * Each tool kicks the behavior off fire-and-forget (it posts back on the PR) and
 * returns immediately. Commits made by fix/simplify/adversarial are attributed to
 * the Slack requester (gitIdentityFor resolves Slack ids).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getPrDetails, getPrDiff } from "../../server/pr-info";
import { runReview, type PrRef } from "../github/review";
import { runAutoFix } from "../github/autofix";
import { runSimplify } from "../github/simplify";
import { runAdversarial } from "../github/adversarial";
import { resolveReviewConfig } from "../github/webhook";

export interface GithubToolContext {
  /** Slack user id of the requester — used for commit attribution and as a label-applier. */
  requestedBy: string;
}

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** Extract a PR number from "4296", "#4296", "pr 4296", or a GitHub PR URL. */
function parsePrNumber(input: number | string): number | null {
  if (typeof input === "number") return Number.isFinite(input) ? Math.trunc(input) : null;
  const s = String(input);
  const m = s.match(/\/pull\/(\d+)/) || s.match(/#?(\d+)\s*$/) || s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function resolveRef(n: number): Promise<{ ref: PrRef; url: string; draft: boolean } | null> {
  const details = await getPrDetails(String(n));
  if (!details) return null;
  const diff = await getPrDiff(details.headRefName);
  return {
    ref: { number: n, headRef: details.headRefName, headSha: diff?.headRefOid || "", title: details.title },
    url: details.url,
    draft: details.isDraft,
  };
}

const prArg = {
  pr: z
    .union([z.number(), z.string()])
    .describe("The PR number on tellahq/tella-fusion (a number, '#4296', or a PR URL)."),
};

export function createGithubMcpServer(ctx: GithubToolContext) {
  const tools = [
    tool(
      "review_pr",
      "Run Michael's automated code review on a tella-fusion PR and post it on the PR: a single pinned summary comment (verdict + confidence) plus inline findings with severity. Use when asked to 'review PR <n>'. Read-only — makes no code changes.",
      prArg,
      async ({ pr }: { pr: number | string }) => {
        const n = parsePrNumber(pr);
        if (!n) return text(`Couldn't read a PR number from "${pr}".`);
        const r = await resolveRef(n);
        if (!r) return text(`PR #${n} not found on tellahq/tella-fusion.`);
        // force=true: the human explicitly asked, so review even an already-reviewed SHA.
        void runReview(r.ref, resolveReviewConfig().config, undefined, true).catch((e) =>
          console.error("[michael-github] review_pr failed:", e),
        );
        return text(`On it — reviewing PR #${n} (“${r.ref.title}”). I'll post the review on the PR: ${r.url}`);
      },
    ),
    tool(
      "auto_fix_pr",
      "Trigger Michael's auto-fix on a tella-fusion PR: address the review findings and any failing CI, push fixes to the PR branch, and loop until CI is green (bounded, never merges). Use when asked to 'auto-fix PR <n>'. Commits are attributed to you.",
      prArg,
      async ({ pr }: { pr: number | string }) => {
        const n = parsePrNumber(pr);
        if (!n) return text(`Couldn't read a PR number from "${pr}".`);
        const r = await resolveRef(n);
        if (!r) return text(`PR #${n} not found on tellahq/tella-fusion.`);
        void runAutoFix(r.ref, ctx.requestedBy).catch((e) =>
          console.error("[michael-github] auto_fix_pr failed:", e),
        );
        return text(`Starting auto-fix on PR #${n} (“${r.ref.title}”). I'll push fixes and post progress on the PR: ${r.url}`);
      },
    ),
    tool(
      "simplify_pr",
      "Run Michael's /simplify pass on a tella-fusion PR (quality cleanup — reuse, simplification, efficiency), push it, then re-review. Use when asked to 'simplify PR <n>'. Commits are attributed to you.",
      prArg,
      async ({ pr }: { pr: number | string }) => {
        const n = parsePrNumber(pr);
        if (!n) return text(`Couldn't read a PR number from "${pr}".`);
        const r = await resolveRef(n);
        if (!r) return text(`PR #${n} not found on tellahq/tella-fusion.`);
        void runSimplify(r.ref, ctx.requestedBy).catch((e) =>
          console.error("[michael-github] simplify_pr failed:", e),
        );
        return text(`Starting a simplify pass on PR #${n} (“${r.ref.title}”). I'll push cleanups and post on the PR: ${r.url}`);
      },
    ),
    tool(
      "adversarial_review_pr",
      "Run Michael's adversarial code review on a tella-fusion PR (two independent hostile review passes, adjudicated), implement the accepted findings, push, and post a summary. Deeper than a normal review. Use when asked to 'adversarial review PR <n>' or for a rigorous/second-opinion review. Commits are attributed to you.",
      prArg,
      async ({ pr }: { pr: number | string }) => {
        const n = parsePrNumber(pr);
        if (!n) return text(`Couldn't read a PR number from "${pr}".`);
        const r = await resolveRef(n);
        if (!r) return text(`PR #${n} not found on tellahq/tella-fusion.`);
        void runAdversarial(r.ref, ctx.requestedBy).catch((e) =>
          console.error("[michael-github] adversarial_review_pr failed:", e),
        );
        return text(`Starting an adversarial review of PR #${n} (“${r.ref.title}”). I'll implement what's worth fixing, push, and post a summary: ${r.url}`);
      },
    ),
  ];

  return createSdkMcpServer({ name: "michael-github", version: "1.0.0", tools });
}
