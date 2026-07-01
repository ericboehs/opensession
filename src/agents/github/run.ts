/**
 * Shared headless-run helper for the github agent. Composes `runAgent` like
 * automations.ts does, but persists its own visible BackstageSessionFile so each
 * PR review/fix/simplify shows up as a Michael session in the web UI, and resumes
 * the engine conversation across rounds via the deterministic per-PR session file.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { BACKSTAGE_CHATS_DIR } from "../../server/paths";
import { writeJsonAtomic } from "../../server/shared/atomic-write";
import { runAgent } from "../../server/agent-runner";
import { providerFor, DEFAULT_FALLBACK_MODEL } from "../../server/models";
import { STRIPE_CONFIRM_TOOLS } from "../../server/claude-runner";
import { gitIdentityFor, type GitIdentity } from "../../server/shared/user-mappings";
import { findOrCreateWorkspaceByKey } from "../../server/workspaces";
import { repoForPath } from "../../server/worktree";
import type { BackstageSessionFile } from "../../server/types";

const HOME = process.env.HOME || "/home/ubuntu";
const SESSIONS_DIR = BACKSTAGE_CHATS_DIR;

/**
 * All chats for one PR (its review/autofix/simplify/adversarial/mention runs,
 * plus whatever session originally opened the PR) belong in one Project folder.
 * Resolve-or-create it by a stable per-PR key, then pull in any existing session
 * on the same head branch — that catches the originating session, which shares
 * the branch but was created elsewhere. Best-effort: never block a run on this.
 */
function projectIdForPr(prNumber: number, branch: string, title: string, cwd: string): string | null {
  try {
    const repo = repoForPath(cwd).id;
    // opts.title is per-kind ("Review · PR #123 <PR title>"). The folder groups
    // ALL kinds for the PR, so name it PR-level: strip the kind + "PR #n" prefix
    // down to the bare PR title (fall back to the full title if it doesn't match).
    const prTitle = title.replace(/^.*?PR #\d+[:\s-]*/i, "").trim() || title;
    const project = findOrCreateWorkspaceByKey(`ghpr-${prNumber}`, {
      name: `#${prNumber} ${prTitle}`.trim().slice(0, 120),
      repo,
      createdBy: "GitHub (automation)",
      prNumber,
      branch,
    });
    // Adopt same-branch siblings that aren't already filed under a project.
    if (branch) {
      for (const file of readdirSync(SESSIONS_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
          const p = `${SESSIONS_DIR}/${file}`;
          const s = JSON.parse(readFileSync(p, "utf-8")) as BackstageSessionFile;
          if (s.id && s.branch === branch && !s.projectId) {
            writeJsonAtomic(p, { ...s, projectId: project.id });
          }
        } catch {}
      }
    }
    return project.id;
  } catch {
    return null;
  }
}

export type GithubRunKind = "review" | "autofix" | "simplify" | "mention" | "adversarial";

/** Stable, deterministic backstage session id per PR + behavior (one resumable session each). */
export function bksIdFor(prNumber: number, kind: GithubRunKind): string {
  return `bks-ghpr-${prNumber}-${kind}`;
}

const UI_BASE = process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

/** Backstage UI link to a run's session, for "open to monitor" links in PR comments. */
export function sessionUrl(prNumber: number, kind: GithubRunKind): string {
  return `${UI_BASE}/session/${bksIdFor(prNumber, kind)}`;
}

/** Map a GitHub login to a git identity for commit attribution (fix/simplify). */
export function authorForLogin(login?: string): GitIdentity | null {
  return gitIdentityFor(login || null);
}

/**
 * Marker the code-mode behaviors emit right before their final summary. We post
 * only the text after it, so the agent's working narration ("let me run the
 * subagents…") never lands on the PR.
 */
export const SUMMARY_SENTINEL = "===MICHAEL-SUMMARY===";

/** Text after the last summary sentinel; falls back to the full trimmed text. */
export function finalSummary(text: string): string {
  if (!text) return "";
  const idx = text.lastIndexOf(SUMMARY_SENTINEL);
  return idx === -1 ? text.trim() : text.slice(idx + SUMMARY_SENTINEL.length).trim();
}

function readEngineSessionId(bksId: string): { id: string; isCodex: boolean } | null {
  const path = `${SESSIONS_DIR}/${bksId}.json`;
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf-8")) as BackstageSessionFile;
    if (f.codexThreadId) return { id: f.codexThreadId, isCodex: true };
    if (f.claudeSessionId) return { id: f.claudeSessionId, isCodex: false };
  } catch {}
  return null;
}

export interface GithubRunOpts {
  prNumber: number;
  kind: GithubRunKind;
  prompt: string;
  cwd: string;
  mode: "ask" | "code";
  model?: string;
  branch: string;
  title: string;
  /** Resume the prior engine conversation for this PR+behavior if one exists. */
  resume?: boolean;
  /** Commit attribution for code-mode runs (the human who asked). */
  author?: GitIdentity | null;
  onSessionCreated?: (bksId: string) => void;
}

export interface GithubRunResult {
  bksId: string;
  text: string;
  error?: string;
}

/** Run one headless turn for a PR behavior; returns the agent's accumulated text. */
export async function runGithubAgent(opts: GithubRunOpts): Promise<GithubRunResult> {
  const bksId = bksIdFor(opts.prNumber, opts.kind);
  const startedAt = new Date();

  // Group this and the PR's other chats under one Project folder.
  const projectId = projectIdForPr(opts.prNumber, opts.branch, opts.title, opts.cwd);

  const resumeFrom = opts.resume ? readEngineSessionId(bksId) : null;

  let effectiveModel = opts.model;
  let effectiveProvider = providerFor(opts.model);
  const persist = (engineSessionId: string) => {
    const isCodex = effectiveProvider === "codex";
    const data: BackstageSessionFile = {
      id: bksId,
      claudeSessionId: isCodex ? "" : engineSessionId,
      ...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
      branch: opts.branch,
      worktreeDir: opts.cwd,
      createdBy: "GitHub (automation)",
      createdAt: startedAt.toISOString(),
      lastActivity: new Date().toISOString(),
      title: opts.title,
      mode: opts.mode,
      automation: "github-pr-review",
      ...(projectId ? { projectId } : {}),
    };
    writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, data);
  };

  let text = "";
  let engineSessionId = resumeFrom?.id || "";
  let errorMsg = "";

  try {
    for await (const event of runAgent({
      prompt: opts.prompt,
      sessionId: resumeFrom?.id || undefined,
      cwd: opts.cwd,
      mode: opts.mode,
      model: opts.model,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      aws: true,
      author: opts.author,
      fallbackModel: DEFAULT_FALLBACK_MODEL,
      journal: { bksSessionId: bksId, kind: `github-${opts.kind}` },
    })) {
      if (event.type === "init") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
        persist(engineSessionId);
        opts.onSessionCreated?.(bksId);
      } else if (event.type === "text_chunk") {
        text += event.text;
      } else if (event.type === "done") {
        engineSessionId = event.sessionId || engineSessionId;
        if (event.provider) effectiveProvider = event.provider;
        if (event.model) effectiveModel = event.model;
      } else if (event.type === "error") {
        errorMsg = event.content || "Unknown error";
      }
    }
  } catch (e: any) {
    errorMsg = e.message || String(e);
  }

  persist(engineSessionId);
  return { bksId, text, error: errorMsg || undefined };
}
