import React, { useState, useEffect, useRef, useCallback } from "react";
import { AnimatePresence } from "motion/react";
import { fetchWorktrees, fetchModels, fetchToolAccounts, fetchSandboxStatus, requestSandboxPrewarm, suggestBranch, suggestRepos, type RepoSuggestion, configuredNewSessionRepo, fetchProviderAccounts, fetchRepos, createWorkspaceApi, updateWorkspaceApi, ApiError, type ProviderAccountOption, type ModelOption, type SandboxStatusInfo } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { type FileAttachment } from "../lib/images";
import {
  loadDraft,
  saveDraft,
  clearDraft,
  onDraftsChanged,
  NEW_SESSION_DRAFT_KEY as DRAFT_KEY,
} from "../lib/drafts";
import {
  addStaging,
  attachToDraft,
  countStaging,
  dropStagingAttachments,
  isStaging,
  NOTHING_STAGING,
  removeDraftFile,
  removeDraftImage,
  sameFiles,
  sameImages,
  subtractStaging,
  type StagingCount,
} from "../lib/attachments";
import { resolveNewSessionModel } from "../lib/default-model-pref";
import { baseModelId, modelEngine } from "./ModelEffortSelect";
import { getSendKeyPref, onSendKeyChanged } from "../lib/send-key-pref";
import { effectiveSendKey, MOD_ENTER_GLYPH } from "../lib/send-key";
import { isApple } from "../lib/platform";
import { AUTO_REPO, NO_REPO } from "../lib/session-repo";
import { getDefaultRepoPref, setDefaultRepoPref } from "../lib/default-repo-pref";
import { repoSelectionHint, toggleRepoSelection } from "../lib/repo-selection";
import {
  NewSessionPrompt,
  type NewSessionPromptHandle,
} from "./NewSessionPrompt";
import { ComposerContextChip } from "./ComposerContextChip";
import {
  IconPaperclip,
  IconChevronDown,
  IconChevronRight,
  IconConnections,
  IconDotsHorizontal,
  IconEye,
  IconReturn,
  IconBox,
  IconMessage,
  IconStack,
  IconNewBranch,
  IconSparkle,
} from "./icons";
import type { WSServerMessage, Workspace } from "../lib/types";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { PaletteSelect } from "./PaletteSelect";
import { RepoTile } from "./RepoTile";
import { ModelEffortSelect } from "./ModelEffortSelect";
import { Menu } from "../ui/menu";
import { displayName } from "../brand-logos";
import { IconTile } from "./BrandTile";
import { Tooltip } from "../ui/tooltip";
import { Modal, useEnterOnMount } from "../ui/modal";
import { useShortcutKeys } from "../hooks/useShortcutBindings";
import { matchesShortcut } from "../lib/shortcuts";
import { composerBox } from "../lib/composer-classes";
import { askSurface } from "../lib/tinted-surface";
import { cn } from "../ui/cn";
import {
	paletteIconBtn,
	paletteIconBtnOn,
	palettePill,
} from "../lib/palette-classes";

interface Props {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  /**
   * Render the same card on the page instead of over a backdrop: the empty
   * state's session input. There is no view behind it to dismiss back to, so
   * the create options collapse to the one that means anything (open what you
   * just made) and `onBack` is only the reset after a create.
   */
  inline?: boolean;
  /** Inline only: bumping this puts the caret back in the prompt. The sidebar's
      draft row points at this field. */
  focusSeq?: number;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
  /** Services selected before the palette opens, such as from a command-menu
   *  shortcut. They use the same chips and create payload as manual picks. */
  initialMcpServers?: string[];
  forceMode?: "ask" | "code" | "scratch";
  /** When starting a session inside a workspace, the session joins that workspace… */
  workspaceId?: string;
  /** Workspace whose model combinations this new, independent session can use. */
  modelWorkspaceId?: string;
  /** …and defaults to the workspace's shared repo + worktree (a sibling's branch). */
  forceRepo?: string;
  forceBranch?: string;
  /** Lets App render the pending session shell before the created session appears
      in the polled session list. */
  onCreateStarted?: (draft: {
    prompt: string;
    mode: "ask" | "code" | "scratch";
    repo: string;
    branch: string | null;
    workspaceId?: string;
    model?: string;
    images?: string[];
    /** Start the session without following it — leave the current view alone. */
    background?: boolean;
  }) => void;
  /** "Save as draft" succeeded: the workspace that now holds the draft
   *  (freshly created, or the scoped `workspaceId` when saving into one). */
  onDraftSaved?: (ws: Workspace) => void;
}

interface Worktree {
  branch: string;
  path: string;
}

interface RepoOption {
  id: string;
  label: string;
  default?: boolean;
  /** A repo whose sessions share one live checkout can be the session's own
   *  repo, but never a second one: there is no isolated worktree to attach. */
  sharedCheckout?: boolean;
}

const LAST_REPO_KEY = "opensession-new-session-repo";

/* ── Palette chrome ───────────────────────────────────────────────────────
   Every class is written out in full: Tailwind scans source TEXT, so a name
   assembled from a variable compiles to nothing. Variants that differ in
   colour or corner carry a COMPLETE string rather than stacking a second
   colour utility onto a shared base — two competing colour utilities on one
   element don't compose, the compiled sheet's order picks the winner.

   The icon button and the model pill are shared with the composer toolbar, so
   they live in lib/palette-classes.ts rather than being restated here. */

/** The hairline is a cutoff for content passing under the header, so it stays
 *  transparent until the prompt has actually scrolled beneath it. The border
 *  itself is always present: switching the colour keeps the height steady,
 *  where toggling `border-b` would jog the layout by a pixel.
 *
 *  Padding is asymmetric for the same reason the footer's is: the top is the
 *  card's own edge, the bottom only a hairline. The pickers are 32px boxes
 *  that fill on hover, so 16px above them matches the 16px beside them.
 *
 *  `flex-wrap` is what keeps the row honest on a phone. The three pickers want
 *  ~64px more than a 393px screen has, and a single line can only pay for that
 *  out of the labels — which took "tella-fusion" down to "tel…" and the branch
 *  to "New br…", two ellipses on the one row that says what the session is
 *  pointed at. Wrapped, the branch drops to a second line at full width and
 *  nothing is abbreviated; on any width that fits (every desktop) the row is
 *  unchanged, since wrapping costs nothing until it happens. */
const HEADER =
	"flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-transparent px-4 pt-4 pb-[11px]";
/** Merged onto HEADER/FOOTER by `cn()`, which drops the transparent colour. */
const EDGE_DIVIDER = "border-line";
/** Header pickers. `relative` is load-bearing — PaletteSelect's phone branch
 *  stacks an invisible native <select> over the trigger.
 *
 *  So is `min-w-0`: a picker's label already truncates, but a flex item whose
 *  own overflow is visible cannot be sized below its content, so the row had
 *  no way to give. On a phone the three of them want more than the header has,
 *  and the repo picker ran out under the branch picker instead of ellipsizing
 *  — the two labels overlapped, with the branch glyph landing on the repo's
 *  chevron. */
const TRIGGER =
	"relative inline-flex min-w-0 max-w-[46%] cursor-pointer items-center gap-1.5 rounded-control px-2 py-[5px] text-label font-medium text-dim transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-55";
/** The repo picker doubles as the palette's title: bigger, solid, heavier. */
const TRIGGER_STRONG =
	"relative inline-flex min-w-0 max-w-[46%] cursor-pointer items-center gap-1.5 rounded-control px-2 py-[5px] text-item-title font-semibold text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-55";
const CHEVRON = "-ml-0.5 shrink-0 text-faint";

/* (The prompt's own surface — the scroller and the field — moved to
   NewSessionPrompt, with the draft state it belongs to.) */
const ERROR = "mx-4 mb-2 rounded-md bg-red-soft px-2.5 py-[7px] text-supporting text-red";

/* Single-line footer: the model pill is the only flexible item — it gives way
   (its label ellipsizes) while the icon buttons and Create keep their size.
   Phones let the row wrap instead of crushing every pill to one letter.

   The bottom pad is deeper than the top one because it is measured against a
   different thing: the top is a hairline, the bottom is the card's own edge,
   rounded at ~30px. Create is a 36px plate inside a 40px row, so 14px here
   leaves it the same 16px clearance the side padding gives it. */
const FOOTER =
	"flex items-center justify-between gap-x-2 gap-y-2 border-t border-transparent px-4 pt-[9px] pb-3.5 phone:flex-wrap max-[560px]:gap-x-1.5 max-[560px]:px-3";
const FOOTER_LEFT = "flex min-w-0 items-center gap-1.5 max-[560px]:gap-1";
const FOOTER_RIGHT = "flex min-w-0 items-center gap-1.5 max-[560px]:gap-1 phone:ml-auto";
const FOOTER_ICON_BTN = cn(paletteIconBtn, "shrink-0 max-[560px]:w-9");
/** Ask mode's toggle. Off, it is one of the footer's quiet icon tools. On, it
 *  wears the same green marker the session composer's toolbar shows for the
 *  same mode, so one mode reads identically in both places — and it names
 *  itself, because the mode governs the whole session and an unlabelled glyph
 *  would leave read-only running silently.
 *
 *  A complete string rather than a variant stacked on FOOTER_ICON_BTN: the two
 *  states differ in width, height and colour, and `max-[560px]:w-9` from the
 *  icon button would crush the labelled chip on phones. 32px tall, the size
 *  the icon buttons' hover wash paints, so the row keeps one rhythm. */
const ASK_BTN_ON =
	"inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-label font-medium transition-colors bg-[color-mix(in_srgb,var(--green)_18%,transparent)] text-green hover:bg-[color-mix(in_srgb,var(--green)_26%,transparent)] disabled:cursor-default disabled:opacity-50";
/** Ask mode paints the whole card, not just its toggle — the same thing the
 *  session composer does for ask and for note mode, because the mode governs
 *  everything you are about to type rather than one control in the corner.
 *
 *  A pseudo-element rather than a background on the card, because the palette
 *  is glass over a dimmed page: the tint has to sit ON the blur and fade in and
 *  out with it intact. Children are lifted above it, and the shell's own
 *  `overflow-hidden` clips it to the rounded corner. */
const ASK_SURFACE =
	"isolate " +
	"before:pointer-events-none before:absolute before:inset-0 before:z-0 before:rounded-[inherit] before:[corner-shape:inherit] before:bg-[var(--palette-ask-bg)] before:opacity-0 before:transition-opacity before:duration-150 before:ease-[cubic-bezier(0.32,0.72,0,1)] " +
	"[&>*]:relative [&>*]:z-[1]";
/** The one flexible footer item. `[&_[data-effort]]` reaches the effort suffix
 *  inside ModelEffortSelect: on ultra-narrow screens it cedes its space to the
 *  model name, which would otherwise truncate to a single letter. */
const MODEL_PILL = cn(
	palettePill,
	"shrink min-w-0 max-[560px]:px-[9px] max-[374px]:[&_[data-effort]]:hidden",
);

/* What a create does with the view behind the palette: "open" follows the new
   session, "background" leaves you where you were, and "more" keeps the palette
   up for the next task. The order is the dropdown's, so the cycle shortcut and
   the menu step the same way. */
const CREATE_ACTIONS = ["open", "background", "more", "draft"] as const;
type CreateAction = (typeof CREATE_ACTIONS)[number];

// What the card is doing, and what it ended on. "savingDraft" and "creating"
// are two different waits (a promise and a WebSocket message), and "failed" is
// the terminal state both of them can reach, including the create whose answer
// never comes back because the socket dropped.
type CreateStatus =
  | { kind: "idle" }
  | { kind: "savingDraft" }
  | { kind: "creating" }
  | { kind: "failed"; message: string };
/** ⌘⌥↓ / ⌘⌥↑ (Ctrl+Alt elsewhere). Vertical rather than horizontal because
 *  Chrome and Safari own ⌘⌥← / ⌘⌥→ for tab switching. */
const CYCLE_SHORTCUT = isApple ? ["⌘", "⌥", "↓"] : ["Ctrl", "Alt", "↓"];
/** Held while picking a repo, it adds one instead of replacing the choice. */
const MULTI_MODIFIER = isApple ? "⌘" : "Ctrl";

const CREATE_LABELS: Record<CreateAction, string> = {
	open: "Create",
	background: "Create in background",
	more: "Create more",
	draft: "Save draft",
};

/* Split button: primary Create action + a caret that opens a mode dropdown.
   The two halves' corners are scoped to mutually exclusive media queries, so
   no two radius utilities ever race: phones drop the caret and round the main
   button out to a full pill.

   Desktop rounds on `rounded-control`, the corner every other button in the
   chrome shares (the Button primitive, the header CTAs). It used to be
   `rounded-md` — one step down, 9.45px against 13.5px — which on a 36px-tall
   plate read visibly square next to its neighbours. */
const CREATE_SPLIT = "relative inline-flex shrink-0 items-stretch";
const CREATE_MAIN =
	"inline-flex cursor-pointer items-center gap-[7px] border-none bg-accent px-3.5 py-[7px] text-label font-semibold text-on-accent transition-[background-color,opacity] enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-40 max-[560px]:px-3";
/** The desktop corner, split between the two shapes the button takes: half of
 *  a split button beside its caret, or the whole button when there is no caret
 *  (inline). Written as two whole classes rather than one plus an override,
 *  because both set `border-top-left-radius`, and which one wins is decided by
 *  the compiled sheet's order rather than the order they are listed here.
 *
 *  On a phone the split stays a split (the caret is the only way to reach
 *  "Save as draft" there): the main button keeps the pill's left half and the
 *  caret takes its right half, so together they still read as one pill. Only
 *  the inline card (no caret at all) rounds the whole button on a phone. */
const CREATE_MAIN_SPLIT = "desktop:rounded-l-control phone:rounded-l-[999px] phone:rounded-r-none";
const CREATE_MAIN_WHOLE = "desktop:rounded-control phone:rounded-[999px]";
const CREATE_CARET =
	"inline-flex cursor-pointer items-center gap-[7px] rounded-r-control phone:rounded-r-[999px] border-none bg-accent p-[7px] text-label font-semibold text-on-accent shadow-[inset_1px_0_0_rgba(0,0,0,0.14)] transition-[background-color,opacity] enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-40";
const CREATE_KBD = "opacity-70";
const CREATE_MENU =
	"absolute bottom-[calc(100%+6px)] right-0 z-20 min-w-[208px] rounded-control bg-popup-glass [backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] p-[5px] smooth-shadow-ring-md";
const CREATE_MENU_ITEM =
	"flex w-full cursor-pointer items-start gap-[9px] rounded-md border-none bg-transparent px-[9px] py-[7px] text-left text-fg transition-colors hover:bg-hover";

/**
 * The same card rendered on the page rather than over a dimmed one: what the
 * empty state shows when there is no session to open yet.
 *
 * Not the palette's glass: `--palette-glass` is mixed to composite over a
 * backdrop, and on the pane's own surface there is little behind it to blur
 * (nothing at all under the mac shell's vibrancy, where the app's layers go
 * transparent). So it takes the composer's lift instead, the tokens for the
 * surface you type into, which is also what the workspace home's first-session
 * composer already wears.
 *
 * The layout half is the palette's and is load-bearing, not decoration: BODY is
 * `min-h-0 flex-1` and only scrolls inside a bounded column, and the header and
 * footer hairlines are keyed off that scroll. `relative` anchors the dictation
 * HUD; `overflow-hidden` keeps the rows' dividers inside the rounded shell.
 */
const INLINE_CARD = cn(
	"relative flex w-full flex-col overflow-hidden rounded-2xl",
	"max-h-[min(560px,68dvh)]",
	composerBox,
);

/**
 * The repo a fresh palette starts on, for someone who hasn't set a preference.
 *
 * This used to be stickiness: whatever you picked last was silently pinned as
 * your default. That reading can't coexist with Auto — pick a repo once and
 * Auto would never be your default again — so the sticky value is carried over
 * into the real preference ONCE and the key retired. Someone who demonstrably
 * always worked in one repo keeps landing there; everyone else meets Auto.
 */
function migratedRepoPref(): string {
  const preferred = getDefaultRepoPref();
  if (preferred) return preferred;
  try {
    const sticky = localStorage.getItem(LAST_REPO_KEY);
    if (!sticky) return "";
    setDefaultRepoPref(sticky);
    localStorage.removeItem(LAST_REPO_KEY);
    return sticky;
  } catch {
    return "";
  }
}

// The repo the sidebar is currently filtered to (persisted by Sidebar.tsx under
// this key). When set to a real repo, a new session should default to it so
// creating from a repo-filtered view lands on that repo.
function filteredRepo(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem("opensession-sidebar-filter") || "{}");
    return typeof v.repo === "string" ? v.repo : null;
  } catch {
    return null;
  }
}

/** Deep-link prefill: <base>/new?mode=ask|code&prompt=…&branch=…&repo= */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  // An explicit ?repo= wins (legacy ?project= still honored); otherwise keep
  // the user's last picker choice across closes/reloads, then use the sidebar
  // filter. The configured default is applied once `/repos` resolves.
  const repoParam = params.get("repo") ?? params.get("project");
  const mode = params.get("mode") === "ask" ? ("ask" as const) : ("code" as const);
  // `?repo=none` is honored in either mode: Ask with no repo reads nothing,
  // Code with no repo is a scratch session. Ask defaults to no repo, matching
  // the toggle — otherwise an Ask deep link would silently inherit whichever
  // repo the last code session used.
  const repo =
    repoParam ||
    (mode === "ask" ? NO_REPO : migratedRepoPref() || filteredRepo() || "");
  return {
    mode,
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    repo,
  };
}

/** The workspace name a draft auto-follows: the prompt's first non-empty
 *  line, trimmed and capped. Mirrors the server's own follow in
 *  updateWorkspace (workspaces.ts). */
function firstNonEmptyLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** Fallback branch name from the prompt when Haiku's auto-suggest hasn't landed. */
function slugifyBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "new-session";
}

export function NewSession({ onBack, inline, focusSeq, send, addHandler, connected, prefillPrompt, initialMcpServers, forceMode, workspaceId, modelWorkspaceId, forceRepo, forceBranch, onCreateStarted, onDraftSaved }: Props) {
  const [prefill] = useState(readPrefill);
  // What the session may do, and nothing else — the footer's Ask toggle. The
  // repo is a separate axis, so Scratch is not a third value here: it is what
  // Code with no repo already is (same write access, same repo-less scratch
  // dir), and `mode` below derives it rather than asking anyone to pick it.
  const [permissionState, setPermissionState] = useState<"ask" | "code">(
    (forceMode || prefill.mode) === "ask" ? "ask" : "code",
  );
  const permission = forceMode === "ask" ? "ask" : permissionState;
  // In a workspace, default to its shared repo; else the prefill/filter repo.
  // `forceMode: "scratch"` (a feed workspace) is a repo-less create, so it
  // arrives here as the repo rather than as a mode.
  const [repo, setRepo] = useState(
    forceMode === "scratch" ? NO_REPO : forceRepo || prefill.repo,
  );
  /**
   * Repos the session works in BESIDES `repo`, in the order they were added
   * (the picker's ⌘-click). Each becomes an attached worktree on the session's
   * branch, so the agent can read and edit across them from its first turn.
   * Only a Code session with a repo can carry them — see `canAddRepos`.
   */
  const [extraRepos, setExtraRepos] = useState<string[]>([]);
  /**
   * Flipping Ask moves the repo with it: Ask means "no repo" unless you go and
   * pick one, and Code goes back to the repo you were last working in. Most
   * asking is not about a checkout, and the pair that stayed pointed at a repo
   * you had chosen for a code session read as Ask silently inheriting it.
   *
   * A palette scoped to a workspace (`forceRepo`) is exempt: there the repo is
   * the whole point of the create, so Ask stays on it.
   */
  function togglePermission() {
    const next = permission === "ask" ? "code" : "ask";
    setPermissionState(next);
    // An Ask session reads one pinned checkout and cuts no worktree, so it has
    // nowhere to put a second repo. Drop them on the way in rather than
    // carrying a selection the create would have to refuse.
    if (next === "ask") setExtraRepos([]);
    if (forceRepo) return;
    if (next === "ask") setRepo(NO_REPO);
    else if (repo === NO_REPO)
      setRepo(migratedRepoPref() || configuredDefaultRepo || AUTO_REPO);
  }

  // The three modes the server stores, from the two axes above. Ask reads (a
  // repo, or nothing); Code writes, on a branch when it has a repo and in a
  // plain scratch dir when it doesn't.
  const mode: "ask" | "code" | "scratch" =
    permission === "ask" ? "ask" : repo === NO_REPO ? "scratch" : "code";
  // A second repo is an isolated worktree on this session's branch, which only
  // a Code session with a repo has. Ask reads one pinned checkout and Scratch
  // has no checkout at all, so neither can carry one.
  const canAddRepos = mode === "code";
  const [repos, setRepos] = useState<RepoOption[]>([]);
  const [configuredDefaultRepo, setConfiguredDefaultRepo] = useState("");
  useEffect(() => {
    let live = true;
    fetchRepos().then((items) => {
      if (!live) return;
      const options: RepoOption[] = items.map((item) => ({
        id: item.id,
        label: item.label || item.id,
        default: item.default,
        sharedCheckout: item.sharedCheckout,
      }));
      setRepos(options);
      // The workspace's configured choice (which may itself be Auto) is what a
      // user with no preference of their own starts on; the repo flagged
      // `default` is only the last resort behind it.
      const workspaceChoice = configuredNewSessionRepo();
      setConfiguredDefaultRepo(
        (workspaceChoice === AUTO_REPO || options.some((i) => i.id === workspaceChoice)
          ? workspaceChoice
          : "") ||
          options.find((item) => item.default)?.id ||
          AUTO_REPO,
      );
    }).catch(() => {
      if (!live) return;
      setRepos([]);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
	setRepo((current) => {
      // "No repo" is a real choice, not an unresolved id — without this it
      // fails the `repos.some(...)` membership test below and gets replaced by
      // the configured default the moment /repos lands.
      // "No repo" and "Auto" are real choices, not unresolved ids: neither is
      // in `repos`, so without this both lose to the configured default the
      // moment /repos lands.
      if (forceRepo === NO_REPO || current === NO_REPO) return current;
      if (current === AUTO_REPO) return current;
      if (forceRepo && repos.some((item) => item.id === forceRepo)) return forceRepo;
      if (repos.some((item) => item.id === current)) return current;
      return configuredDefaultRepo;
    });
  }, [configuredDefaultRepo, forceRepo, repos]);
  /**
   * What Auto made of the prompt. Resolved on the same beat the branch name is
   * (once typing has stopped), because it reads what the draft SAYS.
   *
   * It lands late — a classification runs ~13s — so this is a fill-in, never a
   * gate: the picker shows "Auto" immediately and names the repo when it
   * knows. A Create that beats it doesn't wait either; it hands the same
   * decision to the server (AUTO_REPO), which resolves it before cutting
   * anything.
   */
  const [autoResolved, setAutoResolved] = useState<RepoSuggestion | null>(null);
  const [autoResolving, setAutoResolving] = useState(false);
  // Keyed on the exact text it answered for: an edited prompt invalidates the
  // answer rather than quietly attaching the previous one's repo.
  const autoAnsweredFor = useRef("");
  const autoSeqRef = useRef(0);
  const registeredDefaultRepo =
    repos.find((item) => item.default)?.id || repos[0]?.id || "";
  const autoResolvedRepo =
    autoResolved?.repo ||
    (autoResolved && permission !== "ask" ? registeredDefaultRepo : "");
  /**
   * The repo the REST of the palette acts on. Auto is a picker value, not a
   * checkout: the branch picker, the prompt's repo context and the create all
   * want the repo it resolved to, and nothing at all until it has.
   */
  const effectiveRepo = repo === AUTO_REPO ? autoResolvedRepo : repo;

  /** A repo's picker label, falling back to its id before `/repos` lands. */
  const repoOptionLabel = (id: string) =>
    repos.find((item) => item.id === id)?.label || id;
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // In a workspace, default to a sibling's branch so the new session reuses its
  // worktree; the user can still switch to "New branch" to fork a fresh one.
  const [selectedWorktree, setSelectedWorktree] = useState(forceBranch || "__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  // An explicit prefill (Home hand-off, deep link) wins; otherwise restore the
  // stored draft so closing the palette / navigating away doesn't lose a
  // half-written task. Cleared on session_created.
  //
  // The draft itself belongs to NewSessionPrompt rather than to this component,
  // because typing must not re-render the palette around it. What stays here is
  // only what the palette reads: the current text in a ref, for the moment a
  // create is submitted; whether there is any text, which is the Create
  // button's gate; and the text once typing stops, which is what the branch
  // name is suggested from.
  const [initialPrompt] = useState(
    () => prefillPrompt || prefill.prompt || loadDraft(DRAFT_KEY).text,
  );
  const promptText = useRef(initialPrompt);
  const promptHandle = useRef<NewSessionPromptHandle | null>(null);
  const [hasPromptText, setHasPromptText] = useState(() =>
    /\S/.test(initialPrompt),
  );
  const [settledPrompt, setSettledPrompt] = useState(initialPrompt);
  const [mentionOpen, setMentionOpen] = useState(false);
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  // Attachments live in the draft store, and this is its mirror. Staging a
  // file outlives the palette (lib/attachments.ts), so the store is what an
  // upload writes to and what a reopened palette reads back; keeping a second
  // copy authoritative here is what used to lose a screenshot pasted just
  // before the card closed.
  const [images, setImages] = useState<string[]>(() => loadDraft(DRAFT_KEY).images);
  const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft(DRAFT_KEY).files);
  const [staging, setStaging] = useState<StagingCount>(NOTHING_STAGING);
  const adoptDraftAttachments = useCallback(() => {
    const stored = loadDraft(DRAFT_KEY);
    setImages((prev) => (sameImages(prev, stored.images) ? prev : stored.images));
    setFiles((prev) => (sameFiles(prev, stored.files) ? prev : stored.files));
  }, []);
  // An upload that lands while this palette is open belongs on screen even
  // though it was staged by the instance that closed: the store fires on an
  // attachment change for exactly this.
  useEffect(() => onDraftsChanged(adoptDraftAttachments), [adoptDraftAttachments]);
  // One status for both completion protocols: "savingDraft" resolves through a
  // promise, "creating" waits for a WebSocket message, and "failed" carries the
  // message either of them ended on. A single boolean could not say which
  // protocol was running, and had no terminal state for a create whose answer
  // never arrives.
  const [status, setStatus] = useState<CreateStatus>({ kind: "idle" });
  const busy = status.kind === "creating" || status.kind === "savingDraft";
  // Which edges of the prompt have content beyond them, and so earn a hairline.
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  // Footer controls from the palette design. effort is persisted on the new
  // session and enforced per run (Claude effort / Codex modelReasoningEffort).
  const [effort, setEffort] = useState("high");
  // Pinned provider account for the new session ("" = auto pool pick).
  // Soft pin: the runner prefers it and falls back on exhaustion. Only
  // meaningful for Anthropic/OpenAI subscription-backed models.
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<ProviderAccountOption[]>([]);
  useEffect(() => {
    fetchProviderAccounts().then(setAccounts).catch(() => {});
  }, []);
  const effectiveNewModel = model || defaultModel;
  const accountProvider = models.find(
    (item) => item.id === baseModelId(effectiveNewModel),
  )?.accountProvider;
  // A pin belongs to one provider pool. Drop it when the selected model moves
  // to another family so an opaque id is never reinterpreted.
  useEffect(() => {
    const account = accounts.find((item) => item.id === accountId);
    if (accountId && account?.provider !== accountProvider) setAccountId("");
  }, [accountProvider, accountId, accounts]);
  // What a create does with the view behind the palette. Chosen from the
  // Create split-button's dropdown; the primary button reflects the choice.
  const [chosenCreateAction, setCreateAction] = useState<CreateAction>("open");
  // Inline there is no view behind the card: "background" would leave you on an
  // empty page and "more" is what the card already does, so a create opens the
  // session it just made. The caret that picks between them is hidden too.
  const createAction: CreateAction = inline ? "open" : chosenCreateAction;
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createSplitRef = useRef<HTMLDivElement>(null);
  const isPhone = useIsPhone();
  // "Send messages with" (Settings → Preferences). The session composer honors it,
  // so this field has to as well — otherwise Enter silently does nothing here
  // while the Create button advertises ↩.
  // Resolved per client: a soft keyboard keeps ↩ for newlines (effectiveSendKey).
  const [storedSendKey, setStoredSendKey] = useState(getSendKeyPref);
  useEffect(
    () => onSendKeyChanged(() => setStoredSendKey(getSendKeyPref())),
    [],
  );
  const sendKey = effectiveSendKey(storedSendKey);
  const attachKeys = useShortcutKeys("composer-attach");

  // Sandbox provider picker: the complete model engine + workspace run in the
  // selected environment; native Codex is the sole host-only family.
  // "" = This machine (host, no sandbox); otherwise an explicit provider id
  // sent as the create's `sandbox` string. Options come from
  // /api/sandbox/status (fetched once when the palette opens) — only
  // configured providers are offered, and the whole control hides when the
  // server has no sandbox config or the kill switch is on.
  const [sandboxProvider, setSandboxProvider] = useState("");
  const [sandboxStatus, setSandboxStatus] = useState<SandboxStatusInfo | null>(null);
  const sandboxSelectionTouched = useRef(false);
  useEffect(() => {
    fetchSandboxStatus(getCurrentUser())
      .then((status) => {
        setSandboxStatus(status);
		// This machine remains the clear default. Sandbox configuration belongs
		// behind the explicit Sandbox choice, never in an invisible default.
		if (!sandboxSelectionTouched.current) setSandboxProvider("");
      })
      .catch(() => {});
  }, []);
  const sandboxChoices = sandboxStatus?.connections?.length
    ? sandboxStatus.connections
        .filter((connection) => connection.state === "ready")
        .map((connection) => ({ id: connection.provider, note: undefined as string | undefined }))
    : (sandboxStatus?.providers || []).filter((p) => p.configured && p.certified);
  const selectedSandboxAvailable =
    !sandboxProvider || sandboxChoices.some((choice) => choice.id === sandboxProvider);
  const visibleSandboxChoices =
    sandboxProvider && !selectedSandboxAvailable
      ? [
          {
            id: sandboxProvider,
					note: "Unavailable. Choose This machine or a ready Sandbox before creating.",
          },
          ...sandboxChoices,
        ]
      : sandboxChoices;
  const showSandboxPicker = !!sandboxStatus;
  const sandboxLabel = (id: string) =>
		id === "" ? "This machine" : id === "docker" ? "Docker" : id === "daytona" ? "Daytona" : id === "e2b" ? "E2B" : id === "box" ? "Box" : id === "modal" ? "Modal" : id === "microvm" ? "Local MicroVM" : id === "lambda-microvm" ? "AWS Lambda MicroVM" : id;

  // Provider-independent family check, driven by the same server list the
  // create path enforces.
  const effectiveModelId = model || defaultModel;
  const effectiveModelProvider = effectiveModelId.startsWith("pi/")
    ? "pi"
    : models.find((m) => m.id === effectiveModelId)?.provider ?? "claude";
  const modelFamily = (sandboxStatus?.modelFamilies || []).find(
    (f) => f.match.provider === effectiveModelProvider,
  );
  const sandboxModelWarning = (() => {
    if (sandboxProvider && !selectedSandboxAvailable) {
		return `${sandboxLabel(sandboxProvider)} is unavailable. Choose This machine or a ready Sandbox.`;
    }
	    if (!sandboxProvider || !modelFamily) return null;
    if (modelFamily.sandboxable) return null;
    return (
		`${modelFamily.label} models can't run in a Sandbox` +
      (modelFamily.hint ? ` · ${modelFamily.hint}` : "") +
      "."
    );
  })();

  // Brain-inside remote/MicroVM sessions all adopt a full-runner prewarm.
  // Strictly fire-and-forget: failure must never surface or block typing.
  const isRemoteSandbox = sandboxProvider === "daytona" || sandboxProvider === "e2b" || sandboxProvider === "box" || sandboxProvider === "modal" || sandboxProvider === "lambda-microvm";
  const shouldPrewarm = isRemoteSandbox || sandboxProvider === "microvm";
  const [sandboxWarmed, setSandboxWarmed] = useState(false);
  const lastPrewarmAtRef = useRef(0);
  useEffect(() => {
    // Provider/repo switch: allow an immediate re-fire for the new key.
    lastPrewarmAtRef.current = 0;
    setSandboxWarmed(false);
  }, [sandboxProvider, repo]);
  useEffect(() => {
    // Whether the prompt has anything in it, not what it says: the throttle
    // below means only the first character of a draft ever fires this.
    if (!shouldPrewarm || !hasPromptText || busy) return;
    if (Date.now() - lastPrewarmAtRef.current < 60_000) return;
    lastPrewarmAtRef.current = Date.now();
    requestSandboxPrewarm(sandboxProvider, repo, getCurrentUser())
      .then((r) => setSandboxWarmed(r.state === "ready"))
      .catch(() => {});
  }, [hasPromptText, shouldPrewarm, sandboxProvider, repo, busy]);

  // An empty selection means every available service; one or more picks narrow
  // the session to those services. Command-menu shortcuts seed this same state
  // so their selection stays visible and removable before Create.
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(
    () => initialMcpServers || [],
  );
  const [availableMcpServers, setAvailableMcpServers] = useState<string[]>([]);
  useEffect(() => {
    fetchToolAccounts()
      .then((c) => {
        setAvailableMcpServers(c.servers.map((s) => s.name));
      })
      .catch(() => {});
  }, []);
  function toggleMcpServer(name: string, on: boolean) {
    setSelectedMcpServers((prev) =>
      on ? [...prev, name] : prev.filter((m) => m !== name),
    );
  }

  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Hidden <input type="file"> driven by the "Add file" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);

  // (The prompt is focused on open by Modal.Content's initialFocus — a mount
  // effect here would run a frame before the dialog's popup exists.)
  //
  // Inline there is no dialog to do it, and the children mount in the same
  // commit, so an ordinary effect is enough. On a phone it waits for an
  // explicit `focusSeq` bump: arriving on a page should not raise the keyboard.
  useEffect(() => {
    if (!inline || (isPhone && !focusSeq)) return;
    promptRef.current?.focus();
  }, [inline, focusSeq, isPhone]);

  // (The prompt's auto-grow, its scroll-fade and the draft store it writes
  // through all live in NewSessionPrompt now, beside the text they read.)

  // Close the Create dropdown on an outside click.
  useEffect(() => {
    if (!createMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (createSplitRef.current && !createSplitRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [createMenuOpen]);

  // Step through the Create options without leaving the prompt: the primary
  // button's label is the feedback, and an open dropdown moves its check. This
  // rides on the dialog rather than on window because Base UI's
  // popup stops keydown propagation before it leaves the card, which is also
  // why it can use a chord the rest of the app is free to bind elsewhere.
  function cycleCreateAction(e: React.KeyboardEvent) {
    if (busy) return;
    if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return;
    const step = e.code === "ArrowDown" ? 1 : e.code === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = CREATE_ACTIONS.indexOf(createAction);
    setCreateAction(
      CREATE_ACTIONS[(at + step + CREATE_ACTIONS.length) % CREATE_ACTIONS.length],
    );
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (!busy && matchesShortcut(e, "composer-attach")) {
      e.preventDefault();
      fileInputRef.current?.click();
      return;
    }
    cycleCreateAction(e);
  }

  useEffect(() => {
		fetchModels(modelWorkspaceId || workspaceId)
      .then(async (m) => {
        setModels(m.models);
        setDefaultModel(m.default);
        // Untouched picker: start on this person's own default model and
        // engine (Settings → Preferences); "" is no preference, which keeps
        // the workspace default.
        const preselect = await resolveNewSessionModel(m);
        setModel((current) => {
          if (current) {
            // Pi-routed ids validate against their base entry (the pi/ prefix
            // is routing, not a listed model).
            return m.models.some((item) => item.id === baseModelId(current))
              ? current
              : "";
          }
          return preselect;
        });
      })
      .catch(() => {});
	}, [modelWorkspaceId, workspaceId]);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  // Inside a workspace, snap back to the shared sibling branch, not "New branch".
  useEffect(() => {
    setSelectedWorktree(forceBranch || "__new__");
    if (!effectiveRepo || effectiveRepo === NO_REPO) {
      setWorktrees([]);
      return;
    }
    fetchWorktrees(effectiveRepo)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [effectiveRepo, forceBranch]);

  // Auto-suggest a branch name from the prompt (a Haiku call, once typing has
  // stopped), but only while the field is "ours" — once the user types in it
  // (branchEdited) we back off. The latest-request guard drops a stale response
  // if the user starts editing the branch while a suggestion is in flight.
  //
  // The wait for typing to stop is the prompt field's, not this component's:
  // this is the one thing here that reads what the draft SAYS, so it is handed
  // the text once it has held still rather than on every character.
  const branchEditedRef = useRef(branchEdited);
  branchEditedRef.current = branchEdited;
  const suggestSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== "code" || selectedWorktree !== "__new__" || branchEdited) return;
    if (settledPrompt.trim().length < 10) return;
    const seq = ++suggestSeqRef.current;
    void (async () => {
      const branch = await suggestBranch(settledPrompt.trim());
      // Drop if superseded by a newer prompt or the user grabbed the field.
      if (seq !== suggestSeqRef.current || branchEditedRef.current) return;
      if (branch) setNewBranch(branch);
    })();
  }, [settledPrompt, mode, selectedWorktree, branchEdited]);

  useEffect(() => {
    if (repo !== AUTO_REPO) {
      setAutoResolved(null);
      setAutoResolving(false);
      autoAnsweredFor.current = "";
      return;
    }
    const text = settledPrompt.trim();
    if (text.length < 10 || text === autoAnsweredFor.current) return;
    const seq = ++autoSeqRef.current;
    setAutoResolving(true);
    void (async () => {
      const suggestion = await suggestRepos(text, permission === "ask" ? "ask" : "code");
      // Superseded by a newer prompt, or the picker moved off Auto while we
      // were out — either way this answer is for a question nobody asked.
      if (seq !== autoSeqRef.current) return;
      autoAnsweredFor.current = text;
      setAutoResolved(suggestion);
      setAutoResolving(false);
    })();
  }, [repo, settledPrompt, permission]);

  // Registered from mount and gated on a ref set synchronously in handleCreate:
  // session_created is announced before the worktree even boots, so it can
  // arrive before a `creating`-gated effect would have registered this handler
  // — the palette would miss it (stuck on "creating", draft never cleared).
  // It stays armed until a terminal message arrives, which is deliberately not
  // the same as status.kind === "creating": a create that lost its socket shows
  // "failed" while this stays true, so a late session_created still clears the
  // draft instead of leaving the prompt behind for a session that does exist.
  const creatingRef = useRef(false);
  // A successful create replaces the surface behind this dialog. Returning
  // focus to the now-removed opener makes Base UI advance to the new session's
  // "+" button, so Enter immediately creates another session. Cancelling still
  // restores focus normally.
  const createdRef = useRef(false);
  useEffect(() => {
    return addHandler((msg) => {
      if (!creatingRef.current) return;
      if (msg.type === "error") {
        creatingRef.current = false;
        setStatus({ kind: "failed", message: msg.message });
      } else if (msg.type === "session_created") {
        creatingRef.current = false;
        // The prompt was consumed — drop the stored draft either way, and the
        // field's pending write with it: the draft is written on a debounce, so
        // a write still in flight would land after this and restore the prompt
        // for a session that already has it (a "Create" closes the palette, and
        // the field flushes on the way out).
        promptHandle.current?.dropPendingDraftWrite();
        // Same reasoning for a file still on its way to disk: it belongs to
        // the prompt that just went out, so it must not write itself back
        // into the draft this is clearing.
        dropStagingAttachments(DRAFT_KEY);
        clearDraft(DRAFT_KEY);
        // "Create more" stays in the palette and resets for the next task (App
        // still navigates into the created session behind the overlay). The
        // other two close it: "Create" lets App drop us into the new session,
        // "Create in background" leaves the view we came from in place.
        //
        // Inline takes the same reset: App navigates into the session, which
        // unmounts this card. If anything ever kept it mounted, what is left
        // behind should be an empty prompt rather than the one just sent.
        if (createAction === "more" || inline) {
          setStatus({ kind: "idle" });
          promptHandle.current?.setText("");
          setImages([]);
          setFiles([]);
          setNewBranch("");
          setBranchEdited(false);
          promptRef.current?.focus();
        } else {
          // Only an "open" create replaces the surface behind the palette, so
          // only it declines to restore focus. In the background it is the
          // opener you pressed that you are returning to.
          createdRef.current = createAction === "open";
          onBack();
        }
      }
    });
  }, [addHandler, createAction, inline]);

  // The create's only completion signal is a message on this socket, so a drop
  // between the send and session_created is a wait that can never end. Without
  // this the card sits on "Creating…" with Create and the options caret both
  // disabled and the draft still parked, and only a reload gets out.
  useEffect(() => {
    if (connected || status.kind !== "creating") return;
    setStatus({
      kind: "failed",
      message:
        "Lost the connection before the session started. It may still have been created, so check Sessions before trying again.",
    });
  }, [connected, status.kind]);

  async function addAttachments(picked: FileList | File[]) {
    const staging = countStaging(picked);
    setStaging((current) => addStaging(current, staging));
    try {
      // The staging commits to the draft store itself, so a screenshot pasted
      // while the app is still loading survives this palette closing before
      // its upload lands. Adopt the store rather than the result: it is the
      // one place that has both these files and anything else that arrived.
      const { rejected } = await attachToDraft(DRAFT_KEY, picked);
      adoptDraftAttachments();
      if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
    } finally {
      setStaging((current) => subtractStaging(current, staging));
    }
  }

  // "Save as draft" doesn't start a session at all: it parks the prompt on a
  // workspace (a fresh one, or the one this palette is already scoped to) and
  // never sends create_session. Separate from handleCreate's session_created
  // wait below, which this action never triggers.
  async function saveAsDraft() {
    const text = promptText.current.trim();
    if (!text) return;
    setStatus({ kind: "savingDraft" });
    try {
      const draft = { text, updatedAt: new Date().toISOString(), by: getCurrentUser() };
      const ws = workspaceId
        ? // Scoped to an existing workspace: update its draft, never rename it.
          await updateWorkspaceApi(workspaceId, { draft })
        : await createWorkspaceApi({
            name: firstNonEmptyLine(text).slice(0, 80) || "Draft",
            ...(repo && repo !== NO_REPO ? { repo } : {}),
            draft: { ...draft, autoName: true },
          });
      // Same as a create: the text now lives on the workspace, so the field's
      // pending write must not put it back in the palette's draft.
      promptHandle.current?.dropPendingDraftWrite();
      // Only the text travels: a workspace draft has nowhere to keep a file.
      // So the attachments stay in the palette's own draft rather than being
      // cleared with it — parking a prompt should not quietly destroy the
      // screenshot that was attached to it.
      saveDraft(DRAFT_KEY, { text: "" });
      setStatus({ kind: "idle" });
      window.dispatchEvent(new Event("opensession:workspaces-changed"));
      onDraftSaved?.(ws);
    } catch (e) {
      setStatus({
        kind: "failed",
        message: e instanceof ApiError ? e.message : "Couldn't save the draft",
      });
    }
  }

  function handleCreate() {
    if (!canCreate) return;
    if (createAction === "draft") {
      void saveAsDraft();
      return;
    }
    const prompt = promptText.current.trim();
    // The preview only applies to the exact prompt it answered. If it is still
    // choosing (or the text changed), send the sentinel: the server starts in
    // the normal fallback immediately and lets the session move itself later.
    const resolvedAuto =
      repo === AUTO_REPO && autoAnsweredFor.current === prompt ? autoResolved : null;
    const createRepo =
      repo === AUTO_REPO
        ? resolvedAuto?.repo ||
          (resolvedAuto
            ? permission === "ask"
              ? NO_REPO
              : registeredDefaultRepo || AUTO_REPO
            : AUTO_REPO)
        : repo;
    // An unresolved Auto preview may leave a worktree selected from the prior
    // answer. Start a fresh branch in the fallback repo instead of reusing it.
    const branch =
      createRepo === AUTO_REPO
        ? slugifyBranch(prompt)
        : selectedWorktree === "__new__"
          ? newBranch.trim() || slugifyBranch(prompt)
          : selectedWorktree;
    const attachRepos =
      repo === AUTO_REPO
        ? resolvedAuto?.extras ?? []
        : extraRepos.filter((id) => id !== createRepo);
    const createMode = mode;

    // With "Create more" off, App tears down the palette when the
    // session_created event arrives (and drops us into the new session).
    setStatus({ kind: "creating" });
    creatingRef.current = true;
    // Workspace linkage: scoped to an existing workspace (the tab/sidebar +),
    // the session joins it — sharing its worktree when reusing the sibling branch,
    // stacking a fresh worktree off it for a new branch. Unscoped, the default
    // is a brand-new Workspace + first Session created together.
    const worktreeMode =
      createMode === "ask"
        ? "ask"
        : createMode === "code" && selectedWorktree === "__new__"
          ? "stack"
          : "share";
    onCreateStarted?.({
      prompt,
      mode: createMode,
      // The optimistic shell is replaced once the persisted record lands.
      // Prefer Auto's preview, then the registered default, but never expose
      // the sentinel as though it were a repository id.
      repo:
        createRepo === AUTO_REPO
          ? resolvedAuto?.repo || registeredDefaultRepo
          : createRepo,
      branch: createMode === "code" ? branch : null,
      ...(workspaceId ? { workspaceId } : {}),
      ...(model ? { model } : {}),
      ...(images.length ? { images } : {}),
      // App navigates into a created session by default; this asks it not to.
      ...(createAction === "background" ? { background: true } : {}),
    });
    send({
      type: "create_session",
      mode: createMode,
      repo: createRepo,
      // Repos to work in beside `repo`. The server cuts each an isolated
      // worktree on this session's branch before the first turn runs, so the
      // agent is told about them in the same breath as its own checkout.
      ...(attachRepos.length && (canAddRepos || repo === AUTO_REPO)
        ? { attachRepos }
        : {}),
      ...(workspaceId
        ? { workspaceId: workspaceId, worktreeMode }
        : { createWorkspace: {} }),
      ...(modelWorkspaceId ? { modelWorkspaceId } : {}),
      branch: createMode === "code" ? branch : "",
      prompt,
      user: getCurrentUser(),
      ...(model ? { model } : {}),
      effort,
      ...(accountProvider && accountId ? { accountId } : {}),
      // Once defaults have loaded, Host is an explicit override ("local") —
      // omitting the field would make the server re-apply the user's default.
		...(sandboxStatus ? { sandbox: sandboxProvider || "local" } : {}),
      ...(selectedMcpServers.length ? { mcpServers: selectedMcpServers } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length
        ? {
            files: files.map((f) =>
              f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
            ),
          }
        : {}),
    });
  }

  const canCreate =
    !busy &&
    // An attachment is not attached until its upload lands, and the create
    // reads the list as it stands. Creating a second earlier would send the
    // prompt without the screenshot it is about, silently.
    !isStaging(staging) &&
    // A draft is just the prompt text parked on a workspace: none of the
    // session-create gates (connection, repo, sandbox, branch) apply.
    (createAction === "draft"
      ? hasPromptText
      : connected &&
        // "No repo" is a choice, so it passes; only an unresolved picker (an
        // instance with no repositories registered yet) blocks.
        !!repo &&
        // Unsupported model × environment combo: the server would reject the
        // create with the same message (resolveRequestedSandbox). Block here
        // so the wall is discovered before submit, not after.
        !sandboxModelWarning &&
        (hasPromptText || images.length > 0 || files.length > 0) &&
        (mode === "ask" || mode === "scratch" || selectedWorktree !== ""));

  // "Create from…" picks the base a code session branches off, so it only
  // appears for a Code session that has a repo. Ask cuts no worktree, and Code
  // with no repo has no branch to cut one from.
  const createFromLabel = selectedWorktree === "__new__" ? "New branch" : selectedWorktree;
  const createFromOptions = [
    {
      value: "__new__",
      label: workspaceId && forceBranch
        ? `New stacked branch (off ${forceBranch})`
        : "New branch",
    },
    ...worktrees.map((wt) => ({ value: wt.branch, label: wt.branch })),
  ];

  // Which edges of the prompt earn a hairline. The field measures its own
  // scroller and reports; holding the previous object when nothing moved is
  // what keeps a scroll (or a keystroke) from re-rendering the card.
  function handlePromptEdges(next: { top: boolean; bottom: boolean }) {
    setEdges((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }

  // One frame closed so the palette animates in; App mounts us already-open.
  const open = useEnterOnMount();

  // Ask mode's surface, shared with the session composer so one mode is one
  // strength wherever you meet it. Only the base differs: mixed into
  // `transparent` rather than an opaque colour, because the palette is glass
  // and an opaque tint would paint the blur out.
  const askSurfaceStyle = {
    "--palette-ask-bg": askSurface("transparent"),
  } as React.CSSProperties;

  // The card itself: the same rows whether it floats over the page as a
  // palette or sits on it as the empty state's session input.
  const card = (
    <>
        {/* Header: the Code/Ask switch and the repo (left) · create-from
            (right). Two axes, in the order they're decided: what the session
            may do, then what it is pointed at. Either mode can be pointed at
            nothing — Ask with no repo is a conversation with your tools, Code
            with no repo is a scratch dir. On phones the create-from picker
            stays hidden until the footer's options toggle opens it. */}
        <div className={cn(HEADER, edges.top && EDGE_DIVIDER)}>
          <PaletteSelect
            className={TRIGGER_STRONG}
            title="Repository"
            value={repo}
            options={[
              ...repos.map((p) => ({
                value: p.id,
                label: p.label,
                icon: <RepoTile name={p.id} />,
                // A shared-checkout repo has no isolated worktree to attach,
                // so it can be the session's repo but never a second one.
                singleOnly: p.sharedCheckout,
              })),
              // Either mode can run without a repo, and the Ask toggle in the
              // footer says which one you get: Ask reads nothing, Code writes
              // in a plain scratch dir with no branch or PR flow.
              {
                value: NO_REPO,
                label: "No repo",
                icon: <IconMessage size={20} />,
                singleOnly: true,
              },
              // Last, and on its own: the other rows name a place, this one
              // defers the choice to what you type. It can't be one of several
              // — deciding is the whole of it.
              {
                value: AUTO_REPO,
                label: "Auto",
                icon: <IconSparkle size={20} />,
                singleOnly: true,
              },
            ]}
            onChange={(nextRepo) => {
              setRepo(nextRepo);
              // A plain pick is "work here", not "and here too": it replaces
              // the whole selection, which is what it did before any of this.
              // It does NOT become your default either — that is a setting
              // now (Settings → Preferences), not a thing the picker infers.
              setExtraRepos([]);
            }}
            extraValues={extraRepos}
            onToggleExtra={
              canAddRepos
                ? (id) => {
                    // Adding a repo BESIDE Auto means nothing — there is no
                    // first repo yet to put a second one next to. So on Auto a
                    // modifier-click is just a pick, which is also the only
                    // reading that leaves the picker in a coherent state.
                    if (repo === AUTO_REPO) {
                      setRepo(id);
                      setExtraRepos([]);
                      return;
                    }
                    const next = toggleRepoSelection(
                      { repo, extras: extraRepos },
                      id,
                    );
                    setRepo(next.repo);
                    setExtraRepos(next.extras);
                  }
                : undefined
            }
            multiHint={
              repo === AUTO_REPO
                ? autoResolved?.reason
                  ? `Chose ${autoResolvedRepo ? repoOptionLabel(autoResolvedRepo) : "no repo"} — ${autoResolved.reason}.`
                  : "Picks the repository from what you type."
                : repoSelectionHint(extraRepos, repoOptionLabel, MULTI_MODIFIER)
            }
            // A feed workspace is repo-less by construction (its subject is a
            // Tella video, not a checkout), so its create doesn't offer one.
            disabled={busy || forceMode === "scratch"}
            ariaLabel="Repository"
            isPhone={isPhone}
          >
            {repo === NO_REPO ? (
              <IconMessage className="shrink-0" size={18} />
            ) : repo === AUTO_REPO && !autoResolved?.repo ? (
              <IconSparkle className="shrink-0" size={18} />
            ) : (
              <RepoTile name={effectiveRepo || repo} />
            )}
            <span className="truncate">
              {repo === NO_REPO
                ? "No repo"
                : repo === AUTO_REPO
                  ? // Auto names what it picked as soon as it knows, because
                    // that — not the word "Auto" — is what you need to see
                    // before committing a session to it. Until then it says
                    // what it is doing rather than showing a spinner.
                    autoResolved
                    ? autoResolvedRepo
                      ? repoOptionLabel(autoResolvedRepo)
                      : "No repo"
                    : autoResolving
                      ? "Choosing…"
                      : "Auto"
                  : repoOptionLabel(repo) || repo || "No repositories"}
            </span>
            {repo === AUTO_REPO && autoResolved && (
              <span className="shrink-0 text-label font-medium text-dim">Auto</span>
            )}
            {/* The trigger has room for one repo, so the rest ride as a count —
                the same shorthand the session header's repo pill uses. */}
            {extraRepos.length > 0 && (
              <span
                className="shrink-0 text-label font-medium text-dim"
                title={extraRepos.map(repoOptionLabel).join(", ")}
              >
                +{extraRepos.length}
              </span>
            )}
            {forceMode !== "scratch" && (
              <IconChevronDown className={CHEVRON} size={22} />
            )}
          </PaletteSelect>

          {mode === "code" && (
          <PaletteSelect
            className={TRIGGER}
            title="What to create from"
            value={selectedWorktree}
            options={createFromOptions}
            onChange={setSelectedWorktree}
            disabled={busy}
            ariaLabel="Create from"
            isPhone={isPhone}
            align="end"
          >
            {/* shrink-0 like every other glyph in the header: a long branch
                name squeezes the trigger, and the icon was giving up its width
                before the label gave up characters, leaving a sliver. */}
            <IconNewBranch className="shrink-0" size={19} />
            <span className="truncate">{createFromLabel}</span>
            <IconChevronDown className={CHEVRON} size={22} />
          </PaletteSelect>
          )}
        </div>

        {/* Picked services, above the field like every other thing attached to
            what you are about to send. The picker is two levels inside a menu,
            so without this the only trace of a pick is a count on the overflow
            button, and the pick governs the whole session rather than one
            prompt. The row stays mounted so the last chip can animate out. */}
        <div className="flex flex-wrap items-start gap-x-1 px-4">
          <AnimatePresence initial={false}>
            {selectedMcpServers.map((mcp) => (
              <ComposerContextChip
                key={mcp}
                icon={<IconTile name={mcp} size={15} />}
                label={displayName(mcp)}
                title={`${displayName(mcp)} is on. A session gets only the services you pick here.`}
                onRemove={() => toggleMcpServer(mcp, false)}
                removeLabel={`Remove ${displayName(mcp)}`}
                disabled={busy}
              />
            ))}
          </AnimatePresence>
        </div>

        {/* Prompt. It owns the draft: see NewSessionPrompt for why the text
            does not live in this component. */}
        <NewSessionPrompt
          initialText={initialPrompt}
          textareaRef={promptRef}
          valueRef={promptText}
          handle={promptHandle}
          repo={effectiveRepo}
          mcpServers={selectedMcpServers}
          // Ask sessions read and explain; they never touch the code. Asking
          // "what to work on" in that mode invites a prompt the session
          // cannot carry out.
          placeholder={
            mode === "ask" ? "What do you want to find out?" : "What do you want to work on?"
          }
          disabled={busy}
          images={images}
          files={files}
          staging={staging}
          onRemoveImage={(i) => {
            removeDraftImage(DRAFT_KEY, i);
            adoptDraftAttachments();
          }}
          onRemoveFile={(i) => {
            removeDraftFile(DRAFT_KEY, i);
            adoptDraftAttachments();
          }}
          onAddAttachments={(picked) => void addAttachments(picked)}
          sendKey={sendKey}
          canCreate={canCreate}
          onCreate={handleCreate}
          onHasTextChange={setHasPromptText}
          onDraftSettled={setSettledPrompt}
          onEdgesChange={handlePromptEdges}
          onMentionOpenChange={setMentionOpen}
        />

        {status.kind === "failed" && <div className={ERROR}>{status.message}</div>}
        {sandboxModelWarning && (
          <div className={ERROR} role="alert">
            {sandboxModelWarning}
          </div>
        )}

        {/* Footer toolbar */}
        <div className={cn(FOOTER, edges.bottom && EDGE_DIVIDER)}>
          <div className={FOOTER_LEFT}>
            <Tooltip label="Attach a file" shortcut={attachKeys ?? undefined}>
              <button
                type="button"
                className={FOOTER_ICON_BTN}
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                aria-label="Attach a file"
              >
                <IconPaperclip size={20} />
              </button>
            </Tooltip>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Ask sits with the tools rather than in the header: Code is what
                you are almost always doing, so the header should show what you
                are working on (the repo, the branch) and this is the one
                switch that changes it. Off it is a quiet icon; on it names
                itself and wears the green the card and the composer's Ask pill
                also wear, because read-only running silently is the one state
                worth being loud about. */}
            {!forceMode && (
              <Tooltip
                label={
                  permission === "ask"
                    ? "Ask mode on · reads, changes nothing. Click to write code instead"
                    : "Ask mode · read-only, and no repo unless you pick one"
                }
              >
                <button
                  type="button"
                  className={permission === "ask" ? ASK_BTN_ON : FOOTER_ICON_BTN}
                  onClick={togglePermission}
                  disabled={busy}
                  aria-pressed={permission === "ask"}
                  aria-label="Ask mode"
                >
                  <IconEye size={permission === "ask" ? 14 : 20} />
                  {permission === "ask" && "Ask"}
                </button>
              </Tooltip>
            )}
            {/* Rarely changed execution settings stay one level behind a single
                overflow button. Their current values remain visible in the
                submenu rows, while attachment stays one tap away. */}
            <Menu.Root>
              <Tooltip label="More options">
                <Menu.Trigger
                  type="button"
                  className={cn(
                    FOOTER_ICON_BTN,
						(sandboxProvider || modelEngine(effectiveModelId) !== "opencode" || selectedMcpServers.length > 0) &&
                      paletteIconBtnOn,
                  )}
                  disabled={busy}
                  aria-label="More options"
                >
                  <IconDotsHorizontal size={20} />
                </Menu.Trigger>
              </Tooltip>
              <Menu.Popup
                align="start"
                sideOffset={6}
                className="min-w-[260px] max-w-[min(360px,calc(100vw-1rem))]"
              >
                {showSandboxPicker && (
                  <Menu.SubmenuRoot>
                    <Menu.SubmenuTrigger className="justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <IconBox className="shrink-0 text-dim" size={20} />
                        <span className="truncate">Sandbox</span>
                      </span>
                      <span className="flex flex-none items-center gap-1 text-dim">
                        {sandboxLabel(sandboxProvider)}
                        {sandboxWarmed && shouldPrewarm && (
                          <span className="text-faint">· ready</span>
                        )}
                        <IconChevronRight className="shrink-0 text-faint" size={17} />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Popup className="max-w-[min(340px,calc(100vw-1rem))]">
                      {[{ id: "", note: undefined as string | undefined }, ...visibleSandboxChoices].map(
                        (opt) => {
                          const selected = sandboxProvider === opt.id;
                          return (
                            <Menu.Item
                              key={opt.id || "host"}
                              onClick={() => {
                                sandboxSelectionTouched.current = true;
                                setSandboxProvider(opt.id);
                              }}
                              className="items-start"
                            >
                              <Menu.Check on={selected} className="mt-0.5 text-dim" />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span>
                                  {sandboxLabel(opt.id)}
                                </span>
                                {opt.note && (
                                  <span className="whitespace-normal text-meta font-medium leading-snug text-faint">
                                    {opt.note}
                                  </span>
                                )}
                              </span>
                            </Menu.Item>
                          );
                        },
                      )}
                    </Menu.Popup>
                  </Menu.SubmenuRoot>
                )}
                <Menu.SubmenuRoot>
                  <Menu.SubmenuTrigger className="justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <IconConnections className="shrink-0 text-dim" size={20} />
                      <span className="truncate">Connected services</span>
                    </span>
                    <span className="flex flex-none items-center gap-1 text-dim">
                      {/* Nothing picked is not "none": an empty allowlist means
                          the run gets every service you can see
                          (filterMcpServers, scope "all"), so the readout says
                          so rather than promising a session with no tools. */}
                      {selectedMcpServers.length ? `${selectedMcpServers.length} on` : "All"}
                      <IconChevronRight className="shrink-0 text-faint" size={17} />
                    </span>
                  </Menu.SubmenuTrigger>
                  <Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
                    {availableMcpServers.length > 0 && (
                      <div className="max-w-[300px] px-2 pb-1 text-meta font-medium leading-snug text-faint">
                        Picked services are the only ones the session gets.
                      </div>
                    )}
                    {availableMcpServers.length === 0 && (
                      <Menu.Item disabled className="text-faint">
                        No services available
                      </Menu.Item>
                    )}
                    {availableMcpServers.map((mcp) => {
                      const checked = selectedMcpServers.includes(mcp);
                      return (
                        <Menu.CheckboxItem
                          key={mcp}
                          checked={checked}
                          closeOnClick={false}
                          onCheckedChange={(on) => toggleMcpServer(mcp, on)}
                          className={cn("justify-between gap-3", checked && "bg-hover")}
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            <IconTile name={mcp} size={20} />
                            <span className="min-w-0 truncate">{displayName(mcp)}</span>
                          </span>
                          <Menu.Check on={checked} className="text-dim" />
                        </Menu.CheckboxItem>
                      );
                    })}
                  </Menu.Popup>
                </Menu.SubmenuRoot>
              </Menu.Popup>
            </Menu.Root>
          </div>

          <div className={FOOTER_RIGHT}>
            {/* Always visible — on phones too, so a non-default (dumber) model
                is never silently in effect. */}
            <ModelEffortSelect
              className={MODEL_PILL}
              title="Model and reasoning effort"
              models={models}
              defaultModel={defaultModel}
              model={model}
              onModelChange={setModel}
              effort={effort}
              onEffortChange={setEffort}
              // Account pinning is shown for models backed by a configured
              // Claude or Codex account pool.
              accounts={accountProvider && accounts.length > 0 ? accounts : undefined}
              accountId={accountId}
              onAccountChange={setAccountId}
              disabled={busy}
            />
            <VoiceInput
              className={FOOTER_ICON_BTN}
              disabled={busy}
              onText={(t) => {
                promptHandle.current?.appendText(t);
                promptRef.current?.focus();
              }}
            />

            <div className={CREATE_SPLIT} ref={createSplitRef}>
              <button
                className={cn(
                  CREATE_MAIN,
                  inline ? CREATE_MAIN_WHOLE : CREATE_MAIN_SPLIT,
                )}
                onClick={handleCreate}
                disabled={!canCreate}
              >
                {status.kind === "savingDraft"
                  ? "Saving…"
                  : status.kind === "creating"
                    ? "Creating…"
                    : isStaging(staging)
                      ? "Attaching…"
                      : CREATE_LABELS[createAction]}
                {/* The hint has to match the preference — a bare ↩ next to a
                    field that only creates on ⌘↩ is what made Enter look
                    broken in the first place. */}
                {sendKey === "mod-enter" ? (
                  <span className={`${CREATE_KBD} mx-0 phone:hidden text-xs`}>
                    {MOD_ENTER_GLYPH}
                  </span>
                ) : (
                  /* Snug the return glyph up to the label and nudge it off the
                     button edge. "Create more" is a desktop workflow, so the
                     hint goes away with the caret on phones. */
                  <IconReturn
                    className={`${CREATE_KBD} -mx-[3px] phone:hidden`}
                    size={20}
                  />
                )}
              </button>
              {/* The tooltip is where the cycle shortcut is taught: the caret
                  is the only thing on screen that says these options exist.
                  Inline there are no options to pick between, so the button is
                  whole and the caret is gone. */}
              {!inline && (
              <Tooltip label="Create options" shortcut={CYCLE_SHORTCUT}>
              <button
                type="button"
                className={CREATE_CARET}
                onClick={() => setCreateMenuOpen((v) => !v)}
                // Not having a prompt yet leaves the caret alone: the options
                // are still worth reading, and picking one is how you change
                // what Enter will do. A create in flight is the one thing that
                // closes it off, and then it greys out with the main button
                // beside it, so the pair still reads as one busy control. An
                // attachment on its way to disk holds the same pair the same
                // way, for the second or two it takes.
                disabled={busy || isStaging(staging)}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-label="Create options"
              >
                <IconChevronDown
                  className={`transition-transform ${createMenuOpen ? "rotate-180" : ""}`}
                  size={22}
                />
              </button>
              </Tooltip>
              )}
              {!inline && createMenuOpen && (
                <div className={CREATE_MENU} role="menu">
                  {[
                    { action: "open" as const, title: "Create", desc: "Open the new session" },
                    {
                      action: "background" as const,
                      title: "Create in background",
                      desc: "Stay where you are",
                    },
                    { action: "more" as const, title: "Create more", desc: "Stay here to start another" },
                    {
                      action: "draft" as const,
                      title: "Save as draft",
                      desc: "Keeps the prompt in the sidebar. Nothing runs yet.",
                    },
                  ].map((opt) => (
                    <button
                      key={opt.action}
                      type="button"
                      role="menuitemradio"
                      aria-checked={createAction === opt.action}
                      className={CREATE_MENU_ITEM}
                      onClick={() => {
                        setCreateAction(opt.action);
                        setCreateMenuOpen(false);
                      }}
                    >
                      <Menu.Check
                        on={createAction === opt.action}
                        size={22}
                        className="mt-px text-dim"
                      />
                      <span className="flex min-w-0 flex-col gap-px">
                        <span className="text-label font-semibold">{opt.title}</span>
                        <span className="text-meta text-dim">{opt.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
    </>
  );

  if (inline) {
    return (
      <div
        className={cn(
          INLINE_CARD,
          ASK_SURFACE,
          mode === "ask" && "before:opacity-100 after:opacity-100",
        )}
        style={askSurfaceStyle}
        role="group"
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
      >
        {card}
      </div>
    );
  }

  return (
    <Modal.Root
      open={open}
      // Escape and outside presses both land here. App's global Esc-closes-a-
      // palette shortcut can't double-fire: Base UI stops the keydown before it
      // reaches window, so this is the only close (which matters, because
      // closePalette also pops a /new deep link off history).
      onOpenChange={(next) => {
        if (!next) onBack();
      }}
      // Focus is trapped, but the page is neither inerted nor scroll-locked: the
      // "@"-mention popup portals to <body>, and inerting would leave it dead.
      modal="trap-focus"
      // Mid-create the palette isn't dismissable. An open mention popup also
      // owns the next click: it lives outside the dialog, so pressing it would
      // otherwise read as an outside press and close the whole palette.
      disablePointerDismissal={busy || mentionOpen}
    >
      <Modal.Content
        variant="palette"
        className={cn(
          "max-h-[calc(89dvh-1rem)] max-[560px]:max-h-[calc(93dvh-1rem)]",
          ASK_SURFACE,
          mode === "ask" && "before:opacity-100 after:opacity-100",
        )}
        style={askSurfaceStyle}
        aria-label="New session"
        onKeyDown={handleCardKeyDown}
        // The prompt, not the repo picker Base UI would otherwise land on as the
        // first tabbable.
        initialFocus={promptRef}
        finalFocus={() => !createdRef.current}
      >
        {card}
      </Modal.Content>
    </Modal.Root>
  );
}
