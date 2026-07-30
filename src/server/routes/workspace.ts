/**
 * Worktrees, file/skill autocomplete, repo registry, Projects (chat folders), sibling chats, promote-to-code, and attach/switch/detach repos.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { searchRepoEntries } from "../file-index";
import { runSessionPrompt } from "../run-session";
import { type Sandbox, hasRemoteWorkspace, workspaceExecFor } from "../sandbox";
import { isRemoteSandboxProvider, resolveRequestedSandbox } from "../sandbox/config";
import {
	SESSIONS_DIR,
	findSession,
	invalidateSessionsCache,
	isLegacySideChat,
	peekCachedSessions,
	touchBackstageSession,
} from "../session-cache";
import { attachRepo, switchPrimaryRepo, workspaceOwningWorktree } from "../session-repos";
import { getAllSessions, getTranscriptPath } from "../sessions";
import { writeJsonAtomic } from "../shared/atomic-write";
import { configuredIdentity, defaultRepo } from "../config";
import { searchSkills } from "../skills";
import { handleSlashCommand } from "../slash-commands";
import { suggestBranchName } from "../suggest-branch";
import { type BackstageSessionFile, type StackedOn } from "../types";
import { type Workspace, createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, updateWorkspace } from "../workspaces";
import { resolveExternalWorkspace, resolvePlainWorkspace, resolvePrWorkspace } from "../workspace-resolve";
import { REPOS, createWorktree, createWorktreeForExistingBranch, getRepo, isSharedCheckoutDir, listWorktrees, repoForPath, worktreeHasWork } from "../worktree";
import { randomUUIDv7 } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";

function findBackstageSessionForFileMentions(
	sessionId: string | null,
): BackstageSessionFile | undefined {
	if (!sessionId?.startsWith("bks-") || !/^[a-z0-9-]+$/i.test(sessionId))
		return undefined;
	try {
		const session = JSON.parse(
			readFileSync(`${SESSIONS_DIR}/${sessionId}.json`, "utf8"),
		) as BackstageSessionFile;
		return session.id === sessionId ? session : undefined;
	} catch {
		return undefined;
	}
}

export async function handleWorkspaceRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// List worktrees (optionally for a specific repo)
	if (path === "/backstage/api/worktrees" && req.method === "GET") {
		return Response.json(
			await listWorktrees(url.searchParams.get("repo") || undefined),
		);
	}

	// File/folder-mention autocomplete ("@" in the composer). Searches the
	// session's primary worktree plus any attached repos (cross-repo sessions),
	// falling back to the default repo for new-session composers with no session
	// yet. Each hit carries `insert` (what lands in the textarea: a bare path for
	// the primary repo, `<repo>:path` for an attached one — folders with a
	// trailing slash) and a `repo` label when more than one repo is in play.
	if (path === "/backstage/api/files" && req.method === "GET") {
		const q = url.searchParams.get("q") || "";
		const sessionId = url.searchParams.get("session");
		const repos: Array<{ repo: string; dir: string; primary: boolean }> =
			[];
		// Backstage sessions have an owned JSON file, so read their small record
		// directly instead of refreshing the entire cross-source session catalog.
		const session =
			findBackstageSessionForFileMentions(sessionId) ??
			(sessionId ? findSession(sessionId) : undefined);
		// Volume-mode sandbox workspaces have no host dir — the primary
		// repo's `git ls-files` runs through the sandbox exec below.
		if (
			session?.worktreeDir &&
			(existsSync(session.worktreeDir) || hasRemoteWorkspace(session))
		) {
			repos.push({
				repo:
					session.repo ||
					(session.mode === "scratch"
						? defaultRepo().id
						: repoForPath(session.worktreeDir).id),
				dir: session.worktreeDir,
				primary: true,
			});
			for (const r of session.attachedRepos || []) {
				if (existsSync(r.dir))
					repos.push({ repo: r.repo, dir: r.dir, primary: false });
			}
		}
		if (!repos.length) {
			// Sessions with a repo but no worktree (chat-only, the Desk) search
			// their repo's main checkout rather than the global default.
			const proj = getRepo(
				url.searchParams.get("repo") || session?.repo || undefined,
			);
			repos.push({ repo: proj.id, dir: proj.repo, primary: true });
		}
		// Sandbox exec only for the session's own workspace (never for the
		// main-checkout fallback, which isn't mounted in the container).
		const primaryExec =
			session && repos[0]?.primary && repos[0].dir === session.worktreeDir
				? await workspaceExecFor(session, repos[0].dir)
				: undefined;
		const multi = repos.length > 1;
		const perRepo = multi ? Math.max(6, Math.floor(20 / repos.length)) : 20;
		const out: Array<{
			display: string;
			insert: string;
			repo?: string;
			kind?: "dir";
		}> = [];
		const results = await Promise.all(
			repos.map(async (r) => {
				try {
					return await searchRepoEntries(
						r.dir,
						q,
						perRepo,
						r.primary ? primaryExec : undefined,
					);
				} catch {
					return [];
				}
			}),
		);
		for (const [index, entries] of results.entries()) {
			const r = repos[index];
			for (const f of entries) {
					// Folders insert with a trailing slash so the prompt text
					// (and the agent reading it) can tell them from files.
					const rel = f.dir ? `${f.path}/` : f.path;
					out.push({
						display: f.path,
						insert: r.primary ? rel : `${r.repo}:${rel}`,
						repo: multi ? r.repo : undefined,
						...(f.dir ? { kind: "dir" as const } : {}),
					});
			}
		}
		// "@"-mentions also surface other sessions (inserted as
		// @session:<id>) so a prompt can reference them by name — e.g.
		// "keep monitoring @session:… and @session:…". Matched on
		// title/branch/id once 2+ chars are typed (a bare "@" stays
		// files-only), newest activity first, after file hits.
		const ql = q.toLowerCase();
		const sessionHits =
			ql.length >= 2
				? peekCachedSessions()
						.filter(
							(s) =>
								!s.archived && !isLegacySideChat(s) && s.id !== sessionId,
						)
						.filter(
							(s) =>
								(s.title || "").toLowerCase().includes(ql) ||
								(s.branch || "").toLowerCase().includes(ql) ||
								s.id.toLowerCase().includes(ql),
						)
						.sort((a, b) =>
							(b.lastActivity || "").localeCompare(a.lastActivity || ""),
						)
						.slice(0, 5)
						.map((s) => ({
							display: s.title || s.branch || s.id,
							insert: `session:${s.id}`,
							kind: "session" as const,
							sub: s.branch || s.source,
						}))
				: [];
		// Teammates too (inserted as @<FirstName>) — so a prompt can reference
		// people ("ask @John about GPUs"); the humans tools resolve the name.
		const people =
			ql.length >= 1
				? configuredIdentity()
						.team.filter(
							(m) =>
								m.name.toLowerCase().includes(ql) ||
								(m.aliases || []).some((a) => a.includes(ql)),
						)
						.slice(0, 4)
						.map((m) => ({
							display: m.name,
							insert: m.name.split(" ")[0],
							kind: "person" as const,
							sub: "teammate",
						}))
				: [];
		return Response.json({
			files: [
				...out.slice(0, 24 - sessionHits.length - people.length),
				...sessionHits,
				...people,
			],
		});
	}

	// Skill/command autocomplete ("/" at the start of the composer). Lists
	// what a Claude run in the session's primary checkout would see: user
	// skills+commands (~/.claude) plus the checkout's project ones. Same
	// session/repo resolution as /api/files, primary repo only (project
	// skills load from the run's cwd, so attached repos don't apply).
	if (path === "/backstage/api/skills" && req.method === "GET") {
		const q = url.searchParams.get("q") || "";
		const sessionId = url.searchParams.get("session");
		const session = sessionId ? findSession(sessionId) : undefined;
		let dir: string | undefined =
			session?.worktreeDir && existsSync(session.worktreeDir)
				? session.worktreeDir
				: undefined;
		if (!dir) {
			const proj = getRepo(url.searchParams.get("repo") || undefined);
			if (existsSync(proj.repo)) dir = proj.repo;
		}
		// Backstage's own slash commands (/compact, /model, /goal, …) only
		// work on existing backstage sessions — handleSlashCommand runs in
		// the prompt path, not on new-session opening prompts.
		const includeBuiltins = session?.source === "backstage";
		return Response.json({
			skills: searchSkills(dir, q, undefined, includeBuiltins),
		});
	}

	// Repos available to attach / start a chat against.
	if (path === "/backstage/api/repos" && req.method === "GET") {
		return Response.json({
			repos: Object.values(REPOS).map((p) => ({
				id: p.id,
				label: p.label,
				description: p.description,
				ghRepo: p.ghRepo,
				defaultBranch: p.defaultBranch,
				sharedCheckout: !!p.sharedCheckout,
				default: !!p.default,
			})),
		});
	}

	// ── Projects (folders that group chats) ──
	// A Project is just metadata; membership lives on each chat's `projectId`.
	if (path === "/backstage/api/projects" && req.method === "GET") {
		return Response.json({ projects: listWorkspaces() });
	}

	if (path === "/backstage/api/projects" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as {
			name?: string;
			repo?: string;
			color?: string;
			user?: string;
		};
		if (!body.name || !body.name.trim())
			return Response.json({ error: "name required" }, { status: 400 });
		const project = createWorkspace({
			name: body.name,
			repo: body.repo,
			color: body.color,
			createdBy: requestUser(ctx, body.user) || "Anonymous",
		});
		return Response.json({ project });
	}

	// Resolve-or-create the ONE workspace for a PR or a Plain support ticket
	// (adopt-don't-duplicate — see workspace-resolve.ts). Sidebar PR/ticket
	// rows call this on click and then navigate to the workspace; the `name`
	// hint (ticket title) avoids a Plain API round-trip.
	if (path === "/backstage/api/workspaces/resolve" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as {
			pr?: { repo?: string; number?: number; branch?: string; title?: string };
			plainThreadId?: string;
			/** Generic feed-item linkage (docs/feeds-design.md). */
			externalRef?: { kind?: string; id?: string; url?: string; title?: string };
			name?: string;
			user?: string;
		};
		const createdBy = requestUser(ctx, body.user) || "Anonymous";
		if (body.externalRef?.kind && body.externalRef?.id) {
			const { workspace, created } = resolveExternalWorkspace({
				ref: {
					kind: body.externalRef.kind,
					id: body.externalRef.id,
					...(body.externalRef.url ? { url: body.externalRef.url } : {}),
					title: body.name || body.externalRef.title,
				},
				createdBy,
			});
			return Response.json({ workspaceId: workspace.id, created });
		}
		if (body.plainThreadId) {
			const { workspace, created } = resolvePlainWorkspace({
				threadId: body.plainThreadId,
				title: body.name,
				createdBy,
			});
			return Response.json({ workspaceId: workspace.id, created });
		}
		if (body.pr?.repo && (body.pr.number !== undefined || body.pr.branch)) {
			const resolved = await resolvePrWorkspace({
				repoId: body.pr.repo,
				number: body.pr.number,
				branch: body.pr.branch,
				title: body.pr.title,
				createdBy,
			});
			if (!resolved)
				return Response.json({ error: "PR not found" }, { status: 404 });
			return Response.json({
				workspaceId: resolved.workspace.id,
				created: resolved.created,
			});
		}
		return Response.json(
			{ error: "pr, plainThreadId or externalRef required" },
			{ status: 400 },
		);
	}

	const projectMatch = path.match(/^\/backstage\/api\/projects\/(.+)$/);
	if (projectMatch && req.method === "PATCH") {
		const id = decodeURIComponent(projectMatch[1]);
		const body = (await req.json().catch(() => ({}))) as {
			name?: string;
			repo?: string;
			color?: string;
			order?: number;
		};
		const project = updateWorkspace(id, body);
		if (!project)
			return Response.json({ error: "Project not found" }, { status: 404 });
		return Response.json({ project });
	}

	if (projectMatch && req.method === "DELETE") {
		const id = decodeURIComponent(projectMatch[1]);
		// Membership is derived from each chat's projectId — clear it so member
		// chats fall back to standalone rather than pointing at a dead folder.
		for (const s of getAllSessions()) {
			if (s.projectId === id)
				touchBackstageSession(s.id, { projectId: null });
		}
		const ok = deleteWorkspace(id);
		return Response.json({ ok });
	}

	// Start a new sibling chat: an empty chat that shares the source chat's
	// worktree, branch, repo, and project. It has no engine session yet — its
	// first prompt starts a fresh run (see runSessionPrompt). Powers the tab
	// strip's + button ("new chat in this project").
	//
	// Workspace membership is adopt-don't-duplicate: when a chat/create lands
	// on a worktree an existing workspace already owns, it joins that
	// workspace — a second workspace over the same worktree is always the
	// "clicked + and got a whole new workspace" bug. Main checkouts are
	// excluded (shared by every backstage/ask chat, so ownership is
	// meaningless there); see workspaceOwningWorktree.
	const newChatMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/new-chat$/,
	);
	if (newChatMatch && req.method === "POST") {
		const sourceId = decodeURIComponent(newChatMatch[1]);
		const src = findSession(sourceId);
		if (!src)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			user?: string;
			mode?: "share" | "stack" | "ask";
			/** Sandbox opt-in: true = config default provider, or an explicit
			 *  provider id (including "modal" / "lambda-microvm" — must be configured).
			 *  Recorded on the session file; the first prompt launches it. */
			sandbox?: boolean | string;
		};
		// share (default): reuse the workspace's worktree/branch (parallel chats,
		// one branch). stack: a new worktree branched off it (stacked PRs). ask:
		// no worktree, read-only on main. Empty chat — first prompt starts the run.
		const chatMode = body.mode || "share";
		// Volume-mode sandbox workspaces live inside ONE session's container —
		// share/stack siblings would either mint a divergent second clone at
		// the same path or ENOENT on the host. Not supported yet.
		if (hasRemoteWorkspace(src) && chatMode !== "ask")
			return Response.json(
				{
					error:
						"This chat's workspace lives inside its sandbox volume — sibling chats aren't supported for volume-mode sandboxes yet (open an Ask chat instead)",
				},
				{ status: 400 },
			);
		const bksId = `bks-${randomUUIDv7()}`;
		let branch = src.branch || "";
		let worktreeDir = src.worktreeDir || "";
		let mode: "ask" | "code" | "scratch" = src.mode || "code";
		let repoId = src.repo;
		let stackedOn: StackedOn | undefined;
		// Scratch siblings stay scratch: same repo-less scratch dir (shared
		// downloads), no branch/repo — and the repoForPath probes below must
		// not run on a scratch dir (they'd throw).
		const srcScratch = src.mode === "scratch";
		// A shared checkout (main or ask) recorded on the source isn't a real
		// workspace worktree — legacy ask/review chats point at the main
		// checkout, and copying it hands the sibling whatever branch happens to
		// be parked in that live tree (bks-019f97ec, 2026-07-25: a "+" chat in a
		// PR workspace landed on the main checkout's parked branch instead of
		// the PR's). Treat it as bare so share siblings resolve through the
		// workspace below. Shared-checkout repos (backstage) are exempt — their
		// code chats live on the main checkout by design.
		if (
			!srcScratch &&
			chatMode === "share" &&
			isSharedCheckoutDir(worktreeDir) &&
			!repoForPath(worktreeDir).sharedCheckout
		) {
			branch = "";
			worktreeDir = "";
		}
		if (srcScratch && chatMode !== "ask") {
			branch = "";
			mode = "scratch";
			repoId = undefined;
		} else if (chatMode === "ask") {
			branch = "";
			worktreeDir = "";
			mode = "ask";
		} else if (chatMode === "stack" && src.branch && src.repo) {
			const repo = getRepo(src.repo);
			if (!repo.sharedCheckout) {
				branch = `${src.branch}-stack-${bksId.slice(4, 10)}`;
				worktreeDir = await createWorktree(branch, repo.id, {
					base: src.branch,
				});
				mode = "code";
				// Remember the layer underneath so this chat's PR bases on it and
				// the pair can be linked into a GitHub stack (see pr-stack.ts).
				stackedOn = {
					repo: repo.id,
					branch: src.branch,
					...(src.source === "backstage" ? { sessionId: src.id } : {}),
				};
			}
		} else if (chatMode === "share" && !worktreeDir && src.projectId) {
			// Same workspace ⇒ same worktree: even when the source chat has no
			// worktree of its own (e.g. + from an ask tab), a share sibling
			// joins the workspace's owned worktree instead of starting bare.
			const ws = getWorkspace(src.projectId);
			if (ws?.worktreeDir && existsSync(ws.worktreeDir)) {
				branch = ws.branch || "";
				worktreeDir = ws.worktreeDir;
				mode = "code";
				repoId = repoForPath(ws.worktreeDir).id;
			} else if (ws?.branch && !getRepo(ws.repo).sharedCheckout) {
				// A workspace minted chat-less from a PR/ticket knows its branch
				// but owns no worktree yet: materialize one on that existing
				// branch so the sibling lands on the PR's code (mirrors
				// create_session's fromPr path), and stamp it as the workspace's
				// owned worktree for later siblings.
				branch = ws.branch;
				worktreeDir = await createWorktreeForExistingBranch(ws.branch, ws.repo);
				mode = "code";
				repoId = getRepo(ws.repo).id;
				updateWorkspace(ws.id, { worktreeDir });
			}
		}
		// A workspace-less source gets healed here: adopt the workspace that
		// already owns its worktree when there is one (a fresh workspace over
		// an owned worktree is the "clicked + and got a whole new workspace"
		// bug), else wrap the SOURCE in a fresh workspace and put the sibling
		// in it too, so the pair actually links up in the tab strip and
		// sidebar. Read-only sources (slack/linear files) can join an adopted
		// workspace but can't be stamped themselves.
		let workspaceId = src.projectId || null;
		if (!workspaceId) {
			const owned = workspaceOwningWorktree(src.worktreeDir);
			if (owned) {
				workspaceId = owned.id;
				if (src.source === "backstage")
					touchBackstageSession(src.id, { projectId: owned.id });
			} else if (src.source === "backstage") {
				const ws = createWorkspace({
					name: src.title || src.branch || "Workspace",
					repo: src.repo,
					createdBy: requestUser(ctx, body.user) || src.startedBy || "Anonymous",
					...(src.branch ? { branch: src.branch } : {}),
					...(src.worktreeDir ? { worktreeDir: src.worktreeDir } : {}),
				});
				touchBackstageSession(src.id, { projectId: ws.id });
				workspaceId = ws.id;
			}
		}
		// Sandbox opt-in: boolean true = config default provider; a string
		// must name a configured provider. A sibling chat's first prompt
		// launches the sandbox through the normal prompt path.
		const sandboxResolved = resolveRequestedSandbox(body.sandbox, repoId);
		if (!sandboxResolved.ok)
			return Response.json({ error: sandboxResolved.error }, { status: 400 });
		// A sibling in a ticket-linked chat/workspace stays linked to the ticket
		// (conversation tab + ticket→session mapping follow the workspace).
		const plainThreadId =
			src.plainThreadId ||
			(workspaceId ? getWorkspace(workspaceId)?.plainThreadId : undefined);
		// Feed-item linkage follows the workspace the same way (Video tab +
		// sidebar feed-row → session join — docs/feeds-design.md).
		const siblingRefs =
			src.externalRefs ||
			(workspaceId ? getWorkspace(workspaceId)?.externalRefs : undefined);
		const data: BackstageSessionFile = {
			id: bksId,
			claudeSessionId: "",
			branch,
			worktreeDir,
			...(repoId ? { repo: repoId } : {}),
			...(stackedOn ? { stackedOn } : {}),
			...(workspaceId ? { projectId: workspaceId } : {}),
			...(plainThreadId ? { plainThreadId } : {}),
			...(siblingRefs?.length ? { externalRefs: siblingRefs } : {}),
			// Siblings keep the source chat's MCP scoping (least privilege —
			// a sibling of a tella-scoped chat must not regain every server).
			...(src.mcpServers?.length ? { mcpServers: src.mcpServers } : {}),
			createdBy: requestUser(ctx, body.user) || "Anonymous",
			createdAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			title: "New chat",
			mode,
			...(sandboxResolved.provider
				? {
						sandbox: {
							provider: sandboxResolved.provider,
							// Remote providers are always volume-style (no host mounts).
							...(isRemoteSandboxProvider(sandboxResolved.provider)
								? { workspace: "volume" as const }
								: {}),
						},
					}
				: {}),
		};
		writeJsonAtomic(`${SESSIONS_DIR}/${bksId}.json`, data);
		invalidateSessionsCache();
		// Also return the full unified session so the client can drop it into
		// its session list and render the new chat instantly, instead of
		// flashing a loading screen until the next sessions poll lands.
		return Response.json({ id: bksId, session: findSession(bksId) ?? null });
	}

	// Promote an ask chat to code: create a worktree and attach it. Preserves
	// engine memory by copying the ask transcript into the new cwd's project
	// dir so the SDK resume keeps working after the cwd changes (ask chats run
	// in the main checkout; a code worktree has a different cwd-hash dir).
	const promoteMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/promote$/,
	);
	if (promoteMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(promoteMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		if (session.source !== "backstage")
			return Response.json(
				{ error: "Only backstage chats can be promoted" },
				{ status: 400 },
			);
		const body = (await req.json().catch(() => ({}))) as {
			branch?: string;
			repo?: string;
		};
		const repo = getRepo(body.repo || session.repo);
		if (repo.sharedCheckout)
			return Response.json(
				{ error: "Shared-checkout repos have no worktree to create" },
				{ status: 400 },
			);
		const branch = (
			body.branch ||
			(await suggestBranchName(session.title || "chat")) ||
			`chat-${sessionId.slice(4, 10)}`
		).trim();
		const oldCwd = session.worktreeDir || repo.repo;
		const worktreeDir = await createWorktree(branch, repo.id);
		// Best-effort: copy the ask rollout into the new worktree's hash dir so
		// SDK resume (keyed by cwd) finds the prior conversation.
		try {
			if (session.claudeSessionId) {
				const from = getTranscriptPath(oldCwd, session.claudeSessionId);
				const to = getTranscriptPath(worktreeDir, session.claudeSessionId);
				if (existsSync(from) && !existsSync(to)) {
					mkdirSync(to.slice(0, to.lastIndexOf("/")), { recursive: true });
					copyFileSync(from, to);
				}
			}
		} catch (e) {
			console.warn(`[promote] transcript copy failed for ${sessionId}:`, e);
		}
		touchBackstageSession(sessionId, {
			mode: "code",
			branch,
			worktreeDir,
			repo: repo.id,
		});
		// Materialize the workspace's worktree if it doesn't own one yet.
		if (session.projectId) {
			const ws = getWorkspace(session.projectId);
			if (ws && !ws.worktreeDir)
				updateWorkspace(ws.id, { worktreeDir, branch });
		}
		return Response.json({ ok: true, branch, worktreeDir });
	}

	// Move a chat in/out of a Project (folder). `{ projectId: null }` detaches.
	const setProjectMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/project$/,
	);
	if (setProjectMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(setProjectMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const body = (await req.json().catch(() => ({}))) as {
			projectId?: string | null;
		};
		const projectId = body.projectId ?? null;
		if (projectId && !getWorkspace(projectId))
			return Response.json({ error: "Project not found" }, { status: 404 });
		touchBackstageSession(sessionId, { projectId });
		return Response.json({ ok: true, projectId });
	}

	// Attach a secondary repo to a session (cross-repo work): creates/reuses an
	// isolated worktree and records it on the session.
	const attachMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/attach-repo$/,
	);
	if (attachMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(attachMatch[1]);
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
			branch?: string;
		};
		if (!body.repo)
			return Response.json({ error: "repo required" }, { status: 400 });
		try {
			const { attached, all } = await attachRepo(
				sessionId,
				body.repo,
				body.branch,
			);
			return Response.json({ ok: true, attached, attachedRepos: all });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// Is this session fresh enough to switch its primary repo? Drives the
	// clean-only, silent switcher in the RepoBar — no work means no footgun.
	const switchableMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/repo-switchable$/,
	);
	if (switchableMatch && req.method === "GET") {
		const sessionId = decodeURIComponent(switchableMatch[1]);
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		// `switchable`: this session type can switch its primary repo at all
		// (ask sessions read the shared checkout — nothing to switch).
		// `hasWork`: it already has commits/edits, so the UI confirms before
		// switching (the work stays in the old worktree, not carried over).
		// Scratch sessions are repo-less — nothing to switch either.
		const switchable = session.mode !== "ask" && session.mode !== "scratch";
		const hasWork =
			switchable &&
			!!session.worktreeDir &&
			!!session.branch &&
			(await worktreeHasWork(
				session.worktreeDir,
				session.branch,
				session.repo,
			));
		return Response.json({ switchable, hasWork });
	}

	// Switch the session's PRIMARY repo (wrong repo picked at creation).
	// Rejects with 400 if the session has work unless `force` is set; the
	// old worktree is left on disk either way, so work is never destroyed.
	const switchMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/switch-primary-repo$/,
	);
	if (switchMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(switchMatch[1]);
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
			force?: boolean;
		};
		if (!body.repo)
			return Response.json({ error: "repo required" }, { status: 400 });
		try {
			const result = await switchPrimaryRepo(
				sessionId,
				body.repo,
				!!body.force,
			);
			return Response.json({ ok: true, ...result });
		} catch (e: any) {
			return Response.json(
				{ error: e.message || String(e) },
				{ status: 400 },
			);
		}
	}

	// Detach a secondary repo (drops it from the session; leaves the worktree on
	// disk so unmerged work isn't lost — clean it up via the worktrees sweep).
	// POST, not DELETE, so it isn't swallowed by the generic DELETE /sessions/:id.
	const detachMatch = path.match(
		/^\/backstage\/api\/sessions\/(.+)\/detach-repo$/,
	);
	if (detachMatch && req.method === "POST") {
		const sessionId = decodeURIComponent(detachMatch[1]);
		const body = (await req.json().catch(() => ({}))) as {
			repo?: string;
		};
		const session = findSession(sessionId);
		if (!session)
			return Response.json({ error: "Session not found" }, { status: 404 });
		const all = (session.attachedRepos || []).filter(
			(r) => r.repo !== body.repo,
		);
		touchBackstageSession(sessionId, { attachedRepos: all });
		return Response.json({ ok: true, attachedRepos: all });
	}

	return undefined;
}
