import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { OPENSESSION_CHATS_DIR } from "./paths";
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
import { isLockHeld, readPrState } from "../agents/github/state";
import type {
  UnifiedSession,
  SlackSessionFile,
  LinearSessionFile,
  CLISessionFile,
  BackstageSessionFile,
  SessionPrRef,
  TranscriptEntry,
} from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const SLACK_SESSIONS_DIR = `${HOME}/.slack-sessions`;
const LINEAR_SESSIONS_DIR = `${HOME}/.linear-sessions`;
const CLI_SESSIONS_DIR = `${HOME}/.claude/sessions`;
const SESSIONS_DIR = OPENSESSION_CHATS_DIR;
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

/**
 * User texts already in a session's engine history, for
 * requeueSteerReceipts: a steer that shows up here landed durably (noReply
 * history append), so putting it back into the prompt queue on cancel would
 * deliver it twice.
 */
export function engineUserTexts(session: {
	transcriptPath?: string | null;
	opencodeSessionId?: string | null;
	claudeSessionId?: string | null;
}): string[] {
	try {
		return mergedSessionTranscript({
			transcriptPath: session.transcriptPath ?? null,
			opencodeSessionId: session.opencodeSessionId ?? undefined,
			claudeSessionId: session.claudeSessionId ?? null,
		})
			.filter((e) => e.type === "user")
			.map((e) => e.content.trim());
	} catch {
		return [];
	}
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

// Reverse index of every Claude transcript: session id → its .jsonl path,
// built by walking each project dir ONCE. Without it, the last-resort lookup
// below did an uncached readdir of ~1200 project dirs + an existsSync per dir
// FOR EVERY session that missed the direct path (e.g. the ~575 slack sessions
// with no worktreeDir) — ~600k stat() calls, ~1.4s, on every sessions rebuild.
// That rebuild runs on every cache miss (and every "+ new tab", which nulls the
// cache), so it was the dominant cost of a slow new-tab. Building the index is
// ~16ms and turns each miss into an O(1) map hit. Memoized with a short TTL so a
// burst of rebuilds shares one index while newly-written transcripts still show
// up within a couple seconds.
let transcriptIndexCache: { map: Map<string, string>; ts: number } | null = null;
const TRANSCRIPT_INDEX_TTL = 2000;
function transcriptIndex(): Map<string, string> {
  if (transcriptIndexCache && Date.now() - transcriptIndexCache.ts < TRANSCRIPT_INDEX_TTL)
    return transcriptIndexCache.map;
  const map = new Map<string, string>();
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    projectDirs = [];
  }
  for (const dir of projectDirs) {
    let entries: string[];
    try {
      entries = readdirSync(`${CLAUDE_PROJECTS_DIR}/${dir}`);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const id = e.slice(0, -".jsonl".length);
      // First dir wins — matches the old top-down readdir scan order.
      if (!map.has(id)) map.set(id, `${CLAUDE_PROJECTS_DIR}/${dir}/${e}`);
    }
  }
  transcriptIndexCache = { map, ts: Date.now() };
  return map;
}

function findTranscriptBySessionId(sessionId: string): string | null {
  return transcriptIndex().get(sessionId) ?? null;
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
        data.model,
        // Slack session files store the opencode id in the claude slot.
        isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null
      ),
      opencodeSessionId: isOpencodeSessionId(data.claudeSessionId)
        ? data.claudeSessionId || undefined
        : undefined,
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
      transcriptPath: resolveTranscriptPath(
        findTranscriptPath(data.worktreeDir || null, data.claudeSessionId),
        null,
        data.model,
        // Linear session files store the opencode id in the claude slot too.
        isOpencodeSessionId(data.claudeSessionId) ? data.claudeSessionId : null
      ),
      opencodeSessionId: isOpencodeSessionId(data.claudeSessionId)
        ? data.claudeSessionId || undefined
        : undefined,
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
  if (!existsSync(SESSIONS_DIR)) return [];
  const sessions: UnifiedSession[] = [];

  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json") || SKIP_FILES.has(file)) continue;
    const data = readJsonSafe<BackstageSessionFile>(
      `${SESSIONS_DIR}/${file}`
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
      sideChatOf: data.sideChatOf,
      desk: data.desk,
      spawnDepth: data.spawnDepth,
      attachedRepos: data.attachedRepos,
      linkedPrs: data.linkedPrs,
      previewPath: data.previewPath,
      walkthrough: data.walkthrough,
      automation:
        data.automation ||
        (data.createdBy?.endsWith(" (automation)")
          ? data.createdBy.slice(0, -" (automation)".length)
          : undefined),
      automationId: data.automationId,
      archived: data.archived || undefined,
      archivedReason: data.archivedReason,
      upgradedTo: data.upgradedTo,
      importedFrom: data.importedFrom,
      plainThreadId: data.plainThreadId,
      model: data.model,
      effort: data.effort,
      accountId: data.accountId,
      codexThreadId: data.codexThreadId,
      opencodeSessionId: data.opencodeSessionId,
      lastEngineProvider: data.lastEngineProvider,
      lastEngineModel: data.lastEngineModel,
      modelHistory: data.modelHistory,
      usage: data.usage,
      goal: data.goal,
      goalId: data.goalId,
      lastRunError: data.lastRunError,
      loop: data.loop,
      slackThreads: data.slackThreads,
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
// (diffstat, review decision, author), so the list never has to N+1 fetch per
// PR — only the detail pane does. The bulk cache carries NO CI checks: the
// statusCheckRollup bulk query cost ~111 GraphQL points per refresh (rollup
// cost scales with check runs) and alone exhausted the 5000/hr GraphQL quota
// — real checks come from the cheap per-PR detail query (pr-info.ts).
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
  createdAt: string;
  updatedAt: string;
  checks: PrChecksSummary;
  /** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
  mergeable: string;
  /** Person keys ("kent") of teammates with a pending review request. */
  reviewRequested: string[];
  /** Person keys whose latest submitted PR review stands (approved /
   *  changes requested / commented). Populated for open PRs only. */
  reviewedBy: string[];
  /** Assignee GitHub logins — bot-authored PRs carry the requester here. */
  assignees: string[];
}
// Repos the bulk PR cache covers — the active dev repos whose PRs the sidebar
// Open PRs section and Reviews table surface. Fusion carries 200+ open PRs, so
// limits are per-repo. Repos not listed here fall back to session-derived PR
// info only. The ghRepo target resolves through the config-driven registry
// (worktree.ts REPOS), so a config override of either repo's GitHub target
// flows through.
const PR_REPO_LIMITS = [
	{ id: "tella-fusion", openLimit: 500, recentLimit: 200 },
	{ id: "backstage", openLimit: 100, recentLimit: 100 },
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
let prRefreshPromise: Promise<Set<string>> | null = null;

// The cache is also snapshotted to disk after every successful refresh and
// seeded from there on boot. Without this, a restart during a GitHub outage or
// rate-limit window boots with an empty cache that no refresh can fill, and the
// sidebar's PR queue silently vanishes (2026-07-22). ts stays 0 so the first
// access still refreshes immediately; the snapshot only serves as stale data.
const PR_CACHE_FILE = `${HOME}/.opensession-pr-cache.json`;
try {
  const raw: Record<string, Record<string, PrInfo>> = JSON.parse(
    readFileSync(PR_CACHE_FILE, "utf8"),
  );
  prCache.data = new Map(
    Object.entries(raw).map(([repo, byBranch]) => [
      repo,
      new Map(Object.entries(byBranch)),
    ]),
  );
} catch {}

function persistPrCache(data: Map<string, Map<string, PrInfo>>) {
  try {
    const obj: Record<string, Record<string, PrInfo>> = {};
    for (const [repo, byBranch] of data) obj[repo] = Object.fromEntries(byBranch);
    writeFileSync(PR_CACHE_FILE, JSON.stringify(obj));
  } catch (e) {
    console.error("Failed to persist PR cache:", e);
  }
}

// When gh reports rate-limit exhaustion, stop refreshing until GitHub's stated
// reset (plus slack) instead of re-firing 8 doomed GraphQL calls a minute. The
// cache keeps serving its stale (possibly disk-seeded) snapshot meanwhile.
let ghBackoffUntil = 0;
let ghBackoffProbe: Promise<void> | null = null;
function noteGhRateLimited() {
  if (Date.now() < ghBackoffUntil || ghBackoffProbe) return;
  // Fallback first, in case the probe below fails (core quota can be gone too).
  ghBackoffUntil = Date.now() + 15 * 60_000;
  // rate_limit is REST (core quota), so it usually still answers when GraphQL
  // — what `gh pr list` runs on — is exhausted.
  ghBackoffProbe = (async () => {
    try {
      const proc = Bun.spawn(
        ["gh", "api", "rate_limit", "--jq", ".resources.graphql.reset"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const raw = await new Response(proc.stdout).text();
      if ((await proc.exited) === 0) {
        const reset = parseInt(raw.trim(), 10) * 1000;
        if (reset > Date.now()) ghBackoffUntil = reset + 30_000;
      }
    } catch {}
    console.error(
      `gh rate-limited; pausing PR refresh until ${new Date(ghBackoffUntil).toISOString()}`,
    );
    ghBackoffProbe = null;
  })();
}

// GitHub only populates a PR's `reviewDecision` when branch protection *requires*
// a review. tella-fusion has no such rule, so reviewDecision comes back "" even
// after a teammate approves — which left approved-but-unmerged PRs stuck in the
// sidebar's "Awaiting review" band forever (it clears only on APPROVED or MERGED).
// Derive an effective decision from the actual latest review per reviewer,
// matching GitHub's own precedence: any outstanding CHANGES_REQUESTED blocks,
// otherwise any APPROVED counts. COMMENTED / DISMISSED / PENDING don't decide.
// Used only as a fallback — a real reviewDecision (branch-protected repos) wins.
function deriveReviewDecision(
  latestReviews: Array<{ state?: string }> | undefined,
): string {
  let approved = false;
  for (const r of latestReviews || []) {
    const s = (r.state || "").toUpperCase();
    if (s === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
    if (s === "APPROVED") approved = true;
  }
  return approved ? "APPROVED" : "";
}

// Stale-while-revalidate: never block the event loop on gh (it takes ~10s on
// fusion, which used to freeze every agent in the process).
function getPrsByRepo(): Map<string, Map<string, PrInfo>> {
  if (Date.now() - prCache.ts >= PR_CACHE_TTL) void refreshPrCache();
  return prCache.data;
}

async function ghJson<T>(args: string[]): Promise<T | null> {
  try {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [raw, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if ((await proc.exited) !== 0) {
      if (/rate limit/i.test(err)) noteGhRateLimited();
      return null;
    }
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function refreshPrCache(): Promise<Set<string>> {
  if (prRefreshPromise) return prRefreshPromise;
  prRefreshPromise = refreshPrCacheInner().finally(() => {
    prRefreshPromise = null;
  });
  return prRefreshPromise;
}

async function refreshPrCacheInner(): Promise<Set<string>> {
  const freshRepos = new Set<string>();
  if (Date.now() < ghBackoffUntil) {
    // Rate-limited — keep serving the stale snapshot, don't burn calls.
    prCache.ts = Date.now();
    return freshRepos;
  }
  try {
    type BulkPr = {
      headRefName: string; url: string; state: string; number: number; title: string;
      isDraft: boolean; additions: number; deletions: number; changedFiles: number;
      reviewDecision: string; author?: { login?: string; name?: string }; updatedAt: string;
      createdAt: string;
      reviewRequests?: Array<{ login?: string; name?: string; slug?: string }>;
      assignees?: Array<{ login?: string }>;
      // MERGEABLE | CONFLICTING | UNKNOWN. GitHub computes this asynchronously,
      // so a freshly-pushed PR reads UNKNOWN until the background probe lands —
      // the 60s SWR refresh picks up the real value. `mergeable` is a cheap PR
      // enum (unlike statusCheckRollup), so it's safe to add to the bulk list;
      // mergeStateStatus is NOT a `gh pr list` field (detail-only), don't add it.
      mergeable?: string;
    };
    const FIELDS =
      "headRefName,url,state,number,title,isDraft,additions,deletions,changedFiles,reviewDecision,author,createdAt,updatedAt,reviewRequests,assignees,mergeable";

    // A session's branch is matched against open PRs, so we must see EVERY open
    // PR — not just the newest N. Fusion carries 200+ open PRs at a time, so a
    // single `--state all --limit 200` window silently drops older open ones
    // (the bug where a real PR wouldn't show on its session). Split it:
    //   - `--state open` with a generous limit → all open PRs (the live matches)
    //   - `--state all` window → recently merged/closed (Reviews "merged" view +
    //     sessions whose PR just landed)
    const next = new Map<string, Map<string, PrInfo>>();
    await Promise.all(prRepos().map(async (repo) => {
      const [openPrs, recentAll, reviews] = await Promise.all([
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.openLimit), "--json", FIELDS,
        ]),
        ghJson<BulkPr[]>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "all",
          "--limit", String(repo.recentLimit), "--json", FIELDS,
        ]),
        // Review state per open PR, to fill in an approval GitHub won't report
        // via reviewDecision (see deriveReviewDecision). latestReviews is cheap
        // (~4s and ~2 GraphQL points across every open PR), so it covers the
        // full open window rather than a scoped slice.
        ghJson<Array<{ number: number; latestReviews?: Array<{ state?: string; author?: { login?: string } }> }>>([
          "pr", "list", "--repo", repo.ghRepo, "--state", "open",
          "--limit", String(repo.openLimit), "--json", "number,latestReviews",
        ]),
      ]);

      if (!openPrs) {
        // The open list is authoritative. A successful recent-history query
        // cannot prove an open PR disappeared, so preserve this repo's stale
        // snapshot and do not let notification consumers compare against it.
        const stale = prCache.data.get(repo.id);
        if (stale) next.set(repo.id, stale);
        return;
      }
			freshRepos.add(repo.id);

      const reviewByNumber = new Map<number, string>();
      const reviewedByNumber = new Map<number, string[]>();
      for (const r of reviews || []) {
        const decision = deriveReviewDecision(r.latestReviews);
        if (decision) reviewByNumber.set(r.number, decision);
        // Teammates whose latest submitted review stands (approve / changes /
        // comment) — lets the sidebar tell "you already gave your review" apart
        // from "still on you" instead of only seeing the aggregate decision.
        const people = new Set<string>();
        for (const rev of r.latestReviews || []) {
          const s = (rev.state || "").toUpperCase();
          if (s !== "APPROVED" && s !== "CHANGES_REQUESTED" && s !== "COMMENTED") continue;
          const p = githubLoginToPersonKey(rev.author?.login);
          if (p) people.add(p);
        }
        if (people.size) reviewedByNumber.set(r.number, [...people]);
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
        reviewDecision: pr.reviewDecision || reviewByNumber.get(pr.number) || "",
        author: pr.author?.login || pr.author?.name || "",
        createdAt: pr.createdAt || "",
        updatedAt: pr.updatedAt || "",
        // Always empty in the bulk cache (see PR_REPO_LIMITS comment) — the UI
        // treats zero checks as "no known CI blocker"; the detail pane has the
        // real rollup.
        checks: { total: 0, passed: 0, failed: 0, pending: 0 },
        mergeable: pr.mergeable || "UNKNOWN",
        // Individual review requests only — team requests ("Infra reviewers")
        // have no login and we can't cheaply resolve their membership.
        reviewRequested: (pr.reviewRequests || [])
          .map((r) => githubLoginToPersonKey(r.login))
          .filter((p): p is string => !!p),
        reviewedBy: reviewedByNumber.get(pr.number) || [],
        assignees: (pr.assignees || [])
          .map((a) => a.login)
          .filter((l): l is string => !!l),
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
    if (freshRepos.size) persistPrCache(next);
  } catch (e) {
    console.error("Failed to fetch PRs:", e);
    prCache.ts = Date.now(); // back off on failure too
  }
  return freshRepos;
}

/**
 * Every open PR across the covered repos (prRepos() — from the same batched
 * cache the session enrichment uses), each attributed to a teammate when its
 * GitHub author maps to one via the identity table. Bot-authored PRs
 * (tella-butler — the ones Michael opens from sessions) fall back to the
 * first teammate assignee (sessions instruct the agent to `--assignee` the
 * requester); with neither, `person` is null and the frontend attributes
 * through the session that opened them. Powers the sidebar's Open PRs
 * section, which must show a person's PRs even when no Backstage session
 * exists for them — e.g. PRs opened from another tool (Conductor, local CLI)
 * under their own account.
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
	createdAt: string;
	updatedAt: string;
	checks: PrChecksSummary;
	/** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
	mergeable: string;
	/** Person keys of teammates with a pending review request on this PR. */
	reviewRequested: string[];
	/** An automated OpenSession review is still running for this PR. */
	reviewActive: boolean;
}

export function getOpenPrs(): OpenPrEntry[] {
	const out: OpenPrEntry[] = [];
	for (const [repoId, byBranch] of getPrsByRepo()) {
		const ghRepo = configuredRepos()[repoId]?.ghRepo;
		for (const [branch, pr] of byBranch) {
			if (pr.state !== "OPEN") continue;
			const reviewState = readPrState(pr.number, ghRepo);
			out.push({
				repo: repoId,
				branch,
				url: pr.url,
				number: pr.number,
				title: pr.title,
				isDraft: pr.isDraft,
				reviewDecision: pr.reviewDecision,
				author: pr.author,
				person:
					githubLoginToPersonKey(pr.author) ??
					pr.assignees
						.map((l) => githubLoginToPersonKey(l))
						.find((p): p is string => !!p) ??
					null,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
				checks: pr.checks,
				mergeable: pr.mergeable,
				reviewRequested: pr.reviewRequested,
				reviewActive:
					reviewState?.activeRun?.kind === "review" ||
					isLockHeld("review", pr.number, ghRepo),
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
  // branch name reused across repos never picks up the wrong PR. Beyond the
  // singular pr* fields (still the primary branch's PR, for the list/Reviews
  // consumers), collect EVERY PR the session spans — attached repos and
  // manually linked PRs — into session.prs for the multi-PR surfaces.
  const prsByRepo = getPrsByRepo();
  for (const session of allSessions) {
    if (session.branch) {
      const pr = prsByRepo.get(session.repo || defaultRepo().id)?.get(session.branch);
      if (pr) {
        session.prUrl = pr.url;
        session.prState = pr.state;
        session.prMergeable = pr.mergeable;
        session.prNumber = pr.number;
        session.prTitle = pr.title;
        session.prIsDraft = pr.isDraft;
        session.prAdditions = pr.additions;
        session.prDeletions = pr.deletions;
        session.prChangedFiles = pr.changedFiles;
        session.prReviewDecision = pr.reviewDecision;
        session.prReviewRequested = pr.reviewRequested;
        session.prReviewedBy = pr.reviewedBy;
        session.prAuthor = pr.author;
        session.prUpdatedAt = pr.updatedAt;
        session.prChecks = pr.checks;
      }
    }

    const targets: Array<{
      repo: string;
      branch: string;
      source: SessionPrRef["source"];
      stored?: { url?: string; number?: number; title?: string };
    }> = [];
    if (session.branch)
      targets.push({
        repo: session.repo || defaultRepo().id,
        branch: session.branch,
        source: "primary",
      });
    for (const att of session.attachedRepos || [])
      targets.push({ repo: att.repo, branch: att.branch, source: "attached" });
    for (const lp of session.linkedPrs || [])
      targets.push({ repo: lp.repo, branch: lp.branch, source: "linked", stored: lp });

    const seen = new Set<string>();
    const refs: SessionPrRef[] = [];
    for (const t of targets) {
      const key = `${t.repo}\x00${t.branch}`;
      if (seen.has(key)) continue; // a link duplicating the primary/attached pair
      seen.add(key);
      const pr = prsByRepo.get(t.repo)?.get(t.branch);
      if (pr) {
        refs.push({
          repo: t.repo,
          branch: t.branch,
          source: t.source,
          url: pr.url,
          state: pr.state,
          number: pr.number,
          title: pr.title,
          isDraft: pr.isDraft,
          reviewDecision: pr.reviewDecision,
          checks: pr.checks,
        });
      } else if (
        t.source !== "primary" &&
        (t.stored || !prsByRepo.has(t.repo))
      ) {
        // No cache hit but the target is still real: a linked PR keeps its
        // stored url/number/title as a label, and an attached repo outside the
        // bulk cache's coverage (it only polls the active dev repos) keeps a
        // bare ref — the PR routes resolve it live. A covered repo with no
        // cache entry genuinely has no PR, and a primary branch with no PR
        // stays absent, as before.
        refs.push({ repo: t.repo, branch: t.branch, source: t.source, ...t.stored });
      }
    }
    if (refs.length > 0) session.prs = refs;
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
    if (override) {
      session.title = override;
      session.titleOverridden = true;
    }
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
      const path = `${SESSIONS_DIR}/${session.id}.json`;
      if (existsSync(path)) unlinkSync(path);
      break;
    }
  }
}
