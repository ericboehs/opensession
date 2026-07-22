// Type-only (erased at build): the dynamic-workflow run snapshot broadcast to
// the session's Agents panel.
import type { WorkflowRunSnapshot } from "../../server/workflow-types";

export type SessionSource = "slack" | "linear" | "backstage" | "cli";

/** One message in a session's linked Plain thread (customer support). */
export interface PlainTimelineEntry {
	id: string;
	timestamp: string;
	actorName: string;
	actorType: "customer" | "support" | "bot" | "system";
	/** "message" = a CustomEntry, e.g. the in-app support form's original message. */
	kind: "email" | "chat" | "note" | "message";
	subject?: string;
	text: string;
}

/** A Plain thread's conversation timeline, as shown in the Plain sidebar. */
export interface PlainThread {
	id: string;
	title: string | null;
	status: string | null;
	priority: number | null;
	customer: {
		id?: string | null;
		name: string | null;
		email: string | null;
		isSpam?: boolean;
	};
	/** Workspace user (or bot) the thread is assigned to, if anyone. */
	assignee?: { id: string; name: string; isBot: boolean } | null;
	/** Labels on the thread. `id` removes it, `labelTypeId` is the kind. */
	labels?: { id: string; labelTypeId: string; name: string; icon: string | null }[];
	entries: PlainTimelineEntry[];
}

/** A Plain workspace teammate, for the Support UI's Assign menu. */
export interface PlainWorkspaceUser {
	id: string;
	name: string;
	email: string | null;
}

/** A Plain label kind, for the Support UI's Labels menu. */
export interface PlainLabelType {
	id: string;
	name: string;
	icon: string | null;
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
	/** Labels on the thread (id = instance l_…, typeId = kind lt_…). Optional
	 *  so rows cached by an older server shape still render. */
	labels?: { id: string; typeId: string; name: string; icon: string | null }[];
	customer: { name: string | null; email: string | null };
}

/** One item on a user's Desk todo list (mirror of src/server/todos.ts). */
export interface TodoItem {
	id: string;
	user: string;
	text: string;
	status: "open" | "done" | "dropped";
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	note?: string;
	due?: string;
	/** Reminder: push + Slack DM fire once this ISO datetime passes. */
	remindAt?: string;
	remindedAt?: string;
	source: { kind: "session" | "manual"; sessionId?: string; by?: string };
}

export interface ReportMeta {
	id: string;
	title: string;
	automationId: string;
	automationName: string;
	sessionId?: string;
	createdAt: string;
	summary?: string;
}

export interface ReportGroup {
	automationId: string;
	automationName: string;
	count: number;
	latest: ReportMeta;
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

/** Snapshot of a quoted message (Slack-style "reply") — a copy, so it stays
 *  renderable even after the original leaves the bounded store. */
export interface ChatReplyTo {
	id: string;
	user: string;
	/** Excerpt of the original text (may be empty for image-only originals). */
	text: string;
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
	/** Thread parent's message id — set only on thread replies. */
	threadId?: string;
	/** Quoted message this one replies to (independent of threads). */
	replyTo?: ChatReplyTo;
	/** emoji → display names of teammates who reacted with it. */
	reactions?: Record<string, string[]>;
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

/** One before/after screenshot pair in a session walkthrough. */
export interface WalkthroughShot {
	before?: string;
	after?: string;
	caption?: string;
}

/** Agent-published PR walkthrough: demo video + before/after + writeup.
 *  Paths are server-absolute; stream them via /backstage/media?path=. */
export interface SessionWalkthrough {
	summary: string;
	video?: string;
	videoTitle?: string;
	shots?: WalkthroughShot[];
	publishedAt: string;
	publishedBy?: string;
}

export interface UnifiedSession {
	id: string;
	/** Present and true when the local-profile server owns this session. */
	local?: boolean;
	claudeSessionId: string | null;
	source: SessionSource;
	branch: string | null;
	worktreeDir: string | null;
	startedBy: string | null;
	title: string;
	/** True when `title` is a manual rename rather than derived/generated. */
	titleOverridden?: boolean;
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
	/** MERGEABLE | CONFLICTING | UNKNOWN — GitHub's async conflict probe. */
	prMergeable?: string;
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
	/** Person keys whose latest submitted PR review stands (approved /
	 *  changes requested / commented). Open PRs only. */
	prReviewedBy?: string[];
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
	/** Set on a side chat — the parent session it was spawned from and
	 *  @-mentions back into. Suppressed from the left sidebar. */
	sideChatOf?: string;
	/** The user's standing Desk (concierge) session — fixed title, hidden from
	 *  the session lists, opened via the Desk overlay (⌘J). */
	desk?: boolean;
	/** Secondary repos this session also works in (cross-repo sessions). */
	attachedRepos?: Array<{ repo: string; branch: string; dir: string }>;
	/** PRs manually linked to this session (beyond branch/attached-repo ones). */
	linkedPrs?: Array<{
		repo: string;
		branch: string;
		number?: number;
		url?: string;
		title?: string;
	}>;
	/** Every PR this session spans (primary + attached + linked), enriched from
	 *  the server's bulk PR cache. The singular pr* fields above stay the
	 *  primary branch's PR. */
	prs?: Array<{
		repo: string;
		branch: string;
		source: "primary" | "attached" | "linked";
		url?: string;
		state?: "OPEN" | "MERGED" | "CLOSED";
		number?: number;
		title?: string;
		isDraft?: boolean;
		reviewDecision?: string;
		checks?: { total: number; passed: number; failed: number; pending: number };
	}>;
	/** Route the Preview/Staging buttons deep-link to (agent-set via
	 *  opensession-preview); appended to the base URL. Unset = open the app root. */
	previewPath?: string;
	/** Agent-published demo walkthrough (video + before/after + writeup),
	 *  rendered in the Review tab and mirrored to the PR description. */
	walkthrough?: SessionWalkthrough;
	automation?: string;
	/** Stable automation id for linking back to its settings. */
	automationId?: string;
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
	/** OpenCode reasoning variant for this session's runs; unset = model default. */
	effort?: string;
	/** Pinned Claude subscription (claude-accounts id); unset = auto pool. */
	accountId?: string;
	codexThreadId?: string;
	modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
	/** Cumulative token/cost accounting for this session's runs. */
	usage?: SessionUsage;
	/** Sandbox opt-in (docs/sandboxes-plan.md): the session's runs execute in an
	 *  isolated container via the named provider. `sandboxId` is set once the
	 *  provider materialized it; `workspace: "volume"` means the workspace lives
	 *  ONLY inside the sandbox (no host worktree). Mirrors the session file. */
	sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
	linearIssue?: { identifier: string; title: string; url?: string };
	slackThread?: { channel: string; threadTs: string };
	/** Blocked on an AskUserQuestion — a human needs to answer. Set by /api/sessions. */
	waitingForInput?: boolean;
	/** Number of prompts queued behind the current run. Set by /api/sessions. */
	queuedCount?: number;
	/**
	 * The create run is still preparing this session's worktree (git fetch +
	 * worktree add + dep install). The viewer shows "Waiting for workspace" and
	 * holds sends in the queue until it flips off. Set by /api/sessions.
	 */
	workspacePreparing?: boolean;
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
	reviewRequest?: {
		to: string;
		by: string;
		at: string;
		accepted?: { by: string; at: string };
	};
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
	// On assistant text entries: the model that wrote this message (per-message,
	// so mid-session switches and usage-limit fallbacks stay honest).
	model?: string;
	// Set on a Task/Agent tool_result: the spawned sub-agent's id. Lets the UI
	// open that sub-agent's conversation in the right sidebar.
	agentId?: string;
	// Ready-to-render image srcs (http(s) URLs or data: URLs), e.g. from a Read
	// of an image file or a pasted image.
	images?: string[];
	// Ready-to-render video srcs (served via <base>/media), parsed from
	// `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
	videos?: string[];
	// Non-media composer attachments (staged to disk server-side) — rendered as
	// downloadable chips on the user bubble; `path` feeds <base>/media?path=.
	files?: { name: string; path: string }[];
	// Set when `content` was clamped for the WebSocket wire (server-side, giant
	// entries only) — `contentLength` is the full length; the full entry is at
	// GET /api/sessions/:id/entry/:entryId.
	contentClamped?: boolean;
	contentLength?: number;
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

export interface DiffFileGroup {
	title: string;
	files: string[];
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

export interface PrFile {
	path: string;
	additions: number;
	deletions: number;
}

export interface PrReviewer {
	login: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
	isTeam?: boolean;
}

export interface PrCommit {
	oid: string;
	messageHeadline: string;
	messageBody?: string;
	authoredDate?: string;
	author: string;
}

export interface PrDetails {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
	/** Current head commit, used to keep independently loaded metadata and diffs aligned. */
	headRefOid?: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	reviewDecision: string;
	author: string;
	body: string;
	checks: PrCheck[];
	comments?: PrComment[];
	commits?: PrCommit[];
	/** Per-file line stats, biggest churn first. */
	files?: PrFile[];
	/** People/teams on the reviewer list with their latest review state. */
	reviewers?: PrReviewer[];
	/** MERGEABLE | CONFLICTING | UNKNOWN — the provider's conflict probe. */
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
			/** Sibling-chat ids whose transcripts ride along as context (the
			    fresh-chat "Add chat transcripts" chips). */
			contextChats?: string[];
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
	| {
			// Drag-to-reorder: `order` is the queued items' ids in their new send
			// order. The server reconciles its queue array to match.
			type: "reorder_queued_prompt";
			sessionId: string;
			order: string[];
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
			/** Run in a sandbox: true = server's default provider, or an explicit
			 *  configured provider id (including "modal" / "lambda-microvm"). Omit = host. */
			sandbox?: boolean | string;
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
			/** Byte offset the shipped tail begins at — the "load earlier"
			 *  pagination cursor (absent on older servers → full-resend fallback). */
			startOffset?: number;
	  }
	| {
			/** Older entries: the bulk of a two-stage init, or one "load earlier"
			 *  page. Client merges by id and re-sorts by time (prepend semantics). */
			type: "transcript_history";
			sessionId?: string;
			entries: TranscriptEntry[];
			truncated?: boolean;
			startOffset?: number;
	  }
	| { type: "transcript_append"; sessionId?: string; entries: TranscriptEntry[] }
	| { type: "session_status"; sessionId?: string; isRunning: boolean }
	| { type: "presence"; sessionId: string; viewers: string[] }
	| {
			type: "global_presence";
			viewing: Array<{ user: string; sessionId: string }>;
	  }
	| { type: "pins_changed"; user: string; pins: string[] }
	| { type: "term_data"; data: string }
	| { type: "term_exit"; code?: number }
	// Where the Shell tab's PTY landed (sandboxed sessions run their shell
	// inside the sandbox) + optional fallback explanation.
	| { type: "term_ready"; target: "host" | "docker" | "daytona"; cwd?: string }
	| { type: "term_notice"; message: string }
	| { type: "stream_start"; sessionId: string; by?: string }
	| { type: "stream_text"; sessionId?: string; text: string }
	| { type: "stream_tool_use"; sessionId?: string; entry: TranscriptEntry }
	| { type: "stream_tool_result"; sessionId?: string; entry: TranscriptEntry }
	| { type: "stream_done"; sessionId?: string }
	| { type: "usage_update"; sessionId: string; usage: SessionUsage }
	| { type: "cache_warning"; sessionId: string }
	| {
			type: "session_created";
			id: string;
			workspaceId?: string;
			/** True when this create made a brand-new workspace (vs. adding a chat). */
			newWorkspace?: boolean;
			/** True while the session's worktree is still being created. */
			preparingWorkspace?: boolean;
	  }
	// The create run finished (or failed) preparing the session's worktree.
	| { type: "workspace_status"; sessionId: string; ready: boolean }
	// A silent server-side auto-push published the session's local commits (repo
	// id for multi-repo sessions) — the PR status header refetches on this.
	| { type: "git_pushed"; sessionId: string; repo?: string }
	// The session's scratch assets folder changed (agent wrote/deleted a
	// file) — the Assets tab refetches its tree on this.
	| { type: "assets_changed"; sessionId: string }
	// An automation published a report. sessionId is present for reports tied to
	// a run and lets that run's Reports tab refresh immediately.
	| { type: "reports_changed"; automationId: string; sessionId?: string }
	// The Desk todo list changed (any mutation, any surface — see todos.ts).
	| { type: "todos_changed"; user: string }
	| { type: "notice"; sessionId?: string; message: string }
	// Dynamic workflow run snapshot changed (workflow-store broadcasts every
	// mutation) — powers the session's Agents panel.
	| { type: "workflow_update"; sessionId: string; run: WorkflowRunSnapshot }
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
	// `by` on restart/update notices names the session(s) that likely caused
	// it (best-effort, from in-flight runs in the server checkout) — absent
	// when the trigger wasn't an opensession session.
	| { type: "server_restarting"; by?: string }
	// First frame on every socket: the server process's bootId, so a reconnect
	// can tell a real restart (changed) from a transient blip (unchanged).
	// Absent on old servers — clients fall back to /api/health's bootId.
	// `restartBy` (when the boot was seconds after a shutdown) names the
	// session that likely triggered that restart.
	| { type: "hello"; bootId: string; restartBy?: string }
	| { type: "frontend_updated"; version: string; by?: string }
	// Collaborative notes.
	| { type: "note_state"; noteId: string; update: string }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string }
	| { type: "note_presence"; noteId: string; viewers: string[] }
	// Native team chat (Watercooler + per-session Chat tabs — not Slack).
	// Broadcast to every client so unread badges work without joining.
	| { type: "chat_message"; channel: string; message: ChatMessage }
	// An existing message changed in place (reaction toggled) — replace by id;
	// never bumps unread badges.
	| { type: "chat_message_updated"; channel: string; message: ChatMessage }
	| { type: "chat_typing"; channel: string; user: string }
	| { type: "pong" }
	| { type: "error"; sessionId?: string; message: string };

export interface AskQuestion {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

// ── Analytics (sidebar → Analytics; GET /api/analytics) ──

export interface AnalyticsDay {
	date: string;
	sessions: number;
	sessionsByKind: Record<string, number>;
	turns: number;
	errors: number;
	cancelled: number;
	outputTokens: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputByModel: Record<string, number>;
	prsOpened: number;
	prsMerged: number;
	durationMs: number;
}

export interface AnalyticsModel {
	model: string;
	turns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export interface AnalyticsPerson {
	name: string;
	sessionsCreated: number;
	sessionsActive: number;
	turns: number;
	outputTokens: number;
}

export interface AnalyticsAutomation {
	name: string;
	runs: number;
	sessionsActive: number;
	turns: number;
	outputTokens: number;
	errors: number;
}

export interface AnalyticsRepoPrs {
	repo: string;
	prsOpened: number;
	prsMerged: number;
	allOpened: number;
	allMerged: number;
}

export interface AnalyticsPr {
	repo: string;
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	createdAt: string;
	mergedAt: string | null;
	headRefName: string;
	byOpensession: boolean;
}

export interface AnalyticsSummary {
	from: string;
	to: string;
	days: AnalyticsDay[];
	totals: {
		sessions: number;
		sessionsCreated: number;
		turns: number;
		errors: number;
		cancelled: number;
		oneshots: number;
		durationMs: number;
		outputTokens: number;
		inputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		prsOpened: number;
		prsMerged: number;
		allPrsOpened: number;
		allPrsMerged: number;
		activePeople: number;
	};
	models: AnalyticsModel[];
	people: AnalyticsPerson[];
	automations: AnalyticsAutomation[];
	repos: AnalyticsRepoPrs[];
	prs: AnalyticsPr[];
}
