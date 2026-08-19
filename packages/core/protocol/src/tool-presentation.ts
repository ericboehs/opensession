/**
 * What a tool call IS, and what it did — derived once, for every client.
 *
 * A transcript is mostly tool calls, and each client has to answer the same
 * questions about one: which tool is this really (engines spell the same tool
 * three ways), is it an MCP call, which icon family does it belong to, what
 * single line describes it, and how many lines did it change. Those answers
 * were re-derived per client — ~200 lines inside the web's ToolCallBlock, 540
 * in the native app's ToolPresentation.swift, and again in the terminal
 * client — so the same call could read three different ways.
 *
 * The split here is deliberate:
 *
 *  - Identity and content (canonical name, MCP server, family, `detail`,
 *    line stats) are FACTS about the call. They belong here, and the server
 *    ships them on the entry so a client never re-parses tool input.
 *  - Turning those facts into pixels stays with each client — an SF Symbol
 *    isn't an SVG, and a path is shortened against roots only the client
 *    knows. `formatToolDetail` is the shared default for the string form,
 *    taking the path shortener as an argument rather than owning one.
 *
 * `detail` is structured rather than a pre-rendered string for that reason:
 * the phone dims a path's directory, the terminal truncates it, and both need
 * to know it IS a path.
 */

import type { TranscriptEntry } from "./session";
import { currentPlanItem, parsePlanItems, planDoneCount } from "./todo-plan";

/**
 * Engine dialects for the same tool. Claude Code, opencode and codex all name
 * the basics differently; folding them onto one canonical name is what lets
 * one set of summaries, icons and detail renderers cover all three.
 */
const TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  view_image: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "Edit",
  patch: "Edit",
  apply_patch: "Edit",
  bash: "Bash",
  shell: "Bash",
  exec_command: "Bash",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  skill: "Skill",
  todowrite: "TodoWrite",
  todoread: "TodoWrite",
  update_plan: "TodoWrite",
};

/** Engine-native tools that contain an underscore but are not MCP calls. */
const NATIVE_TOOLS = new Set([
  "invalid",
  "oracle",
  "exit_plan_mode",
  "notebook_edit",
  "web_search",
  "web_fetch",
  "str_replace_editor",
]);

/** The name the renderers key on. Display still uses the raw engine id. */
export function canonicalToolName(name?: string): string {
  if (!name) return "Tool";
  return TOOL_ALIASES[name] ?? name;
}

/**
 * "mcp__linear__list_issues" (Claude SDK) or "linear_list_issues" (opencode's
 * flattened form) → { server: "linear", tool: "list_issues" }. Native tools are
 * excluded by name first, so "apply_patch" doesn't read as an "apply" server.
 */
export function parseMcpTool(
  name: string,
): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] === "mcp" && parts.length >= 3) {
    return { server: parts[1], tool: parts.slice(2).join("__") };
  }
  if (TOOL_ALIASES[name] || NATIVE_TOOLS.has(name)) return null;
  const flat = name.match(/^([A-Za-z][A-Za-z0-9-]*)_(.+)$/);
  return flat ? { server: flat[1], tool: flat[2] } : null;
}

const IDENTIFIER_NAMES: Record<string, string> = {
  api: "API",
  github: "GitHub",
  ios: "iOS",
  mcp: "MCP",
  opensession: "Open Session",
  posthog: "PostHog",
  sql: "SQL",
  tella: "Tella",
  url: "URL",
  workos: "WorkOS",
};

function identifierWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
}

/** "opensession-preview" → "Open Session Preview". */
export function mcpServerDisplayName(name: string): string {
  return identifierWords(name)
    .map((word) => {
      const lower = word.toLowerCase();
      return IDENTIFIER_NAMES[lower] ?? `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}`;
    })
    .join(" ");
}

/** "start_preview" → "Start preview". */
export function mcpToolDisplayName(name: string): string {
  const words = identifierWords(name).map(
    (word) => IDENTIFIER_NAMES[word.toLowerCase()] ?? word.toLowerCase(),
  );
  if (!words.length) return name;
  return `${words[0][0]?.toUpperCase() ?? ""}${words[0].slice(1)}${
    words.length > 1 ? ` ${words.slice(1).join(" ")}` : ""
  }`;
}

/** "mcp__linear__list_issues" → "Linear · List issues", else the tool name. */
export function toolDisplayName(name?: string): string {
  if (!name) return "Tool";
  const mcp = parseMcpTool(name);
  return mcp
    ? `${mcpServerDisplayName(mcp.server)} · ${mcpToolDisplayName(mcp.tool)}`
    : name;
}

/**
 * The icon buckets. One glyph per family is what makes a collapsed turn
 * legible at a glance ("terminal, pencil, pencil, magnifier" reads as "ran
 * something, edited twice, searched"). Clients map a family to their own
 * glyph, and must treat an unknown one from a newer server as `other`.
 */
export type ToolFamily =
  | "run"
  | "file"
  | "edit"
  | "find"
  | "web"
  | "agent"
  | "mcp"
  | "skill"
  | "checklist"
  | "other";

export function toolFamily(toolName: string): ToolFamily {
  if (parseMcpTool(toolName)) return "mcp";
  switch (canonicalToolName(toolName)) {
    case "Bash":
    case "BashOutput":
      return "run";
    case "Read":
    case "NotebookEdit":
      return "file";
    case "Edit":
    case "Write":
    case "FileChange":
      return "edit";
    case "Grep":
    case "Glob":
    case "LSP":
    case "ToolSearch":
      return "find";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Task":
    case "Agent":
    case "Workflow":
      return "agent";
    case "Skill":
      return "skill";
    case "TodoWrite":
      return "checklist";
    default:
      return "other";
  }
}

/**
 * The one line a tool row says, as data. A client formats it: `path`/`paths`
 * get shortened against the session's worktrees and their directory dimmed,
 * `command` is monospaced, `todo` becomes "2/7 done" beside the live step.
 */
export type ToolDetail =
  | { kind: "path"; path: string }
  /** `labels[i]` prefixes `paths[i]` when present ("Update src/x.ts"). */
  | { kind: "paths"; paths: string[]; labels?: string[]; more?: number }
  | { kind: "command"; command: string }
  /** Free text, plus a trailing path the client should shorten — Grep and
   *  Glob are a pattern AND a path. */
  | { kind: "text"; text: string; path?: string }
  | { kind: "todo"; total: number; done: number; current?: string }
  | { kind: "none" };

export interface ToolLineStats {
  additions: number;
  deletions: number;
}

export interface ToolPresentation {
  /** Canonical tool name ("Bash", "Read", "Edit"), or the raw name. */
  canonical: string;
  /** MCP server for `mcp__linear__list_issues` style names ("linear"). */
  mcpServer?: string;
  /** What a row labels the call: the bare tool name for MCP calls (the server
   *  rides in its own pill), else the canonical name. */
  name: string;
  family: ToolFamily;
  detail: ToolDetail;
  /** Lines added/removed by an Edit or Write, when derivable from the input. */
  lineStats?: ToolLineStats;
}

/** First non-empty string among `keys` — engines disagree on the spelling.
 *  Exported because clients reading the same inputs for their expanded views
 *  must not re-invent the spelling list. */
export function toolInputString(inp: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = inp[key];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export const toolFilePath = (inp: Record<string, unknown>) =>
  toolInputString(inp, "file_path", "filePath");
export const toolCommand = (inp: Record<string, unknown>) =>
  toolInputString(inp, "command", "cmd");

/**
 * The scratch file an `opensession-assets` call names, if it names one.
 *
 * Its own accessor rather than a branch inside `toolDetail`, because clients
 * need the path itself and not only a summary line: a session's assets live
 * outside every worktree, so nothing else in a transcript knows what the path
 * means, and the row that names an artifact is the only place a reader can be
 * offered a way into it.
 */
export function assetToolPath(toolName: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const mcp = parseMcpTool(toolName);
  if (mcp?.server !== "opensession-assets") return "";
  if (!/^(write|read|delete)_asset$/.test(mcp.tool)) return "";
  return toolInputString(input as Record<string, unknown>, "path");
}

/** Internal plumbing that shouldn't show up in a summary or the input JSON. */
const HIDDEN_INPUT_KEYS = new Set(["__bks_oc_session"]);

export function isHiddenToolInputKey(key: string): boolean {
  return HIDDEN_INPUT_KEYS.has(key);
}

function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

/** Files named inside a codex-style patch body ("*** Update File: src/x.ts"). */
function patchFiles(inp: Record<string, unknown>): string[] {
  const text = toolInputString(inp, "patchText", "patch");
  if (!text) return [];
  return [
    ...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
  ].map((m) => m[1].trim());
}

function fileChangeDetail(inp: Record<string, unknown>): ToolDetail | null {
  if (!Array.isArray(inp.changes)) return null;
  const paths: string[] = [];
  const labels: string[] = [];
  for (const change of inp.changes.slice(0, 4)) {
    if (typeof change === "string") {
      paths.push(change);
      labels.push("");
      continue;
    }
    if (!change || typeof change !== "object") continue;
    const c = change as Record<string, unknown>;
    paths.push(typeof c.path === "string" ? c.path : "");
    labels.push(typeof c.kind === "string" ? c.kind : "");
  }
  if (paths.every((p) => !p) && labels.every((l) => !l)) return null;
  return { kind: "paths", paths, labels };
}

/** A compact "key: value" render of an input we have no bespoke line for. */
function compactInput(inp: Record<string, unknown>): string {
  return Object.entries(inp)
    .filter(
      ([k, v]) =>
        !isHiddenToolInputKey(k) && v !== undefined && v !== null && v !== "",
    )
    .slice(0, 4)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${truncate(String(s).replace(/\s+/g, " "), 48)}`;
    })
    .join("  ·  ");
}

/** A todowrite/update_plan input → its checklist counts and live step. */
function todoDetail(inp: Record<string, unknown>): ToolDetail | null {
  const items = parsePlanItems(inp);
  if (items.length === 0) return null;
  const current = currentPlanItem(items);
  return {
    kind: "todo",
    total: items.length,
    done: planDoneCount(items),
    ...(current ? { current } : {}),
  };
}

/** What this call is doing, as data. `{ kind: "none" }` when the input says
 *  nothing useful — the caller falls back to the entry's own text. */
export function toolDetail(toolName: string, input: unknown): ToolDetail {
  if (!input || typeof input !== "object") return { kind: "none" };
  const inp = input as Record<string, unknown>;

  switch (canonicalToolName(toolName)) {
    case "Read":
    case "Edit":
    case "Write": {
      const path = toolFilePath(inp);
      if (path) return { kind: "path", path };
      // codex's apply_patch names its files inside the patch body instead.
      const paths = patchFiles(inp);
      if (paths.length === 0) return { kind: "none" };
      return paths.length > 3
        ? { kind: "paths", paths: paths.slice(0, 3), more: paths.length - 3 }
        : { kind: "paths", paths };
    }
    case "FileChange":
      return fileChangeDetail(inp) ?? { kind: "none" };
    case "Bash": {
      const command = toolCommand(inp);
      if (!command) return { kind: "none" };
      return {
        kind: "command",
        command: truncate(command.replace(/\s*\n\s*/g, " ⏎ "), 160),
      };
    }
    case "Grep": {
      const pattern = typeof inp.pattern === "string" ? inp.pattern : "";
      const path = toolInputString(inp, "path");
      return { kind: "text", text: `/${pattern}/`, ...(path ? { path } : {}) };
    }
    case "Glob": {
      const pattern = typeof inp.pattern === "string" ? inp.pattern : "";
      const path = toolInputString(inp, "path");
      if (!pattern && !path) return { kind: "none" };
      return { kind: "text", text: pattern, ...(path ? { path } : {}) };
    }
    case "Task":
    case "Agent": {
      const text = [inp.subagent_type, inp.description]
        .filter((v): v is string => typeof v === "string" && v !== "")
        .join(": ");
      return text ? { kind: "text", text } : { kind: "none" };
    }
    case "Workflow":
      return {
        kind: "text",
        text:
          toolInputString(inp, "name", "description") || "orchestration script",
      };
    case "Skill": {
      const text = toolInputString(inp, "skill", "name");
      return text ? { kind: "text", text } : { kind: "none" };
    }
    case "TodoWrite":
      return todoDetail(inp) ?? { kind: "none" };
    case "WebFetch":
    case "WebSearch": {
      const text = toolInputString(inp, "url", "query");
      return text ? { kind: "text", text } : { kind: "none" };
    }
    case "TaskCreate": {
      const text = toolInputString(inp, "subject", "title");
      return text ? { kind: "text", text } : { kind: "none" };
    }
    default: {
      // An assets write carries the whole artifact in `content`, so the
      // generic render below spends the row on a truncated file body. The
      // path is the part worth reading, and the part a client can open.
      const asset = assetToolPath(toolName, inp);
      if (asset) return { kind: "text", text: asset };
      // MCP and other tools: a compact "key: value" render of the input reads
      // better than the generic "Using <tool>" content fallback.
      const text = compactInput(inp);
      return text ? { kind: "text", text } : { kind: "none" };
    }
  }
}

/**
 * The default string form of a detail. `tidy` shortens a path the way the
 * client wants (repo-relative, `~` for $HOME); omit it to keep paths raw.
 */
export function formatToolDetail(
  detail: ToolDetail,
  tidy: (path: string) => string = (p) => p,
): string {
  switch (detail.kind) {
    case "path":
      return tidy(detail.path);
    case "paths": {
      const shown = detail.paths
        .map((p, i) =>
          [detail.labels?.[i], p ? tidy(p) : ""].filter(Boolean).join(" "),
        )
        .filter(Boolean)
        .join("  ·  ");
      return detail.more ? `${shown}  ·  +${detail.more}` : shown;
    }
    case "command":
      return detail.command;
    case "text":
      return [detail.text, detail.path ? tidy(detail.path) : ""]
        .filter(Boolean)
        .join(" ");
    case "todo":
      return [detail.current, `${detail.done}/${detail.total} done`]
        .filter(Boolean)
        .join("  ·  ");
    case "none":
      return "";
  }
}

export function toolLineStats(
  toolName: string,
  input: unknown,
): ToolLineStats | null {
  if (!input || typeof input !== "object") return null;
  const canonical = canonicalToolName(toolName);
  if (canonical !== "Edit" && canonical !== "Write") return null;
  const inp = input as Record<string, unknown>;
  const patch = toolInputString(inp, "patchText", "patch");
  if (patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return additions || deletions ? { additions, deletions } : null;
  }

  const edits = Array.isArray(inp.edits) ? inp.edits : [inp];
  let additions = 0;
  let deletions = 0;
  for (const value of edits) {
    if (!value || typeof value !== "object") continue;
    const edit = value as Record<string, unknown>;
    additions += lineCount(toolInputString(edit, "new_string", "newString", "content"));
    deletions += lineCount(toolInputString(edit, "old_string", "oldString"));
  }
  return additions || deletions ? { additions, deletions } : null;
}

/** Everything a client needs to draw a tool row, from the call alone. */
export function toolPresentation(entry: TranscriptEntry): ToolPresentation {
  const raw = entry.toolName || "";
  const mcp = raw ? parseMcpTool(raw) : null;
  const canonical = canonicalToolName(raw);
  const stats = toolLineStats(raw, entry.toolInput);
  return {
    canonical,
    ...(mcp ? { mcpServer: mcp.server } : {}),
    name: mcp ? mcp.tool : canonical,
    family: toolFamily(raw),
    detail: toolDetail(raw, entry.toolInput),
    ...(stats ? { lineStats: stats } : {}),
  };
}

/**
 * Tag every tool call in a batch with its presentation, on the way to a
 * client. Same contract as the notice classifier: idempotent, and the same
 * array back when there was nothing to tag.
 */
export function withToolPresentations(
  entries: TranscriptEntry[],
): TranscriptEntry[] {
  let changed = false;
  const out = entries.map((e) => {
    if (e.type !== "tool_use" || e.presentation) return e;
    changed = true;
    return { ...e, presentation: toolPresentation(e) };
  });
  return changed ? out : entries;
}
