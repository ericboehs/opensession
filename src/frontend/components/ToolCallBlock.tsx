import React, { Suspense, lazy, useEffect, useState } from "react";
import type { TranscriptEntry } from "../lib/types";
import { langForFile, langForGrep } from "../lib/lang";
import { cn } from "../ui/cn";
import { openGalleryFrom } from "./MediaLightbox";
import {
  IconTerminal,
  IconFile,
  IconPencil,
  IconSearch,
  IconGlobe,
  IconSparkle,
  IconPlug,
  IconBook,
  IconBranches,
  IconListChecks,
  IconWrench,
  IconCheck,
  IconX,
  IconExpand,
} from "./icons";

// Shiki (the syntax highlighter) is multi-MB; keep it out of the initial
// bundle and load it only when a tool call is actually expanded. Until the
// chunk arrives, the code shows as a plain pre.
const CodeHighlightLazy = lazy(() =>
  import("./CodeHighlight").then((m) => ({ default: m.CodeHighlight }))
);

function CodeHighlight(props: {
  code: string;
  lang: string;
  gutter?: boolean;
  requireGutter?: boolean;
}) {
  return (
    <Suspense fallback={<pre className="tool-pre">{props.code}</pre>}>
      <CodeHighlightLazy {...props} />
    </Suspense>
  );
}

interface Props {
  entry: TranscriptEntry;
  result?: TranscriptEntry;
  /** The run is live and this call hasn't returned yet — show a spinner. */
  pending?: boolean;
  /** For Task/Agent calls with a known sub-agent id: open its conversation. */
  onOpenSubagent?: (agentId: string, label: string) => void;
}

/** Split "mcp__linear__list_issues" into { server: "linear", tool: "list_issues" }. */
export function parseMcpTool(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts[0] !== "mcp" || parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

/** "mcp__linear__list_issues" → "linear · list_issues", else the tool name. */
export function toolDisplayName(name?: string): string {
  if (!name) return "Tool";
  const mcp = parseMcpTool(name);
  return mcp ? `${mcp.server} · ${mcp.tool}` : name;
}

/** One-line human summary of a tool call (also used for collapsed previews). */
export function toolSummary(toolName: string, input: unknown, fallback: string): string {
  if (!input || typeof input !== "object") return fallback;
  const inp = input as Record<string, unknown>;

  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      return tidyPath((inp.file_path as string) || fallback);
    case "Bash":
      return truncate(((inp.command as string) || fallback).replace(/\s*\n\s*/g, " ⏎ "), 160);
    case "Grep":
      return `/${inp.pattern || ""}/ ${tidyPath((inp.path as string) || "")}`;
    case "Glob":
      return `${inp.pattern || ""} ${tidyPath((inp.path as string) || "")}`;
    case "Task":
    case "Agent":
      return [inp.subagent_type, inp.description].filter(Boolean).join(": ") || fallback;
    case "Workflow":
      return (inp.name as string) || (inp.description as string) || "orchestration script";
    case "Skill":
      return (inp.skill as string) || fallback;
    case "WebFetch":
    case "WebSearch":
      return (inp.url as string) || (inp.query as string) || fallback;
    case "TaskCreate":
      return (inp.subject as string) || (inp.title as string) || fallback;
    default:
      // MCP and other tools: a compact "key: value" render of the input reads
      // better than the generic "Using <tool>" content fallback.
      return compactInput(inp) || fallback;
  }
}

function compactInput(inp: Record<string, unknown>): string {
  const parts = Object.entries(inp)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 4)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}: ${truncate(String(s).replace(/\s+/g, " "), 48)}`;
    });
  return parts.join("  ·  ");
}

/**
 * Tool families: each gets an icon and an accent hue (via the --tool-* palette
 * vars, theme-aware). Class strings are literal so the Tailwind scanner sees
 * them. `chip` styles the timeline icon; `edge` tints the expanded detail's
 * left border to visually tie it back to the row.
 */
type FamilyKey =
  | "run" | "file" | "edit" | "find" | "web" | "agent" | "mcp" | "skill" | "plain";

const FAMILY_STYLES: Record<FamilyKey, { chip: string; edge: string }> = {
  run: { chip: "text-tool-run", edge: "border-l-tool-run/45" },
  file: { chip: "text-tool-file", edge: "border-l-tool-file/45" },
  edit: { chip: "text-tool-edit", edge: "border-l-tool-edit/45" },
  find: { chip: "text-tool-find", edge: "border-l-tool-find/45" },
  web: { chip: "text-tool-web", edge: "border-l-tool-web/45" },
  agent: { chip: "text-tool-agent", edge: "border-l-tool-agent/45" },
  mcp: { chip: "text-tool-mcp", edge: "border-l-tool-mcp/45" },
  skill: { chip: "text-tool-skill", edge: "border-l-tool-skill/45" },
  plain: { chip: "text-dim", edge: "border-l-line-strong" },
};

export function toolFamily(toolName: string): FamilyKey {
  if (parseMcpTool(toolName)) return "mcp";
  switch (toolName) {
    case "Bash":
    case "BashOutput":
      return "run";
    case "Read":
    case "NotebookEdit":
      return "file";
    case "Edit":
    case "Write":
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
    default:
      return "plain";
  }
}

export function ToolGlyph({ toolName, size = 20 }: { toolName: string; size?: number }) {
  switch (toolFamily(toolName)) {
    case "run":
      return <IconTerminal size={size} />;
    case "file":
      return <IconFile size={size} />;
    case "edit":
      return <IconPencil size={size} />;
    case "find":
      return <IconSearch size={size} />;
    case "web":
      return <IconGlobe size={size} />;
    case "agent":
      return <IconSparkle size={size} />;
    case "mcp":
      return <IconPlug size={size} />;
    case "skill":
      return <IconBook size={size} />;
    default:
      switch (toolName) {
        case "EnterWorktree":
        case "ExitWorktree":
          return <IconBranches size={size} />;
        case "TaskCreate":
        case "TaskUpdate":
        case "TaskList":
        case "TaskGet":
        case "TodoWrite":
          return <IconListChecks size={size} />;
        default:
          return <IconWrench size={size} />;
      }
  }
}

/** Shorten absolute paths for display: $HOME prefix → "~". */
function tidyPath(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/");
}

/** Path summary with the directory dimmed and the basename readable. */
function PathSummary({ path }: { path: string }) {
  const idx = path.lastIndexOf("/");
  if (idx < 0) return <>{path}</>;
  return (
    <>
      <span className="opacity-55">{path.slice(0, idx + 1)}</span>
      {path.slice(idx + 1)}
    </>
  );
}

function stepDuration(entry: TranscriptEntry, result?: TranscriptEntry): string | null {
  if (!result) return null;
  const secs = Math.round(
    (new Date(result.timestamp).getTime() - new Date(entry.timestamp).getTime()) / 1000
  );
  if (!isFinite(secs) || secs < 2) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function ToolCallBlock({ entry, result, pending, onOpenSubagent }: Props) {
  const hasMedia = Boolean(result?.images?.length || result?.videos?.length);
  // Default closed for text-only output, but auto-open when media arrives
  // (covers both initial render and the live tool_result streaming in later).
  const [expanded, setExpanded] = useState(hasMedia);
  useEffect(() => {
    if (hasMedia) setExpanded(true);
  }, [hasMedia]);
  const toolName = entry.toolName || "Tool";
  const mcp = parseMcpTool(toolName);
  const summary = toolSummary(toolName, entry.toolInput, entry.content);
  const isFileTool = toolName === "Read" || toolName === "Edit" || toolName === "Write";
  const duration = stepDuration(entry, result);
  const failed = Boolean(result?.isError);
  const family = FAMILY_STYLES[toolFamily(toolName)];
  const inputNode = expanded ? toolInputNode(toolName, entry.toolInput) : null;

  // A Task/Agent call whose sub-agent transcript we can open in the sidebar.
  const isAgent = toolName === "Task" || toolName === "Agent";
  const agentId = result?.agentId;
  const canOpenSubagent = isAgent && agentId && onOpenSubagent;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-[3px] text-left font-sans",
          "hover:bg-hover"
        )}
      >
        <span
          className={cn(
            "tool-chip relative z-[1] flex size-[22px] flex-shrink-0 items-center justify-center rounded-md border border-current/25",
            failed ? "text-red" : family.chip
          )}
        >
          <ToolGlyph toolName={toolName} />
        </span>

        {mcp ? (
          <span className="flex min-w-0 flex-shrink-0 items-baseline gap-1.5 text-[12px]">
            <span className="rounded bg-purple/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.04em] text-purple">
              {mcp.server}
            </span>
            <span className="font-medium text-fg">{mcp.tool}</span>
          </span>
        ) : (
          <span className="flex-shrink-0 text-[12px] font-medium text-fg">{toolName}</span>
        )}

        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
            failed ? "text-red/80" : "text-dim"
          )}
        >
          {isFileTool ? <PathSummary path={summary} /> : summary}
        </span>

        {canOpenSubagent && (
          <span
            role="button"
            tabIndex={0}
            className="flex-shrink-0 rounded border border-line px-1.5 py-px text-[10.5px] text-dim opacity-0 transition-opacity hover:border-line-strong hover:text-fg focus:opacity-100 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onOpenSubagent!(agentId!, summary);
            }}
            title="Open this sub-agent's conversation"
          >
            Open ↗
          </span>
        )}

        {duration && (
          <span className="flex-shrink-0 text-[10.5px] tabular-nums text-faint">{duration}</span>
        )}

        {pending ? (
          <span className="size-[10px] flex-shrink-0 animate-spin rounded-full border-2 border-green-soft border-t-green" />
        ) : failed ? (
          <span className="flex-shrink-0 text-red">
            <IconX size={20} />
          </span>
        ) : result ? (
          <span className="flex-shrink-0 text-green opacity-70">
            <IconCheck size={20} />
          </span>
        ) : (
          <span className="flex-shrink-0 text-[10.5px] text-faint">—</span>
        )}
      </button>

      {expanded && (
        <div
          className={cn(
            "relative z-[1] mb-1.5 ml-[30px] mt-0.5 overflow-hidden rounded-lg border border-line border-l-2 bg-panel",
            failed ? "border-l-red/50" : family.edge
          )}
        >
          {inputNode && <div className="p-1.5">{inputNode}</div>}
          {result && (result.content || result.images?.length || result.videos?.length) && (
            <>
              <div
                className={cn(
                  "px-2.5 pb-1 pt-1.5 text-[10px] font-bold uppercase tracking-[0.05em]",
                  inputNode && "border-t border-line",
                  failed ? "text-red" : "text-faint"
                )}
              >
                {failed ? "Error" : "Output"}
              </div>
              <div className={cn("px-1.5 pb-1.5", failed && "[&_.tool-pre]:text-red/75")}>
                {result.content && (
                  <div className="tool-code-surface">
                    {renderResultContent(toolName, entry.toolInput, result.content)}
                  </div>
                )}
                {result.images && result.images.length > 0 && (
                  <div className="tool-result-images">
                    {result.images.map((src, i) => (
                      <a key={i} href={src} target="_blank" rel="noopener noreferrer" className="md-image-link">
                        <img className="md-image" src={src} alt="" loading="lazy" />
                      </a>
                    ))}
                  </div>
                )}
                {result.videos && result.videos.length > 0 && (
                  <div className="tool-result-videos">
                    {result.videos.map((src, i) => (
                      <div key={i} className="md-video-wrap">
                        <video className="md-video" src={src} controls playsInline preload="metadata" />
                        <button
                          type="button"
                          className="md-video-expand"
                          aria-label="Expand"
                          title="Expand"
                          onClick={(e) => {
                            const vid = e.currentTarget.parentElement?.querySelector("video");
                            if (vid) openGalleryFrom(vid);
                          }}
                        >
                          <IconExpand size={20} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The call's input, rendered by what it is rather than as raw JSON where we
 * can: Bash as a highlighted script, Edit as a unified diff, Write as the file
 * content in the file's language. Everything else falls back to pretty JSON.
 * All variants sit on a .tool-code-surface (dark in both themes).
 */
function toolInputNode(toolName: string, input: unknown): React.ReactNode | null {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

  if (toolName === "Bash" && bashCommand(input)) {
    return (
      <div className="tool-code-surface">
        <CodeHighlight code={bashCommand(input)!} lang="bash" />
      </div>
    );
  }

  if (toolName === "Edit" && typeof inp.old_string === "string" && typeof inp.new_string === "string") {
    const diff = [
      ...(inp.old_string as string).split("\n").map((l) => `-${l}`),
      ...(inp.new_string as string).split("\n").map((l) => `+${l}`),
    ].join("\n");
    return (
      <div className="tool-code-surface">
        <CodeHighlight code={truncate(diff, 4000)} lang="diff" />
      </div>
    );
  }

  if (toolName === "Write" && typeof inp.content === "string") {
    return (
      <div className="tool-code-surface">
        <CodeHighlight
          code={truncate(inp.content, 4000)}
          lang={langForFile(inp.file_path as string) || "markdown"}
        />
      </div>
    );
  }

  // Read's input is fully covered by the row summary (plus offset/limit when
  // present — only show those).
  if (toolName === "Read") {
    const extras = Object.entries(inp).filter(([k]) => k !== "file_path");
    if (extras.length === 0) return null;
    return (
      <pre className="tool-pre tool-code-surface">
        {extras.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}
      </pre>
    );
  }

  const text = formatInput(input);
  if (!text) return null;
  return <pre className="tool-pre tool-code-surface">{truncate(text, 4000)}</pre>;
}

/**
 * Tool outputs that carry code get syntax highlighting: Read (cat -n format,
 * lang from file_path) and Grep content output (rg -n format, lang inferred
 * from path/glob/type — only highlighted when the gutter format is detected,
 * so file-list output stays plain).
 */
function renderResultContent(toolName: string, input: unknown, content: string) {
  const text = truncate(content, 2000);
  const lang =
    toolName === "Read"
      ? langForFile((input as any)?.file_path)
      : toolName === "Grep"
        ? langForGrep(input)
        : null;
  if (lang) {
    return <CodeHighlight code={text} lang={lang} gutter requireGutter={toolName === "Grep"} />;
  }
  // Unified diffs (git diff/show in Bash output) highlight as diff
  if (toolName === "Bash" && (text.startsWith("diff --git") || /^@@ -\d/m.test(text))) {
    return <CodeHighlight code={text} lang="diff" />;
  }
  return <pre className="tool-pre">{text}</pre>;
}

/**
 * Bash input rendered as a script: description and flags become `#` comments
 * above the command, so the whole block highlights as bash without losing info.
 */
function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const inp = input as Record<string, unknown>;
  if (typeof inp.command !== "string") return null;

  const comments: string[] = [];
  if (typeof inp.description === "string" && inp.description) {
    comments.push(`# ${inp.description}`);
  }
  for (const [key, value] of Object.entries(inp)) {
    if (key === "command" || key === "description") continue;
    comments.push(`# ${key}: ${JSON.stringify(value)}`);
  }
  return [...comments, inp.command].join("\n");
}

function formatInput(input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}
