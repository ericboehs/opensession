import React, { useState, useEffect, useMemo, useRef } from "react";
import type { TranscriptEntry } from "../lib/types";
import {
  assetToolPath,
  canonicalToolName,
  ToolCallBlock,
  toolDisplayName,
  toolFamily,
  toolLineStats,
  toolSummary,
  useToolPathRoots,
} from "./ToolCallBlock";
import { ClampedBody, EntryImages, EntryVideos } from "./MessageBubble";
import { IconChevronDown, IconStack } from "./icons";
import { cn } from "../ui/cn";
import { msgBody } from "../lib/msg-classes";
import { formatDuration } from "../lib/time";
import {
  getTurnActivityPrefs,
  onTurnActivityChanged,
} from "../lib/turn-activity";
import {
  collectTouchedFiles,
  LineStats,
  TurnLineStatsCard,
} from "./TurnFooter";
import { transcriptDisclosureLedger } from "../lib/transcript-disclosures";
import { turnScrollAnchor } from "../lib/transcript-block-identity";

interface Props {
  /** The folded part of one assistant turn: tool_use + intermediate assistant
   * text entries, in order (the turn's final answer renders outside, as a
   * normal bubble). */
  items: TranscriptEntry[];
  toolResults: Map<string, TranscriptEntry>;
  live: boolean; // this is the active block of a running stream
  onOpenSubagent?: (agentId: string, label: string) => void;
  /** Lets wire-clamped intermediate notes fetch their full content. */
  sessionId?: string;
}

/**
 * One assistant turn's work, folded into a single calm line — "Worked · 12m 4s
 * · 51 steps" — closed by default so the session reads as question → answer.
 * Expanding shows the full flat run: intermediate assistant notes interleaved
 * with the tool calls and a compact change summary.
 *
 * The collapsed line carries what a folded turn can't otherwise say: duration,
 * step count, and the ±lines it moved when the turn wrote files. Line changes
 * keep the diff surfaces' colors, while routine failures stay quiet and one
 * click away. The counts sit after the meta run and never shrink; the
 * duration/steps run truncates first, so a phone drops characters off the
 * middle instead of the numbers.
 *
 * Below the line sits the one thing the fold does not hide: media the turn
 * explicitly surfaced. See featuredTurnMedia for why a marked screenshot is
 * not treated as work.
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
  sessionId,
}: Props) {
  const pathRoots = useToolPathRoots();
  const tools = items.filter((it) => it.type === "tool_use");
  const messages = items.filter((it) => it.type === "assistant");
  const hasNarration = messages.length > 0;

  // Default fold state follows the two preferences (Settings → Preferences),
  // except that routine tool-only work stays one calm summary row. Opening a
  // tool-only turn by default produced the same count twice: "Working 57
  // steps" followed by "57 steps". Once the agent writes a real update there
  // are distinct rows worth showing, so "Expand while running" opens them as
  // before. "Always open" and a person's manual choice still win in either
  // state. Failures stay one click away, and explicitly surfaced media
  // outlives the fold on its own (featuredTurnMedia).
  const [pref, setPref] = useState(getTurnActivityPrefs);
  useEffect(
    () => onTurnActivityChanged(() => setPref(getTurnActivityPrefs())),
    []
  );
  const defaultExpanded =
    pref.work === "open" || (pref.work === "running" && live && hasNarration);
  const [rememberedExpanded] = useState(() =>
    transcriptDisclosureLedger.read(
      "turn",
      sessionId,
      items.map((item) => item.id)
    )
  );
  const [expanded, setExpanded] = useState(
    rememberedExpanded ?? defaultExpanded
  );
  // `tools` owns the nested grouped-call disclosures. Open renders each call
  // in place; folded keeps routine runs behind their compact step rows.
  // ToolCallBlock owns its own detail disclosure either way, so this never
  // expands a Bash input (including generated comment metadata).

  // Once the user has toggled the fold by hand, their choice wins — the
  // auto-sync below must not reopen/collapse it on a later default change
  // (the turn settling, or the preference itself changing).
  const userToggledRef = useRef(rememberedExpanded !== undefined);
  useEffect(() => {
    if (userToggledRef.current) return;
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);
  function rememberExpansion(next: boolean) {
    userToggledRef.current = true;
    transcriptDisclosureLedger.write(
      "turn",
      sessionId,
      items.map((item) => item.id),
      next
    );
    setExpanded(next);
  }

  const duration = blockDuration(items, toolResults);
  const lastTool = tools[tools.length - 1];

  // Memoized against the house rule: a live turn re-renders on every stream
  // event, and this walks every step it has taken so far (collectTouchedFiles
  // skips non-tool entries itself, so `items` and `tools` give the same set).
  const editedFiles = useMemo(() => collectTouchedFiles(items), [items]);
  // Presentation stats cover code-writing tools that do not expose their input
  // as a plain Edit or Write call. Keep the parsed files for the hover card,
  // but let the server-derived aggregate own the summary's total.
  const toolAggregate =
    tools.length > 0 ? toolRunAggregate(tools, toolResults, live) : null;
  const additions = toolAggregate?.additions ?? 0;
  const deletions = toolAggregate?.deletions ?? 0;
  // A tool-only turn has no inner summary row anymore, so keep the small bits
  // of aggregate status that do add information on the one remaining row.
  const toolOnlyAggregate = !hasNarration ? toolAggregate : null;

  const countsLabel =
    tools.length > 0
      ? `${tools.length} step${tools.length === 1 ? "" : "s"}`
      : messages.length > 0
        ? `${messages.length} message${messages.length === 1 ? "" : "s"}`
        : "";
  // One run of faint meta rather than three separately-shrinking ones, so the
  // line collapses by dropping characters off its tail instead of overflowing.
  const metaLabel = [!live && duration, countsLabel].filter(Boolean).join(" · ");

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
  // Survives the fold: a marked screenshot is the answer to "show me", so
  // closing the turn takes the steps and leaves the picture. Only while the
  // steps are hidden — expanded, the media renders in the row that produced
  // it, and a strip as well would show it twice.
  const featured = expanded
    ? { images: [], videos: [] }
    : featuredTurnMedia(items, toolResults);

  return (
    <div
      className="mx-auto mb-3 w-full max-w-[var(--session-col)]"
      // Anchor identity for the history scroll hold: the LAST item survives a
      // history page merging older items into this turn (the first doesn't).
      data-eid={turnScrollAnchor(items)}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          toolOnlyAggregate?.statusLabel
            ? `${live ? "Working" : "Worked"}. ${countsLabel}. ${toolOnlyAggregate.statusLabel}`
            : undefined
        }
        onClick={() => rememberExpansion(!expanded)}
        // Baseline, not centre: this row mixes its 14px title with 13px meta
        // runs, and centring aligns boxes rather than text. The chevron carries
        // no baseline of its own, so it keeps centring individually.
        // The 8px overhang gives the icon-aligned chevron breathing room. Its
        // asymmetric padding moves the disclosure line into that overhang so
        // the open rail sits near the transcript edge instead of floating
        // inside the work column.
        className="-mx-2 flex w-[calc(100%+16px)] min-w-0 cursor-pointer items-baseline gap-2 rounded-control border-0 bg-transparent py-1 pl-1 pr-3 text-left font-sans text-item-title leading-5 text-dim transition-colors hover:bg-hover/40 hover:text-fg"
      >
        <span
          className={cn(
            "grid size-5 flex-shrink-0 self-center place-items-center leading-none text-faint transition-transform duration-150",
            !expanded && "-rotate-90"
          )}
        >
          <IconChevronDown size={20} className="block" />
        </span>
        <span className="flex-shrink-0 font-medium">
          {live ? "Working" : "Worked"}
        </span>
        {metaLabel && (
          <span className="min-w-0 truncate text-label leading-4 text-faint">
            {metaLabel}
          </span>
        )}
        {/* Hovering the counts opens what they count: the lines this turn
            wrote, per file, without unfolding it. */}
        {additions + deletions > 0 && (
          <TurnLineStatsCard
            files={editedFiles}
            additions={additions}
            deletions={deletions}
          />
        )}
        {toolOnlyAggregate?.mediaLabel && (
          <span className="flex-shrink-0 text-meta text-faint">
            {toolOnlyAggregate.mediaLabel}
          </span>
        )}
        {live && !expanded && hasNarration && lastTool && (
          <span className="min-w-0 truncate text-label leading-4 text-faint">
            {toolDisplayName(lastTool.toolName)}:{" "}
            {toolSummary(
              lastTool.toolName || "Tool",
              lastTool.toolInput,
              lastTool.content,
              pathRoots
            )}
          </span>
        )}
      </button>

      {expanded && (
        <div
          className={cn(
            "mt-0.5",
            // Open, the work wears a rail: a hairline dropping from the
            // chevron, with every row nudged in under the header's own text.
            // The turn's final answer sits back at the column edge with no
            // rail beside it, so where the work ends and the answer begins
            // stays legible however long the fold runs (a divider only marks
            // the seam; the rail says "still inside the work" from any
            // scroll position). The 5px puts the hairline under the chevron's
            // center after the disclosure line's 8px left shift.
            "relative mb-2 ml-[5px] border-l border-line pl-2.5"
          )}
        >
          <button
            type="button"
            aria-label={`Collapse ${live ? "Working" : "Worked"}`}
            onClick={() => rememberExpansion(false)}
            className="absolute inset-y-0 -left-2 w-4 cursor-pointer border-0 bg-transparent p-0 after:absolute after:inset-y-0 after:left-1/2 after:border-l after:border-transparent after:transition-colors hover:after:border-line-strong focus-visible:after:border-line-strong"
          />
          {sections.map((sec) =>
            sec.kind === "msg" ? (
              <TurnMessage
                key={sec.entry.id}
                entry={sec.entry}
                sessionId={sessionId}
              />
            ) : (
              // Tool icons align with the fold chevron on desktop. Phones use
              // the 1px optical correction for the icon's inset glyph.
              <div
                key={sec.items[0].id}
                className="-ml-px desktop:ml-0"
                data-eid={`${sec.items[sec.items.length - 1].id}#sec`}
              >
                {/* The outer Working row is already the tool-only run's
                    summary. If someone opens it, reveal the calls directly
                    instead of inserting a second, identical disclosure. */}
                <ToolSection
                  items={sec.items}
                  toolResults={toolResults}
                  live={live}
                  expandAll={!hasNarration || pref.tools === "open"}
                  sessionId={sessionId}
                  onOpenSubagent={onOpenSubagent}
                />
              </div>
            )
          )}
        </div>
      )}

      {/* Aligned with the fold's own rows (see TurnMessage on the 7px). */}
      {(featured.images.length > 0 || featured.videos.length > 0) && (
        <div className="pl-[7px] pr-1">
          <EntryImages images={featured.images} sessionId={sessionId} />
          <EntryVideos videos={featured.videos} />
        </div>
      )}
    </div>
  );
}, turnBlockPropsEqual);

const COMPACT_TOOL_FAMILIES = new Set([
  "run",
  "file",
  "find",
  "web",
  // Loading a skill or updating a plan is routine setup inside the same run.
  // Keeping either direct splits the surrounding work without adding an action.
  "skill",
  "checklist",
  // MCP calls are routine work too. Keeping them direct split otherwise
  // uninterrupted runs into a noisy sequence of verbose call rows.
  "mcp",
  // Edits fold with everything else: four passes over a file are as mechanical
  // as the Bash calls around them, and splitting a run at each one left the
  // turn as a ladder of alternating rows. What an edit adds to the folded row
  // is its ±lines, which the count carries for the whole run.
  "edit",
]);

export interface ToolSectionProps {
  items: TranscriptEntry[];
  toolResults: Map<string, TranscriptEntry>;
  live: boolean;
  /** Work always open with its tool calls open: every call renders in place,
   *  with no grouped row to open and no indent under one. */
  expandAll: boolean;
  onOpenSubagent?: (agentId: string, label: string) => void;
  sessionId?: string;
}

/**
 * Routine tool calls are evidence of the work, not the conversation itself.
 * Keep uninterrupted runs to one line, while calls with their own important
 * affordance (a worker, an asset, or explicitly featured media) stay direct.
 */
export function ToolSection(props: ToolSectionProps) {
  const runs: Array<{ compact: boolean; items: TranscriptEntry[] }> = [];
  for (const entry of props.items) {
    const result = entry.toolUseId
      ? props.toolResults.get(entry.toolUseId)
      : undefined;
    const compact = isCompactTool(entry, result);
    const last = runs[runs.length - 1];
    if (last?.compact && compact) last.items.push(entry);
    else runs.push({ compact, items: [entry] });
  }

  return runs.map((run) =>
    // Two reasons a run stays flat. With the work and its tool calls both
    // always open there is nothing to disclose, so a header and its indent
    // would only wrap rows already on screen. And a run of one has nothing
    // to fold: "1 step" hides
    // a single call behind a click and says less than the call's own row does.
    run.compact && run.items.length > 1 && !props.expandAll ? (
      <ToolRunBlock key={run.items[0].id} {...props} items={run.items} />
    ) : (
      <React.Fragment key={run.items[0].id}>
        {run.items.map((entry) => (
          <ToolCallBlock
            key={entry.id}
            entry={entry}
            sessionId={props.sessionId}
            result={
              entry.toolUseId
                ? props.toolResults.get(entry.toolUseId)
                : undefined
            }
            pending={
              props.live &&
              !!entry.toolUseId &&
              !props.toolResults.has(entry.toolUseId)
            }
            onOpenSubagent={props.onOpenSubagent}
          />
        ))}
      </React.Fragment>
    )
  );
}

function ToolRunBlock({
  items,
  toolResults,
  live,
  onOpenSubagent,
  sessionId,
}: ToolSectionProps) {
  // Start closed unless this overlapping set of steps was toggled before. A
  // live run grows one entry at a time, and its parent can be replaced as that
  // happens, so component-local state alone loses the person's choice.
  const [expanded, setExpanded] = useState(
    () =>
      transcriptDisclosureLedger.read(
        "tool-run",
        sessionId,
        items.map((item) => item.id)
      ) ?? false
  );
  function rememberExpansion(next: boolean) {
    transcriptDisclosureLedger.write(
      "tool-run",
      sessionId,
      items.map((item) => item.id),
      next
    );
    setExpanded(next);
  }

  const {
    label,
    pending,
    additions,
    deletions,
    statusLabel,
    mediaLabel,
  } = toolRunAggregate(items, toolResults, live);

  return (
    <div data-tool-run="true" data-eid={`${items[items.length - 1].id}#run`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${items.length} grouped steps: ${label}${statusLabel ? `. ${statusLabel}` : ""}`}
        title={`${items.length} grouped steps`}
        onClick={() => rememberExpansion(!expanded)}
        className="group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border-0 bg-transparent px-1 py-[3px] text-left font-sans transition-colors hover:bg-hover/40 phone:min-h-10"
      >
        {/* Open, the row is a heading for the steps under it, so it keeps the
            chevron rather than a stack of what is already on screen. Closed,
            the stack stands in until a hover offers the chevron. */}
        <span className="relative grid size-[22px] flex-shrink-0 place-items-center text-faint">
          <span
            className={cn(
              "absolute inset-0 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0",
              expanded && "opacity-0"
            )}
          >
            <IconStack size={18} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
          </span>
          <IconChevronDown
            size={20}
            className={cn(
              "absolute block transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
              expanded ? "opacity-100" : "-rotate-90 opacity-0"
            )}
          />
        </span>
        {/* Just the count. Which tools ran is what the row is folding away,
            and one click puts every step back with its own glyph, so naming
            them here only asks to be read. The names stay in the aria-label,
            where the count alone would tell a screen reader nothing. */}
        <span className="flex-shrink-0 truncate text-item-title font-medium leading-5 text-dim transition-colors group-hover:text-fg">
          {items.length} step{items.length === 1 ? "" : "s"}
        </span>
        {/* What the count can't say: a run that edited files moved lines, in
            the same green/red the turn header and the diff surfaces use. */}
        {additions + deletions > 0 && (
          <LineStats additions={additions} deletions={deletions} />
        )}
        <span className="min-w-0 flex-1" />
        {mediaLabel && (
          <span className="flex-shrink-0 text-meta text-faint">{mediaLabel}</span>
        )}
        {pending > 0 && (
          <span className="size-[11px] flex-shrink-0 animate-spin rounded-full border border-b-line-strong border-l-line-strong border-r-line-strong border-t-dim" />
        )}
      </button>
      {expanded && (
        <div className="ml-3">
          {items.map((entry) => (
            <ToolCallBlock
              key={entry.id}
              entry={entry}
              sessionId={sessionId}
              result={
                entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined
              }
              pending={
                live &&
                !!entry.toolUseId &&
                !toolResults.has(entry.toolUseId)
              }
              onOpenSubagent={onOpenSubagent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function isCompactTool(
  entry: TranscriptEntry,
  result: TranscriptEntry | undefined
): boolean {
  const name = entry.toolName || "Tool";
  if (!COMPACT_TOOL_FAMILIES.has(toolFamily(name))) return false;
  if (assetToolPath(name, entry.toolInput)) return false;
  return !result?.featuredMedia?.length;
}

/** The run's tools in call order, each with how often it ran. */
function groupedTools(
  items: TranscriptEntry[]
): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of items) {
    const name = canonicalToolName(entry.toolName || "Tool");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

function groupedToolName(name: string, count: number): string {
  return count > 1 ? `${name} ×${count}` : name;
}

/** Same run, spelled out for a screen reader: the glyphs carry no text. */
function groupedToolLabel(items: TranscriptEntry[]): string {
  return groupedTools(items)
    .map(({ name, count }) => groupedToolName(name, count))
    .join(" · ");
}

/** Everything the folded run's row says, derived once per run. */
interface ToolRunAggregate {
  label: string;
  pending: number;
  additions: number;
  deletions: number;
  statusLabel: string;
  mediaLabel: string;
}

// Keyed on the run's LAST entry, the way turnTouchedFiles is, because the
// caller has no stable array to key on: ToolSection rebuilds its runs in its
// render body, so a useMemo inside the block could never hit. Entries are
// replaced rather than mutated when they change (mergeTranscriptEntries), so
// identity is a sound key. But a call earlier in the run can be replaced while
// the last one stands, and so can the RESULT a call is waiting on, which is
// what decides pending and the media counts. Both are compared on a hit, and
// `live` with them.
//
// Worth caching because the work is repeated rather than one-off: a live turn
// re-renders on every stream event and this walks every step it has taken so
// far, where toolLineStats splits a whole apply_patch body per edit call and
// groupedToolLabel builds a Map and two arrays.
const aggregateByRun = new WeakMap<
  TranscriptEntry,
  {
    items: TranscriptEntry[];
    results: Array<TranscriptEntry | undefined>;
    live: boolean;
    value: ToolRunAggregate;
  }
>();

function toolRunAggregate(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>,
  live: boolean
): ToolRunAggregate {
  const key = items[items.length - 1];
  const hit = key ? aggregateByRun.get(key) : undefined;
  if (hit && hit.live === live && sameRunInputs(hit, items, toolResults))
    return hit.value;

  const results = items.map((entry) =>
    entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined
  );
  let pending = 0;
  let images = 0;
  let videos = 0;
  let additions = 0;
  let deletions = 0;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    const result = results[i];
    if (live && entry.toolUseId && !result) pending++;
    images += result?.images?.length ?? 0;
    videos += result?.videos?.length ?? 0;
    // Summed from what the rows themselves show, so opening the fold adds up
    // to the number that was on it.
    const stats =
      entry.presentation?.lineStats ??
      toolLineStats(entry.toolName || "Tool", entry.toolInput);
    additions += stats?.additions ?? 0;
    deletions += stats?.deletions ?? 0;
  }
  const mediaCount = images + videos;
  const value: ToolRunAggregate = {
    label: groupedToolLabel(items),
    pending,
    additions,
    deletions,
    statusLabel: [
      mediaCount > 0 ? `${mediaCount} media` : "",
      pending > 0 ? "running" : "",
    ].filter(Boolean).join(", "),
    mediaLabel:
      mediaCount === 0
        ? ""
        : videos === 0
          ? `${images} image${images === 1 ? "" : "s"}`
          : images === 0
            ? `${videos} video${videos === 1 ? "" : "s"}`
            : `${mediaCount} media`,
  };
  if (key) aggregateByRun.set(key, { items: items.slice(), results, live, value });
  return value;
}

function sameRunInputs(
  cached: {
    items: TranscriptEntry[];
    results: Array<TranscriptEntry | undefined>;
  },
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>
): boolean {
  if (cached.items.length !== items.length) return false;
  for (let i = 0; i < items.length; i++) {
    const entry = items[i];
    if (cached.items[i] !== entry) return false;
    const id = entry.toolUseId;
    if (cached.results[i] !== (id ? toolResults.get(id) : undefined))
      return false;
  }
  return true;
}

/** Intermediate reasoning stays readable while the turn itself provides the fold. */
function TurnMessage({
  entry,
  sessionId,
}: {
  entry: TranscriptEntry;
  sessionId?: string;
}) {
  return (
    <div
      // 7px, not the row's 4px: the fold header and the tool rows both pad by
      // 4 and then draw a glyph inset ~5px into its own box, so text padded to
      // 4 starts left of every other line in the turn. 7 sits just inside the
      // chevron's ink — the glyph's own side bearing makes a true 9 read as an
      // indent rather than an alignment.
      className="mx-auto my-2 w-full max-w-[var(--session-col)] pr-1 pl-[7px]"
      data-eid={entry.id}
    >
      <ClampedBody
        className={cn(msgBody, "markdown text-fg")}
        content={entry.content}
        entry={entry}
        sessionId={sessionId}
      />
      <EntryImages images={entry.images} sessionId={sessionId} />
    </div>
  );
}

/**
 * The media a turn's steps explicitly SURFACED, deduped and in call order.
 *
 * An OPENSESSION_IMAGE/_VIDEO marker is the agent saying "look at this", which
 * makes the picture an artifact addressed to the reader rather than part of
 * the work — so the fold hides the steps and keeps it (see the strip under the
 * fold header). Media a step merely touched, a Read of a PNG or a path that
 * turned up in output, is not featured and stays inside the fold: a
 * forty-screenshot verification loop must not put forty images on the page.
 *
 * A loop that captures to one path over and over features the same src each
 * time, so dedupe by src: the strip is what the turn produced, not how many
 * times it wrote the file.
 */
function featuredTurnMedia(
  items: TranscriptEntry[],
  toolResults: Map<string, TranscriptEntry>
): { images: string[]; videos: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  const seen = new Set<string>();
  for (const entry of items) {
    const result = entry.toolUseId ? toolResults.get(entry.toolUseId) : undefined;
    if (!result?.featuredMedia?.length) continue;
    // Take the srcs off images[]/videos[] rather than off featuredMedia, so
    // what renders is always something the entry can resolve — bounded entries
    // rewrite images[] to os-blob: markers and leave featuredMedia at the
    // original path.
    const featured = new Set(result.featuredMedia);
    for (const src of result.images || []) {
      if (!featured.has(src) || seen.has(src)) continue;
      seen.add(src);
      images.push(src);
    }
    for (const src of result.videos || []) {
      if (!featured.has(src) || seen.has(src)) continue;
      seen.add(src);
      videos.push(src);
    }
  }
  return { images, videos };
}

function turnBlockPropsEqual(prev: Props, next: Props): boolean {
  if (prev.live !== next.live) return false;
  if (prev.onOpenSubagent !== next.onOpenSubagent) return false;
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
  return formatDuration(last - first);
}
