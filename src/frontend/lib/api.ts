import { BASE_PATH } from "./base";
import type {
	UnifiedSession,
	SlackChannelLink,
	SlackMessage,
	ChatMessage,
	ChatImage,
	PlainThread,
	PlainWorkspaceUser,
	PlainLabelType,
	SupportThread,
	Project,
} from "./types";

const BASE = `${BASE_PATH}/api`;

/** API base for building direct resource URLs (e.g. <img src> endpoints). */
export const API_BASE = BASE;

/** Single error shape for every API failure: HTTP status + the server's
 * `error` field when it sent one (else a "<label>: <status>" message). */
export class ApiError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

/**
 * The one request helper behind every wrapper below. Checks `res.ok` BEFORE
 * touching the body — so an HTML 502 during a server restart surfaces as a
 * useful ApiError instead of `SyntaxError: Unexpected token '<'` — and parses
 * JSON defensively (a bodyless 204/500 just yields null).
 */
async function request<T>(
	path: string,
	opts: {
		method?: string;
		/** JSON-encoded and sent with a Content-Type header when present. */
		body?: unknown;
		signal?: AbortSignal;
		/** Error-message prefix when the server didn't provide an `error` field. */
		label?: string;
	} = {},
): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: opts.method || "GET",
		signal: opts.signal,
		...(opts.body !== undefined
			? {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(opts.body),
				}
			: {}),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new ApiError(
			body?.error || `${opts.label || "Failed"}: ${res.status}`,
			res.status,
		);
	}
	return (await res.json().catch(() => null)) as T;
}

/**
 * Raw JSON text of the sessions list. useSessions polls this so it can compare
 * the response text against the previous poll and skip the state update (and
 * the app-wide re-render) entirely when nothing changed.
 */
export async function fetchSessionsText(): Promise<string> {
	const res = await fetch(`${BASE}/sessions`);
	if (!res.ok)
		throw new ApiError(`Failed to fetch sessions: ${res.status}`, res.status);
	return res.text();
}

export async function fetchSessions(): Promise<UnifiedSession[]> {
	return request<UnifiedSession[]>("/sessions", {
		label: "Failed to fetch sessions",
	});
}

/** One open PR from the batched repo-wide list (session or not). */
export interface OpenPr {
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
	checks: { total: number; passed: number; failed: number; pending: number };
	/** Person keys of teammates with a pending review request on this PR. */
	reviewRequested?: string[];
}

/** Every open PR in the repo, attributed to teammates by GitHub author. */
export async function fetchOpenPrs(): Promise<OpenPr[]> {
	const data = await request<{ prs: OpenPr[] }>("/open-prs", {
		label: "Failed to fetch open PRs",
	});
	return data?.prs || [];
}

// ── PR Tinder (one-at-a-time triage of open tella-fusion PRs) ───────────────

/** One card in the PR Tinder deck — richer than OpenPr (body, labels, diffstat). */
export interface TinderPr {
	number: number;
	title: string;
	url: string;
	author: string;
	isDraft: boolean;
	createdAt: string;
	updatedAt: string;
	labels: Array<{ name: string; color: string }>;
	body: string;
	reviewDecision: string;
	additions: number;
	deletions: number;
	changedFiles: number;
}

export interface TinderDeck {
	prs: TinderPr[];
	labels: Array<{ name: string; color: string }>;
	/** PR numbers this user already kept (within the server's 14-day TTL). */
	seen: number[];
}

export async function fetchTinderDeck(user: string): Promise<TinderDeck> {
	return request<TinderDeck>(`/pr-tinder?user=${encodeURIComponent(user)}`, {
		label: "Failed to fetch PR Tinder deck",
	});
}

function tinderAction<T = { ok: true }>(
	number: number,
	action: string,
	body: Record<string, unknown> = {},
): Promise<T> {
	return request<T>(`/pr-tinder/${number}/${action}`, {
		method: "POST",
		body,
		label: `PR ${action} failed`,
	});
}

export const keepTinderPr = (number: number, user: string) =>
	tinderAction(number, "keep", { user });
export const unkeepTinderPr = (number: number, user: string) =>
	tinderAction(number, "unkeep", { user });
export const closeTinderPr = (number: number, reason?: string) =>
	tinderAction(number, "close", { reason });
export const reopenTinderPr = (number: number) =>
	tinderAction(number, "reopen");
export const commentTinderPr = (number: number, body: string, user: string) =>
	tinderAction<{ ok: true; commentId?: number }>(number, "comment", {
		body,
		user,
	});
export const uncommentTinderPr = (
	number: number,
	commentId: number,
	user: string,
) => tinderAction(number, "uncomment", { commentId, user });
export const labelTinderPr = (
	number: number,
	opts: { add?: string; remove?: string },
) => tinderAction(number, "labels", opts);

export interface TranscriptMatch {
	id: string;
	snippet: string;
}

/** Full-text search across session transcripts (⌘K "search in conversations"). */
export async function searchTranscripts(
	q: string,
	signal?: AbortSignal,
): Promise<TranscriptMatch[]> {
	const data = await request<{ matches?: TranscriptMatch[] }>(
		`/sessions/search?q=${encodeURIComponent(q)}`,
		{ signal, label: "Transcript search failed" },
	);
	return data?.matches ?? [];
}

export interface PreviewService {
	name: string;
	key: string;
	port: number;
	running: boolean;
	pids: number[];
}

export interface PreviewStatus {
	hasPortsConf: boolean;
	webappPort: number | null;
	running: boolean;
	starting: boolean;
	previewUrl: string | null;
	/** Whether the repo has any bring-up mechanism (committed
	 *  .backstage/start.sh, configured previewCommand, or the tella-local
	 *  fallback). Absent on servers that predate the field — treat as true. */
	bootable?: boolean;
	services: PreviewService[];
}

export async function fetchPreview(sessionId: string): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview`,
		{ label: "Failed to fetch preview" },
	);
}

export async function startPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview/start`,
		{ method: "POST", label: "Failed to start preview" },
	);
}

export async function stopPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	return request<PreviewStatus>(
		`/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
		{ method: "POST", label: "Failed to stop preview" },
	);
}

/** Screenshot the session's running preview; resolves to a data: URL (PNG). */
export async function capturePreviewShot(sessionId: string): Promise<string> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/screenshot`,
		{ method: "POST" },
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new ApiError(body?.error || `Screenshot failed: ${res.status}`, res.status);
	}
	const blob = await res.blob();
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error("Failed to read screenshot"));
		reader.readAsDataURL(blob);
	});
}

export async function fetchTranscript(sessionId: string) {
	return request<any>(
		`/sessions/${encodeURIComponent(sessionId)}/transcript`,
		{ label: "Failed to fetch transcript" },
	);
}

/** One media item in the workspace-overview panel. Image srcs are lazy-load
 * refs served by /sessions/:id/transcript-image; videos stream from
 * <base>/media. */
export interface WorkspaceMediaItem {
	kind: "image" | "video";
	src: string;
	sessionId: string;
	chatTitle?: string;
	at: string;
}

export interface WorkspaceOverview {
	prompt: { content: string; sessionId: string; at: string } | null;
	/** Latest assistant text across the workspace's chats. Optional because a
	 *  server that hasn't restarted onto the new overview code omits the key. */
	lastMessage?: { content: string; sessionId: string; at: string } | null;
	media: WorkspaceMediaItem[];
}

/** Opening prompt + all media across a workspace's chats (the floating
 * preview panel in the session viewer). */
export async function fetchWorkspaceOverview(
	wsId: string,
): Promise<WorkspaceOverview> {
	return request<WorkspaceOverview>(
		`/workspaces/${encodeURIComponent(wsId)}/overview`,
		{ label: "Failed to fetch workspace overview" },
	);
}

export interface SubagentTranscript {
	meta: {
		agentId: string;
		agentType?: string;
		description?: string;
		toolUseId?: string;
		spawnDepth?: number;
	};
	entries: import("./types").TranscriptEntry[];
	sessionRunning: boolean;
}

export async function fetchSubagent(
	sessionId: string,
	agentId: string,
): Promise<SubagentTranscript> {
	return request<SubagentTranscript>(
		`/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`,
		{ label: "Failed to fetch sub-agent" },
	);
}

/** A single "@"-mention suggestion. `insert` is what lands in the textarea. */
export interface FileMention {
	/** Repo-relative path (files) or session title (sessions), for display. */
	display: string;
	/** Text inserted after the "@": path, `repo:path`, or `session:<id>`. */
	insert: string;
	/** Repo label, set only when more than one repo is searched (cross-repo). */
	repo?: string;
	/** Entry type; absent means a file. */
	kind?: "session" | "skill";
	/** Subtitle for non-file entries (e.g. a session's branch, a skill's description). */
	sub?: string;
}

/**
 * File suggestions for "@"-mention autocomplete in the composer. Searches the
 * session's primary checkout plus any attached repos when `sessionId` is given;
 * otherwise the given `repo`'s checkout (used by the New-session prompt, which
 * has no session yet), falling back to the default repo.
 */
export async function fetchFileMentions(
	query: string,
	sessionId?: string,
	repo?: string,
): Promise<FileMention[]> {
	const params = new URLSearchParams({ q: query });
	if (sessionId) params.set("session", sessionId);
	else if (repo) params.set("repo", repo);
	try {
		const data = await request<{ files?: FileMention[] }>(
			`/files?${params.toString()}`,
		);
		return data?.files ?? [];
	} catch (e) {
		console.warn("fetchFileMentions failed:", e);
		return [];
	}
}

/**
 * Skill/command suggestions for the "/" trigger in the composer. Lists what a
 * Claude run in the session's checkout would see (user + project skills and
 * commands); `repo` is the fallback for composers with no session yet.
 */
export async function fetchSkillMentions(
	query: string,
	sessionId?: string,
	repo?: string,
): Promise<FileMention[]> {
	const params = new URLSearchParams({ q: query });
	if (sessionId) params.set("session", sessionId);
	else if (repo) params.set("repo", repo);
	try {
		const data = await request<{
			skills?: Array<{ name: string; description: string; source: string }>;
		}>(`/skills?${params.toString()}`);
		return (data?.skills ?? []).map((s) => ({
			display: s.name,
			insert: s.name,
			kind: "skill" as const,
			sub: s.description,
		}));
	} catch (e) {
		console.warn("fetchSkillMentions failed:", e);
		return [];
	}
}

export interface RepoInfo {
	id: string;
	defaultBranch: string;
	sharedCheckout: boolean;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
	try {
		const data = await request<{ repos?: RepoInfo[] }>("/repos");
		return data?.repos ?? [];
	} catch (e) {
		console.warn("fetchRepos failed:", e);
		return [];
	}
}

// ── Projects (folders that group chats) ──

export async function fetchProjects(): Promise<Project[]> {
	try {
		const data = await request<{ projects?: Project[] }>("/projects");
		return data?.projects ?? [];
	} catch (e) {
		console.warn("fetchProjects failed:", e);
		return [];
	}
}

export async function createProjectApi(input: {
	name: string;
	repo?: string;
	color?: string;
	user: string;
}): Promise<Project> {
	const body = await request<{ project: Project }>("/projects", {
		method: "POST",
		body: input,
	});
	return body.project;
}

export async function updateProjectApi(
	id: string,
	patch: {
		name?: string;
		repo?: string;
		/** null clears the swatch color. */
		color?: string | null;
		order?: number;
	},
): Promise<Project> {
	const body = await request<{ project: Project }>(
		`/projects/${encodeURIComponent(id)}`,
		{ method: "PATCH", body: patch },
	);
	return body.project;
}

export async function deleteProjectApi(id: string): Promise<void> {
	await request<void>(`/projects/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete project",
	});
}

/**
 * Start a new sibling chat in the source chat's workspace. Returns the new
 * chat's id plus its full session object (so the caller can render it
 * immediately, without waiting for the next sessions poll); it has no run yet —
 * its first prompt starts fresh. `mode` picks the worktree relationship: share
 * the workspace worktree (default), stack a new worktree branched off it, or
 * ask (no worktree).
 */
export async function newChatApi(
	sourceId: string,
	user: string,
	mode?: "share" | "stack" | "ask",
): Promise<{ id: string; session: UnifiedSession | null }> {
	const body = await request<{ id: string; session?: UnifiedSession }>(
		`/sessions/${encodeURIComponent(sourceId)}/new-chat`,
		{ method: "POST", body: { user, ...(mode ? { mode } : {}) } },
	);
	return { id: body.id, session: body.session || null };
}

/**
 * Promote an ask chat to code: create a worktree and attach it (also
 * materializes the workspace's worktree if it doesn't own one yet). Returns the
 * new branch + worktree dir.
 */
export async function promoteChatApi(
	sessionId: string,
	opts?: { branch?: string; repo?: string },
): Promise<{ branch: string; worktreeDir: string }> {
	return request<{ branch: string; worktreeDir: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/promote`,
		{ method: "POST", body: opts || {} },
	);
}

/** Move a chat into a project (or `null` to make it standalone). */
export async function setSessionProjectApi(
	sessionId: string,
	projectId: string | null,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/project`, {
		method: "POST",
		body: { projectId },
	});
}

export interface AttachedRepo {
	repo: string;
	branch: string;
	dir: string;
}

export async function attachRepoApi(
	sessionId: string,
	repo: string,
	branch?: string,
): Promise<AttachedRepo[]> {
	const body = await request<{ attachedRepos: AttachedRepo[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/attach-repo`,
		{ method: "POST", body: { repo, ...(branch ? { branch } : {}) } },
	);
	return body.attachedRepos;
}

export async function detachRepoApi(
	sessionId: string,
	repo: string,
): Promise<AttachedRepo[]> {
	const body = await request<{ attachedRepos: AttachedRepo[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/detach-repo`,
		{ method: "POST", body: { repo } },
	);
	return body.attachedRepos;
}

// Can this session switch its primary repo, and does it already have work?
// `switchable` is false only for ask sessions; `hasWork` means the UI should
// confirm first (the current changes stay in the old worktree, not carried over).
export async function fetchRepoSwitchable(
	sessionId: string,
): Promise<{ switchable: boolean; hasWork: boolean }> {
	try {
		const body = await request<{ switchable?: boolean; hasWork?: boolean }>(
			`/sessions/${encodeURIComponent(sessionId)}/repo-switchable`,
		);
		return { switchable: !!body?.switchable, hasWork: !!body?.hasWork };
	} catch (e) {
		console.warn("fetchRepoSwitchable failed:", e);
		return { switchable: false, hasWork: false };
	}
}

// Switch the session's PRIMARY repo (wrong repo picked at creation). Returns the
// new primary repo + branch; the next prompt runs from the new worktree. Pass
// force to switch past existing work (it stays in the old worktree on disk).
export async function switchPrimaryRepoApi(
	sessionId: string,
	repo: string,
	force = false,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	return request<{ repo: string; branch: string; worktreeDir: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/switch-primary-repo`,
		{ method: "POST", body: { repo, force } },
	);
}

// ── Linked Slack channels ──

export async function linkChannelApi(
	sessionId: string,
	opts: { mode: "create" | "existing"; name?: string; channelId?: string },
): Promise<SlackChannelLink> {
	const body = await request<{ slackChannel: SlackChannelLink }>(
		`/sessions/${encodeURIComponent(sessionId)}/link-channel`,
		{ method: "POST", body: opts },
	);
	return body.slackChannel;
}

export async function unlinkChannelApi(sessionId: string): Promise<void> {
	await request<void>(
		`/sessions/${encodeURIComponent(sessionId)}/unlink-channel`,
		{ method: "POST" },
	);
}

export async function fetchChannelHistoryApi(
	sessionId: string,
): Promise<SlackMessage[]> {
	const body = await request<{ messages?: SlackMessage[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/channel/history`,
		{ label: "Failed to fetch history" },
	);
	return Array.isArray(body?.messages) ? body.messages : [];
}

export async function fetchPlainThreadApi(
	sessionId: string,
): Promise<PlainThread | null> {
	const body = await request<{ thread?: PlainThread }>(
		`/sessions/${encodeURIComponent(sessionId)}/plain/thread`,
	);
	return body?.thread || null;
}

/** The Support sidebar's queue: TODO Plain threads, newest status change first. */
export async function fetchSupportThreads(): Promise<SupportThread[]> {
	const body = await request<{ threads?: SupportThread[] }>("/plain/threads", {
		label: "Failed to fetch support threads",
	});
	return body?.threads || [];
}

/** A Plain thread's conversation by thread id (the session-less Support preview). */
export async function fetchPlainThreadById(
	threadId: string,
): Promise<PlainThread | null> {
	const body = await request<{ thread?: PlainThread }>(
		`/plain/threads/${encodeURIComponent(threadId)}`,
	);
	return body?.thread || null;
}

/**
 * Send a human-written message into a Plain thread: a customer-facing reply
 * (email/chat via Plain) or an internal note for the team.
 */
export async function sendPlainReplyApi(
	threadId: string,
	text: string,
	kind: "reply" | "note",
	user: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/reply`,
		{ method: "POST", body: { text, kind, user }, label: "Failed to send" },
	);
}

/** Quick status change on a Plain thread: Todo / Snoozed / Done. */
export async function setPlainThreadStatusApi(
	threadId: string,
	status: "todo" | "done" | "snoozed",
	opts: { durationSeconds?: number; user?: string } = {},
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/status`,
		{
			method: "POST",
			body: { status, ...opts },
			label: "Failed to update status",
		},
	);
}

/** Change a Plain thread's priority (0 = Urgent … 3 = Low). */
export async function setPlainThreadPriorityApi(
	threadId: string,
	priority: number,
	user?: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/priority`,
		{
			method: "POST",
			body: { priority, user },
			label: "Failed to update priority",
		},
	);
}

/**
 * Mark the customer behind a Plain thread as spam (also closes the thread),
 * or undo the spam mark.
 */
export async function setPlainThreadSpamApi(
	threadId: string,
	spam: boolean,
	user?: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/spam`,
		{
			method: "POST",
			body: { spam, user },
			label: "Failed to update spam status",
		},
	);
}

/** Assign a Plain thread to a workspace user, or unassign (userId = null). */
export async function setPlainThreadAssigneeApi(
	threadId: string,
	userId: string | null,
	user?: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/assign`,
		{
			method: "POST",
			body: { userId, user },
			label: "Failed to assign",
		},
	);
}

/** Add/remove labels on a Plain thread (adds = label-type ids, removes = label ids). */
export async function changePlainThreadLabelsApi(
	threadId: string,
	changes: { addLabelTypeIds?: string[]; removeLabelIds?: string[] },
	user?: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/labels`,
		{
			method: "POST",
			body: { ...changes, user },
			label: "Failed to update labels",
		},
	);
}

/** Rename a Plain thread. */
export async function setPlainThreadTitleApi(
	threadId: string,
	title: string,
	user?: string,
): Promise<void> {
	await request<{ ok: boolean }>(
		`/plain/threads/${encodeURIComponent(threadId)}/title`,
		{
			method: "POST",
			body: { title, user },
			label: "Failed to rename",
		},
	);
}

/** Plain workspace users (Assign menu). Server-cached; alias accounts filtered. */
export async function fetchPlainUsersApi(): Promise<PlainWorkspaceUser[]> {
	const body = await request<{ users?: PlainWorkspaceUser[] }>(
		"/plain/users",
		{ label: "Failed to fetch Plain users" },
	);
	return body?.users || [];
}

/** Plain's active label types (Labels menu). Server-cached. */
export async function fetchPlainLabelTypesApi(): Promise<PlainLabelType[]> {
	const body = await request<{ labelTypes?: PlainLabelType[] }>(
		"/plain/label-types",
		{ label: "Failed to fetch label types" },
	);
	return body?.labelTypes || [];
}

/**
 * Start (or reuse) a triage session for a Plain thread — runs the "Plain
 * ticket triage" automation. Slow (~15-60s) when it has to boot a fresh run.
 */
export async function startPlainTriageApi(threadId: string): Promise<string> {
	const body = await request<{ sessionId: string }>(
		`/plain/triage/${encodeURIComponent(threadId)}`,
		{ method: "POST", label: "Failed to start triage" },
	);
	return body.sessionId;
}

export async function postChannelMessageApi(
	sessionId: string,
	text: string,
	user: string,
): Promise<SlackMessage> {
	const body = await request<{ message: SlackMessage }>(
		`/sessions/${encodeURIComponent(sessionId)}/channel/message`,
		{ method: "POST", body: { text, user } },
	);
	return body.message;
}

// ── Native team chat (Watercooler + per-session Chat tabs — not Slack) ──

export async function fetchChatMessagesApi(
	channel: string,
): Promise<ChatMessage[]> {
	const body = await request<{ messages?: ChatMessage[] }>(
		`/chat/messages?channel=${encodeURIComponent(channel)}`,
		{ label: "Failed to fetch chat" },
	);
	return Array.isArray(body?.messages) ? body.messages : [];
}

export async function postChatMessageApi(
	channel: string,
	text: string,
	user: string,
	images?: ChatImage[],
	opts?: {
		/** Post into this message's thread (Slack-style thread reply). */
		threadId?: string;
		/** Quote this message above the new one (Slack-style "reply"). */
		replyTo?: import("./types").ChatReplyTo;
	},
): Promise<ChatMessage> {
	const body = await request<{ message: ChatMessage }>("/chat/messages", {
		method: "POST",
		body: {
			channel,
			text,
			user,
			images: images ?? [],
			...(opts?.threadId ? { threadId: opts.threadId } : {}),
			...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
		},
		label: "Failed to send",
	});
	return body.message;
}

/** Toggle the caller's emoji reaction on a message; resolves to the updated
 *  message (the server also broadcasts it to every client). */
export async function toggleChatReactionApi(
	channel: string,
	messageId: string,
	emoji: string,
	user: string,
): Promise<ChatMessage> {
	const body = await request<{ message: ChatMessage }>("/chat/react", {
		method: "POST",
		body: { channel, messageId, emoji, user },
		label: "Failed to react",
	});
	return body.message;
}

/** Stream an image to permanent chat storage; resolves to its {id,name,mime} ref. */
export async function uploadChatImageApi(file: File): Promise<ChatImage> {
	const res = await fetch(`${BASE}/chat/upload`, {
		method: "POST",
		headers: {
			"x-file-name": encodeURIComponent(file.name),
			"content-type": file.type || "application/octet-stream",
		},
		body: file,
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok || !body?.ok || !body?.id)
		throw new Error(body?.error || `Upload failed (${res.status})`);
	return { id: body.id, name: body.name || file.name, mime: body.mime };
}

/** URL that serves a stored chat image's bytes. */
export function chatImageUrl(id: string): string {
	return `${BASE}/chat/image/${id}`;
}

export async function fetchWorktrees(repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<any>(`/worktrees${qs}`, {
		label: "Failed to fetch worktrees",
	});
}

export async function deleteSessionApi(
	sessionId: string,
	cleanWorktree: boolean,
): Promise<void> {
	const params = cleanWorktree ? "?worktree=true" : "";
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}${params}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function fetchDiff(
	sessionId: string,
): Promise<import("./types").SessionDiffResponse> {
	return request<import("./types").SessionDiffResponse>(
		`/sessions/${encodeURIComponent(sessionId)}/diff`,
		{ label: "Failed to fetch diff" },
	);
}

/**
 * Discard one file's changes in a session worktree (hover action on a diff
 * row). Resets the file to its base-branch state so it drops out of the diff.
 * `repo` targets an attached repo; omit for the primary. Destructive.
 */
export async function discardDiffFile(
	sessionId: string,
	path: string,
	repo?: string,
	oldPath?: string,
): Promise<void> {
	await request(`/sessions/${encodeURIComponent(sessionId)}/discard-file`, {
		method: "POST",
		body: { path, ...(repo ? { repo } : {}), ...(oldPath ? { oldPath } : {}) },
		label: "Failed to discard file",
	});
}

/** Query string targeting one of a session's PRs: `repo` (a repo id) targets an
 *  attached repo's PR, `repo`+`branch` a linked PR; both omitted = primary. */
function prTargetQs(repo?: string, branch?: string) {
	const params = new URLSearchParams();
	if (repo) params.set("repo", repo);
	if (branch) params.set("branch", branch);
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

export async function fetchPr(sessionId: string, repo?: string, branch?: string) {
	const qs = prTargetQs(repo, branch);
	return request<any>(`/sessions/${encodeURIComponent(sessionId)}/pr${qs}`, {
		label: "Failed to fetch PR",
	});
}

/** Local git state (ahead/behind, dirty tree) for the status header. */
export async function fetchGitStatus(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	return request<import("./types").GitStatusInfo | null>(
		`/sessions/${encodeURIComponent(sessionId)}/git-status${qs}`,
		{ label: "Failed to fetch git status" },
	);
}

/** Push the session's branch (sets upstream on first push). */
export async function gitPushApi(sessionId: string, repo?: string) {
	return request<{ ok: true }>(
		`/sessions/${encodeURIComponent(sessionId)}/git-push`,
		{ method: "POST", body: repo ? { repo } : {} },
	);
}

/** Fast-forward the session's checkout (`git pull --ff-only`); `fromBase` pulls
 * origin/<default branch> instead of the branch's upstream. */
export async function gitPullApi(
	sessionId: string,
	repo?: string,
	fromBase?: boolean,
) {
	return request<{ ok: true }>(
		`/sessions/${encodeURIComponent(sessionId)}/git-pull`,
		{
			method: "POST",
			body: { ...(repo ? { repo } : {}), ...(fromBase ? { base: true } : {}) },
		},
	);
}

export async function fetchPrDiff(sessionId: string, repo?: string, branch?: string) {
	const qs = prTargetQs(repo, branch);
	return request<any>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-diff${qs}`,
		{ label: "Failed to fetch PR diff" },
	);
}

/** AI review guide for the PR's Guide view — slow on first call per head commit. */
export async function fetchReviewGuide(sessionId: string, repo?: string, branch?: string) {
	const qs = prTargetQs(repo, branch);
	return request<any>(
		`/sessions/${encodeURIComponent(sessionId)}/review-guide${qs}`,
		{ label: "Failed to fetch review guide" },
	);
}

/** Link a PR to a session by URL (shows beside the branch-derived PRs). */
export async function linkPrApi(sessionId: string, url: string) {
	type LinkedPr = NonNullable<
		import("./types").UnifiedSession["linkedPrs"]
	>[number];
	return request<{ ok: true; linked: LinkedPr; all: LinkedPr[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/link-pr`,
		{ method: "POST", body: { url }, label: "Failed to link PR" },
	);
}

/** Drop a linked PR from a session (the link only — the PR is untouched). */
export async function unlinkPrApi(sessionId: string, repo: string, branch: string) {
	type LinkedPr = NonNullable<
		import("./types").UnifiedSession["linkedPrs"]
	>[number];
	return request<{ ok: true; all: LinkedPr[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/unlink-pr`,
		{ method: "POST", body: { repo, branch }, label: "Failed to unlink PR" },
	);
}

/** Session-less PR details for the sidebar's PR preview (keyed by repo+branch). */
export async function fetchPrPreview(repo: string, branch: string) {
	return request<any>(
		`/pr-preview?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
		{ label: "Failed to fetch PR" },
	);
}

export async function fetchPrPreviewDiff(repo: string, branch: string) {
	return request<any>(
		`/pr-preview-diff?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`,
		{ label: "Failed to fetch PR diff" },
	);
}

export async function postPrCommentApi(
	sessionId: string,
	payload: {
		text: string;
		user: string;
		path?: string;
		line?: number;
		startLine?: number;
		side?: "RIGHT" | "LEFT";
		repo?: string;
		branch?: string;
	},
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-comment`,
		{ method: "POST", body: payload },
	);
}

export async function submitPrReviewApi(
	sessionId: string,
	payload: {
		user: string;
		event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
		summary?: string;
		repo?: string;
		branch?: string;
		comments: Array<{
			text: string;
			path: string;
			line: number;
			startLine?: number;
			side?: "RIGHT" | "LEFT";
			startSide?: "RIGHT" | "LEFT";
		}>;
	},
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-review`,
		{ method: "POST", body: payload },
	);
}

export async function mergePrApi(
	sessionId: string,
	method: "squash" | "merge" | "rebase" = "squash",
	repo?: string,
	branch?: string,
) {
	return request<{ ok: true; url?: string }>(
		`/sessions/${encodeURIComponent(sessionId)}/pr-merge`,
		{
			method: "POST",
			body: {
				method,
				...(repo ? { repo } : {}),
				...(branch ? { branch } : {}),
			},
		},
	);
}

/** GitHub PR agent behaviors (the opensession-* PR labels) fired straight from the
    info panel: review / auto-fix / simplify / adversarial. tella-fusion only. */
export type PrAgentAction = "review" | "autofix" | "simplify" | "adversarial";

export async function triggerPrActionApi(
	sessionId: string,
	kind: PrAgentAction,
	user: string,
	repo?: string,
) {
	return request<{
		ok: boolean;
		message?: string;
		url?: string;
		bksId?: string;
		error?: string;
		/** Auto-fix opens a live chat in the workspace instead of a headless PR run —
		    the caller navigates into bksId rather than showing a "posted on the PR" note. */
		openChat?: boolean;
	}>(`/sessions/${encodeURIComponent(sessionId)}/pr-action`, {
		method: "POST",
		body: { kind, user, ...(repo ? { repo } : {}) },
	});
}

// ── Automations ──

export interface ModelOption {
	id: string;
	provider: "claude" | "codex" | "opencode";
	label: string;
	aliases: string[];
}

/**
 * Ask the backend (a quick Haiku call) to suggest a branch name for a task
 * prompt. Returns null when the prompt is too thin or anything fails — callers
 * just leave the field for the user to fill.
 */
export async function suggestBranch(prompt: string): Promise<string | null> {
	try {
		const data = await request<{ branch?: unknown }>("/suggest-branch", {
			method: "POST",
			body: { prompt },
		});
		return typeof data?.branch === "string" ? data.branch : null;
	} catch {
		return null;
	}
}

/** Voice dictation: send a recorded clip (raw body), get the transcript back.
 * Bypasses `request` — the body is audio bytes, not JSON. */
export async function transcribeClip(audio: Blob): Promise<string> {
	const res = await fetch(`${BASE}/transcribe`, {
		method: "POST",
		headers: { "Content-Type": audio.type || "audio/webm" },
		body: audio,
	});
	const data = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null;
	if (!res.ok) {
		throw new ApiError(
			typeof data?.error === "string" ? data.error : `Transcribe: ${res.status}`,
			res.status,
		);
	}
	return typeof data?.text === "string" ? data.text : "";
}

export async function fetchModels(): Promise<{
	models: ModelOption[];
	default: string;
}> {
	return request<{ models: ModelOption[]; default: string }>("/models", {
		label: "Failed to fetch models",
	});
}

/** One append block of the session system prompt (claude_code preset + these). */
export interface SystemPromptPart {
	title: string;
	text: string;
}

export async function fetchSystemPrompt(mode: "ask" | "code"): Promise<{
	preset: string;
	settingSources: string[];
	parts: SystemPromptPart[];
}> {
	return request(`/system-prompt?mode=${mode}`, {
		label: "Failed to fetch system prompt",
	});
}

/** Trimmed Claude subscription shape for the per-session subscription picker. */
export interface ClaudeAccountOption {
	id: string;
	name: string;
	/** Personal-sub owner, if any (else it's a shared-pool account). */
	owner?: string;
	/** False when the account is currently exhausted / over its cap. */
	usable: boolean;
}

export async function fetchClaudeAccounts(): Promise<ClaudeAccountOption[]> {
	try {
		const data = await request<{ accounts?: any[] }>("/claude-accounts");
		return (data?.accounts ?? []).map((a) => ({
			id: a.id,
			name: a.name,
			owner: a.owner || undefined,
			usable: a.usable !== false,
		}));
	} catch {
		return [];
	}
}

export async function fetchAutomations() {
	return request<any>("/automations", {
		label: "Failed to fetch automations",
	});
}

export interface AutomationTemplate {
	id: string;
	name: string;
	description: string;
	category: "sweep" | "digest" | "investigator" | "triage" | "hygiene";
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

export async function fetchAutomationTemplates(): Promise<AutomationTemplate[]> {
	const res = await fetch(`${BASE}/automation-templates`);
	if (!res.ok) throw new Error(`Failed to fetch templates: ${res.status}`);
	return res.json();
}

export interface AutomationDraft {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

/** Draft an automation config from a free-text description (backend Haiku
 *  call). Throws with a friendly message when the draft fails. */
export async function draftAutomationApi(description: string): Promise<AutomationDraft> {
	const res = await fetch(`${BASE}/automations/draft`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ description }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

/** MCP server list + agent health, for pickers (Automations) and Settings. */
export async function fetchConnections(): Promise<{
	mcpServers: Array<{ name: string; status: string; allowedUsers?: string[] }>;
	agents: Record<string, unknown>;
}> {
	const res = await fetch(`${BASE}/connections`);
	if (!res.ok) throw new Error(`Failed to fetch connections: ${res.status}`);
	return res.json();
}

/** One row of the model-family × environment support matrix — a verbatim
 *  mirror of SANDBOX_MODEL_FAMILIES (src/server/sandbox/config.ts, the single
 *  source of truth). The client only APPLIES the first-match-wins rules; it
 *  never hardcodes a model/environment combo of its own. */
export interface SandboxModelFamilyInfo {
	id: string;
	label: string;
	match: { provider: "claude" | "codex" | "opencode"; idPrefix?: string };
	environments: Record<"local" | "docker" | "daytona" | "e2b", boolean>;
	hint?: string;
}

/** Sandbox capability status for the New-session provider picker
 *  (GET /api/sandbox/status — read fresh server-side per call). */
export interface SandboxStatusInfo {
	enabled: boolean;
	defaultProvider: string;
	providers: Array<{
		id: "docker" | "daytona" | "e2b";
		configured: boolean;
		note?: string;
	}>;
	killSwitch: boolean;
	/** Absent on a pre-upgrade server = no client-side combo warnings. */
	modelFamilies?: SandboxModelFamilyInfo[];
}

export async function fetchSandboxStatus(): Promise<SandboxStatusInfo> {
	const res = await fetch(`${BASE}/sandbox/status`);
	if (!res.ok) throw new Error(`Failed to fetch sandbox status: ${res.status}`);
	return res.json();
}

/** Warm-on-typing sandbox prewarm (POST /api/sandbox/prewarm): fired by the
 *  New-session palette when the user types with a REMOTE provider selected,
 *  so the sandbox bootstrap runs while they write the prompt. Idempotent and
 *  cheap server-side; callers must swallow failures (never block typing). */
export async function requestSandboxPrewarm(
	provider: string,
	repo: string,
	user: string,
): Promise<{ state: string }> {
	const res = await fetch(`${BASE}/sandbox/prewarm`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider, repo, user }),
	});
	if (!res.ok) throw new Error(`prewarm failed: ${res.status}`);
	return res.json();
}

export async function createAutomationApi(input: {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	createdBy: string;
	eventKey?: string;
	model?: string;
	fallbackModel?: string;
	accountId?: string;
	accountStrict?: boolean;
	usageCredits?: boolean;
	mcpServers?: string[];
	slackWatch?: { channel: string };
}) {
	return request<any>("/automations", { method: "POST", body: input });
}

export async function updateAutomationApi(id: string, patch: object) {
	return request<any>(`/automations/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

// ── Scheduled prompts (composer "send later") ──

export interface ScheduledPrompt {
	id: string;
	sessionId: string;
	prompt: string;
	user: string;
	at: string;
	createdAt: string;
}

export async function fetchScheduledPrompts(
	sessionId: string,
): Promise<ScheduledPrompt[]> {
	const data = await request<{ prompts?: ScheduledPrompt[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`,
		{ label: "Failed to fetch scheduled prompts" },
	);
	return data?.prompts ?? [];
}

export async function createScheduledPromptApi(
	sessionId: string,
	input: { prompt: string; at: string; user: string },
): Promise<ScheduledPrompt> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`, {
		method: "POST",
		body: input,
	});
}

export async function deleteScheduledPromptApi(id: string): Promise<void> {
	await request<void>(`/scheduled-prompts/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete scheduled prompt",
	});
}

// ── Human asks (waiting-on-teammates board) ──

export interface HumanAskView {
	id: string;
	sessionId: string;
	createdBy: string;
	person: { slackId: string; name: string };
	question: string;
	options?: string[];
	mode: "block" | "async";
	state: "scheduled" | "delivered" | "answered" | "timeout" | "cancelled";
	answer?: string;
	answeredBy?: string;
	createdAt: string;
	deliveredAt?: string;
	answeredAt?: string;
}

export async function fetchHumanAsks(all = false): Promise<HumanAskView[]> {
	const data = await request<{ asks?: HumanAskView[] }>(
		`/human-asks${all ? "?all=1" : ""}`,
		{ label: "Failed to fetch asks" },
	);
	return data?.asks ?? [];
}

export async function nudgeHumanAsk(id: string): Promise<void> {
	await request<void>(`/human-asks/${encodeURIComponent(id)}/nudge`, {
		method: "POST",
	});
}

export async function cancelHumanAsk(id: string): Promise<void> {
	await request<void>(`/human-asks/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to cancel ask",
	});
}

// ── Audit log ──

export interface AuditPage {
	dates: string[];
	events?: Array<Record<string, unknown>>;
	total?: number;
	types?: string[];
}

export async function fetchAudit(opts: {
	date?: string;
	q?: string;
	type?: string;
	session?: string;
	/** Include the per-turn firehose (tool_use/tool_result/…). */
	all?: boolean;
	offset?: number;
	limit?: number;
}): Promise<AuditPage> {
	const params = new URLSearchParams();
	if (opts.date) params.set("date", opts.date);
	if (opts.q) params.set("q", opts.q);
	if (opts.type) params.set("type", opts.type);
	if (opts.session) params.set("session", opts.session);
	if (opts.all) params.set("all", "1");
	if (opts.offset) params.set("offset", String(opts.offset));
	if (opts.limit) params.set("limit", String(opts.limit));
	return request(`/audit?${params.toString()}`, {
		label: "Failed to fetch audit log",
	});
}

// ── Session monitor (per-user, opt-in) ──

export interface MonitorConfig {
	enabled: boolean;
	intervalMinutes: number;
	slackDm: boolean;
	autoAnswer: boolean;
	stalledMinutes: number;
}

export async function fetchMonitorConfig(user: string): Promise<MonitorConfig> {
	return request(`/monitor?user=${encodeURIComponent(user)}`, {
		label: "Failed to fetch monitor config",
	});
}

export async function updateMonitorConfig(
	user: string,
	patch: Partial<MonitorConfig>,
): Promise<MonitorConfig> {
	return request("/monitor", { method: "PUT", body: { user, ...patch } });
}

// ── Auto-archive (per-user, opt-in by repo) ──

export interface AutoArchiveConfig {
	onMerge: boolean;
	repos: string[];
	onChecksGreen: boolean;
	availableRepos: string[];
}

export async function fetchAutoArchiveConfig(
	user: string,
): Promise<AutoArchiveConfig> {
	return request(`/auto-archive?user=${encodeURIComponent(user)}`, {
		label: "Failed to fetch auto-archive config",
	});
}

export async function updateAutoArchiveConfig(
	user: string,
	patch: Partial<Pick<AutoArchiveConfig, "onMerge" | "repos" | "onChecksGreen">>,
): Promise<AutoArchiveConfig> {
	return request("/auto-archive", { method: "PUT", body: { user, ...patch } });
}

// ── Warm preview templates (Settings → Warm previews) ──

export interface WarmTemplateEntry {
	repoId: string;
	enabled: boolean;
	intervalHours: number;
	refreshing: boolean;
	state: {
		sha?: string;
		refreshedAt?: string;
		lastDurationMs?: number;
		ok?: boolean;
		lastError?: string;
		manifestEntries?: number;
	} | null;
}

export async function fetchWarmTemplates(): Promise<{
	repos: WarmTemplateEntry[];
}> {
	return request("/warm-templates", {
		label: "Failed to fetch warm previews",
	});
}

export async function updateWarmTemplate(
	repoId: string,
	patch: { enabled?: boolean; intervalHours?: number },
): Promise<{ repos: WarmTemplateEntry[] }> {
	return request(`/warm-templates/${encodeURIComponent(repoId)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function refreshWarmTemplateNow(
	repoId: string,
): Promise<{ repos: WarmTemplateEntry[] }> {
	return request(`/warm-templates/${encodeURIComponent(repoId)}/refresh`, {
		method: "POST",
	});
}

// ── Papercuts (Settings → Papercuts: cross-session friction log) ──

export interface PapercutDto {
	ts: string;
	message: string;
	repo?: string;
	sessionId?: string;
	model?: string;
	runKind?: string;
	by?: string;
}

export interface PapercutsRepoConfig {
	repoId: string;
	enabled: boolean;
}

export async function fetchPapercuts(opts?: {
	repo?: string;
	days?: number;
}): Promise<{ entries: PapercutDto[]; repos: PapercutsRepoConfig[] }> {
	const params = new URLSearchParams();
	if (opts?.repo) params.set("repo", opts.repo);
	if (opts?.days) params.set("days", String(opts.days));
	const qs = params.toString();
	return request(`/papercuts${qs ? `?${qs}` : ""}`, {
		label: "Failed to fetch papercuts",
	});
}

export async function setPapercutsRepoEnabled(
	repo: string,
	enabled: boolean,
): Promise<{ repos: PapercutsRepoConfig[] }> {
	return request("/papercuts/config", {
		method: "PUT",
		body: { repo, enabled },
	});
}

// ── Memory (Settings → Memory: repo/user/team/channel stores) ──

export interface MemoryEntryDto {
	id: string;
	text: string;
	by: string;
	at: string;
}

export interface MemoryScopeDto {
	scope: {
		key: string;
		kind: "repo" | "user" | "team" | "channel";
		label: string;
	};
	entries: MemoryEntryDto[];
}

export async function fetchMemory(): Promise<{ scopes: MemoryScopeDto[] }> {
	return request("/memory", { label: "Failed to fetch memory" });
}

export async function addMemoryEntryApi(
	scopeKey: string,
	text: string,
	by: string,
): Promise<{ entry: MemoryEntryDto }> {
	return request("/memory", {
		method: "POST",
		body: { scopeKey, text, by },
		label: "Failed to add memory",
	});
}

export async function updateMemoryEntryApi(
	scopeKey: string,
	id: string,
	text: string,
): Promise<{ entry: MemoryEntryDto }> {
	return request("/memory", {
		method: "PUT",
		body: { scopeKey, id, text },
		label: "Failed to update memory",
	});
}

export async function deleteMemoryEntryApi(
	scopeKey: string,
	id: string,
): Promise<void> {
	await request<void>("/memory", {
		method: "DELETE",
		body: { scopeKey, id },
		label: "Failed to delete memory",
	});
}

// ── Security (deepsec scans + profiles) ──

export interface ScanProfile {
	id: string;
	name: string;
	prompt: string;
	createdBy: string;
	createdAt: string;
}

export interface ScanSessionRef {
	repo: string;
	sessionId: string;
	status: "running" | "ok" | "error";
	error?: string;
}

export interface SecurityScan {
	id: string;
	repos: string[];
	profileId?: string;
	profileName?: string;
	instructions?: string;
	interactive: boolean;
	status: "running" | "done" | "error" | "interactive";
	error?: string;
	createdBy: string;
	createdAt: string;
	finishedAt?: string;
	sessions: ScanSessionRef[];
}

export async function fetchSecurity(): Promise<{
	scans: SecurityScan[];
	profiles: ScanProfile[];
	repos: Array<{ id: string; defaultBranch: string }>;
}> {
	return request("/security", { label: "Failed to fetch security" });
}

export async function startScanApi(input: {
	repos: "all" | string[];
	profileId?: string;
	instructions?: string;
	interactive?: boolean;
	recurrence?: "none" | "daily" | "weekly";
	createdBy: string;
}): Promise<{ scan?: SecurityScan; sessionId?: string; automation?: unknown }> {
	return request("/security/scans", { method: "POST", body: input });
}

export async function deleteScanApi(id: string) {
	await request<void>(`/security/scans/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete scan",
	});
}

export async function createScanProfileApi(input: {
	name: string;
	prompt: string;
	createdBy: string;
}): Promise<ScanProfile> {
	return request("/security/profiles", { method: "POST", body: input });
}

export async function updateScanProfileApi(
	id: string,
	patch: { name?: string; prompt?: string },
): Promise<ScanProfile> {
	return request(`/security/profiles/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteScanProfileApi(id: string) {
	await request<void>(`/security/profiles/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete profile",
	});
}

// ── Goals (long-running, self-pacing missions) ──

export async function fetchGoals() {
	return request<any>("/goals", { label: "Failed to fetch goals" });
}

/** Single goal incl. its ledger text (for the detail view). */
export async function fetchGoal(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		label: "Failed to fetch goal",
	});
}

export async function createGoalApi(input: {
	name: string;
	mission: string;
	mode?: "ask" | "code";
	repo?: string;
	model?: string;
	fallbackModel?: string;
	mcpServers?: string[];
	minWakeMinutes?: number;
	maxWakes?: number;
	createdBy: string;
}) {
	return request<any>("/goals", { method: "POST", body: input });
}

export async function updateGoalApi(id: string, patch: object) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

export async function resumeGoalApi(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/resume`, {
		method: "POST",
		body: {},
	});
}

export async function pauseGoalApi(id: string, reason?: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/pause`, {
		method: "POST",
		body: { reason },
	});
}

// ── Actions (run a registered repo script behind a form) ──

export type ActionInputType = "text" | "number" | "select" | "boolean";

export interface ActionInput {
	name: string;
	label?: string;
	type: ActionInputType;
	required?: boolean;
	default?: string;
	options?: string[];
	hint?: string;
}

export interface Action {
	id: string;
	name: string;
	description?: string;
	kind?: "repo" | "mcp";
	repo?: string;
	scriptPath?: string;
	argMode?: "positional" | "env";
	mcpServer?: string;
	toolName?: string;
	inputs: ActionInput[];
	confirm?: boolean;
	model?: string;
	seeded?: boolean;
	createdBy: string;
	createdAt: string;
	lastRunAt?: string;
	lastRunSessionId?: string;
}

export async function fetchActions(): Promise<Action[]> {
	return request<Action[]>("/actions", { label: "Failed to fetch actions" });
}

export async function createActionApi(input: {
	name: string;
	description?: string;
	kind: "repo" | "mcp";
	repo?: string;
	scriptPath?: string;
	argMode?: "positional" | "env";
	mcpServer?: string;
	toolName?: string;
	inputs: ActionInput[];
	confirm?: boolean;
	createdBy: string;
}): Promise<Action> {
	return request<Action>("/actions", { method: "POST", body: input });
}

export async function deleteActionApi(id: string): Promise<void> {
	await request<void>(`/actions/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runActionApi(
	id: string,
	values: Record<string, unknown>,
	user: string,
): Promise<{ sessionId: string }> {
	return request<{ sessionId: string }>(
		`/actions/${encodeURIComponent(id)}/run`,
		{ method: "POST", body: { values, user } },
	);
}

export async function introspectActionApi(
	repo: string,
	scriptPath: string,
): Promise<{ inputs: ActionInput[]; argMode: "positional" | "env" }> {
	return request<{ inputs: ActionInput[]; argMode: "positional" | "env" }>(
		"/actions/introspect",
		{ method: "POST", body: { repo, scriptPath } },
	);
}

// ── Pins (per-user pinned tabs) ──

export async function fetchPins(user: string): Promise<string[]> {
	const body = await request<{ pins?: string[] }>(
		`/pins?user=${encodeURIComponent(user)}`,
		{ label: "Failed to fetch pins" },
	);
	return Array.isArray(body?.pins) ? body.pins : [];
}

export async function savePinsApi(
	user: string,
	pins: string[],
): Promise<string[]> {
	const body = await request<{ pins?: string[] }>("/pins", {
		method: "PUT",
		body: { user, pins },
		label: "Failed to save pins",
	});
	return Array.isArray(body?.pins) ? body.pins : pins;
}

// ── Tab colors (per-user session tab colors) ──

export async function fetchTabColors(
	user: string,
): Promise<Record<string, string>> {
	const body = await request<{ colors?: Record<string, string> }>(
		`/tab-colors?user=${encodeURIComponent(user)}`,
		{ label: "Failed to fetch tab colors" },
	);
	return body?.colors && typeof body.colors === "object" ? body.colors : {};
}

export async function saveTabColorsApi(
	user: string,
	colors: Record<string, string>,
): Promise<Record<string, string>> {
	const body = await request<{ colors?: Record<string, string> }>(
		"/tab-colors",
		{ method: "PUT", body: { user, colors }, label: "Failed to save tab colors" },
	);
	return body?.colors && typeof body.colors === "object" ? body.colors : colors;
}

// ── Wiki ──

export async function fetchWikiTree() {
	return request<any>("/wiki/tree", { label: "Failed to fetch wiki tree" });
}

export async function fetchWikiFile(path: string) {
	return request<any>(`/wiki/file?path=${encodeURIComponent(path)}`, {
		label: "Failed to fetch doc",
	});
}

export async function searchWikiApi(q: string) {
	return request<any>(`/wiki/search?q=${encodeURIComponent(q)}`, {
		label: "Search failed",
	});
}

// ── Notes (shared, collaborative) ──

export interface NoteMeta {
	id: string;
	title: string;
	updatedAt: number;
}

export async function fetchNotes(): Promise<NoteMeta[]> {
	const body = await request<{ notes?: NoteMeta[] }>("/notes", {
		label: "Failed to fetch notes",
	});
	return Array.isArray(body?.notes) ? body.notes : [];
}

export async function createNoteApi(title?: string): Promise<NoteMeta> {
	const body = await request<{ note: NoteMeta }>("/notes", {
		method: "POST",
		body: { title },
		label: "Failed to create note",
	});
	return body.note;
}

export async function deleteNoteApi(id: string): Promise<void> {
	await request<void>(`/notes/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete note",
	});
}

export interface NoteSearchHit {
	id: string;
	title: string;
	line: number;
	snippet: string;
}

/** Full-text search across the shared notes (merged with docs hits in the UI). */
export async function searchNotesApi(q: string): Promise<NoteSearchHit[]> {
	const body = await request<{ hits?: NoteSearchHit[] }>(
		`/notes/search?q=${encodeURIComponent(q)}`,
		{ label: "Note search failed" },
	);
	return body?.hits ?? [];
}

/** One note's meta + current markdown text (preview / discuss-with-Michael). */
export async function fetchNote(
	id: string,
): Promise<NoteMeta & { text: string }> {
	return request(`/notes/${encodeURIComponent(id)}`, {
		label: "Failed to fetch note",
	});
}

/** Notes that link to this one via [label](note:id) chips. */
export async function fetchNoteBacklinks(
	id: string,
): Promise<Array<{ id: string; title: string }>> {
	const body = await request<{ notes?: Array<{ id: string; title: string }> }>(
		`/notes/${encodeURIComponent(id)}/backlinks`,
		{ label: "Failed to fetch backlinks" },
	);
	return body?.notes ?? [];
}

/** Run a Haiku rewrite of the note; the new content arrives live over the WS. */
export async function promptNoteApi(id: string, prompt: string): Promise<void> {
	await request<void>(`/notes/${encodeURIComponent(id)}/prompt`, {
		method: "POST",
		body: { prompt },
		label: "Update failed",
	});
}

/** Returns `stoppedRun: true` when archiving gracefully stopped an in-flight,
 * process-owned turn (so callers can surface a "stopped the running turn"
 * notice). Always false on unarchive and for idle/external sessions. */
export async function archiveSessionApi(
	sessionId: string,
	archived: boolean,
): Promise<{ stoppedRun: boolean }> {
	const res = await request<{ ok?: boolean; stoppedRun?: boolean } | null>(
		`/sessions/${encodeURIComponent(sessionId)}/archive`,
		{
			method: "POST",
			body: { archived },
			label: "Failed to update archive state",
		},
	);
	return { stoppedRun: !!res?.stoppedRun };
}

/** Set a manual display title for a session; empty string clears the rename. */
export async function renameSessionApi(
	sessionId: string,
	title: string,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/title`, {
		method: "PUT",
		body: { title },
		label: "Failed to rename session",
	});
}

/**
 * Pin a session into a sidebar lane (needsinput/inprogress/review/merged/pending),
 * or pass null to clear the override back to the derived lane.
 */
export async function setSessionStatusApi(
	sessionId: string,
	status:
		| "needsinput"
		| "inprogress"
		| "review"
		| "merged"
		| "pending"
		| null,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/status`, {
		method: "PUT",
		body: { status },
		label: "Failed to change session status",
	});
}

/**
 * Ask a teammate to review this session (surfaces it in a "Needs review" band
 * at the top of their sidebar + pushes a notification); null clears the request.
 */
export async function setSessionReviewerApi(
	sessionId: string,
	reviewer: string | null,
	by: string,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/review`, {
		method: "PUT",
		body: { reviewer, by },
		label: "Failed to set reviewer",
	});
}

/** Mark the session's review request accepted (reviewer signed off) or reopen it. */
export async function acceptReviewApi(
	sessionId: string,
	accept: boolean,
	by: string,
): Promise<void> {
	await request<void>(`/sessions/${encodeURIComponent(sessionId)}/review`, {
		method: "PUT",
		body: { accept, by },
		label: "Failed to update review",
	});
}

export function getWebSocketUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}${BASE_PATH}/ws`;
}

export function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diff = now - then;

	if (diff < 0) return "just now";
	if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return new Date(dateStr).toLocaleDateString();
}
