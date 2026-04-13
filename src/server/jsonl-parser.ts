import { readFileSync, statSync } from "fs";
import { existsSync } from "fs";
import type { TranscriptEntry } from "./types";

// Slack ID → display name
const SLACK_USERS: Record<string, string> = {
  USU9S2YRF: "Grant Shaddick",
  UT41L6GCC: "Michiel Westerbeek",
  U03EACNTLA1: "Linear",
  U065GD4757C: "Thibault Saunier",
  U066K2VRDHA: "Andres Gomez",
  U0866D7PCCU: "Johnny Lin",
  U08CXTV7ML2: "John Soutar",
  U08EWERLX8D: "Jaap Frolich",
  U08JGAT5KNK: "Louise de Sadeleer",
  U08S8B3P83X: "Kent de Bruin",
  U0A3CERFC57: "Connor",
  U0A3PB2MJET: "Ankita Kulkarni",
  U0A7T08405R: "Michael",
  U01D3KX3ATW: "Johnny",
  U01E8UE6L15: "Louise",
  U084XSXRQNB: "Kent",
  U086HCZURPM: "Grant",
};

const SLACK_CHANNELS: Record<string, string> = {
  C0AFQ7PV057: "michael-tinker",
  C01ED50A2KG: "chat",
  C0A77HH0XPT: "design-polish",
  C047JD2KX8B: "engineering",
  C099PSZ8D5M: "michael-log",
};

const SLACK_WORKSPACE = "tella-team";

function resolveSlackIds(text: string): string {
  // Replace <@USERID> with **Name**
  text = text.replace(/<@(U[A-Z0-9]+)>/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**@${name}**` : `@${id}`;
  });
  // Replace [USERID]: at start of lines with **Name**:
  text = text.replace(/\[(U[A-Z0-9]+)\]:/g, (_match, id) => {
    const name = SLACK_USERS[id];
    return name ? `**${name}**:` : `[${id}]:`;
  });
  // Replace <#CHANNELID|name> or <#CHANNELID> channel references
  text = text.replace(/<#(C[A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id, name) => {
    const channelName = name || SLACK_CHANNELS[id] || id;
    return `[#${channelName}](https://app.slack.com/client/T8VB51YAR/${id})`;
  });
  return text;
}

interface RawJsonlEntry {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    role?: string;
    content?: any;
  };
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}

function parseEntry(raw: RawJsonlEntry): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  if (!raw.message?.content) return entries;

  const ts = raw.timestamp || new Date().toISOString();

  if (raw.type === "user") {
    const content = raw.message.content;

    // Check for tool_result blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n")
                : "";
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "tool_result",
            content: resultText,
            timestamp: ts,
            toolUseId: block.tool_use_id,
          });
        } else if (block.type === "text") {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "user",
            content: resolveSlackIds(block.text),
            timestamp: ts,
          });
        }
      }
    } else {
      const text = extractText(content);
      if (text) {
        entries.push({
          id: raw.uuid || crypto.randomUUID(),
          type: "user",
          content: resolveSlackIds(text),
          timestamp: ts,
        });
      }
    }
  }

  if (raw.type === "assistant") {
    const content = raw.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          entries.push({
            id: raw.uuid || crypto.randomUUID(),
            type: "assistant",
            content: block.text,
            timestamp: ts,
            requestId: raw.requestId,
          });
        }
        if (block.type === "tool_use") {
          entries.push({
            id: block.id || crypto.randomUUID(),
            type: "tool_use",
            content: summarizeToolUse(block.name, block.input),
            timestamp: ts,
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
            requestId: raw.requestId,
          });
        }
      }
    } else {
      const text = extractText(content);
      if (text) {
        entries.push({
          id: raw.uuid || crypto.randomUUID(),
          type: "assistant",
          content: text,
          timestamp: ts,
          requestId: raw.requestId,
        });
      }
    }
  }

  return entries;
}

function summarizeToolUse(name: string, input: any): string {
  if (!input) return `Using ${name}`;
  switch (name) {
    case "Read":
      return `Read ${input.file_path || "file"}`;
    case "Edit":
      return `Edit ${input.file_path || "file"}`;
    case "Write":
      return `Write ${input.file_path || "file"}`;
    case "Bash":
      return `$ ${(input.command || "").split("\n")[0].slice(0, 80)}`;
    case "Grep":
      return `Grep: ${input.pattern || ""} ${input.glob || ""}`;
    case "Glob":
      return `Glob: ${input.pattern || ""}`;
    case "WebFetch":
      return `Fetch ${input.url || ""}`;
    case "WebSearch":
      return `Search: ${input.query || ""}`;
    case "Agent":
    case "Task":
      return `Agent: ${input.description || input.prompt?.slice(0, 60) || ""}`;
    default:
      return `Using ${name}`;
  }
}

export function parseTranscript(path: string): TranscriptEntry[] {
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries: TranscriptEntry[] = [];
  const seenRequestIds = new Map<string, number>(); // requestId → last index in entries

  for (const line of lines) {
    let parsed: RawJsonlEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message types
    if (
      parsed.type !== "user" &&
      parsed.type !== "assistant"
    ) {
      continue;
    }

    const newEntries = parseEntry(parsed);
    for (const entry of newEntries) {
      // Deduplicate assistant messages with same requestId (keep last)
      if (
        entry.type === "assistant" &&
        entry.requestId
      ) {
        const prevIdx = seenRequestIds.get(entry.requestId);
        if (prevIdx !== undefined) {
          entries[prevIdx] = entry;
          continue;
        }
        seenRequestIds.set(entry.requestId, entries.length);
      }
      entries.push(entry);
    }
  }

  return entries;
}

export function parseTranscriptFrom(
  path: string,
  byteOffset: number
): { entries: TranscriptEntry[]; newOffset: number } {
  if (!existsSync(path)) return { entries: [], newOffset: byteOffset };

  const file = Bun.file(path);
  const size = file.size;
  if (size <= byteOffset) return { entries: [], newOffset: byteOffset };

  const buf = readFileSync(path);
  const chunk = buf.subarray(byteOffset).toString("utf-8");
  const lines = chunk.split("\n").filter((l) => l.trim());
  const entries: TranscriptEntry[] = [];

  for (const line of lines) {
    let parsed: RawJsonlEntry;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    entries.push(...parseEntry(parsed));
  }

  return { entries, newOffset: size };
}
