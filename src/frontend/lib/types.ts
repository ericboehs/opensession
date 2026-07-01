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

/** One message in a linked Slack channel, as shown in the chat panel. */
export interface SlackMessage {
	ts: string;
	userId: string | null;
	userName: string;
	avatarUrl?: string;
	text: string;
	isBot: boolean;
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
	prAuthor?: string;
	prUpdatedAt?: string;
	prChecks?: { total: number; passed: number; failed: number; pending: number };
	mode?: "ask" | "code";
	/** Primary repo this chat works in (repo id; default "tella-fusion"). */
	repo?: string;
	/** Optional Project (folder) this chat belongs to; null/undefined = standalone. */
	projectId?: string | null;
	/** Secondary repos this session also works in (cross-repo sessions). */
	attachedRepos?: Array<{ repo: string; branch: string; dir: string }>;
	automation?: string;
	archived?: boolean;
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
	codexThreadId?: string;
	modelHistory?: Array<{ model: string; at: string; by?: string }>;
	linearIssue?: { identifier: string; title: string; url?: string };
	slackThread?: { channel: string; threadTs: string };
	/** A Slack channel linked to this session for in-context discussion. */
	slackChannel?: SlackChannelLink;
	/** Blocked on an AskUserQuestion — a human needs to answer. Set by /api/sessions. */
	waitingForInput?: boolean;
	/** Number of prompts queued behind the current run. Set by /api/sessions. */
	queuedCount?: number;
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
}

export type WSClientMessage =
	| { type: "watch"; sessionId: string; user?: string }
	| { type: "load_history"; sessionId: string }
	| {
			type: "prompt";
			sessionId: string;
			content: string;
			user?: string;
			images?: string[];
			/** Reasoning effort for this turn — forward-compatible, not yet enforced. */
			effort?: "low" | "medium" | "high" | string;
	  }
	| {
			type: "interrupt_prompt";
			sessionId: string;
			content: string;
			user?: string;
			effort?: "low" | "medium" | "high" | string;
	  }
	| { type: "cancel" }
	| {
			type: "create_session";
			branch: string;
			prompt: string;
			user: string;
			mode?: "ask" | "code";
			repo?: string;
			/** Project (folder) to add this new chat to; omit for a standalone chat. */
			projectId?: string;
			model?: string;
			images?: string[];
			/**
			 * Palette controls — accepted but not yet consumed server-side (see
			 * NewSession.tsx). Wire these into the runners when ready.
			 */
			effort?: "low" | "medium" | "high";
			fast?: boolean;
			plan?: boolean;
			/** Fork an existing session, keeping its real conversation history. */
			forkFrom?: { sourceId: string; messageId?: string };
	  }
	// Collaborative notes (Yjs updates relayed as base64 over this socket).
	| { type: "watch_note"; noteId: string; user?: string }
	| { type: "leave_note" }
	| { type: "note_update"; noteId: string; update: string }
	| { type: "note_awareness"; noteId: string; update: string };

export type WSServerMessage =
	| { type: "transcript_init"; entries: TranscriptEntry[]; truncated?: boolean }
	| { type: "transcript_append"; entries: TranscriptEntry[] }
	| { type: "session_status"; isRunning: boolean }
	| { type: "presence"; sessionId: string; viewers: string[] }
	| { type: "stream_start"; sessionId: string; by?: string }
	| { type: "stream_text"; text: string }
	| { type: "stream_tool_use"; entry: TranscriptEntry }
	| { type: "stream_tool_result"; entry: TranscriptEntry }
	| { type: "stream_done" }
	| { type: "session_created"; id: string }
	| { type: "notice"; message: string }
	| { type: "model_changed"; sessionId: string; model: string; by?: string }
	| {
			type: "queue_update";
			sessionId: string;
			queued: Array<{ content: string; user?: string }>;
			steered?: Array<{ content: string; user?: string }>;
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
	// Linked Slack channel: a message arrived (inbound event or our own echo).
	| { type: "slack_message"; channelId: string; message: SlackMessage }
	| {
			type: "channel_linked";
			sessionId: string;
			slackChannel: SlackChannelLink | null;
	  }
	| { type: "error"; message: string };

export interface AskQuestion {
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}
