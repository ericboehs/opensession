/**
 * Behavior 1: PR review. Runs an ask-mode agent that reads the diff and emits
 * structured findings. The module posts a fresh summary comment per review (the
 * previous one collapses under an "Outdated review" <details>) plus a formal GitHub
 * review carrying inline comments (GitHub auto-outdates stale ones across commits).
 * Deduped on head SHA so the same commit isn't reviewed twice.
 */
import { getPrDetails, getPrDiff, type PrDetails } from "../../server/pr-info";
import { claimLock, releaseLock, getOrInitPrState, writePrState } from "./state";
import { runGithubAgent, sessionUrl } from "./run";
import { buildReviewPrompt, DEFAULT_REVIEW_PROMPT } from "./prompts";
import {
  postIssueComment,
  editIssueComment,
  supersedeReviewComment,
  findActiveReviewComment,
  submitReview,
  REVIEW_MARKER,
  type ReviewInlineComment,
} from "./github-rest";

const HOME = process.env.HOME || "/home/ubuntu";
const TELLA_FUSION = `${HOME}/projects/tella-fusion`;

export interface PrRef {
  number: number;
  headRef: string;
  headSha: string;
  title: string;
}

export interface ReviewConfig {
  prompt: string;
  model?: string;
}

interface Finding {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: string;
  title?: string;
  body: string;
  suggestion?: string;
}

interface ReviewOutput {
  verdict?: string;
  confidence?: number;
  summary_markdown?: string;
  findings?: Finding[];
}

// P0/P1 are blocking-ish (red), P2 should-fix (orange), P3 minor (white).
// Legacy high/medium/low kept as aliases in case a prompt variant emits them.
const SEV_EMOJI: Record<string, string> = {
  p0: "🔴", p1: "🔴", p2: "🟠", p3: "⚪",
  high: "🔴", medium: "🟠", low: "⚪",
};

export async function runReview(
  pr: PrRef,
  config: ReviewConfig,
  onSessionCreated?: (bksId: string) => void,
  force = false,
  steer?: string,
): Promise<void> {
  if (!claimLock("review", pr.number)) {
    console.log(`[github] review already running for PR #${pr.number}, skipping`);
    return;
  }
  try {
    const state = getOrInitPrState(pr.number, pr.headRef);
    // `force` (manual Slack trigger) reviews even an already-reviewed SHA.
    if (!force && pr.headSha && state.reviewedShas.includes(pr.headSha)) {
      console.log(`[github] PR #${pr.number} @ ${pr.headSha.slice(0, 7)} already reviewed`);
      return;
    }
    // Concurrent deliveries are coalesced by the in-process "review" lock above;
    // the SHA is recorded only AFTER a successful run (below) so a transient
    // failure can be retried rather than permanently suppressed.
    const isUpdate = state.reviewedShas.length > 0;
    state.activeRun = { kind: "review", requestedBy: "", startedAt: new Date().toISOString(), steer };

    // Post a fresh "reviewing…" comment immediately (progress ASAP), then collapse
    // the previous review under an "Outdated review" <details>. Each review is its
    // own comment; postReview edits this placeholder with the result.
    const prevId = state.summaryCommentId ?? (await findActiveReviewComment(pr.number)) ?? undefined;
    const shortSha0 = (pr.headSha || "").slice(0, 7);
    const placeholderId = await postIssueComment(
      pr.number,
      `${REVIEW_MARKER}\n### 🤖 Michael review\n\n🔄 Reviewing${shortSha0 ? ` \`${shortSha0}\`` : ""}… · [📺 open session](${sessionUrl(pr.number, "review")})`,
    );
    if (placeholderId) {
      state.summaryCommentId = placeholderId;
      writePrState(state);
      if (prevId && prevId !== placeholderId) await supersedeReviewComment(prevId).catch(() => {});
    }
    // If the placeholder failed, summaryCommentId keeps prevId and postReview edits it.

    const details = await getPrDetails(pr.headRef);
    if (!details) {
      console.warn(`[github] no PR details for ${pr.headRef}; skipping review`);
      return;
    }

    const base = (config.prompt || "").trim() || DEFAULT_REVIEW_PROMPT;
    const prompt = buildReviewPrompt(base, details, isUpdate, steer);

    console.log(`[github] Reviewing PR #${pr.number} @ ${pr.headSha.slice(0, 7)} (${isUpdate ? "update" : "initial"})`);
    const result = await runGithubAgent({
      prNumber: pr.number,
      kind: "review",
      prompt,
      cwd: TELLA_FUSION,
      mode: "ask",
      model: config.model,
      branch: pr.headRef,
      title: `Review · PR #${pr.number} ${details.title}`.slice(0, 100),
      resume: isUpdate,
      onSessionCreated,
    });

    const parsed = parseReviewOutput(result.text);
    await postReview(pr, details, parsed, result.text, result.error);

    // Record the SHA as reviewed only on a successful run, so a transient failure
    // (model error/timeout) leaves it eligible for retry on the next delivery.
    if (!result.error && pr.headSha) {
      const s = getOrInitPrState(pr.number, pr.headRef);
      if (!s.reviewedShas.includes(pr.headSha)) s.reviewedShas.push(pr.headSha);
      s.lastReviewedSha = pr.headSha;
      writePrState(s);
    }
  } catch (e) {
    console.error(`[github] review failed for PR #${pr.number}:`, e);
  } finally {
    // Clear the recovery flag on completion; a killed process leaves it set so the
    // github agent re-runs the review on startup.
    const s = getOrInitPrState(pr.number, pr.headRef);
    if (s.activeRun?.kind === "review") {
      s.activeRun = undefined;
      writePrState(s);
    }
    releaseLock("review", pr.number);
  }
}

/** Render one finding as an inline comment: severity badge + title, body, optional suggestion block. */
function composeInlineBody(f: Finding): string {
  const sev = (f.severity || "").toUpperCase();
  const emoji = SEV_EMOJI[(f.severity || "").toLowerCase()] || "";
  const head = [emoji, sev && `**${sev}**`, f.title && `— ${f.title}`].filter(Boolean).join(" ").trim();
  let out = [head, f.body?.trim()].filter(Boolean).join("\n\n");
  if (f.suggestion?.trim()) {
    out += `\n\n\`\`\`suggestion\n${f.suggestion.replace(/\n+$/, "")}\n\`\`\``;
  }
  return out.trim();
}

async function postReview(
  pr: PrRef,
  details: PrDetails,
  parsed: ReviewOutput | null,
  rawText: string,
  runError?: string,
): Promise<void> {
  const state = getOrInitPrState(pr.number, pr.headRef);
  const shortSha = (pr.headSha || "").slice(0, 7);

  // Summary comment (single, edited in place).
  const summaryBody = parsed?.summary_markdown?.trim() || fallbackSummary(rawText, runError);
  const verdict = parsed?.verdict ? ` · **${parsed.verdict.replace(/_/g, " ")}**` : "";
  const confidence =
    typeof parsed?.confidence === "number" ? ` · confidence ${parsed.confidence}/5` : "";
  const findingCount = parsed?.findings?.length || 0;
  // Next-steps footer pointing at the action labels.
  const tip = findingCount
    ? "> 💡 Labels: **`michael-auto-fix`** — I fix these and push until CI passes · **`michael-adversarial`** — deeper two-pass review · **`michael-simplify`** — quality cleanup pass."
    : "> 💡 Labels: **`michael-adversarial`** — deeper two-pass review · **`michael-simplify`** — quality cleanup pass · **`michael-auto-fix`** — fix anything outstanding and push until CI passes.";
  const composed = [
    REVIEW_MARKER,
    `### 🤖 Michael review${verdict}${confidence}`,
    "",
    summaryBody,
    "",
    findingCount ? `_${findingCount} inline comment${findingCount === 1 ? "" : "s"} below._` : "",
    tip,
    `<sub>Reviewed \`${shortSha}\` · earlier reviews collapse above · [open session](${sessionUrl(pr.number, "review")})</sub>`,
  ]
    .filter((l) => l !== "")
    .join("\n");

  // Edit the placeholder posted at the start; fall back to a new comment if it's gone.
  let id: number | null = state.summaryCommentId ?? null;
  if (id) {
    const ok = await editIssueComment(id, composed);
    if (!ok) id = await postIssueComment(pr.number, composed);
  } else {
    id = await postIssueComment(pr.number, composed);
  }
  if (id && id !== state.summaryCommentId) {
    state.summaryCommentId = id;
    writePrState(state);
  }

  // Formal review with inline comments, anchored to the diff.
  const findings = parsed?.findings || [];
  if (findings.length && pr.headSha) {
    const diff = await getPrDiff(pr.headRef);
    const commitId = diff?.headRefOid || pr.headSha;
    const valid = diff ? filterToDiff(findings, diff.patch) : findings;
    const inline: ReviewInlineComment[] = valid.map((f) => ({
      path: f.path,
      line: f.line,
      side: f.side === "LEFT" ? "LEFT" : "RIGHT",
      body: composeInlineBody(f),
    }));
    if (inline.length) {
      const ok = await submitReview(pr.number, commitId, `Michael review · \`${shortSha}\``, inline);
      if (!ok) console.warn(`[github] submitReview failed for PR #${pr.number}`);
      if (inline.length < findings.length) {
        console.log(`[github] dropped ${findings.length - inline.length} off-diff finding(s) for PR #${pr.number}`);
      }
    }
  }
}

function fallbackSummary(rawText: string, runError?: string): string {
  if (runError) return `⚠️ Review run errored: ${runError}`;
  const trimmed = (rawText || "").trim();
  if (!trimmed) return "⚠️ The review produced no output.";
  // Couldn't parse the JSON contract — surface the raw text so the review isn't lost.
  return trimmed.slice(0, 4000);
}

/** Pull the last fenced ```json block out of the agent's text and parse it. */
export function parseReviewOutput(text: string): ReviewOutput | null {
  if (!text) return null;
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const block = matches.length ? matches[matches.length - 1][1] : null;
  const candidate = block ?? text;
  try {
    const obj = JSON.parse(candidate.trim());
    if (obj && typeof obj === "object") {
      const findings: Finding[] = Array.isArray(obj.findings)
        ? obj.findings
            .filter((f: any) => f && typeof f.path === "string" && Number.isFinite(f.line) && typeof f.body === "string")
            .map((f: any) => ({
              path: f.path,
              line: f.line,
              side: f.side === "LEFT" ? "LEFT" : "RIGHT",
              severity: typeof f.severity === "string" ? f.severity : undefined,
              title: typeof f.title === "string" ? f.title : undefined,
              body: f.body,
              suggestion: typeof f.suggestion === "string" && f.suggestion.trim() ? f.suggestion : undefined,
            }))
        : [];
      return {
        verdict: obj.verdict,
        confidence: typeof obj.confidence === "number" ? obj.confidence : undefined,
        summary_markdown: obj.summary_markdown,
        findings,
      };
    }
  } catch {}
  return null;
}

// ── Unified-diff line validation ─────────────────────────────
// Keep only findings whose (path, line, side) anchor to a line present in the
// diff — GitHub rejects an entire review if any inline comment is off-diff.

interface DiffLineSet {
  right: Set<number>; // new-file line numbers in the diff (added + context)
  left: Set<number>; // old-file line numbers in the diff (removed + context)
}

export function parseDiffLineSets(patch: string): Map<string, DiffLineSet> {
  const byFile = new Map<string, DiffLineSet>();
  let current: DiffLineSet | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).trim();
      if (p === "/dev/null") { current = null; continue; } // deleted file
      // git quotes paths with spaces/unicode as "b/foo bar.ts"
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      if (p.startsWith("b/")) p = p.slice(2);
      current = { right: new Set(), left: new Set() };
      byFile.set(p, current);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.right.add(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      current.left.add(oldLine);
      oldLine++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a real line.
    } else {
      // context line — valid on both sides
      current.right.add(newLine);
      current.left.add(oldLine);
      newLine++;
      oldLine++;
    }
  }
  return byFile;
}

function filterToDiff(findings: Finding[], patch: string): Finding[] {
  const sets = parseDiffLineSets(patch);
  return findings.filter((f) => {
    const set = sets.get(f.path);
    if (!set) return false;
    return f.side === "LEFT" ? set.left.has(f.line) : set.right.has(f.line);
  });
}
