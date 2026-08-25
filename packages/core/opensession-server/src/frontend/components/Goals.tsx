import { repoLabel } from "../lib/repo-label";
import { BASE_PATH } from "../lib/base";
import React, { useEffect, useState } from "react";
import {
  fetchGoals,
  fetchGoal,
  createGoalApi,
  updateGoalApi,
  deleteGoalApi,
  runGoalApi,
  resumeGoalApi,
  pauseGoalApi,
  fetchModels,
  fetchRepos,
  cachedRepos,
  relativeTime,
  type ModelOption,
  type RepoInfo,
} from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { docTitle, DEFAULT_DOC_TITLE } from "../lib/brand";
import { Button } from "../ui/button";
import { CheckStatusIcon } from "./CheckStatusIcon";
import { IconPlus } from "./icons";
import { SOURCE_CHIP } from "../lib/source-chip-classes";
import { Field, FieldGrid, Input, Textarea } from "../ui/input";
import { OptionSelect } from "../ui/select";
import {
  SettingCard,
  SettingsForm,
  SettingsFormActions,
  SettingsFormTitle,
  SettingsHeader,
  SettingsPanel,
} from "../ui/settings";
import { EmptyState, InlineAlert, LoadingState } from "../ui/state";
import { WorkingPill } from "../ui/status";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps, mergeStylexClassName, mergeStylexOverrideClassName } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	relative: {
			position: "relative"
	},
	flex: {
			display: "flex"
	},
	minH0: {
			minHeight: "0"
	},
	minW0: {
			minWidth: "0"
	},
	flex1: {
			flex: "1"
	},
	mb3: {
			marginBottom: "12px"
	},
	size2: {
			width: "8px",
			height: "8px"
	},
	shrink0: {
			flexShrink: "0"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	,
		cornerShape: "round"},
	truncate: {
			textOverflow: "ellipsis",
			whiteSpace: "nowrap",
			overflow: "hidden"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textFg: {
			color: "var(--text)"
	},
	mt05: {
			marginTop: "2px"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	flexAuto: {
			flex: "auto"
	},
	flexCol: {
			flexDirection: "column"
	},
	borderL: {
			borderLeftStyle: "solid",
			borderLeftWidth: "1px"
	},
	borderLine: {
			borderColor: "var(--border)"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap25: {
			gap: "10px"
	},
	borderB: {
			borderBottomStyle: "solid",
			borderBottomWidth: "1px"
	},
	borderDivider: {
			borderColor: "var(--divider)"
	},
	px4: {
			paddingInline: "16px"
	},
	py3: {
			paddingBlock: "12px"
	},
	My1: {
			marginBlock: "-4px"
	},
	Ml05: {
			marginLeft: "-2px"
	},
	hidden: {
			display: "none"
	},
	gap175: {
			gap: "7px"
	},
	px15: {
			paddingInline: "6px"
	},
	py1: {
			paddingBlock: "4px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	mlAuto: {
			marginLeft: "auto"
	},
	gap15: {
			gap: "6px"
	},
	size7: {
			width: "28px",
			height: "28px"
	},
	justifyCenter: {
			justifyContent: "center"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	gap35: {
			gap: "14px"
	},
	overflowYAuto: {
			overflowY: "auto"
	},
	px5: {
			paddingInline: "20px"
	},
	pt45: {
			paddingTop: "18px"
	},
	pb10: {
			paddingBottom: "40px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
	leadingSnug: {
			lineHeight: "var(--leading-snug)"
	},
	bgSurface: {
			backgroundColor: "var(--bg)"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	roundedPanel: {
			borderRadius: "calc(var(--radius) * var(--rf))"
	,
		cornerShape: "var(--cs)"},
	px35: {
			paddingInline: "14px"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	grid: {
			display: "grid"
	},
	gridColsMaxContent1fr: {
			gridTemplateColumns: "max-content 1fr"
	},
	itemsBaseline: {
			alignItems: "baseline"
	},
	gapX5: {
			columnGap: "20px"
	},
	gapY2: {
			rowGap: "8px"
	},
	mb2: {
			marginBottom: "8px"
	},
	textGreen: {
			color: "var(--green)"
	},
	textRed: {
			color: "var(--red)"
	},
	leading17: {
			lineHeight: "1.7"
	},
	whitespaceNowrap: {
			whiteSpace: "nowrap"
	},
	fontMono: {
			fontFamily: "var(--mono)"
	},
  mb0: { marginBottom: "0" },
  listPane: {
    display: "flex",
    minWidth: 0,
    justifyContent: "center",
    overflowY: "auto",
	},
  listPaneSelected: {
    flex: "0 0 340px",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--border)",
    paddingInline: "10px",
    paddingTop: "16px",
    paddingBottom: "40px",
  },
  listPaneDefault: {
    flex: 1,
    paddingInline: "32px",
    paddingTop: "44px",
    paddingBottom: "88px",
    "@media (max-width: 720px)": {
      paddingInline: "16px",
      paddingTop: "20px",
      paddingBottom: "48px",
    },
  },
  selfStart: { alignSelf: "flex-start" },
  maxWNone: { maxWidth: "none" },
  headerPhone: {
    "@media (max-width: 720px)": {
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "12px",
    },
  },
  headerSelected: { marginBottom: "12px", paddingInline: "8px" },
  goalRow: {
    display: "flex",
    width: "100%",
    minWidth: 0,
    alignItems: "center",
    gap: "12px",
    paddingInline: "20px",
    paddingBlock: "14px",
    textAlign: "left",
    outlineStyle: "none",
    transitionProperty: "color, background-color",
    ":focusVisible": {
      boxShadow:
        "inset 0 0 0 2px color-mix(in srgb, var(--accent) 50%, transparent)",
    },
  },
  goalRowSelected: { backgroundColor: "var(--selected)" },
  goalRowIdle: { ":hover": { "@media (hover: hover)": { backgroundColor: "var(--hover)" } } },
  goalRowNarrow: { gap: "10px", paddingInline: "12px", paddingBlock: "10px" },
  statusActive: { backgroundColor: "var(--green)" },
  statusPaused: { backgroundColor: "var(--yellow)" },
  statusDone: { backgroundColor: "var(--accent)" },
  statusFailed: { backgroundColor: "var(--red)" },
  goalText: { display: "flex", minWidth: 0, flex: 1, flexDirection: "column" },
  muted: { opacity: 0.55 },
  resultIcon: {
    display: "flex",
    width: "20px",
    height: "20px",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  nextWake: {
    width: "84px",
    flexShrink: 0,
    textAlign: "right",
    color: "var(--text-faint)",
  },
  phoneHidden: { "@media (max-width: 720px)": { display: "none" } },
  formStack: { display: "flex", flexDirection: "column", gap: "14px" },
  sectionLabel: {
    marginBottom: "6px",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--text-faint)",
  },
  link: {
    cursor: "pointer",
    color: "var(--link)",
    textDecorationLine: "none",
    ":hover": { "@media (hover: hover)": { textDecorationLine: "underline" } },
  },
  textWhite: { color: "var(--color-white)" },

	max900pxHidden: {
		"@media not all and (min-width: 900px)": {
			"display": "none"
		}
	},
	max900pxBorderL0: {
		"@media not all and (min-width: 900px)": {
			"borderLeftStyle": "var(--tw-border-style)",
			"borderLeftWidth": "0"
		}
	},
	max900pxInlineFlex: {
		"@media not all and (min-width: 900px)": {
			"display": "inline-flex"
		}
	},
	hoverBgHover: {
		"@media (hover: hover)": {
			":hover": {
				"backgroundColor": "var(--hover)"
			}
		}
	},
	hoverTextFg: {
		"@media (hover: hover)": {
			":hover": {
				"color": "var(--text)"
			}
		}
	},
});

/* Goals is a tool surface hosted inside Settings, so it reads as one of its
   pages: the settings reading column, a SettingsHeader on top, the rows on a
   SettingCard plate, and the form in the settings form shapes. What it keeps
   of its own is the master/detail split — selecting a goal opens a drawer and
   the list steps back to a rail (see Automations.tsx, same shape). */

/** The two rules that reach in from the form to its fields: 16px on phones, so
    iOS doesn't zoom a focused field, and paragraph leading in a textarea. */
const FORM_FIELDS =
  "[&_textarea]:leading-normal phone:[&_input]:text-input-phone phone:[&_select]:text-input-phone phone:[&_textarea]:text-input-phone";

type GoalStatus = "active" | "paused" | "done" | "failed";

interface Goal {
  id: string;
  name: string;
  mission: string;
  status: GoalStatus;
  mode: "ask" | "code";
  repo?: string;
  bksSessionId?: string;
  nextWakeAt: string;
  minWakeMinutes: number;
  maxWakes?: number;
  wakeCount: number;
  lastRunAt?: string;
  lastRunStatus?: "running" | "ok" | "error";
  lastRunError?: string;
  phase?: string;
  pauseReason?: string;
  doneReason?: string;
  model?: string;
  fallbackModel?: string;
  mcpServers?: string[];
  createdBy: string;
  isRunning?: boolean;
}

interface Props {
  onOpenSession: (sessionId: string) => void;
  /** Selected goal id (or name) — from the route. */
  selectedId?: string;
  /** Change the selection ("" closes the detail drawer). Routed by App. */
  onSelect: (id: string) => void;
}

const statusStyle: Record<GoalStatus, stylex.StyleXStyles> = {
  active: sx.statusActive,
  paused: sx.statusPaused,
  done: sx.statusDone,
  failed: sx.statusFailed,
};

export function Goals({ onOpenSession, selectedId, onSelect }: Props) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels()
      .then((m) => setDefaultModel(m.default))
      .catch(() => {});
  }, []);

  const load = async () => {
    await (async () => {
setGoals(await fetchGoals());
      setLoading(false);
    })().catch(async () => {});
  };

  useEffect(() => {
    document.title = docTitle("Goals");
    load();
    const id = setInterval(load, 10000);
    return () => {
      clearInterval(id);
      document.title = DEFAULT_DOC_TITLE;
    };
  }, [load]);

  // The routed selection — matched by id, or by name for deep-links.
  const sel = selectedId
        ? goals.find((g) => g.id === selectedId || g.name === selectedId) || null
    : null;

  // Leaving the selection also leaves edit mode.
  useEffect(() => setEditMode(false), [sel?.id]);

  // Escape backs out one layer: inline edit → read view → closed.
  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (editMode) setEditMode(false);
      else onSelect("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!sel, editMode, onSelect]);

  async function act(fn: () => Promise<unknown>, refreshDelay = 400) {
    await (async () => {
await fn();
      setTimeout(load, refreshDelay);
})().catch(async (e: any) => {
setError(e.message);
});
  }

  async function handleDelete(g: Goal) {
    if (
      !confirm(
        `Delete goal "${g.name}" and its ledger? The session it created is left as-is.`,
      )
    )
      return;
    if (sel?.id === g.id) onSelect("");
    await act(() => deleteGoalApi(g.id), 100);
  }

  return (
    <div {...stylex.props(sx.relative, sx.flex, sx.minH0, sx.minW0, sx.flex1)}>
    {/* Drawer open: the list compresses to a narrow rail, and on phones it
        steps aside entirely — Back returns to it. */}
    <div
        {...mergeStylexProps(sel ? mergeStylexClassName("", sx.max900pxHidden) : undefined, sx.listPane, sel ? sx.listPaneSelected : sx.listPaneDefault)}
    >
        <SettingsPanel className={mergeStylexOverrideClassName("", sx.selfStart, sel && sx.maxWNone)}>
      <SettingsHeader
        title="Goals"
        description={
          sel
            ? undefined
            : "Long-running missions that pace themselves, keep a ledger, and stop when done."
        }
            {...mergeStylexProps(sel ? "[&_h1]:text-item-title" : undefined, sx.headerPhone, sel && sx.headerSelected)}
        actions={
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            onClick={() => setShowForm(true)}
          >
            New goal
          </Button>
        }
      />

      {error && (
            <InlineAlert
              className={mergeStylexOverrideClassName("", sx.mb3)}
              onDismiss={() => setError(null)}
            >
          {error}
        </InlineAlert>
      )}

      {showForm && (
        <GoalForm
          initial={null}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {loading ? (
        <LoadingState>Loading…</LoadingState>
      ) : goals.length === 0 && !showForm ? (
        <EmptyState title="No goals yet">
              A goal pursues one mission over days or weeks. It wakes itself,
              reads its ledger, ships work via PRs, measures, and iterates until
              the objective is met.
        </EmptyState>
      ) : (
        <SettingCard>
          {goals.map((g) => {
            const running = g.isRunning || g.lastRunStatus === "running";
            return (
              <button
                key={g.id}
                    {...stylex.props(
                      sx.goalRow,
                      sel?.id === g.id ? sx.goalRowSelected : sx.goalRowIdle,
                      sel && sx.goalRowNarrow,
                )}
                onClick={() => onSelect(g.id)}
              >
                <span
                      {...stylex.props(
                        sx.size2,
                        sx.shrink0,
                        sx.roundedFull,
                        statusStyle[g.status],
                      )}
                  title={g.pauseReason || g.doneReason || g.status}
                />
                <span
                      {...stylex.props(
                        sx.goalText,
                        g.status !== "active" && sx.muted,
                  )}
                >
                      <span
                        {...stylex.props(
                          sx.truncate,
                          sx.fontMedium,
                          sx.textFg,
                          typography.itemTitle,
                        )}
                      >
                        {g.name}
                      </span>
                      <span
                        {...stylex.props(
                          sx.mt05,
                          sx.truncate,
                          sx.textDim,
                          typography.supporting,
                        )}
                      >
                    {g.status}
                    {g.phase ? ` · ${g.phase}` : ""}
                    {` · wake #${g.wakeCount}${g.maxWakes ? ` / ${g.maxWakes}` : ""}`}
                  </span>
                </span>
                {running ? (
                  <WorkingPill />
                    ) : g.lastRunStatus === "ok" ||
                      g.lastRunStatus === "error" ? (
                  <span
                        {...mergeStylexProps("[&_svg]:size-3.5", sx.resultIcon, g.lastRunStatus === "ok" ? sx.textGreen : sx.textRed)}
                    title={
                      g.lastRunStatus === "ok"
                        ? `Last wake ok${g.lastRunAt ? ` · ${relativeTime(g.lastRunAt)}` : ""}`
                        : g.lastRunError || "Last wake failed"
                    }
                  >
                        <CheckStatusIcon
                          kind={
                            g.lastRunStatus === "ok" ? "success" : "failure"
                          }
                        />
                  </span>
                ) : null}
                {/* Only the next wake: the status itself is already the first
                    word of the line on the left, and saying it twice made a
                    paused goal read as two different facts. */}
                <span
                      {...stylex.props(
                        sx.nextWake,
                        typography.meta,
                        sel ? sx.hidden : sx.phoneHidden,
                  )}
                >
                      {g.status === "active" && g.nextWakeAt
                        ? `next ${formatNext(g.nextWakeAt)}`
                        : ""}
                </span>
              </button>
            );
          })}
        </SettingCard>
      )}
    </SettingsPanel>
    </div>

      {sel && (
        <aside
          {...mergeStylexProps("", sx.max900pxBorderL0, sx.flex, sx.minH0, sx.minW0, sx.flexAuto, sx.flexCol, sx.borderL, sx.borderLine, sx.bgPanel)}
        >
          <div
            {...stylex.props(
              sx.flex,
              sx.shrink0,
              sx.itemsCenter,
              sx.gap25,
              sx.borderB,
              sx.borderDivider,
              sx.px4,
              sx.py3,
            )}
          >
            {/* Phones get Back instead of Close: there the drawer is the page. */}
            <button
              {...mergeStylexProps("", sx.max900pxInlineFlex, sx.My1, sx.Ml05, sx.hidden, sx.shrink0, sx.itemsCenter, sx.gap175, sx.px15, sx.py1, sx.fontMedium, sx.textFg, typography.itemTitle)}
              onClick={() => onSelect("")}
              title="Back to goals"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                {...stylex.props(sx.textDim)}
                aria-hidden
              >
                <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
              </svg>
              Goals
            </button>
            <span
              {...stylex.props(
                sx.minW0,
                sx.truncate,
                sx.fontSemibold,
                typography.label,
              )}
            >
              {editMode ? `Edit ${sel.name}` : sel.name}
            </span>
            {!editMode && (
              <div {...stylex.props(sx.mlAuto, sx.flex, sx.shrink0, sx.gap15)}>
                {sel.status === "active" && (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => runGoalApi(sel.id))}
                    disabled={sel.isRunning}
                  >
                    Wake now
                  </Button>
                )}
                {sel.status === "active" ? (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => pauseGoalApi(sel.id))}
                  >
                    Pause
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="soft"
                    onClick={() => act(() => resumeGoalApi(sel.id))}
                  >
                    Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => setEditMode(true)}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => handleDelete(sel)}
                >
                  Delete
                </Button>
              </div>
            )}
            <button
              {...mergeStylexProps("", sx.hoverBgHover, sx.hoverTextFg, sx.max900pxHidden, sx.flex, sx.size7, sx.shrink0, sx.itemsCenter, sx.justifyCenter, sx.roundedMd, sx.textDim)}
              onClick={() => onSelect("")}
              title="Close"
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.749.749 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.749.749 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
              </svg>
            </button>
          </div>
          <div
            {...stylex.props(
              sx.flex,
              sx.minH0,
              sx.flex1,
              sx.flexCol,
              sx.gap35,
              sx.overflowYAuto,
              sx.px5,
              sx.pt45,
              sx.pb10,
            )}
          >
            {editMode ? (
              <GoalForm
                key={sel.id}
                inline
                initial={sel}
                onClose={() => setEditMode(false)}
                onSaved={() => {
                  setEditMode(false);
                  load();
                }}
              />
            ) : (
              <>
                <div {...stylex.props(sx.flex, sx.itemsCenter, sx.gap25)}>
                  <span
                    {...mergeStylexProps(SOURCE_CHIP, statusStyle[sel.status], sx.textWhite)}
                  >
                    {sel.status}
                  </span>
                  {(sel.isRunning || sel.lastRunStatus === "running") && (
                    <WorkingPill />
                  )}
                  {sel.status === "active" && sel.nextWakeAt && (
                    <span
                      {...stylex.props(
                        sx.textFaint,
                        sx.mlAuto,
                        sx.shrink0,
                        typography.label,
                      )}
                      title={sel.nextWakeAt}
                    >
                      next wake {formatNext(sel.nextWakeAt)}
                    </span>
                  )}
                </div>
                {sel.status === "paused" && sel.pauseReason && (
                  <div
                    {...stylex.props(
                      sx.textDim,
                      sx.leadingSnug,
                      typography.supporting,
                    )}
                  >
                    Paused: {sel.pauseReason}
                  </div>
                )}
                {(sel.status === "done" || sel.status === "failed") &&
                  sel.doneReason && (
                    <div
                      {...stylex.props(
                        sx.textDim,
                        sx.leadingSnug,
                        typography.supporting,
                      )}
                    >
                      {sel.status === "done" ? "Done" : "Failed"}:{" "}
                      {sel.doneReason}
                  </div>
                )}

                <div>
                  <div {...stylex.props(sx.sectionLabel, typography.label)}>
                    Mission
                  </div>
                  <div
                    {...stylex.props(
                      sx.bgSurface,
                      sx.border,
                      sx.borderLine,
                      sx.roundedPanel,
                      sx.px35,
                      sx.py3,
                      sx.leadingRelaxed,
                      sx.textDim,
                      sx.whitespacePreWrap,
                      typography.label,
                    )}
                  >
                    {sel.mission}
                  </div>
                </div>

                <div>
                  <div {...stylex.props(sx.sectionLabel, typography.label)}>
                    Configuration
                  </div>
                  <div
                    {...stylex.props(
                      sx.grid,
                      sx.gridColsMaxContent1fr,
                      sx.itemsBaseline,
                      sx.gapX5,
                      sx.gapY2,
                      typography.label,
                    )}
                  >
                    <DetailKey>Mode</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.mode === "ask"
                        ? "Ask · read-only research and measurement"
                        : `Code · persistent worktree${sel.repo ? ` in ${repoLabel(sel.repo)}` : ""}, can open PRs`}
                    </span>

                    {sel.phase && (
                      <>
                        <DetailKey>Phase</DetailKey>
                        <span {...stylex.props(sx.textDim, sx.minW0)}>
                          {sel.phase}
                        </span>
                      </>
                    )}

                    <DetailKey>Model</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      {sel.model || `${defaultModel || "default"} (default)`}
                      {sel.fallbackModel && sel.fallbackModel !== "none" && (
                        <span
                          {...stylex.props(sx.textFaint)}
                          title="Used only when every account for the primary model has hit its usage limit"
                        >
                          {" "}
                          · falls back to {sel.fallbackModel}
                        </span>
                      )}
                    </span>

                    <DetailKey>Cadence</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      at least {sel.minWakeMinutes}m between wakes
                      {sel.maxWakes ? ` · capped at ${sel.maxWakes} wakes` : ""}
                    </span>

                    <DetailKey>MCPs</DetailKey>
                    <span {...stylex.props(sx.textDim, sx.minW0)}>
                      {sel.mcpServers?.length
                        ? sel.mcpServers.join(", ")
                        : "all connectors"}
                    </span>

                    {sel.bksSessionId && (
                      <>
                        <DetailKey>Session</DetailKey>
                        <span {...stylex.props(sx.minW0)}>
                          <a
                            {...stylex.props(sx.link)}
                            onClick={(e) => {
                              e.preventDefault();
                              onOpenSession(sel.bksSessionId!);
                            }}
                            href={`${BASE_PATH}/session/${sel.bksSessionId}`}
                          >
                            open the goal's session
                          </a>
                        </span>
                      </>
                    )}

                    <DetailKey>Created</DetailKey>
                    <span {...stylex.props(sx.textDim)}>
                      by {sel.createdBy}
                    </span>
                  </div>
                </div>

                <div>
                  <div {...stylex.props(sx.sectionLabel, typography.label)}>
                    Activity
                  </div>
                  <div
                    {...stylex.props(sx.textDim, sx.mb2, typography.supporting)}
                  >
                    wake #{sel.wakeCount}
                    {sel.maxWakes ? ` of ${sel.maxWakes}` : ""}
                    {sel.lastRunAt && (
                      <>
                        {" · last wake "}
                        {relativeTime(sel.lastRunAt)}
                        {sel.lastRunStatus === "ok" && (
                          <span {...stylex.props(sx.textGreen)}> ✓</span>
                        )}
                        {sel.lastRunStatus === "error" && (
                          <span
                            {...stylex.props(sx.textRed)}
                            title={sel.lastRunError}
                          >
                            {" "}
                            ✗
                          </span>
                        )}
                      </>
                    )}
                  </div>
                  <GoalLedger id={sel.id} />
                </div>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

/** Left column of the drawer's Configuration grid. */
function DetailKey({ children }: { children: React.ReactNode }) {
  return (
    <span
      {...stylex.props(
        sx.textFaint,
        sx.leading17,
        sx.whitespaceNowrap,
        typography.label,
      )}
    >
      {children}
    </span>
  );
}

/** Lazily fetch + show a goal's full mission + ledger. */
function GoalLedger({ id }: { id: string }) {
  const [ledger, setLedger] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetchGoal(id)
      .then((g) => {
        if (alive) setLedger(g.ledger || "(ledger is empty)");
      })
      .catch(() => alive && setLedger("(failed to load ledger)"));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        maxHeight: 360,
        overflow: "auto",
        margin: 0,
        padding: "10px 12px",
        background: "var(--bg-raised)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontFamily: "var(--mono)",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      {ledger === null ? "Loading ledger…" : ledger}
    </pre>
  );
}

function formatNext(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

/** " (Claude)" / " (OpenAI Codex)" by the model's ACCOUNT POOL — the engine
 *  provider ("pi"/"pi") says nothing about whose subscription pays, and
 *  keying off it labeled every engine entry "(Claude)". Pool-less models get
 *  no suffix. */
function accountPoolSuffix(m: ModelOption): string {
  if (m.accountProvider === "codex") return " (OpenAI Codex)";
  if (m.accountProvider === "claude") return " (Claude)";
  return "";
}

function GoalForm({
  initial,
  inline,
  onClose,
  onSaved,
}: {
  initial: Goal | null;
  /** Hosted in the detail drawer: drop the card chrome + redundant title. */
  inline?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [mission, setMission] = useState(initial?.mission || "");
  const [mode, setMode] = useState<"ask" | "code">(initial?.mode || "ask");
  const [repo, setRepo] = useState(initial?.repo || "");
  // Seeded from the repos this browser saw last (lib/repo-cache), so the repo
  // picker opens on the real list rather than empty; the fetch below corrects it.
  const [repos, setRepos] = useState<RepoInfo[]>(cachedRepos);
  const [model, setModel] = useState(initial?.model || "");
  const [fallbackModel, setFallbackModel] = useState(
    initial?.fallbackModel || "",
  );
  const [mcpServers, setMcpServers] = useState(
    (initial?.mcpServers || []).join(", "),
  );
  const [minWakeMinutes, setMinWakeMinutes] = useState(
    String(initial?.minWakeMinutes ?? 30),
  );
  const [maxWakes, setMaxWakes] = useState(
    initial?.maxWakes ? String(initial.maxWakes) : "",
  );
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchModels(), fetchRepos()])
      .then(([m, repoItems]) => {
        setModels(m.models);
        setDefaultModel(m.default);
        if (repoItems.length) setRepos(repoItems);
        setRepo(
          (current) =>
          current ||
          repoItems.find((item) => item.default)?.id ||
          repoItems[0]?.id ||
          "",
        );
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    const servers = mcpServers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      name,
      mission,
      mode,
      repo: repo.trim() || undefined,
      model: model || undefined,
      fallbackModel: fallbackModel || undefined,
      mcpServers: servers.length ? servers : undefined,
      minWakeMinutes: Number(minWakeMinutes) || undefined,
      maxWakes: maxWakes.trim() ? Number(maxWakes) : undefined,
    };
    await (async () => {
if (initial) {
        await updateGoalApi(initial.id, payload);
      } else {
        await createGoalApi({ ...payload, createdBy: getCurrentUser() });
      }
      onSaved();
})().catch(async (e: any) => {
setError(e.message);
      setSaving(false);
});
  }

  const fields = (
    <>
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rank #1: screen recording software"
        />
      </Field>

      <Field label="Mission">
        <Textarea
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={12}
          placeholder="The full mission brief: objective, strategy, operating loop, hard rules. It's restated to the agent every wake."
        />
      </Field>

      <FieldGrid>
        <Field label="Mode">
          <OptionSelect
            label="Mode"
            value={mode}
            options={[
              {
                value: "ask",
                label: "Ask · read-only research and measurement",
              },
              {
                value: "code",
                label: "Code · persistent worktree, can open PRs",
              },
            ]}
            onChange={(next) => setMode(next as "ask" | "code")}
          />
        </Field>

        <Field label="Repository">
          <OptionSelect
            label="Repository"
            value={repo}
            options={repos.map((item) => ({
              value: item.id,
              label: item.label || repoLabel(item.id),
            }))}
            onChange={setRepo}
          />
        </Field>

        <Field label="Model">
          <OptionSelect
            label="Model"
            value={model}
            options={[
              {
                value: "",
                label: `Default${defaultModel ? ` · ${defaultModel}` : ""}`,
              },
              ...models.map((m) => ({
                value: m.id,
                label: m.label + accountPoolSuffix(m),
              })),
            ]}
            onChange={setModel}
          />
        </Field>

        <Field
          label="Fallback model"
          title="Used only when every account for the primary model has hit its usage limit"
        >
          <OptionSelect
            label="Fallback model"
            value={fallbackModel}
            options={[
              { value: "", label: "None · fail instead" },
              ...models.map((m) => ({
                value: m.id,
                label: m.label + accountPoolSuffix(m),
              })),
            ]}
            onChange={setFallbackModel}
          />
        </Field>
      </FieldGrid>

      <Field
        label="MCP servers"
        title="Comma-separated. Blank means every connector."
      >
        <Input
          value={mcpServers}
          onChange={(e) => setMcpServers(e.target.value)}
          placeholder="ahrefs, slack"
          className={mergeStylexOverrideClassName("", sx.fontMono)}
        />
      </Field>

      <FieldGrid>
        <Field
          label="Minutes between wakes"
          title="The goal never wakes sooner than this."
        >
          <Input
            type="number"
            value={minWakeMinutes}
            onChange={(e) => setMinWakeMinutes(e.target.value)}
            placeholder="30"
          />
        </Field>

        <Field label="Max wakes" title="Safety cap. Blank means no limit.">
          <Input
            type="number"
            value={maxWakes}
            onChange={(e) => setMaxWakes(e.target.value)}
            placeholder="–"
          />
        </Field>
      </FieldGrid>

      {error && <InlineAlert>{error}</InlineAlert>}

      <SettingsFormActions>
        <Button variant="soft" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={saving || !name.trim() || !mission.trim()}
        >
          {saving ? "Saving…" : initial ? "Save changes" : "Create goal"}
        </Button>
      </SettingsFormActions>
    </>
  );

  // In the drawer the panel is already the surface, so the form drops the
  // plate and the title the drawer's own header carries.
  if (inline)
    return (
      <div {...mergeStylexProps(FORM_FIELDS, sx.formStack)}>
        {fields}
      </div>
    );

  return (
    <SettingsForm
      {...mergeStylexProps(FORM_FIELDS, sx.mb3, sx.formStack)}
    >
      <SettingsFormTitle className={mergeStylexOverrideClassName("", sx.mb0)}>
        {initial ? `Edit "${initial.name}"` : "New goal"}
      </SettingsFormTitle>
      {fields}
    </SettingsForm>
  );
}
