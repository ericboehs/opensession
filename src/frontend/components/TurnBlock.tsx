import React, { useState, useEffect } from "react";
import type { TranscriptEntry } from "../lib/types";
import {
  ToolCallBlock,
  ToolGlyph,
  toolFamily,
  toolDisplayName,
  toolSummary,
} from "./ToolCallBlock";
import { ClampedBody } from "./MessageBubble";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { IconChevronDown } from "./icons";
import { cn } from "../ui/cn";
import {
  getTurnActivityPref,
  onTurnActivityChanged,
} from "../lib/turn-activity";

interface Props {
  /** The folded part of one assistant turn: tool_use + intermediate assistant
   * text entries, in order (the turn's final answer renders outside, as a
   * normal bubble). */
  items: TranscriptEntry[];
  toolResults: Map<string, TranscriptEntry>;
  live: boolean; // this is the active block of a running stream
  onOpenSubagent?: (agentId: string, label: string) => void;
  onOpenEvidence?: (entry: TranscriptEntry, result?: TranscriptEntry) => void;
  /** Lets wire-clamped intermediate notes fetch their full content. */
  sessionId?: string;
}

/**
 * One assistant turn's work, folded into a single calm line — "12 tool calls,
 * 3 messages" with the distinct tool-family glyphs — closed by default so the
 * chat reads as question → answer. Expanding shows the full flat run:
 * intermediate assistant notes interleaved with the tool calls on the
 * timeline rail.
 */
// Memoized with a custom comparator: TranscriptBlocks rebuilds the `items`
// arrays and the `toolResults` Map on every render, so plain shallow-prop memo
// would never bail. The entries themselves keep stable references (mergeEntries
// reuses objects), so compare element-wise — and only the results this block's
// items actually read — letting untouched history blocks skip re-rendering on
// each stream event.
export const TurnBlock = React.memo(function TurnBlock({
  items,
  toolResults,
  live,
  onOpenSubagent,
  onOpenEvidence,
  sessionId,
}: Props) {
  const tools = items.filter((it) => it.type === "tool_use");
  const messages = items.filter((it) => it.type === "assistant");

  // If any tool in the block returned media (image or video), keep the block
  // open so the screenshot/recording stays visible after the run finishes.
  const hasMedia = tools.some((it) => {
    const r = it.toolUseId ? toolResults.get(it.toolUseId) : undefined;
    return (r?.images?.length ?? 0) > 0 || (r?.videos?.length ?? 0) > 0;
  });
  const hasFailure = tools.some((it) => {
    const result = it.toolUseId ? toolResults.get(it.toolUseId) : undefined;
    return Boolean(result?.isError);
  });
  // Default fold state follows the per-browser preference (Settings →
  // Appearance). "auto": open while the turn is still working (thinking /
  // tool steps in flight, no final answer yet) so you can watch it run, and
  // collapse the moment it settles and the end message appears — the chat
  // then reads question → answer. "expanded"/"collapsed" pin one state for
  // readers who always (or never) want the working visible. Media pins it
  // open regardless so a screenshot/recording stays visible.
  const [pref, setPref] = useState(getTurnActivityPref);
  useEffect(
    () => onTurnActivityChanged(() => setPref(getTurnActivityPref())),
    []
  );
  const defaultExpanded =
    hasMedia || hasFailure || (pref === "auto" ? live : pref === "expanded");
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const duration = blockDuration(items, toolResults);
  const failures = tools.filter(
    (it) => it.toolUseId && toolResults.get(it.toolUseId)?.isError
  ).length;
  const lastTool = tools[tools.length - 1];

  // One glyph per distinct tool family, in order of first use — a compact
  // fingerprint of what the run did (terminal, files, edits, …).
  const familyReps: TranscriptEntry[] = [];
  {
    const seen = new Set<string>();
    for (const it of tools) {
      const fam = toolFamily(it.toolName || "Tool");
      if (seen.has(fam)) continue;
      seen.add(fam);
      familyReps.push(it);
      if (familyReps.length >= 6) break;
    }
  }
  const touchedPaths = new Set<string>();
  for (const tool of tools) {
    if (!tool.toolInput || typeof tool.toolInput !== "object") continue;
    const input = tool.toolInput as Record<string, unknown>;
    const direct =
      typeof input.file_path === "string"
        ? input.file_path
        : typeof input.path === "string" &&
            ["Edit", "Write", "Read", "FileChange"].includes(tool.toolName || "")
          ? input.path
          : null;
    if (direct) touchedPaths.add(direct);
    if (Array.isArray(input.changes)) {
      for (const change of input.changes) {
        if (
          change &&
          typeof change === "object" &&
          typeof (change as { path?: unknown }).path === "string"
        ) {
          touchedPaths.add((change as { path: string }).path);
        }
      }
    }
  }

  const countsLabel = [
    tools.length > 0 &&
      `${tools.length} step${tools.length === 1 ? "" : "s"}`,
    touchedPaths.size > 0 &&
      `${touchedPaths.size} file${touchedPaths.size === 1 ? "" : "s"}`,
    tools.length === 0 &&
      messages.length > 0 &&
      `${messages.length} message${messages.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(", ");

  // Interleave: consecutive tool calls share one timeline rail; intermediate
  // assistant messages break the rail into segments.
  const sections: Array<
    | { kind: "tools"; items: TranscriptEntry[] }
    | { kind: "msg"; entry: TranscriptEntry }
  > = [];
  for (const it of items) {
    if (it.type === "tool_use") {
      const last = sections[sections.length - 1];
      if (last?.kind === "tools") last.items.push(it);
      else sections.push({ kind: "tools", items: [it] });
    } else {
      sections.push({ kind: "msg", entry: it });
    }
  }
  const lastItem = items[items.length - 1];

  return (
    <div
      className="mx-auto mb-3 w-full max-w-[var(--chat-col)]"
      // Anchor identity for the history scroll hold: the LAST item survives a
      // history page merging older items into this turn (the first doesn't).
      data-eid={lastItem ? `${lastItem.id}#turn` : undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mx-auto flex w-full max-w-[var(--chat-col)] min-w-0 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1 py-1 text-left font-sans text-[12.5px] text-dim hover:bg-hover"
      >
        <span
          className={cn(
            "flex-shrink-0 text-faint transition-transform duration-150",
            !expanded && "-rotate-90"
          )}
        >
          <IconChevronDown size={20} />
        </span>
        <span className={cn("flex-shrink-0 font-medium", live && "text-green")}>
          {live ? "Working" : "Worked"}
        </span>
        {familyReps.length > 0 && (
          <span className="flex flex-shrink-0 items-center gap-1.5 text-faint">
            {familyReps.map((it) => (
              <ToolGlyph key={it.id} toolName={it.toolName || "Tool"} size={15} />
            ))}
          </span>
        )}
        {duration && !live && (
          <span className="flex-shrink-0 text-faint">{duration}</span>
        )}
        {countsLabel && (
          <span className="flex-shrink-0 text-faint">· {countsLabel}</span>
        )}
        {failures > 0 && !live && (
          <span className="flex-shrink-0 text-[11.5px] text-red/80">
            · {failures} failed
          </span>
        )}
        {live && !expanded && lastTool && (
          <span className="min-w-0 truncate font-mono text-[11px] text-faint">
            {toolDisplayName(lastTool.toolName)}:{" "}
            {toolSummary(
              lastTool.toolName || "Tool",
              lastTool.toolInput,
              lastTool.content
            )}
          </span>
        )}
        {live && (
          <span className="ml-auto size-[10px] flex-shrink-0 animate-spin rounded-full border-2 border-green-soft border-t-green" />
        )}
      </button>

      {expanded && (
        <div className="mt-0.5">
          {sections.map((sec) =>
            sec.kind === "msg" ? (
              <TurnMessage
                key={sec.entry.id}
                entry={sec.entry}
                sessionId={sessionId}
              />
            ) : (
              <div
                key={sec.items[0].id}
                className="relative pl-1"
                data-eid={`${sec.items[sec.items.length - 1].id}#sec`}
              >
                {/* Timeline rail drawn behind the (opaque) tool icons */}
                {/* pl-1 (4px) + row px-1 (4px) + half the 22px icon = 19px to the icon centerline */}
                <span
                  aria-hidden
                  className="absolute bottom-2 left-[19px] top-2 w-px bg-line"
                />
                {sec.items.map((entry) => (
                  <ToolCallBlock
                    key={entry.id}
                    entry={entry}
                    sessionId={sessionId}
                    result={
                      entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined
                    }
                    pending={
                      live &&
                      entry === lastItem &&
                      !!entry.toolUseId &&
                      !toolResults.has(entry.toolUseId)
                    }
                    onOpenSubagent={onOpenSubagent}
                    onOpenEvidence={onOpenEvidence}
                  />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}, turnBlockPropsEqual);

/** An intermediate assistant note inside the fold — body only, no label. */
function TurnMessage({
  entry,
  sessionId,
}: {
  entry: TranscriptEntry;
  sessionId?: string;
}) {
  return (
    <div
      className="mx-auto my-2 w-full max-w-[var(--chat-col)] px-1"
      data-eid={entry.id}
    >
      <ClampedBody
        className="msg-body msg-body-assistant markdown"
        content={entry.content}
        entry={entry}
        sessionId={sessionId}
      />
      {entry.images && entry.images.length > 0 && (
        <div className="msg-images">
          {entry.images.map((raw, i) => {
            const src = resolveEntryImageSrc(raw, sessionId);
            return (
              <a
                key={i}
                href={src}
                target="_blank"
                rel="noopener noreferrer"
                className="md-image-link"
              >
                <img className="md-image" src={src} alt="" loading="lazy" />
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function turnBlockPropsEqual(prev: Props, next: Props): boolean {
  if (prev.live !== next.live) return false;
  if (prev.onOpenSubagent !== next.onOpenSubagent) return false;
  if (prev.onOpenEvidence !== next.onOpenEvidence) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.items.length !== next.items.length) return false;
  for (let i = 0; i < next.items.length; i++) {
    if (prev.items[i] !== next.items[i]) return false;
    const id = next.items[i].toolUseId;
    if (id && prev.toolResults.get(id) !== next.toolResults.get(id))
      return false;
  }
  return true;
}

function blockDuration(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>
): string | null {
  if (items.length === 0) return null;
  const first = new Date(items[0].timestamp).getTime();
  const lastItem = items[items.length - 1];
  const lastResult = lastItem.toolUseId
    ? toolResults.get(lastItem.toolUseId)
    : undefined;
  const last = new Date((lastResult || lastItem).timestamp).getTime();
  const secs = Math.round((last - first) / 1000);
  if (!isFinite(secs) || secs < 1) return null;
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}
