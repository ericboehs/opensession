import { existsSync, readFileSync, rmSync } from "fs";
import { configuredCloud, configuredRepos, configuredServer, type Repo } from "../config";
import { gitPush } from "../git-status";
import { sessionHasJournaledRun } from "../migrate-engine";
import {
  existingOpencodeTranscriptPath,
  getOpencodeTranscriptPath,
  isOpencodeSessionId,
} from "../opencode-transcript";
import { OPENSESSION_CHATS_DIR } from "../paths";
import { isLocalProfile } from "../profile";
import {
  findSession,
  getCachedSessions,
  invalidateSessionsCache,
} from "../session-cache";
import { writeFileAtomic, writeJsonAtomic } from "../shared/atomic-write";
import type { BackstageSessionFile, UnifiedSession } from "../types";
import {
  createWorktreeForExistingBranch,
  worktreeHeadBranch,
} from "../worktree";
import {
  isAgentSessionBusy,
  markSessionStarting,
  unmarkSessionStarting,
} from "../agent-runner";
import type { RouteContext } from "./context";

const BKS_UUID_V7 =
  /^bks-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ImportedFromLocalMarker {
  importedFrom: "local";
}

export interface UpgradedToCloudMarker {
  upgradedTo: { id: string; url: string };
}

export interface TransferSessionSubset {
  id: string;
  title?: string;
  createdBy?: string;
  createdAt?: string;
  lastActivity?: string;
  mode?: "ask" | "code";
  model?: string;
  effort?: string;
  modelHistory?: BackstageSessionFile["modelHistory"];
  usage?: BackstageSessionFile["usage"];
}

export interface SessionImportRequest {
  session: TransferSessionSubset;
  transcriptJsonl: string;
  repo: string;
  branch: string;
}

interface ImportDependencies {
  repos(): Record<string, Repo>;
  sessionExists(id: string): boolean;
  branchExists(repo: Repo, branch: string): Promise<boolean>;
  createWorktree(branch: string, repo: string): Promise<string>;
  verifyWorktree(repo: Repo, branch: string, worktreeDir: string): Promise<void>;
  writeTranscript(engineSessionId: string, transcriptJsonl: string): void;
  removeTranscript(engineSessionId: string): void;
  writeSession(id: string, session: BackstageSessionFile & ImportedFromLocalMarker): void;
  sessionUrl(id: string): string;
}

interface GitState {
  branch: string | null;
  uncommittedFiles: string[];
}

interface UpgradeDependencies {
  repos(): Record<string, Repo>;
  findSession(id: string): UnifiedSession | undefined;
  readSession(id: string): BackstageSessionFile | null;
  isBusy(session: UnifiedSession, data: BackstageSessionFile): boolean;
  reserve(id: string): void;
  release(id: string): void;
  gitState(dir: string): Promise<GitState>;
  push(dir: string, branch: string): Promise<{ ok: true } | { error: string }>;
  readTranscript(session: UnifiedSession, data: BackstageSessionFile): string;
  cloud(): { upstream: string; token: string | null };
  fetch: typeof fetch;
  archive(
    id: string,
    data: BackstageSessionFile,
    upgradedTo: { id: string; url: string },
  ): void;
}

const importingSessionIds: Set<string> = ((globalThis as any)
  .__importingLocalSessionIds ??= new Set());

function errorResponse(error: string, status = 400, extra?: object): Response {
  return Response.json({ error, ...extra }, { status });
}

function validImportId(id: unknown): id is string {
  return typeof id === "string" && BKS_UUID_V7.test(id);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateTranscriptJsonl(value: unknown): string | null {
  if (typeof value !== "string") return "transcriptJsonl must be a string";
  for (const [index, line] of value.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const message = parsed?.message as Record<string, unknown> | undefined;
      if (
        !parsed ||
        (parsed.type !== "user" && parsed.type !== "assistant") ||
        typeof parsed.uuid !== "string" ||
        !parsed.uuid ||
        !message ||
        (message.role !== "user" && message.role !== "assistant") ||
        !Array.isArray(message.content)
      ) {
        return `transcriptJsonl line ${index + 1} is not a supported Claude-shape transcript record`;
      }
    } catch {
      return `transcriptJsonl line ${index + 1} is not valid JSON`;
    }
  }
  return null;
}

function importEngineId(sessionId: string): string {
  return `ses_import_${sessionId.slice("bks-".length).replaceAll("-", "")}`;
}

function transferredSession(
  value: unknown,
): { ok: true; session: TransferSessionSubset } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "session must be an object" };
  }
  const input = value as Record<string, unknown>;
  if (!validImportId(input.id)) {
    return { ok: false, error: "session.id must be a lowercase bks- UUIDv7 id" };
  }
  if (input.mode !== undefined && input.mode !== "ask" && input.mode !== "code") {
    return { ok: false, error: 'session.mode must be "ask" or "code"' };
  }
  for (const key of ["createdAt", "lastActivity"] as const) {
    if (input[key] !== undefined && !validDate(input[key])) {
      return { ok: false, error: `session.${key} must be an ISO date string` };
    }
  }
  const text = (key: string, max: number): string | undefined =>
    typeof input[key] === "string" && input[key].trim()
      ? input[key].trim().slice(0, max)
      : undefined;
  return {
    ok: true,
    session: {
      id: input.id,
      ...(text("title", 80) ? { title: text("title", 80) } : {}),
      ...(text("createdBy", 100) ? { createdBy: text("createdBy", 100) } : {}),
      ...(validDate(input.createdAt) ? { createdAt: input.createdAt } : {}),
      ...(validDate(input.lastActivity) ? { lastActivity: input.lastActivity } : {}),
      ...(input.mode === "ask" || input.mode === "code" ? { mode: input.mode } : {}),
      ...(text("model", 200) ? { model: text("model", 200) } : {}),
      ...(text("effort", 40) ? { effort: text("effort", 40) } : {}),
      ...(Array.isArray(input.modelHistory)
        ? { modelHistory: input.modelHistory as BackstageSessionFile["modelHistory"] }
        : {}),
      ...(input.usage && typeof input.usage === "object" && !Array.isArray(input.usage)
        ? { usage: input.usage as BackstageSessionFile["usage"] }
        : {}),
    },
  };
}

export function sessionSubsetForTransfer(
  data: BackstageSessionFile,
): TransferSessionSubset {
  return {
    id: data.id,
    ...(data.title ? { title: data.title } : {}),
    ...(data.createdBy ? { createdBy: data.createdBy } : {}),
    ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    ...(data.lastActivity ? { lastActivity: data.lastActivity } : {}),
    ...(data.mode ? { mode: data.mode } : {}),
    ...(data.model ? { model: data.model } : {}),
    ...(data.effort ? { effort: data.effort } : {}),
    ...(data.modelHistory ? { modelHistory: data.modelHistory } : {}),
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

export async function importCloudSession(
  body: unknown,
  authUser: RouteContext["authUser"],
  deps: ImportDependencies,
): Promise<Response> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("Request body must be an object");
  }
  const input = body as Record<string, unknown>;
  const selected = transferredSession(input.session);
  if (!selected.ok) return errorResponse(selected.error);
  const repoId = typeof input.repo === "string" ? input.repo.trim() : "";
  const branch = typeof input.branch === "string" ? input.branch.trim() : "";
  const repo = deps.repos()[repoId];
  if (!repo) return errorResponse(`Repository "${repoId}" is not registered`);
  if (!branch) return errorResponse("branch is required");
  const transcriptError = validateTranscriptJsonl(input.transcriptJsonl);
  if (transcriptError) return errorResponse(transcriptError);

  const id = selected.session.id;
  if (deps.sessionExists(id) || importingSessionIds.has(id)) {
    return errorResponse(`Session "${id}" already exists`, 409);
  }
  importingSessionIds.add(id);
  const engineId = importEngineId(id);
  let transcriptWritten = false;
  try {
    if (!(await deps.branchExists(repo, branch))) {
      return errorResponse(
        `Branch "${branch}" does not exist on origin for repository "${repoId}"`,
      );
    }
    const worktreeDir = await deps.createWorktree(branch, repoId);
    await deps.verifyWorktree(repo, branch, worktreeDir);
    const now = new Date().toISOString();
    const session: BackstageSessionFile & ImportedFromLocalMarker = {
      id,
      claudeSessionId: engineId,
      opencodeSessionId: engineId,
      branch,
      worktreeDir,
      repo: repoId,
      createdBy: selected.session.createdBy || authUser?.name || "Local user",
      ...(authUser?.login ? { createdByLogin: authUser.login } : {}),
      createdAt: selected.session.createdAt || now,
      lastActivity: selected.session.lastActivity || now,
      ...(selected.session.title ? { title: selected.session.title } : {}),
      mode: selected.session.mode || "code",
      ...(selected.session.model ? { model: selected.session.model } : {}),
      ...(selected.session.effort ? { effort: selected.session.effort } : {}),
      ...(selected.session.modelHistory
        ? { modelHistory: selected.session.modelHistory }
        : {}),
      ...(selected.session.usage ? { usage: selected.session.usage } : {}),
      importedFrom: "local",
    };
    deps.writeTranscript(engineId, input.transcriptJsonl as string);
    transcriptWritten = true;
    deps.writeSession(id, session);
    return Response.json({ id, url: deps.sessionUrl(id) }, { status: 201 });
  } catch (error) {
    if (transcriptWritten) deps.removeTranscript(engineId);
    return errorResponse(
      error instanceof Error ? error.message : String(error),
      500,
    );
  } finally {
    importingSessionIds.delete(id);
  }
}

function normalizeGitHubRepo(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

function upstreamEndpoint(upstream: string, path: string): string {
  const url = new URL(upstream);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("cloud.upstream must use HTTP or HTTPS");
  }
  return `${url.toString().replace(/\/+$/, "")}${path}`;
}

function cloudSessionDestination(
  value: unknown,
  id: string,
  upstream: string,
): { id: string; url: string } | null {
  if (!value || typeof value !== "object") return null;
  const result = value as { id?: unknown; url?: unknown };
  if (result.id !== id || !validImportId(result.id) || typeof result.url !== "string") {
    return null;
  }
  try {
    const expectedOrigin = new URL(upstream).origin;
    const destination = new URL(result.url);
    if (
      destination.origin !== expectedOrigin ||
      !destination.pathname.endsWith(`/session/${encodeURIComponent(id)}`)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { id, url: result.url };
}

async function passUpstreamError(response: Response): Promise<Response> {
  const headers = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  return new Response(await response.text(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function upgradeLocalSession(
  id: string,
  deps: UpgradeDependencies,
): Promise<Response> {
  const session = deps.findSession(id);
  if (!session || session.source !== "backstage") {
    return errorResponse("Local session not found", 404);
  }
  const data = deps.readSession(id);
  if (!data?.id || data.id !== id) {
    return errorResponse("Local session file not found", 404);
  }
  if (data.upgradedTo) {
    return Response.json(data.upgradedTo);
  }
  if (session.archived || data.archived) {
    return errorResponse("Archived local sessions cannot be upgraded", 409);
  }
  if (deps.isBusy(session, data)) {
    return errorResponse("Session is running; stop it before upgrading", 409);
  }
  // Reserve synchronously before the first await below. This uses the same
  // starting-state gate as a prompt, so no new engine turn can begin while the
  // branch and transcript are being shipped.
  deps.reserve(id);
  try {
    return await finishLocalUpgrade(id, session, data, deps);
  } finally {
    deps.release(id);
  }
}

async function finishLocalUpgrade(
  id: string,
  session: UnifiedSession,
  data: BackstageSessionFile,
  deps: UpgradeDependencies,
): Promise<Response> {
  if (!session.worktreeDir || !session.branch || session.mode !== "code") {
    return errorResponse("Only local code sessions with a branch can be upgraded");
  }
  const repoId = session.repo || data.repo || "";
  const repo = deps.repos()[repoId];
  if (!repo) return errorResponse(`Local repository "${repoId}" is not registered`);
  if (!repo.ghRepo) {
    return errorResponse(
      `Repository "${repoId}" does not have a GitHub origin and cannot be upgraded`,
    );
  }

  let state: GitState;
  try {
    state = await deps.gitState(session.worktreeDir);
  } catch (error) {
    return errorResponse(
      `Could not inspect the session worktree: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  if (!state.branch) {
    return errorResponse("The session worktree has a detached HEAD", 409);
  }
  if (state.branch !== session.branch) {
    return errorResponse(
      `The session records branch "${session.branch}" but the worktree is on "${state.branch}"`,
      409,
    );
  }
  if (state.uncommittedFiles.length) {
    return errorResponse(
      "Commit or discard the worktree changes before upgrading",
      409,
      { uncommittedFiles: state.uncommittedFiles },
    );
  }

  const cloud = deps.cloud();
  if (!cloud.token) {
    return errorResponse(
      "Cloud upgrade is not configured; set cloud.token or OPENSESSION_CLOUD_TOKEN",
    );
  }
  let reposUrl: string;
  let importUrl: string;
  let sessionsUrl: string;
  try {
    reposUrl = upstreamEndpoint(cloud.upstream, "/backstage/api/repos");
    importUrl = upstreamEndpoint(cloud.upstream, "/backstage/api/sessions/import");
    sessionsUrl = upstreamEndpoint(cloud.upstream, "/backstage/api/sessions");
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
  const headers = { authorization: `Bearer ${cloud.token}` };
  let reposResponse: Response;
  try {
    reposResponse = await deps.fetch(reposUrl, { headers });
  } catch (error) {
    return errorResponse(`Cloud OpenSession is unreachable: ${error}`, 502);
  }
  if (!reposResponse.ok) return passUpstreamError(reposResponse);
  const reposBody = await reposResponse.json().catch(() => null);
  const cloudRepos = Array.isArray(reposBody?.repos) ? reposBody.repos : null;
  if (!cloudRepos) {
    return errorResponse("Cloud OpenSession returned an invalid repository list", 502);
  }
  const ghRepo = normalizeGitHubRepo(repo.ghRepo);
  const cloudRepo = cloudRepos.find(
    (entry: any) =>
      typeof entry?.id === "string" &&
      typeof entry?.ghRepo === "string" &&
      normalizeGitHubRepo(entry.ghRepo) === ghRepo,
  );
  if (!cloudRepo) {
    return errorResponse(
      `GitHub repository "${repo.ghRepo}" is not registered on the cloud OpenSession`,
    );
  }

  let pushed: { ok: true } | { error: string };
  try {
    pushed = await deps.push(session.worktreeDir, session.branch);
  } catch (error) {
    return errorResponse(
      `Could not push the session branch: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  if ("error" in pushed) return errorResponse(pushed.error, 500);

  let transcriptJsonl: string;
  try {
    transcriptJsonl = deps.readTranscript(session, data);
  } catch (error) {
    return errorResponse(
      `Could not read the local transcript: ${error instanceof Error ? error.message : String(error)}`,
      500,
    );
  }
  const importBody: SessionImportRequest = {
    session: sessionSubsetForTransfer(data),
    transcriptJsonl,
    repo: cloudRepo.id,
    branch: session.branch,
  };
  let imported: Response;
  try {
    imported = await deps.fetch(importUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(importBody),
    });
  } catch (error) {
    return errorResponse(`Cloud OpenSession is unreachable: ${error}`, 502);
  }
  let destination: { id: string; url: string } | null = null;
  if (imported.ok) {
    destination = cloudSessionDestination(
      await imported.json().catch(() => null),
      id,
      cloud.upstream,
    );
  } else if (imported.status === 409) {
    // The cloud import commits before the local archive marker. If the process
    // died in that narrow gap, a retry sees the required duplicate-id 409.
    // Verify that the existing destination is this local import, then finish
    // the local archive instead of stranding the transfer forever.
    try {
      const sessionsResponse = await deps.fetch(sessionsUrl, { headers });
      if (sessionsResponse.ok) {
        const sessions = await sessionsResponse.json().catch(() => null);
        const existing = Array.isArray(sessions)
          ? sessions.find(
              (entry: any) =>
                entry?.id === id &&
                entry?.importedFrom === "local" &&
                entry?.repo === cloudRepo.id &&
                entry?.branch === session.branch,
            )
          : null;
        if (existing) {
          destination = {
            id,
            url: upstreamEndpoint(
              cloud.upstream,
              `/session/${encodeURIComponent(id)}`,
            ),
          };
        }
      }
    } catch {}
    if (!destination) return passUpstreamError(imported);
  } else {
    return passUpstreamError(imported);
  }
  if (!destination) {
    return errorResponse("Cloud OpenSession returned an invalid import response", 502);
  }

  try {
    deps.archive(id, data, destination);
  } catch (error) {
    return errorResponse(
      `The cloud session was imported, but the local session could not be archived: ${error instanceof Error ? error.message : String(error)}`,
      500,
      destination,
    );
  }
  return Response.json(destination);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const productionImportDependencies: ImportDependencies = {
  repos: configuredRepos,
  sessionExists: (id) =>
    existsSync(`${OPENSESSION_CHATS_DIR}/${id}.json`) ||
    getCachedSessions().some(
      (session) => session.id === id || session.aliasIds?.includes(id),
    ),
  branchExists: async (repo, branch) => {
    const valid = await runGit(repo.repo, ["check-ref-format", "--branch", branch]);
    if (valid.exitCode !== 0) return false;
    const remote = await runGit(repo.repo, [
      "ls-remote",
      "--exit-code",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    if (remote.exitCode !== 0) return false;
    const fetched = await runGit(repo.repo, ["fetch", "origin", branch, "--quiet"]);
    return fetched.exitCode === 0;
  },
  createWorktree: createWorktreeForExistingBranch,
  verifyWorktree: async (repo, branch, worktreeDir) => {
    const [head, origin, status] = await Promise.all([
      runGit(worktreeDir, ["rev-parse", "HEAD"]),
      runGit(repo.repo, ["rev-parse", `origin/${branch}`]),
      runGit(worktreeDir, ["status", "--porcelain=v1"]),
    ]);
    if (head.exitCode !== 0 || origin.exitCode !== 0 || head.stdout !== origin.stdout) {
      throw new Error(
        `Cloud worktree for "${branch}" does not match the freshly fetched origin branch`,
      );
    }
    if (status.exitCode !== 0 || status.stdout) {
      throw new Error(`Cloud worktree for "${branch}" has uncommitted changes`);
    }
  },
  writeTranscript: (engineId, transcriptJsonl) =>
    writeFileAtomic(
      getOpencodeTranscriptPath(engineId),
      transcriptJsonl && !transcriptJsonl.endsWith("\n")
        ? `${transcriptJsonl}\n`
        : transcriptJsonl,
    ),
  removeTranscript: (engineId) =>
    rmSync(getOpencodeTranscriptPath(engineId), { force: true }),
  writeSession: (id, session) => {
    writeJsonAtomic(`${OPENSESSION_CHATS_DIR}/${id}.json`, session);
    invalidateSessionsCache();
  },
  sessionUrl: (id) =>
    `${configuredServer().publicBaseUrl.replace(/\/+$/, "")}/session/${encodeURIComponent(id)}`,
};

const productionUpgradeDependencies: UpgradeDependencies = {
  repos: configuredRepos,
  findSession,
  readSession: (id) => {
    try {
      return JSON.parse(
        readFileSync(`${OPENSESSION_CHATS_DIR}/${id}.json`, "utf-8"),
      );
    } catch {
      return null;
    }
  },
  isBusy: (session, data) =>
    session.isRunning ||
    isAgentSessionBusy(
      session.claudeSessionId,
      session.codexThreadId,
      session.id,
    ) ||
    sessionHasJournaledRun(session.id, data),
  reserve: markSessionStarting,
  release: unmarkSessionStarting,
  gitState: async (dir) => {
    const branch = worktreeHeadBranch(dir);
    const status = await runGit(dir, ["status", "--porcelain=v1"]);
    if (status.exitCode !== 0) {
      throw new Error(status.stderr || "git status failed");
    }
    return {
      branch,
      uncommittedFiles: status.stdout
        .split("\n")
        .filter(Boolean)
        // runGit trims the full stdout, so the first porcelain line may lose
        // its leading index-space (" M file" becomes "M file"). Accept both.
        .map((line) => line.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim()),
    };
  },
  push: gitPush,
  readTranscript: (session, data) => {
    const engineId =
      data.opencodeSessionId ||
      (isOpencodeSessionId(data.claudeSessionId)
        ? data.claudeSessionId
        : undefined);
    const path = existingOpencodeTranscriptPath(engineId) || session.transcriptPath;
    if (!path || !existsSync(path)) {
      if (engineId) throw new Error("OpenCode transcript mirror not found");
      return "";
    }
    return readFileSync(path, "utf-8");
  },
  cloud: configuredCloud,
  fetch,
  archive: (id, data, upgradedTo) => {
    const now = new Date().toISOString();
    writeJsonAtomic(`${OPENSESSION_CHATS_DIR}/${id}.json`, {
      ...data,
      archived: true,
      archivedAt: now,
      archivedReason: "manual",
      lastActivity: now,
      upgradedTo,
    } satisfies BackstageSessionFile & UpgradedToCloudMarker);
    invalidateSessionsCache();
  },
};

export async function handleSessionTransferRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (
    !isLocalProfile() &&
    ctx.path === "/backstage/api/sessions/import" &&
    ctx.req.method === "POST"
  ) {
    const body = await ctx.req.json().catch(() => null);
    return importCloudSession(body, ctx.authUser, productionImportDependencies);
  }

  const upgradeMatch = ctx.path.match(
    /^\/backstage\/api\/sessions\/([^/]+)\/upgrade$/,
  );
  if (isLocalProfile() && upgradeMatch && ctx.req.method === "POST") {
    return upgradeLocalSession(
      decodeURIComponent(upgradeMatch[1]),
      productionUpgradeDependencies,
    );
  }

  return undefined;
}
