import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Workspace, UnifiedSession } from "../lib/types";
import { fetchHomeStats, fetchRecentPrs, type HomeStats, type RecentPr } from "../lib/api";
import { prStatusMark } from "../lib/pr-status";
import {
  buildWorktreeRows,
  compactAge,
  compactDiff,
  dateGroup,
  personLabel,
  type WorktreeRow,
} from "../lib/pr-rows";
import { Button } from "../ui/button";
import { useIsPhone } from "../hooks/useIsPhone";
import { ResponsiveDialog } from "../ui/sheet";
import { toast } from "../ui/toast";
import { PrQueuePreview } from "./PrQueuePreview";
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { RepoTile, repoLabel } from "./RepoTile";
import { usePeople } from "../lib/people";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { EmptyState } from "../ui/state";
import {
  PR_GROUP_LABEL,
  PR_LIST,
  PR_ROW,
  PR_SECTION_LABEL,
} from "../lib/pr-list-classes";
import {
  IconArchive,
  IconDotsHorizontal,
  IconFolder,
  IconGitMerge,
  IconPeople,
  IconPlus,
  IconPullRequest,
  IconRepo,
  IconSidebarLeft,
  IconX,
} from "./icons";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps , mergeStylexClassName} from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	textFaint: {
			color: "var(--text-faint)"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	Mx1: {
			marginInline: "-4px"
	},
	flex: {
			display: "flex"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	flexWrap: {
			flexWrap: "wrap"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gapX15: {
			columnGap: "6px"
	},
	gapY05: {
			rowGap: "2px"
	},
	roundedSm: {
			borderRadius: "calc(4px * var(--rf))"
	},
	px1: {
			paddingInline: "4px"
	},
	textLeft: {
			textAlign: "left"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	transitionColors: {
			transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to",
			transitionTimingFunction: "var(--tw-ease,var(--ease))",
			transitionDuration: "var(--tw-duration,var(--dur-micro))"
	},
	gap2: {
			gap: "8px"
	},
	h25: {
			height: "10px"
	},
	w40: {
			width: "160px"
	},
	shrink: {
			flexShrink: "1"
	},
	bgLine: {
			backgroundColor: "var(--border)"
	},
	w200px: {
			width: "200px"
	},
	minW90px: {
			minWidth: "90px"
	},
	shrink100: {
			flexShrink: "100"
	},
	minW0: {
			minWidth: "0"
	},
	maxW150px: {
			maxWidth: "150px"
	},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	minW200px: {
			minWidth: "200px"
	},
	maxW320px: {
			maxWidth: "320px"
	},
	size18px: {
			width: "18px",
			height: "18px"
	},
	shrink0: {
			flexShrink: "0"
	},
	flex1: {
			flex: "1"
	},
	minH0: {
			minHeight: "0"
	},
	wFull: {
			width: "100%"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	mxAuto: {
			marginInline: "auto"
	},
	maxW920px: {
			maxWidth: "920px"
	},
	px6: {
			paddingInline: "24px"
	},
	pb15: {
			paddingBottom: "60px"
	},
	pt7: {
			paddingTop: "28px"
	},
	mb18px: {
			marginBottom: "18px"
	},
	mb8: {
			marginBottom: "32px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	mb5: {
			marginBottom: "20px"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	leading13: {
			lineHeight: "1.3"
	},
	textFg: {
			color: "var(--text)"
	},
	justifySelfEnd: {
			justifySelf: "flex-end"
	},
	textGreen: {
			color: "var(--green)"
	},
	ml2: {
			marginLeft: "8px"
	},
	textRed: {
			color: "var(--red)"
	},
	minH13: {
			minHeight: "52px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	px3: {
			paddingInline: "12px"
	},
	fontNormal: {
			fontWeight: "var(--font-weight-normal)"
	},
	minH10: {
			minHeight: "40px"
	},
	size10: {
			width: "40px",
			height: "40px"
	},

	h15: {
		"height": "6px"
	},
	w15: {
		"width": "6px"
	},
	roundedFull: {
		"borderRadius": "3.40282e38px"
	},
	bgGreen: {
		"backgroundColor": "var(--green)"
	},
	motionSafeAnimatePulse: {
		"@media (prefers-reduced-motion: no-preference)": {
			"animation": "var(--animate-pulse)"
		}
	},

	tabularNums: {
		"--tw-numeric-spacing": "tabular-nums",
		"fontVariantNumeric": "var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)"
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
	max560pxPx4: {
		"@media not all and (min-width: 560px)": {
			"paddingInline": "16px"
		}
	},
	max560pxPb12: {
		"@media not all and (min-width: 560px)": {
			"paddingBottom": "48px"
		}
	},
	max560pxPt18px: {
		"@media not all and (min-width: 560px)": {
			"paddingTop": "18px"
		}
	},
	max560pxMb35: {
		"@media not all and (min-width: 560px)": {
			"marginBottom": "14px"
		}
	},
	phoneHidden: {
		"@media (max-width: 720px)": {
			"display": "none"
		}
	},
	phoneMinH14: {
		"@media (max-width: 720px)": {
			"minHeight": "56px"
		}
	},
	phoneMinH11: {
		"@media (max-width: 720px)": {
			"minHeight": "44px"
		}
	},
	phoneSize11: {
		"@media (max-width: 720px)": {
			"width": "44px",
			"height": "44px"
		}
	},
});

interface Props {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onShowArchived: () => void;
  onOpenAnalytics?: () => void;
  /** Create or adopt the PR's workspace without leaving the preview. */
  onAddToSidebar: (pr: PrPreviewTarget) => Promise<string>;
  /** Open a PR workspace after it is already represented in the sidebar. */
  onOpenWorkspace: (workspaceId: string, pr: PrPreviewTarget) => void;
  /** The pane's top bar, where this page's controls go. */
  topbarActionsEl?: HTMLElement | null;
}

type PrPreviewTarget = Pick<
  WorktreeRow,
  "repo" | "branch" | "title" | "number" | "workspaceId" | "state"
>;

const compactFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const fmtCompact = (n: number) => compactFmt.format(n);
const HOME_STATS_CACHE_KEY = "opensession.homeStats.v2";

function readCachedHomeStats(): HomeStats | null {
  try {
    const cached = JSON.parse(
      localStorage.getItem(HOME_STATS_CACHE_KEY) || "null",
    ) as Partial<HomeStats> | null;
    return cached?.today && cached.week && cached.completeWeek && cached.priorWeek
      ? (cached as HomeStats)
      : null;
  } catch {
    return null;
  }
}

function cacheHomeStats(stats: HomeStats): void {
  try {
    localStorage.setItem(HOME_STATS_CACHE_KEY, JSON.stringify(stats));
  } catch {
    // Stats still render when storage is unavailable.
  }
}

function fmtAgentTime(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)}h`;
}

function runningLabel(running: number): string {
  if (running === 0) return "No agents running";
  return running === 1 ? "1 agent running" : `${running} agents running`;
}

// Agent time over the last seven whole days against the seven before them. A
// percentage is the only shape a trend takes in one clause, and agent time is
// the field that answers "how much did we get through" without needing a
// second number beside it. Under 5% is noise at this scale, so it says so
// rather than reporting a 2% week as movement.
function weekTrend(stats: HomeStats | null): string | null {
  const now = stats?.completeWeek?.durationMs ?? 0;
  const before = stats?.priorWeek?.durationMs ?? 0;
  if (!now || !before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (Math.abs(pct) < 5) return "level with last week";
  return `${Math.abs(pct)}% ${pct > 0 ? "busier" : "quieter"} than last week`;
}

function Separator() {
  // A space of its own rather than a margin: the dot costs the line as little
  // as it can, and the clauses stay on one row a little longer for it.
  return (
    <span aria-hidden="true" {...stylex.props(sx.textFaint)}>
      {" ·"}
    </span>
  );
}

// The page is about its list, so the day rides under the title as one line
// instead of a slab of five figures with a second week-long tier under each.
// The three kept are the ones you act on: what is live now, and how much
// happened today. Turns, tokens, errors and the week are a click away in
// Analytics, which this line opens and the sidebar also lists.
//
// One figure per clause. Sessions and agent time used to share one, joined by
// a comma, which made the line read as a sentence with a list in the middle of
// it rather than as four numbers.
function OverviewLine({
  running,
  stats,
  onOpenAnalytics,
}: {
  running: number;
  stats: HomeStats | null;
  onOpenAnalytics?: () => void;
}) {
  const today = stats?.today;
  const trend = weekTrend(stats);
  return (
    <button
      type="button"
      onClick={onOpenAnalytics}
      title={
        today
          ? `Open Analytics · ${today.turns.toLocaleString()} turns and ${fmtCompact(today.outputTokens)} tokens out today${
              trend
                ? ` · ${fmtAgentTime(stats!.completeWeek.durationMs)} of agent time over the last 7 whole days against ${fmtAgentTime(stats!.priorWeek.durationMs)} the week before`
                : ""
            }`
          : "Analytics are loading"
      }
      aria-busy={!stats} {...mergeStylexProps("group", sx.tabularNums, sx.hoverTextFg, sx.focusRing, sx.Mx1, sx.flex, sx.maxWFull, sx.cursorPointer, sx.flexWrap, sx.itemsCenter, sx.gapX15, sx.gapY05, sx.roundedSm, sx.px1, sx.textLeft, sx.textDim, sx.transitionColors, typography.supporting)}
    >
      <span {...stylex.props(sx.flex, sx.itemsCenter, sx.gap2)}>
        <span
          aria-hidden="true"
          className={
            running > 0
              ? mergeStylexClassName("", sx.h15, sx.w15, sx.shrink0, sx.roundedFull, sx.bgGreen, sx.motionSafeAnimatePulse)
              : mergeStylexClassName("", sx.h15, sx.w15, sx.shrink0, sx.roundedFull, sx.bgLine)
          }
        />
        {runningLabel(running)}
        {/* Every separator trails the clause it follows, so a wrap leaves it at
            the end of the line it finished. Led, it would orphan a dot at the
            start of the next line, which reads as a bullet. */}
        {today ? <Separator /> : null}
      </span>
      {today ? (
        <>
          <span>
            {fmtCompact(today.sessions)} sessions today
            <Separator />
          </span>
          <span>
            {fmtAgentTime(today.durationMs)} of agent time
            {trend ? <Separator /> : null}
          </span>
        </>
      ) : null}
      {trend ? (
        <span {...mergeStylexProps("group-hover:text-dim", sx.textFaint, sx.transitionColors)}>
          {trend}
        </span>
      ) : null}
      {!stats && (
        <span {...mergeStylexProps("", sx.motionSafeAnimatePulse, sx.h25, sx.w40, sx.shrink, sx.roundedSm, sx.bgLine)} />
      )}
    </button>
  );
}

function StateIcon({ state }: { state: WorktreeRow["state"] }) {
  if (state === "MERGED") return <IconGitMerge size={20} />;
  if (state === "CLOSED") return <IconArchive size={20} />;
  return <IconPullRequest size={20} />;
}

export function Prs({
  sessions,
  workspaces,
  onSelect,
  onNewSession,
  onShowArchived,
  onOpenAnalytics,
  onAddToSidebar,
  onOpenWorkspace,
  topbarActionsEl,
}: Props) {
  const currentUser = useCurrentUser();
  const isPhone = useIsPhone();
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState("all");
  const [repo, setRepo] = useState("all");
  // Whose pull requests to show, and nothing more. This used to be the app's
  // person lens, so narrowing the list here also swapped the sidebar out from
  // under you. It is an ordinary filter now, alongside workspace and repo:
  // switching whose work the app is showing is the People page's job.
  const [person, setPerson] = useState("all");
  // Everyone, not only whoever the default request happened to return, because
  // picking someone fetches their pull requests below.
  const roster = usePeople();
  const people = [...roster].sort(
    (a, b) =>
      Number(b.name.toLowerCase() === currentUser.toLowerCase()) -
      Number(a.name.toLowerCase() === currentUser.toLowerCase()),
  );
  const [showArchived, setShowArchived] = useState(false);
  const [recentPrs, setRecentPrs] = useState<RecentPr[]>([]);
  const [personPrs, setPersonPrs] = useState<RecentPr[]>([]);
  const [stats, setStats] = useState<HomeStats | null>(readCachedHomeStats);
  const [preview, setPreview] = useState<PrPreviewTarget | null>(null);
  const [addingToSidebar, setAddingToSidebar] = useState(false);

  function openPreviewTarget(repo: string, branch: string) {
    setPreview({ repo, branch, title: repo, state: "OPEN", workspaceId: null });
  }

  async function addPreviewToSidebar() {
    if (!preview || addingToSidebar) return;
    const target = preview;
    setAddingToSidebar(true);
    await (async () => {
const workspaceId = await onAddToSidebar(target);
      setPreview((current) =>
        current?.repo === target.repo && current.branch === target.branch
          ? { ...current, workspaceId }
          : current,
      );
      toast("Added to sidebar");
})().catch(async () => {
toast("Couldn't add to sidebar");
}).finally(async () => {
setAddingToSidebar(false);
});
  }

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchHomeStats()
        .then((data) => {
          if (!active) return;
          setStats(data);
          cacheHomeStats(data);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const running = (sessions.filter((s) => s.isRunning && !s.archived).length);

  useEffect(() => {
    let active = true;
    fetchRecentPrs(undefined, showArchived ? {} : { limit: 500 })
      .then((prs) => active && setRecentPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showArchived]);

  useEffect(() => {
    if (person === "all") {
      setPersonPrs([]);
      return;
    }
    let active = true;
    fetchRecentPrs(person)
      .then((prs) => active && setPersonPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [person]);

  const allWorktrees = (() => {
    const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
    for (const pr of personPrs) prs.set(pr.url, pr);
    return buildWorktreeRows([...prs.values()], sessions);
  })();

  const worktrees = (() => {
    const needle = query.trim().toLowerCase();
    return allWorktrees
      .filter((row) => {
        if (!showArchived && row.archived) return false;
        if (workspaceId === "standalone" && row.workspaceId) return false;
        if (workspaceId !== "all" && workspaceId !== "standalone" && row.workspaceId !== workspaceId)
          return false;
        if (repo !== "all" && row.repo !== repo) return false;
        if (person !== "all" && row.person !== person) return false;
        if (!needle) return true;
        return [row.title, row.repo, row.branch, row.author, row.number ? `#${row.number}` : ""]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      });
  })();

  const sections = (() => {
    const definitions: Array<{ state: WorktreeRow["state"]; label: string }> = [
      { state: "OPEN", label: "Open" },
      { state: "MERGED", label: "Merged" },
      { state: "CLOSED", label: "Closed" },
    ];
    return definitions.flatMap((definition) => {
      const rows = worktrees.filter((row) => row.state === definition.state);
      if (!rows.length) return [];
      const groups = new Map<string, WorktreeRow[]>();
      for (const row of rows) {
        const label = dateGroup(row.updatedAt);
        groups.set(label, [...(groups.get(label) || []), row]);
      }
      return [{ ...definition, rows, groups: [...groups.entries()] }];
    });
  })();

  const workspaceOptions = (() => {
    const represented = new Set(sessions.filter((s) => s.prUrl || s.prs?.some((pr) => pr.url)).map((s) => s.workspaceId));
    return workspaces.filter((workspace) => represented.has(workspace.id));
  })();

  const repoOptions = ([...new Set(allWorktrees.map((row) => row.repo).filter(Boolean))].sort());

  // The page's controls, in the window's top bar rather than in a strip of
  // their own. That bar spans the pane and was empty until the heading below
  // scrolled under it, while this page spent three rows on chrome before its
  // first pull request. Search, the scopes and the one CTA go up there, and the
  // body keeps the title and the day's numbers.
  //
  // The three scopes stay three controls, side by side, rather than folding
  // into one Filters button: each says what it is set to without being opened,
  // which is the whole of what this row has to tell you at rest. They are ghost
  // buttons so the run of them reads as one group of words between the field
  // and the CTA, rather than as three more plates.
  //
  // Each names its value rather than a phrase about it ("All repos", not "In
  // all repos"): three of them and a field and a button share this row, and the
  // preposition is the first thing that does not fit. The glyph already says
  // which scope it is, and the label now matches the row it is set to in the
  // menu below.
  const actions = (
    <>
      {/* Everything else in this row is sized by its own label, so the field is
          what gives the bar back when the pane is narrow. It has to be weighted
          weighted to do it. Shrink is shared in proportion, so on equal terms
          every control gives up its share at once and a scope's label is the
          first thing an ellipsis takes: a label needs its exact width and loses
          a word to one spare pixel, while a field that is merely shorter costs
          nothing. The scopes are therefore given a shrink of almost zero, so
          the field surrenders everything it has before a label gives anything,
          and past the field's floor the labels do truncate, which is the honest
          end of a bar that has run out of room. */}
      <Input
        {...stylex.props(sx.w200px, sx.minW90px, sx.shrink100)}
        type="search"
        aria-label="Search pull requests"
        placeholder="Search pull requests…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        spellCheck={false}
      />

      {people.length > 0 && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button variant="ghost" {...stylex.props(sx.minW0)} icon={<IconPeople size={18} />} caret>
                <span {...stylex.props(sx.maxW150px, sx.truncate)}>
                  {person === "all" ? "Anyone" : personLabel(person)}
                </span>
              </Button>
            }
          />
          <Menu.Popup align="end" {...stylex.props(sx.minW200px, sx.maxW320px)}>
            <Menu.RadioGroup
              value={person}
              onValueChange={(value) => setPerson(String(value))}
            >
              <Menu.RadioItem value="all" closeOnClick>
                {/* Sized to the faces below so every label shares one edge. */}
                <span {...stylex.props(sx.size18px, sx.shrink0)} />
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>Anyone</span>
                <Menu.Check on={person === "all"} />
              </Menu.RadioItem>
              {people.map((who) => {
                const key = who.name.toLowerCase();
                return (
                  <Menu.RadioItem key={key} value={key} closeOnClick>
                    <UserAvatar name={who.name} size={18} />
                    <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>
                      {key === currentUser.toLowerCase()
                        ? `${who.fullName} (you)`
                        : who.fullName}
                    </span>
                    <Menu.Check on={person === key} />
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Root>
      )}

      <Menu.Root>
        <Menu.Trigger
          render={
            <Button variant="ghost" {...stylex.props(sx.minW0)} icon={<IconFolder size={18} />} caret>
              <span {...stylex.props(sx.maxW150px, sx.truncate)}>
                {workspaceId === "all"
                  ? "All workspaces"
                  : workspaceId === "standalone"
                    ? "Standalone"
                    : (workspaceOptions.find((w) => w.id === workspaceId)?.name ?? "Workspace")}
              </span>
            </Button>
          }
        />
        {/* Capped, because a workspace is named after the pull request it was
            opened for and those names run long. Uncapped, one of them sets the
            width of the whole popup and the menu spans half the page. */}
        <Menu.Popup align="end" {...stylex.props(sx.minW200px, sx.maxW320px)}>
          <Menu.RadioGroup
            value={workspaceId}
            onValueChange={(value) => setWorkspaceId(String(value))}
          >
            <Menu.RadioItem value="all" closeOnClick>
              <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>All workspaces</span>
              <Menu.Check on={workspaceId === "all"} />
            </Menu.RadioItem>
            {workspaceOptions.map((workspace) => (
              <Menu.RadioItem key={workspace.id} value={workspace.id} closeOnClick>
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>{workspace.name}</span>
                <Menu.Check on={workspaceId === workspace.id} />
              </Menu.RadioItem>
            ))}
            <Menu.RadioItem value="standalone" closeOnClick>
              <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>Standalone</span>
              <Menu.Check on={workspaceId === "standalone"} />
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Popup>
      </Menu.Root>

      {repoOptions.length > 1 && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button variant="ghost" {...stylex.props(sx.minW0)} icon={<IconRepo size={18} />} caret>
                <span {...stylex.props(sx.maxW150px, sx.truncate)}>
                  {repo === "all" ? "All repos" : repoLabel(repo)}
                </span>
              </Button>
            }
          />
          <Menu.Popup align="end" {...stylex.props(sx.minW200px, sx.maxW320px)}>
            <Menu.RadioGroup value={repo} onValueChange={(value) => setRepo(String(value))}>
              <Menu.RadioItem value="all" closeOnClick>
                {/* Sized to the tiles below so every label shares one edge. */}
                <span {...stylex.props(sx.size18px, sx.shrink0)} />
                <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>All repos</span>
                <Menu.Check on={repo === "all"} />
              </Menu.RadioItem>
              {repoOptions.map((name) => (
                <Menu.RadioItem key={name} value={name} closeOnClick>
                  <RepoTile name={name} size={18} />
                  <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>{repoLabel(name)}</span>
                  <Menu.Check on={repo === name} />
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Root>
      )}

      {/* Archived is a rarely-flipped switch, so it lives behind the overflow
          menu rather than spending a slot of its own. It keeps its own colour
          when on, so the row still says the list is narrowed. */}
      <Menu.Root>
        <Tooltip label="More filters">
          <Menu.Trigger
            render={
              <Button
                variant="ghost"
                className={showArchived ? mergeStylexClassName("", sx.shrink0, sx.textFg) : mergeStylexClassName("", sx.shrink0)}
                aria-label="More filters"
                icon={<IconDotsHorizontal size={18} />}
              />
            }
          />
        </Tooltip>
        <Menu.Popup align="end">
          <Menu.CheckboxItem
            checked={showArchived}
            onCheckedChange={(next) => {
              setShowArchived(next);
              if (next) onShowArchived();
            }}
            closeOnClick
          >
            <IconArchive size={18} />
            <span {...stylex.props(sx.minW0, sx.flex1, sx.truncate)}>Show archived</span>
            <Menu.Check on={showArchived} />
          </Menu.CheckboxItem>
        </Menu.Popup>
      </Menu.Root>

      {/* The page's one CTA carries its verb as a glyph as well as a word: at
          this size a label alone is a coloured rectangle you read, and the plus
          is what makes it scan as the button that makes something. */}
      <Button
        variant="primary"
        {...stylex.props(sx.shrink0)}
        icon={<IconPlus size={18} />}
        onClick={onNewSession}
      >
        New session
      </Button>
    </>
  );

  return (
    // The page frame every other list page in the app uses: one centred
    // column at the shared width and padding, a PageHeader on top.
    <div data-page-scroll {...stylex.props(sx.minH0, sx.wFull, sx.flex1, sx.overflowYAuto, sx.bgSurface)}>
      {topbarActionsEl ? createPortal(actions, topbarActionsEl) : null}
      <div {...mergeStylexProps("", sx.max560pxPx4, sx.max560pxPb12, sx.max560pxPt18px, sx.mxAuto, sx.wFull, sx.maxW920px, sx.px6, sx.pb15, sx.pt7)}>
        {/* The page's name is the top bar's now. With no `PageTitle` under it
            the large-title handoff never has a heading to defer to, so the bar
            holds "Pull requests" in its left corner for good rather than
            fading it in on scroll (hooks/useLargeTitle.ts). That buys the body
            its first screen back: the day's numbers take a row of their own,
            and the list starts on Open instead of a third row of chrome.

            `min-w-0` because the line wraps, and a flex child asked for its
            content size takes the width of one clause rather than of the row. */}
        <div {...mergeStylexProps("", sx.max560pxMb35, sx.mb18px, sx.flex, sx.minW0)}>
          <OverviewLine
            running={running}
            stats={stats}
            onOpenAnalytics={onOpenAnalytics}
          />
        </div>
        {sections.length === 0 ? (
          <EmptyState
            title={
              query
                ? "No matching pull requests"
                : person === "all"
                  ? "No pull requests yet"
                  : `Nothing open for ${personLabel(person)}`
            }
          >
            {query
              ? "Try another search or workspace."
              : person === "all"
                ? "Workspaces with pull requests appear here."
                : "Pick someone else, or set the filter back to anyone."}
          </EmptyState>
        ) : (
          <div className={PR_LIST}>
            {sections.map((section) => (
              <section key={section.state} {...stylex.props(sx.mb8)}>
                <h2 className={PR_SECTION_LABEL}>
                  {section.label}
                  <span {...stylex.props(sx.fontMedium, sx.textFaint, typography.label)}>{section.rows.length}</span>
                </h2>
                {section.groups.map(([label, rows]) => (
                  <div key={label} {...stylex.props(sx.mb5)}>
                    <h3 className={PR_GROUP_LABEL}>
                      {label}
                      <span {...stylex.props(sx.fontMedium)}>{rows.length}</span>
                    </h3>
                    <div>
                      {rows.map((row) => {
                        const status = prStatusMark(row);
                        return (
                          <button
                            key={row.key}
                            className={PR_ROW}
                            onClick={() => setPreview(row)}
                            title={`${repoLabel(row.repo)} · ${row.branch}`}
                          >
                            {/* Hue is for the rows with something to say. A
                                section of open pull requests is almost all
                                healthy, so the resting mark is drawn as
                                structure and green now means approved. */}
                            <span
                              className={[status.quiet ? mergeStylexClassName("", sx.textDim) : status.className, mergeStylexClassName("", sx.flex, sx.itemsCenter)].filter(Boolean).join(" ")}
                              title={status.label}
                            >
                              <StateIcon state={row.state} />
                            </span>
                            {person === "all" && row.person ? (
                              <UserAvatar name={personLabel(row.person)} size={20} title={personLabel(row.person)} />
                            ) : (
                              <RepoTile name={row.repo} size={20} />
                            )}
                            {/* One line. The branch under the title restated it
                                in kebab case on most rows and cost the list
                                half its height; it stays in the row's tooltip,
                                in search, and in the panel the row opens. */}
                            <span {...stylex.props(sx.flex, sx.minW0, sx.itemsBaseline, sx.gap2)}>
                              <span {...stylex.props(sx.truncate, sx.fontMedium, sx.leading13, sx.textFg, typography.itemTitle)}>
                                {row.title}
                              </span>
                              {row.number && (
                                <span {...mergeStylexProps("", sx.tabularNums, sx.shrink0, sx.textFaint, typography.meta)}>
                                  #{row.number}
                                </span>
                              )}
                            </span>
                            {/* Added and removed keep diff's own green and red.
                                It is the one place on the row where the colour
                                is the convention rather than a status, and it
                                reads at a glance in a way a neutral pair of
                                numbers does not. */}
                            <span {...mergeStylexProps("", sx.tabularNums, sx.phoneHidden, sx.justifySelfEnd, typography.meta)}>
                              {row.additions !== undefined && (
                                <span {...stylex.props(sx.textGreen)}>+{compactDiff(row.additions)}</span>
                              )}
                              {row.deletions !== undefined && (
                                <span {...stylex.props(sx.ml2, sx.textRed)}>−{compactDiff(row.deletions)}</span>
                              )}
                            </span>
                            <span {...mergeStylexProps("", sx.tabularNums, sx.justifySelfEnd, sx.textFaint, typography.meta)}>
                              {compactAge(row.updatedAt)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      <ResponsiveDialog
        open={Boolean(preview)}
        onClose={() => setPreview(null)}
        phone={isPhone}
        label={preview ? `Pull request: ${preview.title}` : "Pull request"}
        showPhoneGrabber={false}
        modalClassName="h-[min(820px,85vh)] w-[min(1280px,92vw)] max-w-none bg-surface"
        sheetClassName="top-0 h-[100dvh] max-h-none bg-surface [border-radius:0]! [box-shadow:none]!"
      >
        {preview && (
          <>
            <div {...mergeStylexProps("", sx.phoneMinH14, sx.flex, sx.minH13, sx.shrink0, sx.itemsCenter, sx.gap2, sx.borderB, sx.borderLine, sx.bgPanel, sx.px3)}>
              <div {...stylex.props(sx.flex, sx.minW0, sx.flex1, sx.itemsCenter, sx.gap2, sx.px1, sx.fontMedium, sx.textFg, typography.itemTitle)}>
                <IconPullRequest size={19} {...stylex.props(sx.shrink0, sx.textDim)} />
                <span {...stylex.props(sx.truncate)}>{repoLabel(preview.repo)}</span>
                {preview.number && (
                  <span {...mergeStylexProps("", sx.tabularNums, sx.shrink0, sx.fontNormal, sx.textFaint)}>
                    #{preview.number}
                  </span>
                )}
              </div>
              {preview.workspaceId ? (
                <Button
                  variant="default" {...mergeStylexProps("", sx.phoneMinH11, sx.minH10, sx.shrink0)}
                  icon={<IconSidebarLeft size={18} />}
                  onClick={() => {
                    onOpenWorkspace(preview.workspaceId!, preview);
                    setPreview(null);
                  }}
                >
                  Open workspace
                </Button>
              ) : preview.state === "OPEN" ? (
                <Button
                  variant="default" {...mergeStylexProps("", sx.phoneMinH11, sx.minH10, sx.shrink0)}
                  icon={<IconSidebarLeft size={18} />}
                  disabled={addingToSidebar}
                  onClick={() => void addPreviewToSidebar()}
                >
                  {addingToSidebar ? "Adding…" : "Add to sidebar"}
                </Button>
              ) : null}
              <Button
                variant="ghost" {...mergeStylexProps("", sx.phoneSize11, sx.size10, sx.shrink0)}
                icon={<IconX size={20} />}
                aria-label="Close pull request"
                onClick={() => setPreview(null)}
              />
            </div>
            <div {...stylex.props(sx.minH0, sx.flex1)}>
              <PrQueuePreview
                key={`${preview.repo}:${preview.branch}`}
                repo={preview.repo}
                branch={preview.branch}
                sessions={sessions}
                onOpenSession={(id) => {
                  const session = sessions.find((item) => item.id === id);
                  if (session) onSelect(session);
                  setPreview(null);
                }}
                onOpenPr={openPreviewTarget}
              />
            </div>
          </>
        )}
      </ResponsiveDialog>
    </div>
  );
}
