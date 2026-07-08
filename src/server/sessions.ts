import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { existsSync } from "fs";
import {
	slackIdToFirstName,
	githubLoginToPersonKey,
} from "./shared/user-mappings";
import { isArchivedId, getArchiveReason } from "./archive";
import { getTitleOverride } from "./title-overrides";
import { getStatusOverride } from "./status-overrides";
import { getReviewRequest } from "./review-requests";
import { getGeneratedTitle } from "./generated-titles";
import { findCodexRollout } from "./codex-accounts";
import { providerFor } from "./models";
import { parseTranscript } from "./jsonl-parser";
import {
  isOpencodeSessionId,
  readOpencodeTranscript,
  existingOpencodeTranscriptPath,
} from "./opencode-transcript";
import { configuredRepos, defaultRepo } from "./config";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  BackstageSessionFile,
  TranscriptEntry,
} from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const SLACK_SESSIONS_DIR = `${HOME}/.slack-sessions`;
const LINEAR_SESSIONS_DIR = `${HOME}/.linear-sessions`;
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const BACKSTAGE_SESSIONS_DIR = BACKSTAGE_CHATS_DIR;
const CLAUDE_PROJECTS_DIR = `${HOME}/.claude/projects`;

const SKIP_FILES = new Set([
  "worktree-channels.json",
  "message-queue.json",
  "active-worktrees.json",
  "prompt-queues.json",
  "active-at-shutdown.json",
  "active-runs.json",
]);

function resolveSlackUser(userId: string): string {
  // Could be a Slack user ID (e.g. UT41L6GCC) or already a display name
  const mapped = slackIdToFirstName(userId);
  if (mapped) return mapped;
  // Extract first name from "Firstname Lastname" format
  if (userId.includes(" ")) return userId.split(" ")[0];
  return userId;
}

export function getTranscriptPath(
  worktreeDir: string,
  sessionId: string
): string {
  const hash = worktreeDir.replaceAll("/", "-").replace(/^-/, "");
  return `${CLAUDE_PROJECTS_DIR}/-${hash}/${sessionId}.jsonl`;
}

export function getEngineTranscriptPath(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "opencode"
): string | null {
  if (provider === "codex") {
    return findCodexRollout(engineSessionId)?.path || null;
  }
  // OpenCode's own storage is SQLite (no tailable file), but the opencode
  // runner persists a claude-shape jsonl per session precisely so the watcher
  // and reload paths work unchanged. Null until the session's first persisted
  // run (the runner creates the file before yielding init).
  if (provider === "opencode") return existingOpencodeTranscriptPath(engineSessionId);
  return getTranscriptPath(worktreeDir, engineSessionId);
}

/**
 * A session's engine transcript as entries, whatever the engine: claude jsonl
 * and codex rollouts parse from their transcript file; opencode reads straight
 * out of OpenCode's SQLite store. This is the source for cross-engine handoff
 * notes (buildEngineSwitchHandoffNote) in BOTH directions — including the
 * previously-stubbed opencode→claude/codex direction.
 */
export function readEngineTranscript(
  worktreeDir: string,
  engineSessionId: string,
  provider: "claude" | "codex" | "opencode"
): TranscriptEntry[] {
  if (provider === "opencode") return readOpencodeTranscript(engineSessionId);
  const path = getEngineTranscriptPath(worktreeDir, engineSessionId, provider);
  return path ? parseTranscript(path) : [];
}

/**
 * Full UI transcript for a session that may span engines: the claude/codex
 * transcript file (turns before a migration to opencode, or the whole history
 * for single-engine sessions) merged with the opencode store's entries (turns
 * after), ordered by timestamp. Also covers legacy session files where the
 * opencode id rides the claude slot (pre-`opencodeSessionId` runs) — those
 * previously rendered as an empty transcript after a reload.
 */
export function mergedSessionTranscript(
  session: Pick<
    UnifiedSession,
    "transcriptPath" | "opencodeSessionId" | "claudeSessionId"
  >
): TranscriptEntry[] {
  const fileEntries = session.transcriptPath
    ? parseTranscript(session.transcriptPath)
    : [];
  const ocId =
    session.opencodeSessionId ||
    (isOpencodeSessionId(session.claudeSessionId) ? session.claudeSessionId : null);
  if (!ocId) return fileEntries;
  // Prefer the persisted claude-shape file (it is seeded/backfilled to be
  // self-contained); fall back to reading OpenCode's SQLite store for legacy
  // sessions whose next run hasn't backfilled a file yet.
  const ocPath = existingOpencodeTranscriptPath(ocId);
  if (ocPath && ocPath === session.transcriptPath) return fileEntries;
  const ocEntries = ocPath ? parseTranscript(ocPath) : readOpencodeTranscript(ocId);
  if (!ocEntries.length) return fileEntries;
  if (!fileEntries.length) return ocEntries;
  // A seeded opencode file repeats the prior engine's entries (same ids) —
  // dedupe by id, keeping the first occurrence, then order by time.
  const seen = new Set<string>();
  const merged = [...fileEntries, ...ocEntries].filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  return merged.sort((a, b) =>
    (a.timestamp || "").localeCompare(b.timestamp || "")
  );
}

export function engineSessionPatch(
  provider: "claude" | "codex" | "opencode",
  engineSessionId: string
): Partial<BackstageSessionFile> {
  if (provider === "codex") return { codexThreadId: engineSessionId || undefined };
  // OpenCode ids get their own slot (readers prefer it) AND still mirror into
  // the claude slot, the historical ride every pre-existing code path — and
  // any not-yet-reloaded closure during a hot-reload window — reads and
  // writes. Readers recognize the ride by the `ses_` id shape. The mirror is
  // transitional: dropping it requires no `ses_…`-riding session files and no
  // pre-opencodeSessionId code paths left.
  if (provider === "opencode")
    return {
      opencodeSessionId: engineSessionId || undefined,
      claudeSessionId: engineSessionId || undefined,
    };
  return { claudeSessionId: engineSessionId || undefined };
}

function sessionEngineKeys(session: UnifiedSession): string[] {
  return [
    session.claudeSessionId ? `claude:${session.claudeSessionId}` : null,
    session.codexThreadId ? `codex:${session.codexThreadId}` : null,
    session.opencodeSessionId ? `opencode:${session.opencodeSessionId}` : null,
  ].filter((key): key is string => !!key);
}

function findTranscriptPath(
  worktreeDir: string | null,
  sessionId: string | null
): string | null {
  if (!sessionId) return null;
  // Legacy files where an opencode id rides the claude slot: there is no
  // claude jsonl for a `ses_…` id — skip the (project-dir-wide) scan.
  if (isOpencodeSessionId(sessionId)) return null;
  if (worktreeDir) {
    const path = getTranscriptPath(worktreeDir, sessionId);
    if (existsSync(path)) return path;
  }
  // Fallback: check common CWD paths the agents use
  const fallbacks = [
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu-projects-tella-fusion/${sessionId}.jsonl`,
    `${CLAUDE_PROJECTS_DIR}/-home-ubuntu/${sessionId}.jsonl`,
  ];
  for (const path of fallbacks) {
    if (existsSync(path)) return path;
  }
  // Last resort: the recorded worktreeDir can drift from the cwd the run
  // actually used (e.g. a session migrated between repos), so the hashed
  // path above misses even though Claude did write a transcript. The session
  // id is globally unique, so scan every project folder for <id>.jsonl and
  // take the match. Only reached when the direct lookups all fail.
  return findTranscriptBySessionId(sessionId);
}

function findTranscriptBySessionId(sessionId: string): string | null {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const path = `${CLAUDE_PROJECTS_DIR}/${dir}/${sessionId}.jsonl`;
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Transcript for a session that may have run on either engine: codex-model
 * sessions prefer their rollout jsonl; Claude-model sessions prefer their
 * Claude jsonl. If the preferred provider has not produced a transcript yet,
 * fall back to the other engine so mixed sessions don't appear blank after a
 * provider switch.
 */
function resolveTranscriptPath(
  claudePath: string | null,
  codexThreadId: string | null | undefined,
  model: string | null | undefined,
  opencodeSessionId?: string | null
): string | null {
  const codexPath = codexThreadId ? findCodexRollout(codexThreadId)?.path || null : null;
  const ocPath = existingOpencodeTranscriptPath(opencodeSessionId);
  // An opencode-model session's persisted file is self-contained (seeded with
  // any pre-migration history), so it wins while the session runs on opencode.
  if (ocPath && providerFor(model) === "opencode") return ocPath;
  if (codexThreadId && providerFor(model) === "codex") {
    return codexPath || claudePath || ocPath;
  }
  return claudePath || codexPath || ocPath;
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    // A missing file is normal; a corrupt one makes the session silently
    // vanish from the UI, so leave a trace.
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT")
      console.warn(`[sessions] Failed to parse ${path}:`, e);
    return null;
  }
}

function getFileMtime(path: string): string {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function scanSlackSessions(): UnifiedSession[] {
  if (!existsSync(SLACK_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SLACK_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<SlackSessionFile>(
      `${SLACK_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const branch = data.branch || file.replace(".json", "");
    const startedBy = data.userId
      ? resolveSlackUser(data.userId)
      : null;

    // Use a stable ID based on filename
    const id = `slack-${file.replace(".json", "")}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId || null,
      source: "slack",
      branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title: branch,
      lastActivity:
        data.lastActivity ||
        data.createdAt ||
        getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      createdAt:
        data.createdAt || getFileMtime(`${SLACK_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir || null, data.claudeSessionId || null),
        data.codexThreadId,
        data.model
      ),
      slackThread: data.channel
        ? { channel: data.channel, threadTs: data.threadTs || "" }
        : undefined,
      model: data.model,
      codexThreadId: data.codexThreadId || undefined,
    });
  }
  return sessions;
}

function scanLinearSessions(): UnifiedSession[] {
  if (!existsSync(LINEAR_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(LINEAR_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<LinearSessionFile>(
      `${LINEAR_SESSIONS_DIR}/${file}`
    );
    if (!data) continue;

    const rawName =
      data.participants?.[0]?.name ||
      data.lastActiveUser?.name ||
      null;
    // Clean up email-style names (e.g. "john@tella.com" → "John")
    const startedBy = rawName?.includes("@")
      ? rawName.split("@")[0].charAt(0).toUpperCase() + rawName.split("@")[0].slice(1)
      : rawName;

    const title = data.issueIdentifier
      ? `${data.issueIdentifier}: ${data.issueTitle || data.branch}`
      : data.branch;

    const id = `linear-${data.branch}`;

    sessions.push({
      id,
      claudeSessionId: data.claudeSessionId,
      source: "linear",
      branch: data.branch,
      worktreeDir: data.worktreeDir || null,
      startedBy,
      title,
      lastActivity:
        data.updatedAt || getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      createdAt: getFileMtime(`${LINEAR_SESSIONS_DIR}/${file}`),
      isRunning: false,
      transcriptPath: findTranscriptPath(
        data.worktreeDir || null,
        data.claudeSessionId
      ),
      linearIssue: data.issueIdentifier
        ? {
            identifier: data.issueIdentifier,
            title: data.issueTitle || data.branch,
            url: data.issueUrl,
          }
        : undefined,
      model: data.model,
    });
  }
  return sessions;
}

function scanBackstageSessions(): UnifiedSession[] {
  if (!existsSync(BACKSTAGE_SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(BACKSTAGE_SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<BackstageSessionFile>(
      `${BACKSTAGE_SESSIONS_DIR}/${file}`
    );
    // Skip non-session bookkeeping files in this dir (active-runs.json,
    // prompt-queues.json, active-at-shutdown.json, …) — a real session always
    // has an id, these don't, so they'd otherwise become bogus id:undefined rows.
    if (!data || !data.id) continue;

    sessions.push({
      id: data.id,
      claudeSessionId: data.claudeSessionId,
      source: "backstage",
      branch: data.branch || null,
      worktreeDir: data.worktreeDir || null,
      startedBy: data.createdBy,
      title: data.title || data.branch || "Ask session",
      mode: data.mode,
      // Back-compat: older session files stored the repo under `project`.
      repo: data.repo ?? (data as { project?: string }).project,
      // Dual-read: the migration mirrors projectId→workspaceId; prefer the new key.
      projectId:
        (data as { workspaceId?: string | null }).workspaceId ??
        data.projectId ??
        null,
      parentSessionId: data.parentSessionId,
      spawnDepth: data.spawnDepth,
      attachedRepos: data.attachedRepos,
      previewPath: data.previewPath,
      automation:
        data.automation ||
        (data.createdBy?.endsWith(" (automation)")
          ? data.createdBy.slice(0, -" (automation)".length)
          : undefined),
      archived: data.archived || undefined,
      archivedReason: data.archivedReason,
      plainThreadId: data.plainThreadId,
      model: data.model,
      effort: data.effort,
      accountId: data.accountId,
      codexThreadId: data.codexThreadId,
      opencodeSessionId: data.opencodeSessionId,
      lastEngineProvider: data.lastEngineProvider,
      modelHistory: data.modelHistory,
      usage: data.usage,
      goal: data.goal,
      goalId: data.goalId,
      lastRunError: data.lastRunError,
      loop: data.loop,
      slackChannel: data.slackChannel,
      sandbox: data.sandbox,
      lastActivity: data.lastActivity,
      createdAt: data.createdAt,
      isRunning: false,
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir, data.claudeSessionId),
        data.codexThreadId,
        data.model,
        data.opencodeSessionId ||
          (isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null)
      ),
    });
  }
  return sessions;
}

function getRunningPids(): Map<string, number> {
  // Map of sessionId → pid for currently running CLI sessions
  const running = new Map<string, number>();
  if (!existsSync(CLI_SESSIONS_DIR)) return running;

  for (const file of readdirSync(CLI_SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    const data = readJsonSafe<CLISessionFile>(`${CLI_SESSIONS_DIR}/${file}`);
    if (!data) continue;

    try {
      process.kill(data.pid, 0); // Check if PID is alive
      running.set(data.sessionId, data.pid);
    } catch {
      // PID is dead
    }
  }
  return running;
}

// PR cache: branch → rich PR info, refreshed every 60s. A single batched
// `gh pr list` carries everything the Reviews table renders as columns
// (diffstat, review decision, a CI checks rollup summary, author), so the list
// never has to N+1 fetch per PR — only the detail pane does.
interface PrChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}
interface PrInfo {
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  number: number;
  title: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  author: string;
  updatedAt: string;
  checks: PrChecksSummary;
  /** Person keys ("kent") of teammates with a pending review request. */
  reviewRequested: string[];
}
// Repos the bulk PR cache covers — the active dev repos whose PRs the sidebar
// Open PRs section and Reviews table surface. Fusion carries 200+ open PRs and
// GitHub's GraphQL 504s on wide statusCheckRollup queries there, so limits are
// per-repo. Repos not listed here fall back to session-derived PR info only.
// The ghRepo target resolves through the config-driven registry (worktree.ts
// REPOS), so a config override of either repo's GitHub target flows through.
const PR_REPO_LIMITS = [
	{ id: "tella-fusion", openLimit: 500, recentLimit: 200, rollupLimit: 60 },
	{ id: "backstage", openLimit: 100, recentLimit: 100, rollupLimit: 30 },
] as const;
function prRepos() {
	return PR_REPO_LIMITS.flatMap((limits) => {
		const repo = configuredRepos()[limits.id];
		return repo?.ghRepo ? [{ ...limits, ghRepo: repo.ghRepo }] : [];
	});
}

// repo id → branch → PR info. Keyed per repo so the same branch name in two
// repos (multi-repo sessions share branch names) never collides.
let prCache: { data: Map<string, Map<string, PrInfo>>; ts: number } = { data: new Map(), ts: 0 };
const PR_CACHE_TTL = 60_000;
let prRefreshing = false;

interface RollupCheck { status?: string; conclusion?: string; state?: string }

// Collapse GitHub's per-check rollup into the four counts the UI shows. A check
// is "pending" until COMPLETED; once complete its conclusion decides pass/fail.
// Skipped/neutral checks count toward the total but are neither pass nor fail,
// matching how GitHub's merge box treats them.
function summarizeChecks(rollup: RollupCheck[] | undefined): PrChecksSummary {
  const summary: PrChecksSummary = { total: 0, passed: 0, failed: 0, pending: 0 };
  for (const c of rollup || []) {
    summary.total++;
    // StatusContext (legacy commit statuses) report `state`; CheckRun reports
    // status + conclusion.
    const status = (c.status || "").toUpperCase();
    const conclusion = (c.conclusion || c.state || "").toUpperCase();
    if (status && status !== "COMPLETED") {
      summary.pending++;
    } else if (["FAILURE", "TIMED_OUT", "ERROR", "STARTUP_FAILURE", "ACTION_REQUIRED", "CANCELLED"].includes(conclusion)) {
      summary.failed++;
    } else if (conclusion === "SUCCESS") {
      summary.passed++;
    }
    // SKIPPED / NEUTRAL / "" fall through — counted in total only.
  }
  return summary;
}

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// fusion, which used to freeze every agent in the process).
function getPrsByRepo(): Map<string, Map<string, PrInfo>> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

async function ghJson<T>(args: string[]): Promise<T | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore" });
    const raw = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0 || !raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function refreshPrCache(): Promise<void> {
  if (prRefreshing) return;
  prRefreshing = true;
  try {
    type BulkPr = {
      headRefName: string; url: string; state: string; number: number; title: string;
      isDraft: boolean; additions: number; deletions: number; changedFiles: number;
      reviewDecision: string; author?: { login?: string; name?: string }; updatedAt: string;
      reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
    };
    const FIELDS =
      "headRefName,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,updatedAt,reviewRequests";

    // A session's branch is matched against open PRs, so we must see EVERY open
    // PR — not just the newest N. Fusion carries 200+ open PRs at a time, so a
    // single `--state all --limit 200` window silently drops older open ones
    // (the bug where a real PR wouldn't show on its session). Split it:
    //   - `--state open` with a generous limit → all open PRs (the live matches)
    //   - `--state all` window → recently merged/closed (Reviews "merged" view +
    //     sessions whose PR just landed)
    // GitHub's GraphQL also 504s asking for statusCheckRollup across hundreds of
    // PRs, so the CI rollup stays a small scoped call over the most recent open
    // PRs (the ones a reviewer actually triages); others show no checks column.
    const next = new Map<string, Map<string, PrInfo>>();
    await Promise.all(prRepos().map(async (repo) => {
      const [openPrs, recentAll, rollups] = await Promise.all([
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.openLimit), "--json", FIELDS,
        ]),
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "all",
          "--limit", String(repo.recentLimit), "--json", FIELDS,
        ]),
        ghJson<Array<{ number: number; statusCheckRollup?: RollupCheck[] }>>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.rollupLimit), "--json", "number,statusCheckRollup",
        ]),
      ]);

      if (!openPrs && !recentAll) {
        // Both calls failed for this repo — keep its stale data.
        const stale = prCache.data.get(repo.id);
        if (stale) next.set(repo.id, stale);
        return;
      }

      const checksByNumber = new Map<number, PrChecksSummary>();
      for (const r of rollups || []) {
        checksByNumber.set(r.number, summarizeChecks(r.statusCheckRollup));
      }

      const toInfo = (pr: BulkPr): PrInfo => ({
        url: pr.url,
        state: pr.state as PrInfo["state"],
        number: pr.number,
        title: pr.title || "",
        isDraft: !!pr.isDraft,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0,
        changedFiles: pr.changedFiles || 0,
        reviewDecision: pr.reviewDecision || "",
        author: pr.author?.login || pr.author?.name || "",
        updatedAt: pr.updatedAt || "",
        checks: checksByNumber.get(pr.number) || { total: 0, passed: 0, failed: 0, pending: 0 },
        // Individual review requests only — team requests ("Infra reviewers")
        // have no login and we can't cheaply resolve their membership.
        reviewRequested: (pr.reviewRequests || [])
          .map((r) => githubLoginToPersonKey(r.login))
          .filter((p): p is string => !!p),
      });

      // Seed with recent closed/merged (newest-first → keep the first per branch),
      // then let open PRs override: an open PR is the authoritative state for a
      // branch even if an older closed PR reused the same head ref.
      const map = new Map<string, PrInfo>();
      for (const pr of recentAll || []) {
        if (!map.has(pr.headRefName)) map.set(pr.headRefName, toInfo(pr));
      }
      for (const pr of openPrs || []) {
        map.set(pr.headRefName, toInfo(pr));
      }
      next.set(repo.id, map);
    }));
    prCache = { data: next, ts: Date.now() };
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  } finally {
    prRefreshing = false;
  }
}

/**
 * Every open PR across the covered repos (prRepos() — from the same batched
 * cache the session enrichment uses), each attributed to a teammate when its
 * GitHub author maps to one via the identity table. Bot-authored PRs
 * (tella-butler — the ones Michael opens from sessions) come back with
 * `person: null`; the frontend attributes those through the session that
 * opened them. Powers the sidebar's Open PRs section, which must show a
 * person's PRs even when no Backstage session exists for them — e.g. PRs
 * opened from another tool (Conductor, local CLI) under their own account.
 */
export interface OpenPrEntry {
	repo: string;
	branch: string;
	url: string;
	number: number;
	title: string;
	isDraft: boolean;
	reviewDecision: string;
	author: string;
	/** Web user-picker key ("kent"), or null when the author isn't a teammate. */
	person: string | null;
	updatedAt: string;
	checks: PrChecksSummary;
	/** Person keys of teammates with a pending review request on this PR. */
	reviewRequested: string[];
}

export function getOpenPrs(): OpenPrEntry[] {
	const out: OpenPrEntry[] = [];
	for (const [repoId, byBranch] of getPrsByRepo()) {
		for (const [branch, pr] of byBranch) {
			if (pr.state !== "OPEN") continue;
			out.push({
				repo: repoId,
				branch,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				isDraft: pr.isDraft,
				reviewDecision: pr.reviewDecision,
				author: pr.author,
				person: githubLoginToPersonKey(pr.author),
				updatedAt: pr.updatedAt,
				checks: pr.checks,
				reviewRequested: pr.reviewRequested,
			});
		}
	}
	return out.sort((a, b) =>
		(b.updatedAt || "").localeCompare(a.updatedAt || ""),
	);
}

export function getAllSessions(): UnifiedSession[] {
  const slackSessions = scanSlackSessions();
  const linearSessions = scanLinearSessions();
  const backstageSessions = scanBackstageSessions();
  const runningPids = getRunningPids();

  // Merge all sessions, deduplicating by engine id (Claude session or Codex
  // thread). Keep the one with richer data (backstage > linear > slack), and
  // preserve dropped ids as aliases for deep links.
  const byEngineId = new Map<string, UnifiedSession>();
  const allSessions: UnifiedSession[] = [];

  for (const session of [
    ...backstageSessions,
    ...linearSessions,
    ...slackSessions,
  ]) {
    const engineKeys = sessionEngineKeys(session);
    let existing: UnifiedSession | undefined;
    for (const key of engineKeys) {
      existing = byEngineId.get(key);
      if (existing) break;
    }
    if (existing) {
      if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
        existing.isRunning = true;
      }
      // Keep the dropped ID as an alias so deep links to it (e.g. the
      // Slack "Open in Backstage" button, which uses slack-<channel>-<ts>)
      // still resolve to the surviving session.
      existing.aliasIds = [...(existing.aliasIds || []), session.id];
      for (const aliasKey of engineKeys) byEngineId.set(aliasKey, existing);
      continue;
    }

    // Mark running status
    if (session.claudeSessionId && runningPids.has(session.claudeSessionId)) {
      session.isRunning = true;
    }

    allSessions.push(session);
    for (const key of engineKeys) byEngineId.set(key, session);
  }

  // Enrich with PR URLs and state, matched within the session's own repo so a
  // branch name reused across repos never picks up the wrong PR.
  const prsByRepo = getPrsByRepo();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prsByRepo.get(session.repo || defaultRepo().id)?.get(session.branch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
        session.prNumber = pr.number;
        session.prTitle = pr.title;
        session.prIsDraft = pr.isDraft;
        session.prAdditions = pr.additions;
        session.prDeletions = pr.deletions;
        session.prChangedFiles = pr.changedFiles;
        session.prReviewDecision = pr.reviewDecision;
        session.prReviewRequested = pr.reviewRequested;
        session.prAuthor = pr.author;
        session.prUpdatedAt = pr.updatedAt;
        session.prChecks = pr.checks;
      }
    }
  }

  // Apply the cross-source archive registry
  for (const session of allSessions) {
    if (!session.archived && isArchivedId(session.id)) {
      session.archived = true;
      session.archivedReason = getArchiveReason(session.id) || "manual";
    }
  }

  // Apply auto-generated summary titles (the short Conductor-style name),
  // keyed by unified id or merged alias id. Sits UNDER a manual rename (applied
  // next) but OVER the derived first-line title.
  for (const session of allSessions) {
    const generated =
      getGeneratedTitle(session.id) ??
      session.aliasIds?.map((a) => getGeneratedTitle(a)).find(Boolean);
    if (generated) session.title = generated;
  }

  // Apply cross-source manual title overrides (rename). Keyed by the unified id
  // or any merged alias id, so a rename sticks across the dedup in this scan.
  for (const session of allSessions) {
    const override =
      getTitleOverride(session.id) ??
      session.aliasIds?.map((a) => getTitleOverride(a)).find(Boolean);
    if (override) session.title = override;
  }

  // Apply manual status-lane overrides. Keyed by unified id or any merged alias
  // id (same as the rename registry) so a pinned lane survives the dedup scan.
  for (const session of allSessions) {
    const status =
      getStatusOverride(session.id) ??
      session.aliasIds?.map((a) => getStatusOverride(a)).find(Boolean);
    if (status) session.manualStatus = status;
  }

  // Apply pending review requests (the info panel's Reviewer picker), keyed by
  // unified id or any merged alias id like the registries above.
  for (const session of allSessions) {
    const review =
      getReviewRequest(session.id) ??
      session.aliasIds?.map((a) => getReviewRequest(a)).find(Boolean);
    if (review) session.reviewRequest = review;
  }

  // Sort by lastActivity descending
  allSessions.sort(
    (a, b) =>
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );

  return allSessions;
}

export function deleteSession(session: UnifiedSession): void {
  // Delete the session JSON file based on source
  switch (session.source) {
    case "slack": {
      // ID format: slack-{filename}
      const filename = session.id.replace(/^slack-/, "") + ".json";
      const path = `${SLACK_SESSIONS_DIR}/${filename}`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "linear": {
      // ID format: linear-{branch}
      const branch = session.id.replace(/^linear-/, "");
      const path = `${LINEAR_SESSIONS_DIR}/${branch}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
    case "backstage": {
      const path = `${BACKSTAGE_SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
}
