import { existsSync, mkdirSync, readFileSync, realpathSync } from "fs";
import { basename } from "path";
import { configPath, configuredRepos, type RepoSection } from "../config";
import { isLocalProfile, localProfileRoot } from "../profile";
import { writeJsonAtomic } from "../shared/atomic-write";
import type { RouteContext } from "./context";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], cwd?: string): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
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

function rawConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Local config must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function persistRepos(repos: Record<string, RepoSection>): void {
  const config = rawConfig();
  config.repos = repos;
  writeJsonAtomic(configPath(), config);
}

function repoName(input: string): string {
  const trimmed = input.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  return basename(trimmed.replace(/^.*:/, "")) || "repo";
}

export function localRepoId(input: string): string {
  const id = repoName(input)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return id || "repo";
}

export function githubRepoFromRemote(remote: string): string | undefined {
  const normalized = remote.trim().replace(/\.git$/i, "");
  const match = normalized.match(
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+)$/i,
  );
  return match?.[1];
}

async function inspectRepo(repoPath: string): Promise<{
  path: string;
  defaultBranch: string;
  ghRepo?: string;
}> {
  const root = await git(["rev-parse", "--show-toplevel"], repoPath);
  if (root.exitCode !== 0 || !root.stdout) {
    throw new Error("Path is not a Git repository");
  }
  const path = realpathSync(root.stdout);
  const remoteHead = await git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    path,
  );
  const current = await git(["branch", "--show-current"], path);
  const defaultBranch = remoteHead.stdout.replace(/^origin\//, "") || current.stdout;
  if (!defaultBranch) throw new Error("Repository must have a checked-out branch");
  const origin = await git(["remote", "get-url", "origin"], path);
  return {
    path,
    defaultBranch,
    ...(origin.exitCode === 0
      ? { ghRepo: githubRepoFromRemote(origin.stdout) }
      : {}),
  };
}

async function registerRepo(input: { url?: string; path?: string }) {
  if (!!input.url === !!input.path) {
    throw new Error("Provide exactly one of url or path");
  }

  let requestedName: string;
  let checkoutPath: string;
  if (input.url) {
    requestedName = repoName(input.url);
    const id = localRepoId(requestedName);
    checkoutPath = `${localProfileRoot()}/repos/${id}`;
    if (existsSync(checkoutPath)) {
      throw new Error(`Clone destination already exists: ${checkoutPath}`);
    }
    mkdirSync(`${localProfileRoot()}/repos`, { recursive: true });
    const cloned = await git(["clone", "--", input.url, checkoutPath]);
    if (cloned.exitCode !== 0) {
      throw new Error(cloned.stderr || "git clone failed");
    }
  } else {
    checkoutPath = realpathSync(input.path!);
    requestedName = basename(checkoutPath);
  }

  const inspected = await inspectRepo(checkoutPath);
  const id = localRepoId(requestedName);
  const current = configuredRepos();
  if (current[id]) throw new Error(`Repository id already registered: ${id}`);

  const config = rawConfig();
  const repos = {
    ...((config.repos && typeof config.repos === "object" && !Array.isArray(config.repos)
      ? config.repos
      : {}) as Record<string, RepoSection>),
    [id]: {
      repo: inspected.path,
      wtPrefix: id,
      defaultBranch: inspected.defaultBranch,
      ...(inspected.ghRepo ? { ghRepo: inspected.ghRepo } : {}),
      ...(Object.keys(current).length === 0 ? { default: true } : {}),
    },
  };
  persistRepos(repos);
  return configuredRepos()[id];
}

function removeRepo(id: string): boolean {
  const config = rawConfig();
  const repos = {
    ...((config.repos && typeof config.repos === "object" && !Array.isArray(config.repos)
      ? config.repos
      : {}) as Record<string, RepoSection>),
  };
  if (!repos[id]) return false;
  const wasDefault = repos[id].default === true;
  delete repos[id];
  if (wasDefault) {
    const next = Object.keys(repos)[0];
    if (next) repos[next] = { ...repos[next], default: true };
  }
  persistRepos(repos);
  return true;
}

export async function handleLocalReposRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (!isLocalProfile()) return undefined;
  const { req, path } = ctx;

  if (path === "/backstage/api/repos" && req.method === "GET") {
    return Response.json({ repos: Object.values(configuredRepos()) });
  }

  if (path === "/backstage/api/repos" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      url?: unknown;
      path?: unknown;
    } | null;
    try {
      const repo = await registerRepo({
        ...(typeof body?.url === "string" && body.url.trim()
          ? { url: body.url.trim() }
          : {}),
        ...(typeof body?.path === "string" && body.path.trim()
          ? { path: body.path.trim() }
          : {}),
      });
      return Response.json(repo, { status: 201 });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  const removeMatch = path.match(/^\/backstage\/api\/repos\/([^/]+)\/remove$/);
  if (removeMatch && req.method === "POST") {
    const id = decodeURIComponent(removeMatch[1]);
    return removeRepo(id)
      ? Response.json({ ok: true })
      : Response.json({ error: "Repository not found" }, { status: 404 });
  }

  return undefined;
}
