export type SessionSource = "slack" | "linear" | "backstage" | "cli";

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
  mode?: "ask" | "code";
  automation?: string;
  archived?: boolean;
  // Source-specific
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
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
}

// CLI session file format (~/.claude/sessions/*.json)
export interface CLISessionFile {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

// Backstage session file format
export interface BackstageSessionFile {
  id: string;
  claudeSessionId: string;
  branch: string;
  worktreeDir: string;
  createdBy: string;
  createdAt: string;
  lastActivity: string;
  title?: string;
  mode?: "ask" | "code";
  automation?: string; // name of the automation that created this session
  plainThreadId?: string; // Plain thread this session is triaging
  archived?: boolean;
  archivedAt?: string;
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
}

export interface FileWatcherState {
  path: string;
  lastMtime: number;
  lastByteOffset: number;
  viewers: Set<any>;
}
