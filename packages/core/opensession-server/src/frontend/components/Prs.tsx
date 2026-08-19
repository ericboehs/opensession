import React, { useEffect, useMemo, useState } from "react";
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
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { RepoTile, repoLabel } from "./RepoTile";
import { usePeople } from "../lib/people";
import { Menu } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";
import { Input } from "../ui/input";
import { PageHeader, PageTitle } from "../ui/page-header";
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
} from "./icons";

interface Props {
  sessions: UnifiedSession[];
  workspaces: Workspace[];
  onSelect: (session: UnifiedSession) => void;
  onNewSession: () => void;
  onShowArchived: () => void;
  onOpenAnalytics?: () => void;
  /** The pane's top bar, where this page's controls go. */
  topbarActionsEl?: HTMLElement | null;
}

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
    <span aria-hidden="true" className="text-faint">
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
      aria-busy={!stats}
      // The clauses wrap rather than truncate: a narrow window should cost the
      // line a second row, not hide the trend behind an ellipsis that gives no
      // hint of what it swallowed.
      className="focus-ring group -mx-1 mt-1 flex max-w-full cursor-pointer flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-sm px-1 text-left text-supporting tabular-nums text-dim transition-colors hover:text-fg"
    >
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={
            running > 0
              ? "h-1.5 w-1.5 shrink-0 rounded-full bg-green motion-safe:animate-pulse"
              : "h-1.5 w-1.5 shrink-0 rounded-full bg-line"
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
        <span className="text-faint transition-colors group-hover:text-dim">
          {trend}
        </span>
      ) : null}
      {!stats && (
        <span className="h-2.5 w-40 shrink rounded-sm bg-line motion-safe:animate-pulse" />
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
  topbarActionsEl,
}: Props) {
  const currentUser = useCurrentUser();
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

  const running = useMemo(
    () => sessions.filter((s) => s.isRunning && !s.archived).length,
    [sessions],
  );

  useEffect(() => {
    let active = true;
    fetchRecentPrs()
      .then((prs) => active && setRecentPrs(prs))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

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

  const allWorktrees = useMemo(() => {
    const prs = new Map(recentPrs.map((pr) => [pr.url, pr]));
    for (const pr of personPrs) prs.set(pr.url, pr);
    return buildWorktreeRows([...prs.values()], sessions);
  }, [personPrs, recentPrs, sessions]);

  const worktrees = useMemo(() => {
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
  }, [allWorktrees, person, workspaceId, query, repo, showArchived]);

  const sections = useMemo(() => {
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
  }, [worktrees]);

  const workspaceOptions = useMemo(() => {
    const represented = new Set(sessions.filter((s) => s.prUrl || s.prs?.some((pr) => pr.url)).map((s) => s.workspaceId));
    return workspaces.filter((workspace) => represented.has(workspace.id));
  }, [workspaces, sessions]);

  const repoOptions = useMemo(
    () => [...new Set(allWorktrees.map((row) => row.repo).filter(Boolean))].sort(),
    [allWorktrees],
  );

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
        className="w-[200px] min-w-[90px] shrink-[100]"
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
              <Button variant="ghost" className="min-w-0" icon={<IconPeople size={18} />} caret>
                <span className="max-w-[150px] truncate">
                  {person === "all" ? "Anyone" : personLabel(person)}
                </span>
              </Button>
            }
          />
          <Menu.Popup align="end" className="min-w-[200px] max-w-[320px]">
            <Menu.RadioGroup
              value={person}
              onValueChange={(value) => setPerson(String(value))}
            >
              <Menu.RadioItem value="all" closeOnClick>
                {/* Sized to the faces below so every label shares one edge. */}
                <span className="size-[18px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">Anyone</span>
                <Menu.Check on={person === "all"} />
              </Menu.RadioItem>
              {people.map((who) => {
                const key = who.name.toLowerCase();
                return (
                  <Menu.RadioItem key={key} value={key} closeOnClick>
                    <UserAvatar name={who.name} size={18} />
                    <span className="min-w-0 flex-1 truncate">
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
            <Button variant="ghost" className="min-w-0" icon={<IconFolder size={18} />} caret>
              <span className="max-w-[150px] truncate">
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
        <Menu.Popup align="end" className="min-w-[200px] max-w-[320px]">
          <Menu.RadioGroup
            value={workspaceId}
            onValueChange={(value) => setWorkspaceId(String(value))}
          >
            <Menu.RadioItem value="all" closeOnClick>
              <span className="min-w-0 flex-1 truncate">All workspaces</span>
              <Menu.Check on={workspaceId === "all"} />
            </Menu.RadioItem>
            {workspaceOptions.map((workspace) => (
              <Menu.RadioItem key={workspace.id} value={workspace.id} closeOnClick>
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                <Menu.Check on={workspaceId === workspace.id} />
              </Menu.RadioItem>
            ))}
            <Menu.RadioItem value="standalone" closeOnClick>
              <span className="min-w-0 flex-1 truncate">Standalone</span>
              <Menu.Check on={workspaceId === "standalone"} />
            </Menu.RadioItem>
          </Menu.RadioGroup>
        </Menu.Popup>
      </Menu.Root>

      {repoOptions.length > 1 && (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button variant="ghost" className="min-w-0" icon={<IconRepo size={18} />} caret>
                <span className="max-w-[150px] truncate">
                  {repo === "all" ? "All repos" : repoLabel(repo)}
                </span>
              </Button>
            }
          />
          <Menu.Popup align="end" className="min-w-[200px] max-w-[320px]">
            <Menu.RadioGroup value={repo} onValueChange={(value) => setRepo(String(value))}>
              <Menu.RadioItem value="all" closeOnClick>
                {/* Sized to the tiles below so every label shares one edge. */}
                <span className="size-[18px] shrink-0" />
                <span className="min-w-0 flex-1 truncate">All repos</span>
                <Menu.Check on={repo === "all"} />
              </Menu.RadioItem>
              {repoOptions.map((name) => (
                <Menu.RadioItem key={name} value={name} closeOnClick>
                  <RepoTile name={name} size={18} />
                  <span className="min-w-0 flex-1 truncate">{repoLabel(name)}</span>
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
                className={showArchived ? "shrink-0 text-fg" : "shrink-0"}
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
            <span className="min-w-0 flex-1 truncate">Show archived</span>
            <Menu.Check on={showArchived} />
          </Menu.CheckboxItem>
        </Menu.Popup>
      </Menu.Root>

      {/* The page's one CTA carries its verb as a glyph as well as a word: at
          this size a label alone is a coloured rectangle you read, and the plus
          is what makes it scan as the button that makes something. */}
      <Button
        variant="primary"
        className="shrink-0"
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
    <div data-page-scroll className="min-h-0 w-full flex-1 overflow-y-auto bg-surface">
      {topbarActionsEl ? createPortal(actions, topbarActionsEl) : null}
      <div className="mx-auto w-full max-w-[920px] px-6 pb-15 pt-7 max-[560px]:px-4 max-[560px]:pb-12 max-[560px]:pt-[18px]">
        <PageHeader>
          {/* `flex-1` even as an only child: the day's line wraps, and a
              wrapping flex box asked for its content size takes the width of
              one clause rather than of the row. */}
          <div className="min-w-0 flex-1">
            <PageTitle>Pull requests</PageTitle>
            <OverviewLine
              running={running}
              stats={stats}
              onOpenAnalytics={onOpenAnalytics}
            />
          </div>
        </PageHeader>
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
              <section key={section.state} className="mb-8">
                <h2 className={PR_SECTION_LABEL}>
                  {section.label}
                  <span className="text-label font-medium text-faint">{section.rows.length}</span>
                </h2>
                {section.groups.map(([label, rows]) => (
                  <div key={label} className="mb-5">
                    <h3 className={PR_GROUP_LABEL}>
                      {label}
                      <span className="font-medium">{rows.length}</span>
                    </h3>
                    <div>
                      {rows.map((row) => {
                        const status = prStatusMark(row);
                        return (
                          <button
                            key={row.key}
                            className={PR_ROW}
                            onClick={() =>
                              row.session ? onSelect(row.session) : row.url && window.open(row.url, "_blank", "noopener")
                            }
                            title={`${repoLabel(row.repo)} · ${row.branch}`}
                          >
                            {/* Hue is for the rows with something to say. A
                                section of open pull requests is almost all
                                healthy, so the resting mark is drawn as
                                structure and green now means approved. */}
                            <span
                              className={`${status.quiet ? "text-dim" : status.className} flex items-center`}
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
                            <span className="flex min-w-0 items-baseline gap-2">
                              <span className="truncate text-item-title font-medium leading-[1.3] text-fg">
                                {row.title}
                              </span>
                              {row.number && (
                                <span className="shrink-0 text-meta tabular-nums text-faint">
                                  #{row.number}
                                </span>
                              )}
                            </span>
                            {/* Added and removed keep diff's own green and red.
                                It is the one place on the row where the colour
                                is the convention rather than a status, and it
                                reads at a glance in a way a neutral pair of
                                numbers does not. */}
                            <span className="justify-self-end text-meta tabular-nums phone:hidden">
                              {row.additions !== undefined && (
                                <span className="text-green">+{compactDiff(row.additions)}</span>
                              )}
                              {row.deletions !== undefined && (
                                <span className="ml-2 text-red">−{compactDiff(row.deletions)}</span>
                              )}
                            </span>
                            <span className="justify-self-end text-meta tabular-nums text-faint">
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
    </div>
  );
}
