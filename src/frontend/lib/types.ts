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
  linearIssue?: { identifier: string; title: string; url?: string };
  slackThread?: { channel: string; threadTs: string };
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
  | { type: "prompt"; sessionId: string; content: string; user?: string }
  | { type: "cancel" }
  | { type: "create_session"; branch: string; prompt: string; user: string; mode?: "ask" | "code" };

export type WSServerMessage =
  | { type: "transcript_init"; entries: TranscriptEntry[] }
  | { type: "transcript_append"; entries: TranscriptEntry[] }
  | { type: "session_status"; isRunning: boolean }
  | { type: "presence"; sessionId: string; viewers: string[] }
  | { type: "stream_start"; sessionId: string; by?: string }
  | { type: "stream_text"; text: string }
  | { type: "stream_tool_use"; entry: TranscriptEntry }
  | { type: "stream_tool_result"; entry: TranscriptEntry }
  | { type: "stream_done" }
  | { type: "session_created"; id: string }
  | { type: "error"; message: string };
