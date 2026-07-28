/**
 * Pre-flight review: a session about to open a PR asks for the same review the
 * PR would get — run NOW, locally, before `gh pr create`. Cuts review rounds by
 * catching findings while the author still has full context: no webhook lag, no
 * per-PR review worktree, no GitHub round-trip, findings land straight back in
 * the authoring session.
 *
 * Same bar as the PR review: same base prompt (resolveReviewConfig — the live
 * `github-pr-review` automation JSON), same output contract, and the same
 * model-inversion invariant — the reviewer NEVER shares the authoring session's
 * model family (preflightReviewerFor). The reviewer runs ask-mode in the
 * authoring session's own worktree with a fresh context and no MCP servers.
 *
 * This complements the PR review, it does not replace it: the GitHub review
 * still runs when the PR opens (it's the accountable, human-visible gate and
 * feeds the feedback-learning loop) — it should just converge in ~1 round.
 */
import { runAgent } from "../../server/agent-runner";
import { updateSessionFile } from "../../server/session-cache";
import { audit } from "../../server/audit";
import { repoForPath } from "../../server/worktree";
import { modelLabel, providerFor } from "../../server/models";
import { engineSessionPatch } from "../../server/sessions";
import { resolveReviewConfig } from "./webhook";
import { preflightReviewerFor } from "./model-inversion";
import { buildPreflightReviewPrompt, DEFAULT_REVIEW_PROMPT } from "./prompts";
import { learnedRulesSection } from "./learned-rules";
import { parseReviewOutput, type Finding } from "./review";
import { loadReviewOptions, pathIgnored } from "./review-options";
import { uiSessionUrl } from "./run";
import type { BackstageSessionFile } from "../../server/types";

export interface PreflightOpts {
  /** The authoring session asking for the review. */
  sessionId: string;
  /** Its worktree — the reviewer reads this exact tree. */
  cwd: string;
  branch: string;
  /** The authoring session's model — decides the (inverted) reviewer family. */
  sessionModel?: string;
  /** Its workspace, so the reviewer session files under the same folder. */
  projectId?: string | null;
  sessionTitle?: string;
  /** Optional focus from the authoring session ("pay attention to X"). */
  focus?: string;
}

export interface PreflightResult {
  /** Markdown the calling session can act on directly. */
  markdown: string;
  findings: number;
  blocking: number;
  verdict?: string;
  confidence?: number;
  error?: string;
  model?: string;
  reviewSessionId: string;
}

/** One pre-flight at a time per session — a second call reports the first. */
const inFlight = new Map<string, Promise<PreflightResult>>();

export function runPreflightReview(opts: PreflightOpts): Promise<PreflightResult> {
  const running = inFlight.get(opts.sessionId);
  if (running) return running;
  const p = runPreflightReviewInner(opts).finally(() => {
    inFlight.delete(opts.sessionId);
  });
  inFlight.set(opts.sessionId, p);
  return p;
}

async function runPreflightReviewInner(opts: PreflightOpts): Promise<PreflightResult> {
  const repo = repoForPath(opts.cwd);
  const bksId = `${opts.sessionId}-preflight`;
  const startedAt = new Date().toISOString();

  const { config } = resolveReviewConfig();
  const base = (config.prompt || "").trim() || DEFAULT_REVIEW_PROMPT;
  const reviewer = preflightReviewerFor(opts.sessionModel);
  // Inversion kill switch off → configured review model (same as PR reviews).
  const model = reviewer.model || config.model;
  const reviewOpts = loadReviewOptions(opts.cwd);

  const prompt = buildPreflightReviewPrompt(base, {
    ghRepo: repo.ghRepo,
    branch: opts.branch,
    baseBranch: repo.defaultBranch,
    authorFamily: reviewer.authorFamily,
    ignoreGlobs: reviewOpts.ignoreGlobs,
    focus: opts.focus,
    learnedRules: learnedRulesSection(repo.ghRepo),
  });

  // Visible session file so the run shows up in the UI, grouped under the
  // authoring session's workspace. Fresh every time (resume: none) — a
  // pre-flight is self-contained like a PR review round.
  let effectiveModel = model;
  const persist = (engineSessionId: string) =>
    updateSessionFile(bksId, (data) => {
      const existing: Partial<BackstageSessionFile> = data;
      return {
        id: bksId,
        claudeSessionId: "",
        createdAt: startedAt,
        ...existing,
        ...(engineSessionId
          ? engineSessionPatch(providerFor(effectiveModel), engineSessionId)
          : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        branch: opts.branch,
        worktreeDir: opts.cwd,
        createdBy: "GitHub (automation)",
        lastActivity: new Date().toISOString(),
        title: `Pre-flight review · ${opts.sessionTitle || opts.branch}`.slice(0, 100),
        mode: "ask" as const,
        automation: "github-pr-review",
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      };
    }).catch((e) => {
      console.error(`[preflight] failed to persist session ${bksId}:`, e);
    });

  let text = "";
  let errorMsg = "";
  try {
    for await (const event of runAgent({
      prompt,
      cwd: opts.cwd,
      mode: "ask",
      model,
      // Fast + least-privilege: the reviewer needs the checkout, nothing else.
      mcpServers: [],
      journal: { bksSessionId: bksId, kind: "github-preflight" },
    })) {
      if (event.type === "init") {
        if (event.model) effectiveModel = event.model;
        persist(event.sessionId || "");
      } else if (event.type === "text_chunk") {
        text += event.text;
      } else if (event.type === "done") {
        if (event.model) effectiveModel = event.model;
        persist(event.sessionId || "");
      } else if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }
  } catch (e: any) {
    errorMsg = e.message || String(e);
  }

  const parsed = parseReviewOutput(text);
  const all = parsed?.findings || [];
  const findings = all.filter((f) => !pathIgnored(f.path, reviewOpts));
  const blocking = findings.filter((f) => {
    const s = (f.severity || "").toLowerCase();
    return s === "p0" || s === "p1" || s === "high";
  }).length;

  audit({
    msg: "review_preflight",
    bks_session_id: opts.sessionId,
    repo: repo.ghRepo,
    branch: opts.branch,
    review_model: effectiveModel,
    author_model: opts.sessionModel,
    verdict: parsed?.verdict,
    findings: findings.length,
    blocking,
    ...(errorMsg ? { error: errorMsg } : {}),
  });

  return {
    markdown: formatResult(parsed, findings, text, errorMsg, effectiveModel, bksId),
    findings: findings.length,
    blocking,
    verdict: parsed?.verdict,
    confidence: parsed?.confidence,
    error: errorMsg || undefined,
    model: effectiveModel,
    reviewSessionId: bksId,
  };
}

type Parsed = ReturnType<typeof parseReviewOutput>;

function formatResult(
  parsed: Parsed,
  findings: Finding[],
  rawText: string,
  errorMsg: string,
  model?: string,
  bksId?: string,
): string {
  if (errorMsg && !parsed) return `⚠️ Pre-flight review errored: ${errorMsg}`;
  const lines: string[] = [];
  const verdict = parsed?.verdict ? `**${parsed.verdict.replace(/_/g, " ")}**` : "";
  const confidence = typeof parsed?.confidence === "number" ? `confidence ${parsed.confidence}/5` : "";
  const head = [verdict, confidence].filter(Boolean).join(" · ");
  lines.push(`🛫 Pre-flight review${head ? ` — ${head}` : ""}${model ? ` (${modelLabel(model)})` : ""}`);
  const summary = parsed?.summary_markdown?.trim();
  if (summary) lines.push("", summary);
  if (!parsed) {
    // Couldn't parse the contract — surface the raw text so the review isn't lost.
    const trimmed = (rawText || "").trim();
    lines.push("", trimmed ? trimmed.slice(0, 6000) : "⚠️ The review produced no output.");
  }
  if (findings?.length) {
    lines.push("", `Findings (${findings.length}):`);
    for (const f of findings.slice(0, 25)) {
      const sev = (f.severity || "P?").toUpperCase();
      lines.push("", `- **${sev}** \`${f.path}:${f.line}\`${f.title ? ` — ${f.title}` : ""}`);
      if (f.body?.trim()) lines.push(indent(f.body.trim().slice(0, 2000)));
      if (f.suggestion?.trim()) lines.push(indent("Suggested fix:\n```\n" + f.suggestion.replace(/\n+$/, "") + "\n```"));
    }
    if (findings.length > 25) lines.push("", `…and ${findings.length - 25} more.`);
  } else if (parsed) {
    lines.push("", "No findings — clean to open the PR.");
  }
  if (bksId) lines.push("", `<sub>[open review session](${uiSessionUrl(bksId)})</sub>`);
  return lines.join("\n");
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
