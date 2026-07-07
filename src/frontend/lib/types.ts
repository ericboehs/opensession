export type SessionSource = "slack" | "linear" | "backstage" | "cli";

/** A Slack channel linked to a backstage session (strictly one-to-one). */
export interface SlackChannelLink {
	channelId: string;
	name: string;
}

/** One message in a session's linked Plain thread (customer support). */
export interface PlainTimelineEntry {
	id: string;
	timestamp: string;
	actorName: string;
	actorType: "customer" | "support" | "bot" | "system";
	kind: "email" | "chat" | "note";
	subject?: string;
	text: string;
}

/** A Plain thread's conversation timeline, as shown in the Plain sidebar. */
export interface PlainThread {
	id: string;
	title: string | null;
	status: string | null;
	priority: number | null;
	customer: { name: string | null; email: string | null };
	entries: PlainTimelineEntry[];
}

/** A TODO Plain thread in the sidebar's Support queue. */
export interface SupportThread {
	id: string;
	title: string | null;
	previewText: string | null;
	status: string | null;
	statusChangedAt: string | null;
	createdAt: string | null;
	priority: number | null;
	customer: { name: string | null; email: string | null };
}

/** One message in a linked Slack channel, as shown in the chat panel. */
export interface SlackMessage {
	ts: string;
	userId: string | null;
	userName: string;
	avatarUrl?: string;
	text: string;
	isBot: boolean;
}

/**
 * Native team-chat message (mirror of src/server/chat.ts). Lives in a channel:
 * "watercooler" (team-wide room) or "session:<id>" (a session's Chat tab).
 * Text may carry `@Name` teammate mentions and `@session:<id>` session tags.
 */
export interface ChatImage {
	id: string;
	/** Original filename (alt text / download). */
	name: string;
	/** MIME type, e.g. "image/png". */
	mime: string;
}

export interface ChatMessage {
	id: string;
	/** Sender's self-selected backstage-user display name ("Michiel"). */
	user: string;
	text: string;
	/** Attached images (absent/empty on text-only messages). */
	images?: ChatImage[];
	/** ms epoch */
	ts: number;
}

/**
 * Cumulative token/cost accounting for a session (mirror of the server type).
 * Cost is the API-equivalent USD spend — authoritative for Claude runs, an
 * approximation for Codex (`costApproximate`). `contextTokens` is the most
 * recent turn's full prompt size, shown against `contextWindow` as the live
 * "how full is the context window" gauge.
 */
export interface SessionUsage {
	costUsd: number;
	costApproximate?: boolean;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	contextTokens: number;
	contextWindow: number;
	turns: number;
	updatedAt: string;
}

export interface UnifiedSession {
	id: string;
	claudeSessionId: string | null;
	source: SessionSource;
	branch: string | null;
	worktreeDir: string | null;
	startedBy: string | null;
	title: string;
	lastActivity: string;
	createdAt: string;
	isRunning: boolean;
	/**
	 * When the in-flight run started (ISO), for the "in progress" elapsed ticker
	 * in the sidebar. Only set while isRunning; sourced server-side from the run
	 * journal so it survives a refresh. Absent for external CLI/tmux runs — the
	 * sidebar then falls back to a client-observed start time.
	 */
	runStartedAt?: string;
	transcriptPath: string | null;
	prUrl?: string;
	prState?: "OPEN" | "MERGED" | "CLOSED";
	// Rich PR fields, populated from the batched gh pr list for the Reviews
	// table's columns (so the list never fetches per-PR).
	prNumber?: number;
	prTitle?: string;
	prIsDraft?: boolean;
	prAdditions?: number;
	prDeletions?: number;
	prChangedFiles?: number;
	prReviewDecision?: string;
	/** Person keys ("kent") of teammates with a pending review request. */
	prReviewRequested?: string[];
	prAuthor?: string;
	prUpdatedAt?: string;
	prChecks?: { total: number; passed: number; failed: number; pending: number };
	mode?: "ask" | "code";
	/** Primary repo this chat works in (repo id; default "tella-fusion"). */
	repo?: string;
	/** Optional Project (folder) this chat belongs to; null/undefined = standalone. */
	projectId?: string | null;
	/** Parent/orchestrator session when spawned as a worker sub-session. */
	parentSessionId?: string;
	/** Secondary repos this session also works in (cross-repo sessions). */
	attachedRepos?: Array<{ repo: string; branch: string; dir: string }>;
	/** Route the Preview/Staging buttons deep-link to (agent-set via
	 *  michael-preview); appended to the base URL. Unset = open the app root. */
	previewPath?: string;
	automation?: string;
	archived?: boolean;
	/** Why this session is archived — powers the "Auto-archived" filter. */
	archivedReason?: "manual" | "idle" | "auto" | "plain";
	plainThreadId?: string;
	goal?: string;
	loop?: {
		prompt: string;
		intervalMinutes: number;
		lastRunAt?: string;
		setBy?: string;
	};
	aliasIds?: string[];
	model?: string;
	/** Reasoning effort for this session's runs (low|medium|high); unset = default (high). */
	effort?: string;
	/** Pinned Claude subscription (claude-accounts id); unset = auto pool. */
	accountId?: string;
	codexThreadId?: string;
	modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
	/** Cumulative token/cost accounting for this session's runs. */
	usage?: SessionUsage;
	linearIssue?: { identifier: string; title: string; url?: string };
	slackThread?: { channel: string; threadTs: string };
	/** A Slack channel linked to this session for in-context discussion. */
	slackChannel?: SlackChannelLink;
	/** Blocked on an AskUserQuestion — a human needs to answer. Set by /api/sessions. */
	waitingForInput?: boolean;
	/** Number of prompts queued behind the current run. Set by /api/sessions. */
	queuedCount?: number;
	/**
	 * The last run died on a terminal failure (usage limits exhausted, credit/API
	 * errors) — a human must act, so the session reads as "Needs input" rather
	 * than Backlog. Cleared by the next run that ends cleanly. Set by /api/sessions.
	 */
	lastRunError?: { message: string; at: string };
	/**
	 * Manual sidebar-lane override. When set it wins over the lane derived from
	 * PR/run state, letting a human pin a session into any lane (e.g. Backlog).
	 * Set server-side from the status-override registry; unset = derive as usual.
	 */
	manualStatus?: "needsinput" | "inprogress" | "review" | "merged" | "pending";
	/**
	 * A pending "please review this" pointed at a teammate, set from the info
	 * panel's Reviewer picker. Surfaces the session in a "Needs review" band at
	 * the top of the reviewer's sidebar until cleared or re-assigned.
	 */
	reviewRequest?: { to: string; by: string; at: string };
}

/** A Project — an optional folder that groups chats (sessions). */
export interface Project {
	id: string;
	name: string;
	repo?: string;
	color?: string;
	createdBy: string;
	createdAt: string;
	order?: number;
	/** Present on auto-created PR folders. */
	prNumber?: number;
	branch?: string;
}

export interface TranscriptEntry {
	id: string;
	type: "user" | "assistant" | "tool_use" | "tool_result" | "system";
	content: string;
	timestamp: string;
	toolName?: string;
	toolInput?: unknown;
	toolUseId?: string;
	requestId?: string;
	// Set on a tool_result whose block carried is_error — shown as a failed step.
	isError?: boolean;
	// Set on a Task/Agent tool_result: the spawned sub-agent's id. Lets the UI
	// open that sub-agent's conversation in the right sidebar.
	agentId?: string;
	// Ready-to-render image srcs (http(s) URLs or data: URLs), e.g. from a Read
	// of an image file or a pasted image.
	images?: string[];
	// Ready-to-render video srcs (served via /backstage/media), parsed from
	// `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
	videos?: string[];
}

export interface DiffFile {
	path: string;
	oldPath?: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	additions: number;
	deletions: number;
	binary?: boolean;
}

export interface SessionDiff {
	branch: string | null;
	baseRef: string | null;
	files: DiffFile[];
	totalAdditions: number;
	totalDeletions: number;
	rawPatch: string;
	truncated?: boolean;
}

/** One repo's diff within a (possibly multi-repo) session. */
export interface RepoDiff {
	repo: string;
	dir: string | null;
	primary: boolean;
	diff: SessionDiff;
}

export interface SessionDiffResponse {
	repos: RepoDiff[];
	error?: string;
}

export interface PrCheck {
	name: string;
	status: string;
	conclusion: string;
	url?: string;
	startedAt?: string;
	completedAt?: string;
	/** CheckRun workflow (e.g. "CI") — StatusContexts (Vercel deploys) have none. */
	workflowName?: string;
}

export interface PrComment {
	author: string;
	body: string;
	url?: string;
	createdAt?: string;
}

export interface PrDetails {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	reviewDecision: string;
	author: string;
	body: string;
	checks: PrCheck[];
	comments?: PrComment[];
	/** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's conflict probe. */
	mergeable?: string;
	/** CLEAN | BEHIND | BLOCKED | DIRTY | UNSTABLE | … — merge-box state. */
	mergeStateStatus?: string;
	/** The PR's webapp staging deploy (Vercel preview), when one exists. */
	staging?: { url: string; status: string } | null;
}

/** Local git state of a session's worktree (git-status endpoint). */
export interface GitStatusInfo {
	branch: string | null;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	behindBase: number;
	baseBranch: string;
	uncommittedFiles: number;
}

export type WSClientMessage =
	// Liveness probe — the server echoes `pong`. Detects half-open sockets
	// (iOS/Safari kills backgrounded connections without firing onclose).
	| { type: "ping" }
	| { type: "watch"; sessionId: string; user?: string }
	| { type: "unwatch"; sessionId: string }
	| { type: "load_history"; sessionId: string }
	| {
			type: "prompt";
			sessionId: string;
			content: string;
			user?: string;
			images?: string[];
			files?: unknown;
			busyMode?: "queue" | "steer";
			/** Reasoning effort — persisted on the session and enforced per run. */
			effort?: "low" | "medium" | "high" | string;
	  }
	| {
			type: "interrupt_prompt";
			sessionId: string;
			content: string;
			user?: string;
			images?: string[];
			files?: unknown;
			effort?: "low" | "medium" | "high" | string;
	  }
	| {
			type: "delete_queued_prompt";
			sessionId: string;
			queueId?: string;
			queueIndex?: number;
	  }
	| {
			type: "update_queued_prompt";
			sessionId: string;
			queueId?: string;
			queueIndex?: number;
			content: string;
	  }
	| {
			type: "steer_queued_prompt";
			sessionId: string;
			queueId?: string;
			queueIndex?: number;
	  }
	| {
			type: "interrupt_queued_prompt";
			sessionId: string;
			queueId?: string;
			queueIndex?: number;
	  }
	| { type: "cancel" }
	| {
			type: "create_session";
			branch: string;
			prompt: string;
			user: string;
			mode?: "ask" | "code";
			repo?: string;
			/** Existing workspace (folder) to add this new chat to. */
			projectId?: string;
			/** Existing workspace to add this chat to (alias of projectId, preferred). */
			workspaceId?: string;
			/** Create a new workspace for this chat (New modal default). */
			createWorkspace?: { name?: string };
			/**
			 * How the chat relates to its workspace's worktree: share it (default),
			 * stack a new worktree off it, or ask (no worktree).
			 */
			chatMode?: "share" | "stack" | "ask";
			model?: string;
			/** Optional MCP server allowlist for the opening run. [] means no external MCP servers. */
			mcpServers?: string[];
			images?: string[];
			/** Reasoning effort — persisted on the new session and enforced per run. */
			effort?: "low" | "medium" | "high";
			/** Fork an existing session, keeping its real conversation history. */
			forkFrom?: { sourceId: string; messageId?: string };
			/**
			 * Session opened from a sidebar PR row: `branch` is the PR's existing
			 * head branch — check it out (isolated worktree) instead of creating a
			 * new branch off origin/default.
			 */
			fromPr?: boolean;
	  }
	// Collaborative notes (Yjs updates relayed as base64 over this socket).
	| { type: "watch_note"; noteId: string; user?: string }
	| { type: "leave_note" }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string }
	// Native team chat: ephemeral typing signal for a chat channel
	// ("watercooler" or "session:<id>"). Relay-only, never persisted.
	| { type: "chat_typing"; channel: string; user: string };

export type WSServerMessage =
	// sessionId on the session-scoped messages lets viewers drop events meant
	// for a different chat (socket races, creator-side direct sends). Optional
	// because a few direct replies (slash-command notices, pre-create errors)
	// legitimately have no session.
	| {
			type: "transcript_init";
			sessionId?: string;
			entries: TranscriptEntry[];
			truncated?: boolean;
	  }
	| { type: "transcript_append"; sessionId?: string; entries: TranscriptEntry[] }
	| { type: "session_status"; sessionId?: string; isRunning: boolean }
	| { type: "presence"; sessionId: string; viewers: string[] }
	| {
			type: "global_presence";
			viewing: Array<{ user: string; sessionId: string }>;
	  }
	| { type: "term_data"; data: string }
	| { type: "term_exit"; code?: number }
	| { type: "stream_start"; sessionId: string; by?: string }
	| { type: "stream_text"; sessionId?: string; text: string }
	| { type: "stream_tool_use"; sessionId?: string; entry: TranscriptEntry }
	| { type: "stream_tool_result"; sessionId?: string; entry: TranscriptEntry }
	| { type: "stream_done"; sessionId?: string }
	| { type: "usage_update"; sessionId: string; usage: SessionUsage }
	| {
			type: "session_created";
			id: string;
			workspaceId?: string;
			/** True when this create made a brand-new workspace (vs. adding a chat). */
			newWorkspace?: boolean;
	  }
	| { type: "notice"; sessionId?: string; message: string }
	| { type: "model_changed"; sessionId: string; model: string; from?: string; by?: string }
	| {
			type: "subscription_changed";
			sessionId: string;
			accountId: string | null;
			name: string | null;
			by?: string;
	  }
	| {
			type: "queue_update";
			sessionId: string;
			queued: Array<{
				id: string;
				content: string;
				user?: string;
				images?: string[];
				files?: unknown;
			}>;
			steered?: Array<{
				id: string;
				content: string;
				user?: string;
				images?: string[];
				files?: unknown;
			}>;
	  }
	| {
			type: "ask_question";
			sessionId: string;
			questionId: string;
			questions: AskQuestion[];
	  }
	| { type: "ask_resolved"; sessionId: string; questionId: string }
	| { type: "server_restarting" }
	| { type: "frontend_updated"; version: string }
	// Collaborative notes.
	| { type: "note_state"; noteId: string; update: string }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string }
	| { type: "note_presence"; noteId: string; viewers: string[] }
	// Native team chat (Watercooler + per-session Chat tabs — not Slack).
	// Broadcast to every client so unread badges work without joining.
	| { type: "chat_message"; channel: string; message: ChatMessage }
	| { type: "chat_typing"; channel: string; user: string }
	// Linked Slack channel: a message arrived (inbound event or our own echo).
	| { type: "slack_message"; channelId: string; message: SlackMessage }
	| {
			type: "channel_linked";
			sessionId: string;
			slackChannel: SlackChannelLink | null;
	  }
	| { type: "pong" }
	| { type: "error"; sessionId?: string; message: string };

export interface AskQuestion {
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}
