/**
 * Server-side repository setup, part of the /api/setup family dispatched from
 * setup.ts:
 *
 *   GET  /api/setup/github/repos: repos the instance's GitHub credential can
 *                                  see, for the registration picker.
 *   POST /api/setup/repos: clone `owner/name` and register it in config.repos.
 *   PATCH /api/setup/repos/:id: change its default branch.
 */

import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { audit } from "../audit";
import { codeStorageConfig, configuredRepos, type RepoSection } from "../config";
import { getRepo as getCsRepo, listRepos as listCsRepos } from "../codestorage/client";
import { cloneCsCheckout } from "../codestorage/remote";
import {
  persistRawConfig,
  rawConfig,
  reposForMutation,
  repoSectionForMutation,
  withConfigMutationLock,
} from "../config-mutation";
import { githubCredentialForLogin, soleGithubAccount, type GithubCredential } from "../github-auth";
import { githubCredentialHelperCommand } from "../github-git-credential";
import { homeDir } from "../paths";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";
import type { RouteContext } from "./context";
import {
  inspectRepo,
  repoCurrentBranch,
  repoHasBranch,
  repoIdFromName,
} from "./repo-inspection";

/** Strict: this value reaches a spawn argv (always array-spawned, never a
 *  shell string — the regex is belt AND suspenders). */
export const GITHUB_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

export { githubCredentialHelperCommand };

export function validGithubFullName(value: unknown): value is string {
  return typeof value === "string" && GITHUB_FULL_NAME_RE.test(value);
}

/** Normalize a branch name through git's own ref validator so the editor
 * accepts exactly the branch grammar the rest of the git layer supports. */
export async function normalizeDefaultBranch(value: unknown): Promise<string | null> {
  if (typeof value !== "string") return null;
  const branch = value.trim();
  if (!branch) return null;
  const checked = Bun.spawn(["git", "check-ref-format", "--branch", branch], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await checked.exited) === 0 ? branch : null;
}

/**
 * The GitHub credential to act with for listing and cloning: the signed-in
 * user's stored token when web sign-in is active (operator mode), else the
 * single connected account in simple mode (soleGithubAccount, no authUser to
 * scope by there). Null falls back to the bot PAT or anonymous access.
 */
function actingGithubCredential(ctx: RouteContext): GithubCredential | null {
  return (
    (ctx.authUser?.login ? githubCredentialForLogin(ctx.authUser.login) : null) ??
    soleGithubAccount()
  );
}

// ── GitHub repo listing ──────────────────────────────────────────────────────

interface PickerRepo {
  fullName: string;
  private: boolean;
  description?: string;
  defaultBranch: string;
  registered: boolean;
  /** For pushed_at-desc sorting; stripped before responding. */
  pushedAt?: string;
}

const REPO_LIST_CAP = 300;
const REPO_CACHE_TTL_MS = 60_000;

/** 60s in-module cache keyed by credential principal, to keep the picker
 *  snappy across the setup page's refetches. */
const repoListCache = new Map<
  string,
  { at: number; payload: { source: "user" | "bot"; repos: PickerRepo[] } }
>();

async function githubJson(
  token: string,
  url: string,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "opensession",
    },
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
}

function toPickerRepo(r: any, registeredNames: Set<string>): PickerRepo | null {
  const fullName = typeof r?.full_name === "string" ? r.full_name : null;
  if (!fullName) return null;
  return {
    fullName,
    private: r.private === true,
    ...(typeof r.description === "string" && r.description
      ? { description: r.description }
      : {}),
    defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main",
    registered: registeredNames.has(fullName.toLowerCase()),
    ...(typeof r.pushed_at === "string" ? { pushedAt: r.pushed_at } : {}),
  };
}

/** Registered ghRepo names, lowercased, for the picker's `registered` flag. */
function registeredGhRepos(): Set<string> {
  return new Set(
    Object.values(configuredRepos())
      .map((r) => r.ghRepo.toLowerCase())
      .filter(Boolean),
  );
}

/** PAT path: everything the token's user owns or is an org member of. */
async function listReposViaUserRepos(token: string): Promise<PickerRepo[]> {
  const registered = registeredGhRepos();
  const repos: PickerRepo[] = [];
  for (let page = 1; repos.length < REPO_LIST_CAP && page <= 5; page++) {
    const { ok, body } = await githubJson(
      token,
      `https://api.github.com/user/repos?per_page=100&affiliation=owner,organization_member&sort=pushed&page=${page}`,
    );
    if (!ok || !Array.isArray(body)) break;
    for (const r of body) {
      const repo = toPickerRepo(r, registered);
      if (repo) repos.push(repo);
    }
    if (body.length < 100) break;
  }
  return repos.slice(0, REPO_LIST_CAP);
}

/** GitHub App user-token path: union of the token's accessible installations.
 *  Returns null when the token isn't installation-scoped (classic OAuth/PAT)
 *  so the caller can fall back to /user/repos. */
async function listReposViaInstallations(token: string): Promise<PickerRepo[] | null> {
  const installations = await githubJson(
    token,
    "https://api.github.com/user/installations?per_page=100",
  );
  const list = installations.body?.installations;
  if (!installations.ok || !Array.isArray(list)) return null;
  const registered = registeredGhRepos();
  const repos: PickerRepo[] = [];
  for (const installation of list) {
    const id = installation?.id;
    if (typeof id !== "number") continue;
    for (let page = 1; repos.length < REPO_LIST_CAP && page <= 5; page++) {
      const { ok, body } = await githubJson(
        token,
        `https://api.github.com/user/installations/${id}/repositories?per_page=100&page=${page}`,
      );
      if (!ok || !Array.isArray(body?.repositories)) break;
      for (const r of body.repositories) {
        const repo = toPickerRepo(r, registered);
        if (repo) repos.push(repo);
      }
      if (body.repositories.length < 100) break;
    }
    if (repos.length >= REPO_LIST_CAP) break;
  }
  return repos.slice(0, REPO_LIST_CAP);
}

// ── code.storage repo listing ────────────────────────────────────────────────

/** Same 60s snappiness as the GitHub cache; one org per instance, one slot. */
let csRepoListCache: {
  at: number;
  payload: { source: "org"; repos: PickerRepo[] };
} | null = null;

/** Drop the cached org repo list — the connect/disconnect flow
 *  (setup-codestorage.ts) calls this so the setup wizard's code.storage
 *  section reflects the new connection immediately instead of serving a
 *  stale (pre-connect or pre-disconnect) probe for up to 60s. */
export function invalidateCsRepoListCache(): void {
  csRepoListCache = null;
}

/** Registered csRepo paths, lowercased, for the picker's `registered` flag. */
function registeredCsRepos(): Set<string> {
  return new Set(
    Object.values(configuredRepos())
      .filter((r) => r.host === "codestorage")
      .map((r) => (r.csRepo || "").toLowerCase())
      .filter(Boolean),
  );
}

/** Everything the org's signing key can see. Mirrors the /setup/github/repos
 *  shape so the wizard renders either host with the same component. */
async function listCodestorageRepos(): Promise<PickerRepo[]> {
  const registered = registeredCsRepos();
  const repos = await listCsRepos();
  return repos
    .map((r) => ({
      fullName: r.url || r.repo_id,
      // No public/private concept — repos are only reachable with an org JWT.
      private: true,
      defaultBranch: r.default_branch || "main",
      registered: registered.has((r.url || r.repo_id).toLowerCase()),
      ...(typeof r.created_at === "string" ? { pushedAt: r.created_at } : {}),
    }))
    .slice(0, REPO_LIST_CAP);
}

// ── Server-side clone + register ─────────────────────────────────────────────

async function runCommand(
  argv: string[],
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    env: {
      ...process.env,
      GIT_SSH_COMMAND:
        process.env.GIT_SSH_COMMAND ||
        "ssh -o ConnectTimeout=20 -o ServerAliveInterval=10 -o ServerAliveCountMax=3",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(9), timeoutMs);
  const [exitCode, stderr] = await Promise.all([
    proc.exited.finally(() => clearTimeout(timeout)),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr: stderr.trim() };
}

/** Replace every occurrence of a secret in text bound for a log or an API
 *  error. Cheap and total, so a token can't ride out on a clone failure. */
function scrubSecret(text: string, secret?: string): string {
  return secret ? text.split(secret).join("***") : text;
}

/**
 * Clone `owner/name` to `dest`, NEVER embedding a credential in the persisted
 * remote URL. Both paths take the full https URL (never the bare owner/name) so
 * a `-`-prefixed name can't be read as a CLI flag.
 *
 * With a connected user token, clone privately and secretlessly: the token
 * reaches git only through a 0700 GIT_ASKPASS helper that echoes it for the
 * password prompt — never in argv (ps-visible), never in .git/config. The URL
 * carries the username `x-access-token` (GitHub's app-token username, not a
 * secret) so git skips the username prompt; origin is normalized to the
 * tokenless URL afterward, holding the "no credential in the persisted remote"
 * invariant. Without a token: `gh` (brings its own auth) if present, else an
 * anonymous https clone — still enough for public repos.
 */
async function cloneGithubRepo(
  fullName: string,
  dest: string,
  userToken?: string,
): Promise<void> {
  const cleanUrl = `https://github.com/${fullName}.git`;
  if (userToken) {
    const askpassDir = mkdtempSync(join(tmpdir(), "os-gh-askpass-"));
    const askpass = join(askpassDir, "askpass.sh");
    // The script body is static and secret-free: git passes the prompt text as
    // $1, and the helper echoes the username or the token from the environment
    // (which only this child and its git subprocess can read).
    writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n*[Uu]sername*) printf %s "$GIT_USERNAME" ;;\n*) printf %s "$GIT_PASSWORD" ;;\nesac\n',
      { mode: 0o700 },
    );
    chmodSync(askpass, 0o700); // belt against a permissive umask on create
    try {
      const result = await runCommand(
        ["git", "clone", "--", `https://x-access-token@github.com/${fullName}.git`, dest],
        5 * 60_000,
        {
          GIT_ASKPASS: askpass,
          GIT_TERMINAL_PROMPT: "0",
          GIT_USERNAME: "x-access-token",
          GIT_PASSWORD: userToken,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(scrubSecret(result.stderr, userToken) || "git clone failed");
      }
      // The token never touched the persisted remote (it lived only in the
      // askpass env), but drop the username too so origin is the plain URL.
      await runCommand(["git", "-C", dest, "remote", "set-url", "origin", cleanUrl], 30_000);
    } finally {
      rmSync(askpassDir, { recursive: true, force: true });
    }
    return;
  }
  const argv = Bun.which("gh")
    ? ["gh", "repo", "clone", cleanUrl, dest]
    : ["git", "clone", "--", cleanUrl, dest];
  const result = await runCommand(argv, 5 * 60_000);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `${argv[0]} clone failed`);
  }
}

function checkoutsRoot(): string {
  return `${homeDir()}/checkouts`;
}

async function configureGithubCredentialHelper(checkoutPath: string): Promise<void> {
  const helperKey = "credential.https://github.com.helper";
  await $`git -C ${checkoutPath} config --replace-all ${helperKey} ${""}`.quiet();
  await $`git -C ${checkoutPath} config --add ${helperKey} ${githubCredentialHelperCommand()}`.quiet();
}

async function registerGithubRepo(input: {
  fullName: string;
  id?: string;
  /** Connected user credential for the private clone and later Git operations. */
  credential?: GithubCredential;
}): Promise<RepoSection & { id: string }> {
  const name = input.fullName.split("/")[1];
  const id = repoIdFromName(input.id?.trim() || name);
  if (configuredRepos()[id]) {
    const err = new Error(`Repository id already registered: ${id}`);
    (err as any).status = 409;
    throw err;
  }
  const root = checkoutsRoot();
  const dest = `${root}/${id}`;
  if (existsSync(dest)) {
    throw new Error(`Clone destination already exists: ${dest}`);
  }
  mkdirSync(root, { recursive: true });
  try {
    await cloneGithubRepo(input.fullName, dest, input.credential?.env.GH_TOKEN);
    // A private clone authenticated through a one-shot GIT_ASKPASS; the remote
    // it leaves is tokenless, so wire the credential helper for future
    // fetch/push. No-op for a public (tokenless) clone — the helper simply has
    // nothing to answer with.
    if (input.credential) await configureGithubCredentialHelper(dest);
    const inspected = await inspectRepo(dest);
    const config = rawConfig();
    const repos = reposForMutation(config) as Record<string, RepoSection>;
    const entry: RepoSection = {
      label: name,
      repo: inspected.path,
      wtPrefix: id,
      defaultBranch: inspected.defaultBranch,
      ghRepo: inspected.ghRepo || input.fullName,
      ...(Object.keys(configuredRepos()).length === 0 ? { default: true } : {}),
    };
    repos[id] = entry;
    config.repos = repos;
    persistRawConfig(config);
    audit({ kind: "setup_repo_register", repo: input.fullName, id, path: inspected.path });
    return { id, ...entry };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

/** code.storage repo path, e.g. "acme/widget" — only ever reaches an https
 *  URL (and the array-spawned git argv behind `--`). */
export const CS_REPO_ID_RE = /^[\w.-]+(?:\/[\w.-]+)*$/;

export function validCsRepoId(value: unknown): value is string {
  return typeof value === "string" && CS_REPO_ID_RE.test(value);
}

async function registerCodestorageRepo(input: {
  repoId: string;
  id?: string;
}): Promise<RepoSection & { id: string }> {
  const cfg = codeStorageConfig();
  if (!cfg) throw new Error("code.storage is not configured (integrations.codeStorage)");
  // Resolve through the REST API: validates existence and canonicalizes the
  // repo path before anything touches disk or config.
  const resolved = await getCsRepo(input.repoId);
  const csRepo = resolved.url || input.repoId;
  const name = csRepo.split("/").pop() || csRepo;
  const id = repoIdFromName(input.id?.trim() || name);
  if (configuredRepos()[id]) {
    const err = new Error(`Repository id already registered: ${id}`);
    (err as any).status = 409;
    throw err;
  }
  if (
    Object.values(configuredRepos()).some(
      (repo) => repo.host === "codestorage" && repo.csRepo === csRepo,
    )
  ) {
    const err = new Error(`code.storage repository already registered: ${csRepo}`);
    (err as any).status = 409;
    throw err;
  }
  const root = checkoutsRoot();
  const dest = `${root}/${id}`;
  if (existsSync(dest)) {
    throw new Error(`Clone destination already exists: ${dest}`);
  }
  mkdirSync(root, { recursive: true });
  try {
    // Clones with a short-lived JWT, persists the credential-free remote, and
    // wires the URL-scoped credential helper for ambient git fetch/push.
    await cloneCsCheckout(csRepo, dest);
    const inspected = await inspectRepo(dest);
    const config = rawConfig();
    const repos = reposForMutation(config) as Record<string, RepoSection>;
    const entry: RepoSection = {
      label: name,
      repo: inspected.path,
      wtPrefix: id,
      defaultBranch: inspected.defaultBranch || resolved.default_branch || "main",
      host: "codestorage",
      csRepo,
      ...(Object.keys(configuredRepos()).length === 0 ? { default: true } : {}),
    };
    repos[id] = entry;
    config.repos = repos;
    persistRawConfig(config);
    audit({ kind: "setup_repo_register", repo: csRepo, id, path: inspected.path });
    return { id, ...entry };
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function handleSetupRepoRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/setup/github/repos" && req.method === "GET") {
    // Credential preference: the acting user's stored GitHub token (signed-in
    // user in operator mode, the sole connected account in simple mode), else
    // the bot PAT, else an empty (but well-formed) answer.
    const userCredential = actingGithubCredential(ctx);
    const token = userCredential?.env.GH_TOKEN || process.env.GITHUB_API_TOKEN;
    const source: "user" | "bot" | null = userCredential
      ? "user"
      : process.env.GITHUB_API_TOKEN
        ? "bot"
        : null;
    if (!token || !source) {
      return Response.json({ source: null, repos: [] });
    }
    const cacheKey = userCredential ? userCredential.principal : "bot";
    const cached = repoListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < REPO_CACHE_TTL_MS) {
      return Response.json(cached.payload);
    }
    try {
      // App user tokens list via installations; anything else (PAT, classic
      // OAuth) via /user/repos. The installations call itself tells us which
      // kind we have — a non-App token gets an error and we fall back.
      const repos =
        (source === "user" ? await listReposViaInstallations(token) : null) ??
        (await listReposViaUserRepos(token));
      repos.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
      const payload = {
        source,
        repos: repos.map(({ pushedAt: _pushedAt, ...repo }) => repo),
      };
      repoListCache.set(cacheKey, { at: Date.now(), payload });
      return Response.json(payload);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
  }

  if (path === "/api/setup/codestorage/repos" && req.method === "GET") {
    // Same well-formed empty answer as the GitHub route when unconfigured, so
    // the wizard can probe both hosts unconditionally.
    if (!codeStorageConfig()) return Response.json({ source: null, repos: [] });
    if (csRepoListCache && Date.now() - csRepoListCache.at < REPO_CACHE_TTL_MS) {
      return Response.json(csRepoListCache.payload);
    }
    try {
      const repos = await listCodestorageRepos();
      repos.sort((a, b) => (b.pushedAt || "").localeCompare(a.pushedAt || ""));
      const payload = {
        source: "org" as const,
        repos: repos.map(({ pushedAt: _pushedAt, ...repo }) => repo),
      };
      csRepoListCache = { at: Date.now(), payload };
      return Response.json(payload);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 502 },
      );
    }
  }

  if (path === "/api/setup/repos" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      source?: unknown;
      fullName?: unknown;
      repoId?: unknown;
      id?: unknown;
    } | null;
    if (body?.source === "codestorage") {
      // Accepts the id under either key so the wizard can reuse its GitHub
      // submit shape ({fullName}) unchanged.
      const repoId = body?.repoId ?? body?.fullName;
      if (!validCsRepoId(repoId)) {
        return Response.json(
          { error: "repoId must be a code.storage repo path (e.g. acme/widget)" },
          { status: 400 },
        );
      }
      if (body?.id !== undefined && (typeof body.id !== "string" || !body.id.trim())) {
        return Response.json({ error: "id must be a non-empty string" }, { status: 400 });
      }
      if (!codeStorageConfig()) {
        return Response.json(
          { error: "code.storage is not configured (integrations.codeStorage)" },
          { status: 400 },
        );
      }
      try {
        const repo = await withConfigMutationLock(() =>
          registerCodestorageRepo({
            repoId,
            ...(typeof body!.id === "string" ? { id: body!.id } : {}),
          }),
        );
        return Response.json(repo, { status: 201 });
      } catch (e) {
        const status = (e as any)?.status === 409 ? 409 : 400;
        return Response.json(
          { error: e instanceof Error ? e.message : String(e) },
          { status },
        );
      }
    }
    if (!validGithubFullName(body?.fullName)) {
      return Response.json(
        { error: "fullName must be a GitHub owner/name" },
        { status: 400 },
      );
    }
    if (body?.id !== undefined && (typeof body.id !== "string" || !body.id.trim())) {
      return Response.json({ error: "id must be a non-empty string" }, { status: 400 });
    }
    // The acting token lets a private clone succeed without ambient gh /
    // credential-helper auth; absent, the clone stays anonymous (public repos).
    const credential = actingGithubCredential(ctx);
    try {
      const repo = await withConfigMutationLock(() =>
        registerGithubRepo({
          fullName: body!.fullName as string,
          ...(typeof body!.id === "string" ? { id: body!.id } : {}),
          ...(credential ? { credential } : {}),
        }),
      );
      return Response.json(repo, { status: 201 });
    } catch (e) {
      const status = (e as any)?.status === 409 ? 409 : 400;
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status },
      );
    }
  }

  const updateMatch = path.match(/^\/api\/setup\/repos\/([^/]+)$/);
  if (updateMatch && req.method === "PATCH") {
    let id: string;
    try {
      id = decodeURIComponent(updateMatch[1]);
    } catch {
      return Response.json({ error: "Invalid repository id" }, { status: 400 });
    }
    if (["__proto__", "prototype", "constructor"].includes(id)) {
      return Response.json({ error: "Invalid repository id" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      defaultBranch?: unknown;
    } | null;
    const defaultBranch = await normalizeDefaultBranch(body?.defaultBranch);
    if (!defaultBranch) {
      return Response.json(
        { error: "defaultBranch must be a valid Git branch" },
        { status: 400 },
      );
    }

    const repos = configuredRepos();
    if (!Object.hasOwn(repos, id)) {
      return Response.json({ error: `Unknown repository: ${id}` }, { status: 404 });
    }
    const repo = repos[id];
    if (!(await repoHasBranch(repo.repo, defaultBranch))) {
      return Response.json(
        { error: `Branch not found on ${id}'s origin: ${defaultBranch}` },
        { status: 400 },
      );
    }
    if (repo.sharedCheckout) {
      const current = await repoCurrentBranch(repo.repo);
      if (current !== defaultBranch) {
        return Response.json(
          {
            error: `The shared checkout is on ${current || "a detached HEAD"}. Switch it to ${defaultBranch} before changing the default branch.`,
          },
          { status: 400 },
        );
      }
    }

    try {
      const updated = await withConfigMutationLock(async () => {
        const config = rawConfig();
        const section = repoSectionForMutation(config, id);
        if (!section) return null;
        section.defaultBranch = defaultBranch;
        persistRawConfig(config);
        audit({ kind: "setup_repo_update", id, defaultBranch });
        return { id, defaultBranch };
      });
      if (!updated) {
        return Response.json({ error: `Unknown repository: ${id}` }, { status: 404 });
      }
      if (process.env.NODE_ENV !== "test") {
        const [{ scheduleSandboxEnvironmentInvalidation }, { invalidateAskCheckoutRefresh }] =
          await Promise.all([
            import("../sandbox/environments"),
            import("../worktree"),
          ]);
        invalidateAskCheckoutRefresh(id);
        scheduleSandboxEnvironmentInvalidation(id);
      }
      return Response.json(updated);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 400 },
      );
    }
  }

  return undefined;
}
