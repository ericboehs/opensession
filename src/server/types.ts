export type SessionSource = "slack" | "linear" | "backstage" | "cli";

/** A Slack channel linked to a backstage session (strictly one-to-one). */
export interface SlackChannelLink {
  channelId: string;
  name: string;
}

/**
 * Cumulative token/cost accounting for a chat session, updated after every run.
 * Cost is the API-equivalent USD spend (authoritative `total_cost_usd` from the
 * Claude SDK; computed from the rate table for Codex). `contextTokens` is the
 * size of the most recent turn's full prompt (input + cache read + cache
 * creation) — the live "how full is the window" number, shown against
 * `contextWindow`. `costApproximate` is set when any run in the session priced
 * cost from the table rather than an authoritative SDK figure (i.e. Codex).
 */
export interface SessionUsage {
  costUsd: number;
  costApproximate?: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Most recent turn's full prompt size (context currently in use). */
  contextTokens: number;
  /** Token ceiling of the model that produced `contextTokens`. */
  contextWindow: number;
  /** Number of completed turns folded into these totals. */
  turns: number;
  /** ISO time of the last update. */
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
   * in the sidebar. Only set while isRunning; sourced from the run journal, so
   * it survives a page refresh (external CLI/tmux runs have no journal record,
   * so it's absent there and the UI falls back to a client-observed start).
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
  attachedRepos?: AttachedRepo[];
  /**
   * Root-relative route the agent recorded as the place to test this change
   * (e.g. `/settings/tags`). Appended to the Preview (local dev) and Staging
   * (PR deploy) URLs so a click lands directly on the feature under test.
   */
  previewPath?: string;
  automation?: string;
  archived?: boolean;
  /** Why this session is archived — powers the "Auto-archived" filter. */
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  plainThreadId?: string;
  /** Model id for runs in this session; unset = default (MICHAEL_MODEL). */
  model?: string;
  /** Reasoning effort for runs in this session (low|medium|high); unset = backend default. */
  effort?: string;
  /**
   * Pinned Claude subscription (claude-accounts id) for runs in this session.
   * Unset = auto (personal-sub-first, shared-pool fallback). Claude models only;
   * the pinned account is preferred and the pool is still the fallback when it's
   * exhausted, so a pin never hard-fails a run.
   */
  accountId?: string;
  /** Codex thread id, when this session has run on a codex-provider model. */
  codexThreadId?: string;
  /** Provider whose engine last drove a run — lets the next run detect an
   *  in-place cross-provider switch and bridge context. */
  lastEngineProvider?: "claude" | "codex";
  /** /model switches, newest last — rendered as dividers in the conversation.
   *  `from` is the model in effect before the switch (for a "X → Y" divider). */
  modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
  /** Cumulative token/cost accounting for this session's runs. */
  usage?: SessionUsage;
  goal?: string;
  /** Goal record id, when this session is driven by a Goal (src/server/goals.ts). */
  goalId?: string;
  /**
   * The session's last run died on a terminal failure (usage limits exhausted
   * on every account, credit/API errors) — a human must act before the session
   * can continue, so the UI surfaces it as "Needs input" instead of Backlog.
   * Cleared by the next run that ends cleanly.
   */
  lastRunError?: { message: string; at: string };
  /**
   * Manual sidebar-lane override (Needs input / In progress / In review / Done /
   * Backlog). When set it wins over the derived lane in the sidebar, letting a
   * human pin a session where they want it. Set from the status-override
   * registry in getAllSessions; unset = derive the lane as usual.
   */
  manualStatus?: "needsinput" | "inprogress" | "review" | "merged" | "pending";
  /**
   * A pending "please review this" pointed at a teammate, set from the info
   * panel's Reviewer picker. Surfaces the session in a "Needs review" band at
   * the top of the reviewer's sidebar. Set from the review-request registry in
   * getAllSessions; cleared by picking "No reviewer" (or re-assigning).
   */
  reviewRequest?: {
    to: string;
    by: string;
    at: string;
    accepted?: { by: string; at: string };
  };
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  // Other IDs that resolve to this session. The same Claude session can be
  // tracked by multiple files (e.g. a Slack run writes both <branch>.json and
  // <channel>-<threadTs>.json) and external deep links may use any of them.
  aliasIds?: string[];
  /** A Slack channel linked to this session for in-context discussion. */
  slackChannel?: SlackChannelLink;
  // Source-specific
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
  mcpServers?: string[]; // External MCP servers loaded for this session
  /** Sandbox opt-in (docs/sandboxes-plan.md): mirrors the session file's field.
   *  Runs route through the named provider when config + kill-switch allow;
   *  `sandboxId` is set once a provider materializes the sandbox (Phase 1+).
   *  `workspace` records how the workspace was materialized: "volume" means it
   *  lives ONLY inside the sandbox (no host worktree — Phase 2). */
  sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
}

// Slack session file format (two variants exist)
export interface SlackSessionFile {
  branch?: string | null;
  userId?: string;
  message?: string;
  worktreeDir?: string | null;
  claudeSessionId?: string | null;
  createdAt?: string;
  lastActivity?: string;
  channel?: string;
  threadTs?: string;
  mode?: "conversational" | "worktree";
  model?: string;
  codexThreadId?: string | null;
}

// Linear session file format
export interface LinearSessionFile {
  branch: string;
  claudeSessionId: string | null;
  issueIdentifier?: string;
  issueTitle?: string;
  worktreeDir?: string;
  linearSessionId?: string;
  isRalphMode?: boolean;
  issueId?: string;
  issueUrl?: string;
  participants?: Array<{ id: string; name: string; email: string | null }>;
  lastActiveUser?: { id: string; name: string; email: string | null } | null;
  updatedAt?: string;
  model?: string;
}

// CLI session file format (~/.claude/sessions/*.json)
export interface CLISessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// Backstage session file format
/**
 * A secondary repo attached to a session for cross-repo work. Each gets its own
 * isolated worktree (never the shared main checkout), so the agent can branch,
 * commit, and open a PR there independently of the primary repo.
 */
export interface AttachedRepo {
  repo: string; // repo id (key in worktree.ts REPOS)
  branch: string;
  dir: string; // worktree path
}

export interface BackstageSessionFile {
  id: string;
  claudeSessionId: string;
  branch: string;
  worktreeDir: string;
  /** Secondary repos this session also works in (cross-repo sessions). */
  attachedRepos?: AttachedRepo[];
  /** Root-relative route the Preview/Staging buttons deep-link to (set by the
   *  agent via michael-preview's set_preview_path). Unset = open the app root. */
  previewPath?: string;
  createdBy: string;
  createdAt: string;
  lastActivity: string;
  title?: string;
  mode?: "ask" | "code";
  repo?: string; // which repo this chat works in (default "tella-fusion")
  workspaceId?: string | null; // Workspace this chat belongs to (canonical key)
  projectId?: string | null; // legacy alias of workspaceId (dual-read during migration)
  /** Parent/orchestrator session when this chat was spawned as a visible worker sub-session. */
  parentSessionId?: string;
  automation?: string; // name of the automation that created this session

  plainThreadId?: string; // Plain thread this session is triaging
  model?: string; // model id for this session's runs; unset = default
  effort?: string; // reasoning effort for this session's runs (low|medium|high); unset = backend default
  accountId?: string; // pinned Claude subscription (claude-accounts id); unset = auto pool
  codexThreadId?: string; // codex thread id once the session has run on a codex model
  /** Provider whose engine last actually drove a run in this session. Lets the
   *  next run detect an in-place cross-provider switch (Claude↔Codex) and hand
   *  the incoming engine a transcript bridge so context carries over. */
  lastEngineProvider?: "claude" | "codex";
  modelHistory?: Array<{ model: string; from?: string; at: string; by?: string }>;
  usage?: SessionUsage; // cumulative token/cost accounting for this session's runs
  archived?: boolean;
  archivedAt?: string;
  archivedReason?: "manual" | "idle" | "auto" | "plain";
  goal?: string; // pinned goal, appended to every prompt until cleared
  goalId?: string; // Goal record this session is driven by (src/server/goals.ts)
  lastRunError?: { message: string; at: string }; // last run died on a terminal error; cleared on the next clean run
  loop?: { prompt: string; intervalMinutes: number; lastRunAt?: string; setBy?: string };
  slackChannel?: SlackChannelLink; // Slack channel linked for in-context discussion
  mcpServers?: string[]; // External MCP servers to load for this session; empty = none (minimal context)
  /** Sandbox opt-in (docs/sandboxes-plan.md): recorded at create time when the
   *  creator asked for a sandbox. `provider` is the effective provider id at
   *  creation ("local" until a real provider is configured); `sandboxId` is
   *  set once a provider materializes a sandbox for the session (Phase 1+);
   *  `workspace` records the materialized mode — "volume" workspaces live only
   *  inside the sandbox (no host worktree; Phase 2). */
  sandbox?: { provider: string; sandboxId?: string; workspace?: "bind" | "volume" };
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
  // Set on a tool_result whose block carried is_error — the UI shows the step
  // with an error state instead of a success check.
  isError?: boolean;
  // Set on a Task/Agent tool_result: the spawned sub-agent's id. The SDK writes
  // the sub-agent's own transcript to <transcript>/subagents/agent-<agentId>.jsonl,
  // so this links a tool call to its sub-agent conversation (see subagents.ts).
  agentId?: string;
  // Ready-to-render image srcs (http(s) URLs or data: URLs) extracted from
  // image blocks — e.g. a Read of an image file, or a pasted image.
  images?: string[];
  // Ready-to-render video srcs (served via /backstage/media) parsed from
  // `BACKSTAGE_VIDEO: <path>` markers a tool printed — e.g. tella-local rec.mjs.
  videos?: string[];
}

export interface FileWatcherState {
  path: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>;
}
