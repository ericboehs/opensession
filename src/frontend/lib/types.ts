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

export type WSClientMessage =
  | { type: "watch"; sessionId: string }
  | { type: "prompt"; sessionId: string; content: string }
  | { type: "cancel" }
  | { type: "create_session"; branch: string; prompt: string; user: string };

export type WSServerMessage =
  | { type: "transcript_init"; entries: TranscriptEntry[] }
  | { type: "transcript_append"; entries: TranscriptEntry[] }
  | { type: "session_status"; isRunning: boolean }
  | { type: "stream_start"; sessionId: string }
  | { type: "stream_text"; text: string }
  | { type: "stream_tool_use"; entry: TranscriptEntry }
  | { type: "stream_tool_result"; entry: TranscriptEntry }
  | { type: "stream_done" }
  | { type: "error"; message: string };
