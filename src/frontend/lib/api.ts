import type {
	UnifiedSession,
	SlackChannelLink,
	SlackMessage,
	PlainThread,
	Project,
} from "./types";

const BASE = "/backstage/api";

export async function fetchSessions(): Promise<UnifiedSession[]> {
	const res = await fetch(`${BASE}/sessions`);
	if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
	return res.json();
}

export interface TranscriptMatch {
	id: string;
	snippet: string;
}

/** Full-text search across session transcripts (⌘K "search in conversations"). */
export async function searchTranscripts(
	q: string,
	signal?: AbortSignal,
): Promise<TranscriptMatch[]> {
	const res = await fetch(`${BASE}/sessions/search?q=${encodeURIComponent(q)}`, {
		signal,
	});
	if (!res.ok) throw new Error(`Transcript search failed: ${res.status}`);
	const data = await res.json();
	return data.matches ?? [];
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
	services: PreviewService[];
}

export async function fetchPreview(sessionId: string): Promise<PreviewStatus> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview`,
	);
	if (!res.ok) throw new Error(`Failed to fetch preview: ${res.status}`);
	return res.json();
}

export async function startPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/start`,
		{
			method: "POST",
		},
	);
	if (!res.ok) throw new Error(`Failed to start preview: ${res.status}`);
	return res.json();
}

export async function stopPreviewApi(
	sessionId: string,
): Promise<PreviewStatus> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/preview/stop`,
		{
			method: "POST",
		},
	);
	if (!res.ok) throw new Error(`Failed to stop preview: ${res.status}`);
	return res.json();
}

export async function fetchTranscript(sessionId: string) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/transcript`,
	);
	if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
	return res.json();
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/subagent/${encodeURIComponent(agentId)}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch sub-agent: ${res.status}`);
	return res.json();
}

/** A single "@"-mention suggestion. `insert` is what lands in the textarea. */
export interface FileMention {
	/** Repo-relative path, for display. */
	display: string;
	/** Text inserted after the "@": bare path (primary repo) or `repo:path`. */
	insert: string;
	/** Repo label, set only when more than one repo is searched (cross-repo). */
	repo?: string;
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
	const res = await fetch(`${BASE}/files?${params.toString()}`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.files ?? [];
}

export interface RepoInfo {
	id: string;
	defaultBranch: string;
	sharedCheckout: boolean;
}

export async function fetchRepos(): Promise<RepoInfo[]> {
	const res = await fetch(`${BASE}/repos`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.repos ?? [];
}

// ── Projects (folders that group chats) ──

export async function fetchProjects(): Promise<Project[]> {
	const res = await fetch(`${BASE}/projects`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.projects ?? [];
}

export async function createProjectApi(input: {
	name: string;
	repo?: string;
	color?: string;
	user: string;
}): Promise<Project> {
	const res = await fetch(`${BASE}/projects`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.project as Project;
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
	const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.project as Project;
}

export async function deleteProjectApi(id: string): Promise<void> {
	const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete project: ${res.status}`);
}

/**
 * Start a new sibling chat in the source chat's workspace. Returns the new
 * chat's id; it has no run yet — its first prompt starts fresh. `mode` picks the
 * worktree relationship: share the workspace worktree (default), stack a new
 * worktree branched off it, or ask (no worktree).
 */
export async function newChatApi(
	sourceId: string,
	user: string,
	mode?: "share" | "stack" | "ask",
): Promise<string> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sourceId)}/new-chat`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ user, ...(mode ? { mode } : {}) }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.id as string;
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/promote`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts || {}),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { branch: string; worktreeDir: string };
}

/** Move a chat into a project (or `null` to make it standalone). */
export async function setSessionProjectApi(
	sessionId: string,
	projectId: string | null,
): Promise<void> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/project`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectId }),
		},
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Failed: ${res.status}`);
	}
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/attach-repo`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repo, ...(branch ? { branch } : {}) }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.attachedRepos as AttachedRepo[];
}

export async function detachRepoApi(
	sessionId: string,
	repo: string,
): Promise<AttachedRepo[]> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/detach-repo`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repo }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.attachedRepos as AttachedRepo[];
}

// Whether this session is fresh enough to switch its primary repo (clean-only).
export async function fetchRepoSwitchable(sessionId: string): Promise<boolean> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/repo-switchable`,
	);
	if (!res.ok) return false;
	const body = await res.json();
	return !!body.switchable;
}

// Switch the session's PRIMARY repo (wrong repo picked at creation). Returns the
// new primary repo + branch; the next prompt runs from the new worktree.
export async function switchPrimaryRepoApi(
	sessionId: string,
	repo: string,
): Promise<{ repo: string; branch: string; worktreeDir: string }> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/switch-primary-repo`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repo }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { repo: string; branch: string; worktreeDir: string };
}

// ── Linked Slack channels ──

export async function linkChannelApi(
	sessionId: string,
	opts: { mode: "create" | "existing"; name?: string; channelId?: string },
): Promise<SlackChannelLink> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/link-channel`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.slackChannel as SlackChannelLink;
}

export async function unlinkChannelApi(sessionId: string): Promise<void> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/unlink-channel`,
		{ method: "POST" },
	);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.error || `Failed: ${res.status}`);
	}
}

export async function fetchChannelHistoryApi(
	sessionId: string,
): Promise<SlackMessage[]> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/channel/history`,
	);
	if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.messages) ? body.messages : [];
}

export async function fetchPlainThreadApi(
	sessionId: string,
): Promise<PlainThread | null> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/plain/thread`,
	);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.error || `Failed: ${res.status}`);
	}
	const body = await res.json();
	return (body?.thread as PlainThread) || null;
}

export async function postChannelMessageApi(
	sessionId: string,
	text: string,
	user: string,
): Promise<SlackMessage> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/channel/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, user }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body.message as SlackMessage;
}

export async function fetchWorktrees(repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const res = await fetch(`${BASE}/worktrees${qs}`);
	if (!res.ok) throw new Error(`Failed to fetch worktrees: ${res.status}`);
	return res.json();
}

export async function deleteSessionApi(
	sessionId: string,
	cleanWorktree: boolean,
): Promise<void> {
	const params = cleanWorktree ? "?worktree=true" : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}${params}`,
		{
			method: "DELETE",
		},
	);
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Failed to delete: ${res.status}`);
	}
}

export async function fetchDiff(
	sessionId: string,
): Promise<import("./types").SessionDiffResponse> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/diff`,
	);
	if (!res.ok) throw new Error(`Failed to fetch diff: ${res.status}`);
	return res.json();
}

/** `repo` (a repo id) targets an attached repo's PR; omit for the primary. */
export async function fetchPr(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr${qs}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
	return res.json();
}

export async function fetchPrDiff(sessionId: string, repo?: string) {
	const qs = repo ? `?repo=${encodeURIComponent(repo)}` : "";
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-diff${qs}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch PR diff: ${res.status}`);
	return res.json();
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
	},
) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-comment`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
}

export async function submitPrReviewApi(
	sessionId: string,
	payload: {
		user: string;
		event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
		summary?: string;
		repo?: string;
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
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-review`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
}

export async function mergePrApi(
	sessionId: string,
	method: "squash" | "merge" | "rebase" = "squash",
	repo?: string,
) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/pr-merge`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ method, ...(repo ? { repo } : {}) }),
		},
	);
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body as { ok: true; url?: string };
}

// ── Automations ──

export interface ModelOption {
	id: string;
	provider: "claude" | "codex";
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
		const res = await fetch(`${BASE}/suggest-branch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt }),
		});
		if (!res.ok) return null;
		const data = await res.json();
		return typeof data.branch === "string" ? data.branch : null;
	} catch {
		return null;
	}
}

export async function fetchModels(): Promise<{
	models: ModelOption[];
	default: string;
}> {
	const res = await fetch(`${BASE}/models`);
	if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
	return res.json();
}

export async function fetchAutomations() {
	const res = await fetch(`${BASE}/automations`);
	if (!res.ok) throw new Error(`Failed to fetch automations: ${res.status}`);
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
}) {
	const res = await fetch(`${BASE}/automations`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function updateAutomationApi(id: string, patch: object) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function deleteAutomationApi(id: string) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runAutomationApi(id: string) {
	const res = await fetch(`${BASE}/automations/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
}

// ── Goals (long-running, self-pacing missions) ──

export async function fetchGoals() {
	const res = await fetch(`${BASE}/goals`);
	if (!res.ok) throw new Error(`Failed to fetch goals: ${res.status}`);
	return res.json();
}

/** Single goal incl. its ledger text (for the detail view). */
export async function fetchGoal(id: string) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(`Failed to fetch goal: ${res.status}`);
	return res.json();
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
	const res = await fetch(`${BASE}/goals`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function updateGoalApi(id: string, patch: object) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(patch),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function deleteGoalApi(id: string) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runGoalApi(id: string) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
}

export async function resumeGoalApi(id: string) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function pauseGoalApi(id: string, reason?: string) {
	const res = await fetch(`${BASE}/goals/${encodeURIComponent(id)}/pause`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
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
	const res = await fetch(`${BASE}/actions`);
	if (!res.ok) throw new Error(`Failed to fetch actions: ${res.status}`);
	return res.json();
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
	const res = await fetch(`${BASE}/actions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function deleteActionApi(id: string): Promise<void> {
	const res = await fetch(`${BASE}/actions/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function runActionApi(
	id: string,
	values: Record<string, unknown>,
	user: string,
): Promise<{ sessionId: string }> {
	const res = await fetch(`${BASE}/actions/${encodeURIComponent(id)}/run`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ values, user }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

export async function introspectActionApi(
	repo: string,
	scriptPath: string,
): Promise<{ inputs: ActionInput[]; argMode: "positional" | "env" }> {
	const res = await fetch(`${BASE}/actions/introspect`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ repo, scriptPath }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

// ── Pins (per-user pinned tabs) ──

export async function fetchPins(user: string): Promise<string[]> {
	const res = await fetch(`${BASE}/pins?user=${encodeURIComponent(user)}`);
	if (!res.ok) throw new Error(`Failed to fetch pins: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.pins) ? body.pins : [];
}

export async function savePinsApi(
	user: string,
	pins: string[],
): Promise<string[]> {
	const res = await fetch(`${BASE}/pins`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user, pins }),
	});
	if (!res.ok) throw new Error(`Failed to save pins: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.pins) ? body.pins : pins;
}

// ── Tab colors (per-user session tab colors) ──

export async function fetchTabColors(
	user: string,
): Promise<Record<string, string>> {
	const res = await fetch(
		`${BASE}/tab-colors?user=${encodeURIComponent(user)}`,
	);
	if (!res.ok) throw new Error(`Failed to fetch tab colors: ${res.status}`);
	const body = await res.json();
	return body?.colors && typeof body.colors === "object" ? body.colors : {};
}

export async function saveTabColorsApi(
	user: string,
	colors: Record<string, string>,
): Promise<Record<string, string>> {
	const res = await fetch(`${BASE}/tab-colors`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user, colors }),
	});
	if (!res.ok) throw new Error(`Failed to save tab colors: ${res.status}`);
	const body = await res.json();
	return body?.colors && typeof body.colors === "object" ? body.colors : colors;
}

// ── Wiki ──

export async function fetchWikiTree() {
	const res = await fetch(`${BASE}/wiki/tree`);
	if (!res.ok) throw new Error(`Failed to fetch wiki tree: ${res.status}`);
	return res.json();
}

export async function fetchWikiFile(path: string) {
	const res = await fetch(`${BASE}/wiki/file?path=${encodeURIComponent(path)}`);
	if (!res.ok) throw new Error(`Failed to fetch doc: ${res.status}`);
	return res.json();
}

export async function searchWikiApi(q: string) {
	const res = await fetch(`${BASE}/wiki/search?q=${encodeURIComponent(q)}`);
	if (!res.ok) throw new Error(`Search failed: ${res.status}`);
	return res.json();
}

// ── Notes (shared, collaborative) ──

export interface NoteMeta {
	id: string;
	title: string;
	updatedAt: number;
}

export async function fetchNotes(): Promise<NoteMeta[]> {
	const res = await fetch(`${BASE}/notes`);
	if (!res.ok) throw new Error(`Failed to fetch notes: ${res.status}`);
	const body = await res.json();
	return Array.isArray(body?.notes) ? body.notes : [];
}

export async function createNoteApi(title?: string): Promise<NoteMeta> {
	const res = await fetch(`${BASE}/notes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) throw new Error(`Failed to create note: ${res.status}`);
	const body = await res.json();
	return body.note;
}

export async function deleteNoteApi(id: string): Promise<void> {
	const res = await fetch(`${BASE}/notes/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`Failed to delete note: ${res.status}`);
}

/** Run a Haiku rewrite of the note; the new content arrives live over the WS. */
export async function promptNoteApi(id: string, prompt: string): Promise<void> {
	const res = await fetch(`${BASE}/notes/${encodeURIComponent(id)}/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt }),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.error || `Update failed: ${res.status}`);
	}
}

export async function archiveSessionApi(sessionId: string, archived: boolean) {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/archive`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ archived }),
		},
	);
	if (!res.ok) throw new Error(`Failed to update archive state: ${res.status}`);
}

/** Set a manual display title for a session; empty string clears the rename. */
export async function renameSessionApi(
	sessionId: string,
	title: string,
): Promise<void> {
	const res = await fetch(
		`${BASE}/sessions/${encodeURIComponent(sessionId)}/title`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		},
	);
	if (!res.ok) throw new Error(`Failed to rename session: ${res.status}`);
}

export async function archiveOldApi(
	days: number,
): Promise<{ archived: number }> {
	const res = await fetch(`${BASE}/sessions/archive-old`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ days }),
	});
	if (!res.ok) throw new Error(`Failed to archive: ${res.status}`);
	return res.json();
}

export function getWebSocketUrl(): string {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	return `${proto}//${location.host}/backstage/ws`;
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
