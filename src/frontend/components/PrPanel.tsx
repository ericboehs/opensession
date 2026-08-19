import { repoLabel } from "../lib/repo-label";
import { AGENT_NAME } from "../lib/brand";
import React, {
  useEffect,
  useState,
  useCallback,
  useId,
  useMemo,
  useRef,
} from "react";
import { motion } from "motion/react";
import { duration, ease } from "../ui/motion";
import type {
  GitStatusInfo,
  DiffFileGroup,
  PrCheck,
  PrDetails,
  CodeFlowResult,
  SessionWalkthrough,
  UnifiedSession,
  WSServerMessage,
} from "../lib/types";
import { PrSessionsList, prRelatedSessions } from "./PrSessions";
import { WalkthroughCard } from "./WalkthroughCard";
import {
  API_BASE,
  fetchPr,
  fetchPrDiff,
  fetchPrCodeFlow,
  fetchPrDiffGroups,
  fetchPrViewedFiles,
  fetchPrFile,
  setPrFileViewed,
  fetchGitStatus,
  fetchReviewGuide,
  fetchWorktreeFile,
  saveWorktreeFile,
  submitPrReviewApi,
  mergePrApi,
  closePrApi,
  unlinkPrApi,
} from "../lib/api";
import {
  fetchPrPreview,
  fetchPrPreviewDiff,
  fetchPrPreviewCodeFlow,
  fetchPrPreviewGuide,
  submitPrPreviewReviewApi,
  mergePrPreviewApi,
  closePrPreviewApi,
} from "../lib/api";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toast } from "../ui/toast";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  CommentableDiff,
  type CommentTarget,
  type PendingComment,
} from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { renderPrCommentMarkdown } from "../lib/markdown";
import { useMarkdownRepo } from "./MarkdownBody";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import {
  dedupeTargets,
  matchFocusTarget,
  type PrFocus,
  type PrTarget,
} from "../lib/pr-focus";
import { providerFromUrl, prCapabilities } from "../lib/provider";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { Textarea } from "../ui/input";
import {
  IconArrowDown,
  IconArrowUp,
  IconBranches,
  IconChevronRight,
  IconCopy,
  IconDiffSplit,
  IconDiffUnified,
  IconDotsHorizontal,
  IconFile,
  IconGitMerge,
  IconGlobe,
  IconListCircles,
  IconSliders,
  IconX,
} from "./icons";
import { Menu, MENU_ICON } from "../ui/menu";
import { Modal, useEnterOnMount } from "../ui/modal";
import { Tooltip } from "../ui/tooltip";
import { Popover } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Segmented, SegmentedOption } from "../ui/segmented";
import { OptionSelect } from "../ui/select";

import { checkClass, isDeployment, summarize } from "../lib/pr-status-derive";
import { prStatusMark } from "../lib/pr-status";
import {
  PR_REPO_TAB_X,
  PR_REPO_TABS,
  prRepoTabClass,
} from "../lib/pr-tone-classes";
import { formatPrCommentPrompt, stripHtmlComments } from "../lib/pr-prompts";
import { CheckRow } from "./pr/CheckRow";
import { PrStateIcon } from "./pr/PrStateIcon";
import { ConversationView } from "./pr/PrViews";
import { LinkPrControl } from "./pr/LinkPrControl";
import { PrCard } from "./pr/PrCard";
import { StackSection } from "./pr/Stack";
import { ReviewRail } from "./pr/ReviewRail";
import { GitStatusRows } from "./pr/GitStatus";
import { InlineAlert, LoadingState } from "../ui/state";
import { CodeFlow } from "./CodeFlow";
import { revealDiffFile } from "../lib/diff-navigation";
import { PrFileTree } from "./pr/PrFileTree";
import { reviewDiffLoadPolicy } from "../lib/review-diff";
import { BrandMark } from "./BrandTile";
import { useCopy } from "../ui/copy";

// Re-exported so existing importers of these (formerly local) helpers keep working.
export {
  checkClass,
  isDeployment,
  formatPrCommentPrompt,
  CheckRow,
  PrStateIcon,
};

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** The lenses the code page can be read through, in menu order. */
const CODE_VIEWS = {
  all: { label: "All changes", Icon: IconFile },
  guide: { label: "Review guide", Icon: IconListCircles },
  flow: { label: "Code flow", Icon: IconBranches },
} as const;
type CodeView = keyof typeof CODE_VIEWS;

const NO_PR_FILES: NonNullable<PrDetails["files"]> = [];

function useStoredCodeSetting<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key) as T | null;
    return stored && allowed.includes(stored) ? stored : fallback;
  });
  const change = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {}
    },
    [key],
  );
  return [value, change];
}

interface Props {
  sessionId: string;
  /** When provided, the review action bar offers "Open workspace" (Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /**
   * Repos in this session (primary + attached). Together with `linkedPrs`
   * these form the PR targets; when more than one, a tab bar selects which PR
   * to show. Omit for single-repo callers (e.g. the Reviews drawer) — they
   * target the primary branch as before.
   */
  repos?: Array<{ repo: string; primary: boolean }>;
  /** PRs manually linked to the session (session.linkedPrs) — extra targets. */
  linkedPrs?: LinkedPrEntry[];
  /**
   * PRs the server discovered through the session link in their body footer
   * (`session.prs` entries with source "discovered") — the PRs this session
   * opened on branches it doesn't own. Same tabs as a linked PR, minus the
   * unlink affordance: the link is derived from the PR itself, not stored.
   */
  discoveredPrs?: LinkedPrEntry[];
  /**
   * Preselect one of the targets — the PR chips in the Workspace strip, and
   * `repo#123` mentions in prose, open the Review tab on a specific PR. `seq`
   * is bumped per click so clicking the same chip again re-focuses it after
   * the user has switched tabs by hand. See lib/pr-focus.ts for the matching.
   */
  focusTarget?: PrFocus;
  /** Offer the "Link PR" affordance (session Review tab; off in the Reviews drawer). */
  linkable?: boolean;
  /**
   * WebSocket sender. When provided, selecting text in the PR info column shows a
   * "Send to session" popover that delivers the selection + a message to this PR's
   * session (via a `prompt` message — the server steers/queues if it's busy).
   */
  send?: (msg: any) => void;
  /** Agent-published walkthrough (session.walkthrough) — rendered at the top
   *  of the info column; its mirrored section is stripped from the PR body. */
  walkthrough?: SessionWalkthrough;
  /**
   * Allow in-place edit mode (@pierre/diffs edit) on the review canvas's diff.
   * Only meaningful for callers whose session backs the shown PR with a live
   * worktree; carries the same agent-idle gate as the Changes tab (edits and
   * agent writes must not race). Linked/discovered PRs and session-less
   * previews stay read-only regardless.
   */
  editGate?: boolean;
  /** Session-less PR target; uses the same canvas with repo+branch APIs. */
  previewTarget?: { repo: string; branch: string };
  /**
   * Live sessions list. When provided, the panel surfaces every session
   * linked to the shown PR (matched by repo + head branch / number) and — with
   * `send` — offers starting a new session on the PR's head branch.
   */
  sessions?: UnifiedSession[];
  /** Navigate to a session picked from the linked-sessions list. */
  onOpenSessionById?: (id: string) => void;
  /** Open another PR in this panel — used by the stack map to move between
   *  layers in-app. Without it the layer rows still link, just via a full
   *  page load. */
  onOpenPr?: (repo: string, branch: string) => void;
  /** WS handler hook — resets the new-session form on server errors. */
  addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
  diffVersion?: string;
  skippedFiles?: number;
}

/** A PR manually linked to the session (mirrors session.linkedPrs entries). */
export interface LinkedPrEntry {
  repo: string;
  branch: string;
  number?: number;
  url?: string;
  title?: string;
}

const NO_LINKED_PRS: LinkedPrEntry[] = [];

/** One narrative section of the AI review guide (mirrors the server shape). */
interface ReviewGuideSection {
  title: string;
  explanation: string;
  files: string[];
}

export interface ReviewGuideData {
  number: number;
  headRefOid: string;
  sections: ReviewGuideSection[];
}

/** Split a unified diff into per-file chunks keyed by the new-side path. */
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of patch.split(/^(?=diff --git )/m)) {
    if (!part.startsWith("diff --git ")) continue;
    const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (m) map.set(m[2], part);
  }
  return map;
}

/**
 * Pair each guide section with the slice of the unified diff covering its
 * files (so inline commenting keeps working inside the guide). Model paths are
 * matched exactly, then by suffix; files no section claimed come back as a
 * trailing "Everything else" section so guide mode never hides part of a PR.
 */
export function sectionsWithPatches(guide: ReviewGuideData, patch: string) {
  const byFile = splitPatchByFile(patch);
  const unclaimed = new Set(byFile.keys());
  // A suffix match can only ever pair two paths that end in the same segment,
  // so bucket the patch's paths by basename once rather than scanning every
  // one of them per section file.
  const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const byBasename = new Map<string, string[]>();
  for (const path of byFile.keys()) {
    const bucket = byBasename.get(basename(path));
    if (bucket) bucket.push(path);
    else byBasename.set(basename(path), [path]);
  }
  const resolve = (file: string): string | null => {
    if (byFile.has(file)) return file;
    for (const path of byBasename.get(basename(file)) ?? [])
      if (path.endsWith(`/${file}`) || file.endsWith(`/${path}`)) return path;
    return null;
  };
  const out = guide.sections.map((s) => {
    const chunks: string[] = [];
    for (const file of s.files) {
      const path = resolve(file);
      if (!path || !unclaimed.has(path)) continue;
      unclaimed.delete(path);
      chunks.push(byFile.get(path)!);
    }
    return { ...s, patch: chunks.join("") };
  });
  if (unclaimed.size > 0)
    out.push({
      title: "Everything else",
      explanation: "Changes the guide didn't group into a section.",
      files: [...unclaimed],
      patch: [...unclaimed].map((f) => byFile.get(f)!).join(""),
    });
  return out;
}

export function PrPanel({
  sessionId,
  onOpenSession,
  onAddToInput,
  repos,
  linkedPrs,
  discoveredPrs,
  focusTarget,
  linkable,
  send,
  walkthrough,
  editGate,
  previewTarget,
  sessions,
  onOpenSessionById,
  onOpenPr,
  addHandler,
}: Props) {
  // Local copy of the linked-PR list so link/unlink applies instantly; the
  // sessions list catches up on its next refresh.
  const [linkedLocal, setLinkedLocal] = useState<LinkedPrEntry[] | null>(null);
  // One identity for "no linked PRs", or the `targets` memo below re-runs on
  // every render for the (common) session with none.
  const linked = linkedLocal ?? linkedPrs ?? NO_LINKED_PRS;
  const targets = useMemo<PrTarget[]>(
    () =>
      dedupeTargets([
      ...(previewTarget
        ? [
            {
              key: `preview:${previewTarget.repo}:${previewTarget.branch}`,
              repo: previewTarget.repo,
              branch: previewTarget.branch,
              primary: true,
              label: previewTarget.repo,
            },
          ]
        : (repos ?? []).map((r) => ({
            key: r.repo,
            repo: r.repo,
            primary: r.primary,
            label: r.repo,
          }))),
      ...linked.map((lp) => ({
        key: `${lp.repo} ${lp.branch}`,
        repo: lp.repo,
        branch: lp.branch,
        number: lp.number,
        linked: true,
        label: lp.number
          ? `${repoLabel(lp.repo)} #${lp.number}`
          : `${repoLabel(lp.repo)}:${lp.branch}`,
      })),
      // Last, so an explicit link (which owns the unlink affordance) wins the
      // dedupe over the same PR discovered from its body footer.
        ...(previewTarget ? [] : (discoveredPrs ?? [])).map((dp) => ({
        key: `${dp.repo} ${dp.branch}`,
        repo: dp.repo,
        branch: dp.branch,
        number: dp.number,
        discovered: true,
        label: dp.number
          ? `${repoLabel(dp.repo)} #${dp.number}`
          : `${repoLabel(dp.repo)}:${dp.branch}`,
      })),
    ]),
    [repos, linked, discoveredPrs, previewTarget?.repo, previewTarget?.branch],
  );
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (targets.find((t) => t.primary) ?? targets[0])?.key,
  );
  const active = targets.find((t) => t.key === activeKey) ?? targets[0];
  // A PR chip — in the Workspace strip, or a `repo#123` mention in prose —
  // opened the Review tab on a specific PR. Keyed on `seq` so re-clicking the
  // same chip re-focuses it, and so a re-render never fights a tab the reader
  // picked by hand.
  //
  // A request waits for the target it names instead of being dropped: the PRs
  // arrive with the session, so a `/pr/<number>` link followed cold resolves
  // long before there is anything to select, and giving up on the first pass
  // is exactly what leaves the reader on the primary PR.
  const focusApplied = useRef<{ target?: number; checks?: number }>({});
  useEffect(() => {
    if (!focusTarget) return;
    const { seq } = focusTarget;
    if (focusTarget.repo && focusApplied.current.target !== seq) {
      const match = matchFocusTarget(targets, focusTarget);
      if (match) {
        focusApplied.current.target = seq;
        setActiveKey(match.key);
      }
    }
    // Checks stopped being a page of their own: reveal them where they live.
    if (focusTarget.view === "checks" && focusApplied.current.checks !== seq) {
      focusApplied.current.checks = seq;
      setPage("overview");
      setFocusChecksSeq((prev) => prev + 1);
    }
  }, [focusTarget?.seq, targets]);
  const loadTargetKey = previewTarget
    ? `preview:${previewTarget.repo}:${previewTarget.branch}`
    : active?.key || sessionId;
  // `#5528` in a PR body or review comment means a PR in the repo THIS panel is
  // showing — which is the attached repo's, not the session's, when the strip
  // is on a sibling PR. Only fall back to the surrounding surface's repo.
  const contextRepo = useMarkdownRepo();
  const markdownRepo = previewTarget?.repo || active?.repo || contextRepo;
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [loadedDiff, setDiff] = useState<PrDiffData | null>(null);
  const diff = loadedDiff?.headRefOid === pr?.headRefOid ? loadedDiff : null;
  const diffOutOfDate = !!loadedDiff && !diff;
  const diffLoadPolicy = reviewDiffLoadPolicy(
    diff?.patch.length ?? 0,
    pr?.changedFiles ?? 0,
  );
  const [diffGroups, setDiffGroups] = useState<{
    oid: string;
    groups: DiffFileGroup[] | null;
  } | null>(null);
  const [diffGroupsLoading, setDiffGroupsLoading] = useState(false);
  const [diffGroupsRetry, setDiffGroupsRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("APPROVE");
  // Only the dialog's opening value and what it hands back on close. The live
  // field lives in FinishReviewDialog: a keystroke here would re-render every
  // mounted file of the diff behind it.
  const [summaryDraft, setSummaryDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const { copy: copyPrLink } = useCopy();
  // Merging is a separate decision from approving, so it starts off: the
  // reviewer opts into it, and the primary action stays "Approve".
  const [mergeAfterReview, setMergeAfterReview] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  /**
   * The review is two places, not six tabs: Overview (the conversation and the
   * PR's metadata) and Files changed (the code). `codeView` is which lens the
   * code page uses, held apart from the page so a trip to Overview and back
   * never re-triggers guide or code-flow generation.
   */
  const [page, setPage] = useState<"overview" | "files">("files");
  const [codeView, setCodeView] = useState<"all" | "guide" | "flow">("all");
  /** A check chip elsewhere in the app asked for the checks (focusTarget). */
  const [focusChecksSeq, setFocusChecksSeq] = useState(0);
  /** A file picked on Overview, waiting for the code page to have its diff. */
  const [pendingReveal, setPendingReveal] = useState<string | null>(null);
  const phoneLayout = window.matchMedia("(max-width: 720px)").matches;
  const [diffStyle, changeDiffStyle] = useStoredCodeSetting(
    "opensession-pr-diff-style",
    ["unified", "split"] as const,
    phoneLayout ? "unified" : "split",
  );
  // Long lines scroll sideways by default (GitHub's behaviour). Wrapping keeps
  // them all on screen, which matters most in split view where each side is
  // half as wide.
  const [wrapSetting, changeWrapSetting] = useStoredCodeSetting(
    "opensession-pr-diff-wrap",
    ["0", "1"] as const,
    "0",
  );
  const wrapLines = wrapSetting === "1";
  const changeWrapLines = (wrap: boolean) =>
    changeWrapSetting(wrap ? "1" : "0");
  const [structuralSetting, changeStructuralSetting] = useStoredCodeSetting(
    "opensession-pr-structural-highlighting",
    ["0", "1"] as const,
    "1",
  );
  const [fileStatsSetting, changeFileStatsSetting] = useStoredCodeSetting(
    "opensession-pr-file-stats",
    ["0", "1"] as const,
    "1",
  );
  const [grouping, changeGrouping] = useStoredCodeSetting(
    "opensession-pr-grouping",
    ["none", "ai"] as const,
    "none",
  );
  const [fileListMode, changeFileListMode] = useStoredCodeSetting(
    "opensession-pr-file-list",
    ["flat", "tree", "hidden"] as const,
    phoneLayout ? "hidden" : "flat",
  );
  const [fileOrder, changeFileOrder] = useStoredCodeSetting(
    "opensession-pr-file-order",
    ["path", "changes", "pull-request"] as const,
    "path",
  );
  const [sortDirection, changeSortDirection] = useStoredCodeSetting(
    "opensession-pr-file-order-direction",
    ["asc", "desc"] as const,
    "asc",
  );
  const [hideReviewedSetting, changeHideReviewedSetting] = useStoredCodeSetting(
    "opensession-pr-hide-reviewed",
    ["0", "1"] as const,
    "0",
  );
  const [codeTheme, changeCodeTheme] = useStoredCodeSetting(
    "opensession-pr-code-theme",
    ["system", "light", "dark"] as const,
    "system",
  );
  // Keyed like the code flow below, so one target's guide never renders under
  // another's diff and a slow response can't land after the panel moved on.
  const [guide, setGuide] = useState<{
    key: string;
    data: ReviewGuideData;
  } | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  const guideGenerationRef = useRef(0);
  const [codeFlow, setCodeFlow] = useState<{
    key: string;
    data: CodeFlowResult;
  } | null>(null);
  const [codeFlowLoading, setCodeFlowLoading] = useState(false);
  const [codeFlowError, setCodeFlowError] = useState<string | null>(null);
  const codeFlowGenerationRef = useRef(0);
  // GitHub's per-viewer "Viewed" file state for the shown PR (review canvas
  // checkboxes). Keyed so a stale PR's set never leaks onto the next one.
  const [prViewed, setPrViewed] = useState<{
    key: string;
    prId: string;
    viewed: ReadonlySet<string>;
  } | null>(null);
  const prViewedRef = useRef(prViewed);
  prViewedRef.current = prViewed;
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rail collapses on the panel's own width, not the viewport's. In the
   * workspace this panel is flanked by the sidebar and the workspace panel, so
   * it is around 990px inside a 1440px window and `phone:` (a viewport query)
   * never fires for it. Below the threshold the rail stacks above the
   * conversation instead of sitting beside it.
   */
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [railStacked, setRailStacked] = useState(false);
  const [headerCompact, setHeaderCompact] = useState(
    () => window.matchMedia("(max-width: 720px)").matches,
  );
  /* One underline that MOVES between the two tabs rather than a mark that
     blinks on and off, so the strip says which way the choice went — the same
     shape (and the same id-per-instance rule) as the Segmented knob. It is
     minted up here with the other hooks: the render below returns early while
     the PR loads, and a `useId` past that point is a conditional hook. */
  const tabUnderlineId = useId();
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);
  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setRailStacked(entry.contentRect.width < 880);
      setHeaderCompact(entry.contentRect.width < 640);
    });
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [rootEl]);
  const loadGenerationRef = useRef(0);
  const activeLoadTargetRef = useRef(loadTargetKey);
  const loadInFlightRef = useRef<{
    key: string;
    promise: Promise<void>;
  } | null>(null);
  activeLoadTargetRef.current = loadTargetKey;

  const load = useCallback(
    (force = false): Promise<void> => {
      if (loadTargetKey !== activeLoadTargetRef.current)
        return Promise.resolve();
    const existing = loadInFlightRef.current;
    if (!force && existing?.key === loadTargetKey) return existing.promise;

    const generation = ++loadGenerationRef.current;
    setDiffLoading(true);
    let prSettled = false;
    let diffSettled = false;
    let prResult: PrDetails | null = null;
    let diffResult: PrDiffData | null = null;
    const isCurrent = () =>
      generation === loadGenerationRef.current &&
      loadTargetKey === activeLoadTargetRef.current;
    const commitDiff = () => {
      if (!isCurrent() || !prSettled || !diffSettled) return;
      setDiff(
        diffResult?.headRefOid === prResult?.headRefOid ? diffResult : null,
      );
      setDiffLoading(false);
    };
      const prRequest = (
        previewTarget
      ? fetchPrPreview(previewTarget.repo, previewTarget.branch)
      : fetchPr(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        prSettled = true;
        prResult = data;
        if (isCurrent()) {
          setPr(data);
          setLoadError(null);
        }
        commitDiff();
      })
      .catch((e: any) => {
        prSettled = true;
        prResult = null;
          if (isCurrent())
            setLoadError(e?.message || "Failed to load the pull request.");
        commitDiff();
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
      const diffRequest = (
        previewTarget
      ? fetchPrPreviewDiff(previewTarget.repo, previewTarget.branch)
      : fetchPrDiff(sessionId, active?.repo, active?.branch)
    )
      .then((data) => {
        diffSettled = true;
        diffResult = data;
        if (isCurrent()) setDiffError(null);
        commitDiff();
      })
      .catch((e: any) => {
        diffSettled = true;
        diffResult = null;
          if (isCurrent())
            setDiffError(e?.message || "Failed to load pull request changes.");
        commitDiff();
      });
    // A linked PR has no local worktree in this session — no git state.
      const gitRequest = (
        previewTarget || active?.linked
      ? Promise.resolve(null)
      : fetchGitStatus(sessionId, active?.repo)
    )
      .then((data) => {
        if (isCurrent()) setGit(data);
      })
      .catch(() => {
        if (isCurrent()) setGit(null);
      });

      const promise = Promise.allSettled([
        prRequest,
        diffRequest,
        gitRequest,
      ]).then(() => undefined);
    loadInFlightRef.current = { key: loadTargetKey, promise };
    void promise.then(() => {
        if (loadInFlightRef.current?.promise === promise)
          loadInFlightRef.current = null;
    });
    return promise;
    },
    [
    sessionId,
    loadTargetKey,
    active?.repo,
    active?.branch,
    active?.linked,
    previewTarget?.repo,
    previewTarget?.branch,
    ],
  );

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setDiffLoading(true);
    setDiffError(null);
    setPr(null);
    setDiff(null);
    setGit(null);
    setPending([]);
    setReviewing(false);
    setReviewOpen(false);
    setPrViewed(null);
    setCodeFlow(null);
    setCodeFlowLoading(false);
    setCodeFlowError(null);
    codeFlowGenerationRef.current += 1;
    load();
    const stopPolling = pollWhileVisible(load, PR_WEBHOOK_FALLBACK_POLL_MS);
    return () => {
      stopPolling();
      loadGenerationRef.current += 1;
    };
  }, [load]);

  // A GitHub webhook reported activity on the shown PR's branch (review, CI,
  // push, merge) — refetch immediately. Primary targets omit their branch, so
  // match those through the loaded PR number/head branch instead.
  // The server invalidated its caches before broadcasting, so this reads
  // fresh data.
  useEffect(() => {
    if (!addHandler) return;
    return addHandler((msg) => {
      if (msg.type !== "pr_updated") return;
      const branch = previewTarget?.branch ?? active?.branch;
      const repo = previewTarget?.repo ?? active?.repo;
      if (
        msg.repo === repo &&
        (branch
          ? msg.branch === branch
          : !pr || msg.number === pr.number || msg.branch === pr.headRefName)
      )
        void load(true);
    });
  }, [
    addHandler,
    load,
    previewTarget?.repo,
    previewTarget?.branch,
    active?.repo,
    active?.branch,
    pr?.number,
    pr?.headRefName,
  ]);

  useEffect(() => {
    const files = pr?.files || [];
    if (!diff?.patch || files.length < 3 || !diffLoadPolicy.groupFiles) {
      setDiffGroups(null);
      setDiffGroupsLoading(false);
      return;
    }
    setDiffGroups(null);
    setDiffGroupsLoading(true);
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retryTimer = setTimeout(
        () => setDiffGroupsRetry((attempt) => attempt + 1),
        125_000,
      );
    };
    fetchPrDiffGroups(
      sessionId,
      files,
      diff.patch,
      active?.repo,
      active?.branch,
    )
      .then((result) => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: result.groups });
        if (!result.groups) retryLater();
      })
      .catch(() => {
        if (!live) return;
        setDiffGroups({ oid: diff.headRefOid, groups: null });
        retryLater();
      })
      .finally(() => {
        if (live) setDiffGroupsLoading(false);
      });
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    diff?.headRefOid,
    diffLoadPolicy.groupFiles,
    pr?.files?.length,
    diffGroupsRetry,
  ]);

  // A guide belongs to one target's head commit: the key is what makes a
  // guide from the PR the panel just left read as absent rather than current.
  const guideKey = diff ? `${loadTargetKey}\0${diff.headRefOid}` : "";
  const loadGuide = useCallback(async () => {
    if (!guideKey) return;
    const generation = ++guideGenerationRef.current;
    setGuideLoading(true);
    setGuideFailed(false);
    try {
      const data = previewTarget
        ? await fetchPrPreviewGuide(previewTarget.repo, previewTarget.branch)
        : await fetchReviewGuide(sessionId, active?.repo, active?.branch);
      if (generation !== guideGenerationRef.current) return;
      if (data) setGuide({ key: guideKey, data });
      else setGuideFailed(true);
    } catch {
      if (generation === guideGenerationRef.current) setGuideFailed(true);
    } finally {
      if (generation === guideGenerationRef.current) setGuideLoading(false);
    }
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    previewTarget?.repo,
    previewTarget?.branch,
    guideKey,
  ]);

  const prPatchVersion = diff?.diffVersion || "";
  const codeFlowKey =
    diff && prPatchVersion
      ? `${loadTargetKey}\0${diff.headRefOid}\0${prPatchVersion}`
      : "";
  const loadCodeFlow = useCallback(async () => {
    if ((!diff?.patch && !diff?.skippedFiles) || !codeFlowKey) return;
    const generation = ++codeFlowGenerationRef.current;
    setCodeFlowLoading(true);
    setCodeFlowError(null);
    try {
      const data = previewTarget
        ? await fetchPrPreviewCodeFlow(previewTarget.repo, previewTarget.branch)
        : await fetchPrCodeFlow(sessionId, active?.repo, active?.branch);
      if (!data)
        throw new Error("Code flow isn't available for this pull request.");
      if (data.diffVersion !== prPatchVersion) {
        if (generation === codeFlowGenerationRef.current) {
          setCodeFlowError(
            "The pull request updated while code flow was loading. Try again.",
          );
        }
        return;
      }
      if (generation === codeFlowGenerationRef.current)
        setCodeFlow({ key: codeFlowKey, data });
    } catch (error: any) {
      if (generation === codeFlowGenerationRef.current)
        setCodeFlowError(error?.message || "Couldn't load code flow.");
    } finally {
      if (generation === codeFlowGenerationRef.current)
        setCodeFlowLoading(false);
    }
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    previewTarget?.repo,
    previewTarget?.branch,
    diff?.patch,
    prPatchVersion,
    codeFlowKey,
  ]);

  const refreshCodeFlow = useCallback(async () => {
    codeFlowGenerationRef.current += 1;
    setCodeFlow(null);
    setCodeFlowError(null);
    setCodeFlowLoading(true);
    await load(true);
    setCodeFlowLoading(false);
  }, [load]);

  // The guide is generated on demand (the first request per head commit takes
  // the model a while) — only fetch once the reviewer opens the Guide tab, and
  // refetch when a new push moves the head commit.
  const showingGuide = page === "files" && codeView === "guide";
  const showingFlow = page === "files" && codeView === "flow";
  // A different PR or a new head commit is a different guide: drop the in-flight
  // and failed flags with it, or one failure would disable auto-load for the
  // rest of the panel's life. The keyed `guide` itself goes stale on its own.
  useEffect(() => {
    guideGenerationRef.current += 1;
    setGuideLoading(false);
    setGuideFailed(false);
  }, [guideKey]);

  useEffect(() => {
    if (!showingGuide || !diff?.patch || !guideKey) return;
    if (guideLoading || guideFailed) return;
    if (guide?.key === guideKey) return;
    void loadGuide();
  }, [
    showingGuide,
    diff?.patch,
    guideKey,
    guide,
    guideLoading,
    guideFailed,
    loadGuide,
  ]);

  useEffect(() => {
    if (!showingFlow || codeFlowLoading || codeFlowError) return;
    if (!diff?.patch && !diff?.skippedFiles) {
      if (diffLoading || diffOutOfDate) return;
      setCodeView("all");
      return;
    }
    if (codeFlow && codeFlow.key !== codeFlowKey) {
      setCodeFlowError(
        "The pull request updated. Refresh code flow to analyze the latest diff.",
      );
      return;
    }
    if (!codeFlow) void loadCodeFlow();
  }, [
    showingFlow,
    diff?.patch,
    diffLoading,
    diffOutOfDate,
    codeFlow,
    codeFlowKey,
    codeFlowLoading,
    codeFlowError,
    loadCodeFlow,
  ]);

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (the provider's native flow).
  // Both are stable: they ride diffProps into every mounted file row, so a new
  // identity here re-renders the whole diff.
  const handleAddPending = useCallback(
    async (target: CommentTarget, text: string) => {
      setPending((prev) => [
        ...prev,
        { ...target, text, id: crypto.randomUUID() },
      ]);
    setReviewDone(null);
    },
    [],
  );

  const handleRemovePending = useCallback((id: string) => {
    setPending((prev) => prev.filter((c) => c.id !== id));
  }, []);

  async function handleSubmitReview(summary: string) {
    if (submitting) return;
    const actionTargetKey = loadTargetKey;
    if (pending.length === 0 && !summary.trim() && reviewEvent !== "APPROVE") {
      setReviewError("Add a comment or a summary first");
      return;
    }
    setSubmitting(true);
    setReviewError(null);
    try {
      const payload = {
        user: getCurrentUser(),
        event: reviewEvent,
        summary: summary.trim() || undefined,
        repo: active?.repo,
        branch: active?.branch,
        comments: pending.map((c) => ({
          text: c.text,
          path: c.path,
          line: c.endLine,
          startLine: c.startLine !== c.endLine ? c.startLine : undefined,
          side: (c.side === "deletions" ? "LEFT" : "RIGHT") as "LEFT" | "RIGHT",
        })),
      };
      const result = previewTarget
        ? await submitPrPreviewReviewApi(
            previewTarget.repo,
            previewTarget.branch,
            payload,
          )
        : await submitPrReviewApi(sessionId, payload);
      let merged = false;
      if (reviewEvent === "APPROVE" && mergeAfterReview) {
        try {
          if (previewTarget)
            await mergePrPreviewApi(
              previewTarget.repo,
              previewTarget.branch,
              "squash",
            );
          else
            await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
          merged = true;
        } catch (e: any) {
          setMergeError(
            `Review approved, but merge failed: ${e.message || "unknown error"}`,
          );
        }
      }
      if (actionTargetKey !== activeLoadTargetRef.current) return;
      setPending([]);
      setSummaryDraft("");
      setReviewOpen(false);
      setReviewEvent("APPROVE");
      setMergeAfterReview(false);
      setReviewDone(merged ? "merged" : result.url || "submitted");
      setTimeout(() => {
        if (actionTargetKey !== activeLoadTargetRef.current) return;
        setReviewDone(null);
        setReviewing(false);
      }, 6000);
      await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current)
        setReviewError(e.message || "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  }

  // Two-click confirm guards against accidental merges (this mutates the repo).
  async function handleMerge() {
    if (!confirmMerge) {
      setConfirmMerge(true);
      setMergeError(null);
      setTimeout(() => setConfirmMerge(false), 4000);
      return;
    }
    setConfirmMerge(false);
    setMerging(true);
    setMergeError(null);
    const actionTargetKey = loadTargetKey;
    try {
      if (previewTarget)
        await mergePrPreviewApi(
          previewTarget.repo,
          previewTarget.branch,
          "squash",
        );
      else await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current) {
        const message = e.message || "Merge failed";
        setMergeError(message);
        toast(message);
      }
    } finally {
      setMerging(false);
    }
  }

  async function handleClose() {
    if (!confirmClose) {
      setConfirmClose(true);
      setCloseError(null);
      setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    setConfirmClose(false);
    setClosing(true);
    setCloseError(null);
    const actionTargetKey = loadTargetKey;
    try {
      if (previewTarget)
        await closePrPreviewApi(previewTarget.repo, previewTarget.branch);
      else await closePrApi(sessionId, active?.repo, active?.branch);
      if (actionTargetKey === activeLoadTargetRef.current) await load(true);
    } catch (e: any) {
      if (actionTargetKey === activeLoadTargetRef.current)
        setCloseError(e.message || "Failed to close pull request");
    } finally {
      setClosing(false);
    }
  }

  // Roll the per-check list up into headline counts, and split deployments
  // (Vercel previews & friends) from CI checks — failing and running entries
  // sort first within each group.
  const checkSummary = useMemo(() => {
    const checks = pr?.checks || [];
    const s = summarize(checks);
    const rank = (c: PrCheck) => {
      const cls = checkClass(c.status, c.conclusion);
      return cls === "check-failure"
        ? 0
        : cls === "check-pending"
          ? 1
          : cls === "check-success"
            ? 3
            : 2;
    };
    const sorted = [...checks].sort((a, b) => rank(a) - rank(b));
    return {
      ...s,
      deployments: sorted.filter(isDeployment),
      checks: sorted.filter((c) => !isDeployment(c)),
    };
  }, [pr]);

  const bodyHtml = useMemo(() => {
    if (!pr?.body) return "";
    // The mirrored walkthrough section is for GitHub readers; here
    // WalkthroughCard renders the real thing, so drop the mirror.
    const stripped = pr.body
      .replace(
        /<!-- opensession:walkthrough -->[\s\S]*?<!-- \/opensession:walkthrough -->/,
        "",
      )
      .trim();
    // A PR body is PR prose like its comments: the same `<details>` blocks,
    // `<img>` screenshots and bot markup, rendered by the same allowlist.
    return stripped
      ? renderPrCommentMarkdown(stripped, { repo: markdownRepo })
      : "";
  }, [pr?.body, markdownRepo]);
  const provider = useMemo(() => providerFromUrl(pr?.url), [pr?.url]);
  // Host capability gating: absent (GitHub, older cache entries) means all
  // true, so nothing GitHub-shaped ever disappears. code.storage payloads
  // carry an explicit set (no checks/reviewers/comments/viewed state/stacks).
  const caps = prCapabilities(pr?.capabilities);

  // A file picked anywhere but the code itself (the Overview rail, a code-flow
  // location) has to wait: the code page may not be mounted yet, and its diff
  // loads on its own clock. Park the path and let the effect below spend it
  // once both are true, rather than revealing into a tree that isn't there.
  const scrollToFile = useCallback(
    (path: string) => {
      if (page === "files" && codeView !== "flow") {
        revealDiffFile(rootRef.current, path);
        return;
      }
      setPage("files");
      if (codeView === "flow") setCodeView("all");
      setPendingReveal(path);
    },
    [page, codeView],
  );
  useEffect(() => {
    if (
      !pendingReveal ||
      page !== "files" ||
      codeView === "flow" ||
      !diff?.patch
    )
      return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        revealDiffFile(rootRef.current, pendingReveal);
        setPendingReveal(null);
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [pendingReveal, page, codeView, diff?.patch]);

  // Changed images render as pictures, served from the repo at the PR's head
  // (new side) / base (old side) refs through the pr-image endpoint.
  const prBase = pr?.baseRefName;
  const prHead = pr?.headRefName;
  const activeRepoId = active?.repo;
  const prImageSrcs = useCallback(
    (file: FileDiffMetadata) => {
      const src = (ref: string, p: string) =>
        `${API_BASE}/pr-image?${activeRepoId ? `repo=${encodeURIComponent(activeRepoId)}&` : ""}ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(p)}`;
      return {
        oldSrc: prBase ? src(prBase, file.prevName || file.name) : undefined,
        newSrc: prHead ? src(prHead, file.name) : undefined,
      };
    },
    [prBase, prHead, activeRepoId],
  );
  // The pr-image endpoint serves blobs through the GitHub API — on hosts
  // without it, image files fall back to the plain binary-diff placeholder.
  const imageSrcs = caps.images ? prImageSrcs : undefined;
  const fileActions = useMemo(() => {
    const ref = pr?.headRefOid || pr?.headRefName;
    const prUrl = pr?.url;
    return {
      providerName: provider.name,
      url: (file: FileDiffMetadata) => {
        if (provider.key !== "github" || !prUrl || !ref) return null;
        try {
          const url = new URL(prUrl);
          url.pathname = `${url.pathname.replace(/\/pull\/\d+.*$/, "")}/blob/${encodeURIComponent(ref)}/${file.name
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          url.search = "";
          url.hash = "";
          return url.toString();
        } catch {
          return null;
        }
      },
      loadContents:
        provider.key === "github" && ref
          ? (file: FileDiffMetadata) => fetchPrFile(activeRepoId, ref, file.name)
          : undefined,
    };
  }, [pr?.headRefOid, pr?.headRefName, pr?.url, provider, activeRepoId]);

  // In-place edit mode on the review canvas. Only targets backed by one of the
  // session's own worktrees qualify (primary/attached repos — their worktree is
  // the PR's head branch); linked/discovered PRs live on branches this session
  // doesn't have checked out, so they stay read-only. Saves only touch the
  // worktree — the PR diff won't reflect them until they're committed and
  // pushed — so saved files accumulate into a "tell the agent" note that asks
  // it to commit them on this branch.
  const [handEdited, setHandEdited] = useState<string[]>([]);
  useEffect(() => setHandEdited([]), [sessionId, activeRepoId]);
  const worktreeEditable =
    !!editGate && !previewTarget && !!active && !active.branch;
  const editFile = useMemo(
    () =>
      worktreeEditable
        ? {
            load: (file: FileDiffMetadata, side: "new" | "base") =>
              fetchWorktreeFile(
                sessionId,
                side === "base" ? file.prevName || file.name : file.name,
                activeRepoId,
                side,
              ),
            save: async (path: string, content: string) => {
              await saveWorktreeFile(sessionId, path, content, activeRepoId);
              setHandEdited((prev) =>
                prev.includes(path) ? prev : [...prev, path],
              );
              // The diff column is the PR's committed state, so it can't show
              // the edit yet — but the divergence strip's dirty state can.
              void fetchGitStatus(sessionId, activeRepoId)
                .then((g) => setGit(g))
                .catch(() => {});
            },
          }
        : undefined,
    [worktreeEditable, sessionId, activeRepoId],
  );
  const tellAgentAboutEdits = useCallback(() => {
    if (!send || !handEdited.length) return;
    const list = handEdited.map((p) => `- \`${p}\``).join("\n");
    send({
      type: "prompt",
      sessionId,
      user: getCurrentUser(),
      content:
        `${getCurrentUser()} hand-edited these files directly in the worktree via the review tab editor` +
        `${activeRepoId ? ` (${activeRepoId} repo)` : ""}:\n\n${list}\n\n` +
        `Review the edits, keep them (don't revert them unless they're clearly broken), and commit + push them on this branch so the pull request picks them up.`,
    });
    setHandEdited([]);
  }, [send, handEdited, sessionId, activeRepoId]);

  // GitHub "Viewed" state: fetched per PR (and refetched when the head moves,
  // since a push flips changed files to DIRTY = unviewed on GitHub's side).
  // Hosts without viewed state never fetch — prViewed stays unset, so the
  // checkboxes stay hidden.
  const viewedKey = diff ? `${activeRepoId || "pr"}#${diff.number}` : null;
  useEffect(() => {
    if (!caps.viewedState || !viewedKey || !diff) return;
    let live = true;
    fetchPrViewedFiles(activeRepoId, diff.number, getCurrentUser())
      .then((res) => {
        if (!live) return;
        setPrViewed({
          key: viewedKey,
          prId: res.prId,
          viewed: new Set(res.viewed),
        });
      })
      .catch(() => {
        // Leave prViewed unset — checkboxes just stay hidden for this PR.
      });
    return () => {
      live = false;
    };
  }, [viewedKey, diff?.headRefOid, caps.viewedState]);

  const handleToggleViewed = useCallback((path: string, next: boolean) => {
    const info = prViewedRef.current;
    if (!info) return;
    const apply = (set: ReadonlySet<string>, add: boolean) => {
      const v = new Set(set);
      if (add) v.add(path);
      else v.delete(path);
      return v;
    };
    // Optimistic: flip locally, revert if GitHub rejects the mutation.
    setPrViewed({ ...info, viewed: apply(info.viewed, next) });
    void setPrFileViewed(info.prId, path, next, getCurrentUser()).catch(() => {
      setPrViewed((prev) =>
        prev && prev.key === info.key
          ? { ...prev, viewed: apply(prev.viewed, !next) }
          : prev,
      );
    });
  }, []);

  function handleLinked(all: LinkedPrEntry[], justLinked: LinkedPrEntry) {
    setLinkedLocal(all);
    setActiveKey(`${justLinked.repo} ${justLinked.branch}`);
  }

  async function handleUnlink(t: PrTarget) {
    try {
      const res = await unlinkPrApi(sessionId, t.repo, t.branch!);
      setLinkedLocal(res.all);
      if (activeKey === t.key)
        setActiveKey((targets.find((x) => x.primary) ?? targets[0])?.key);
      toast("PR unlinked");
    } catch (e: any) {
      toast(e.message || "Couldn't unlink the PR");
    }
  }

  // Tab bar across the top: one tab per PR (primary repo, attached repos,
  // linked PRs) plus the link affordance. With a single target the bar
  // disappears and "Link PR" moves into the actions row instead.
  // Sessions linked to the shown PR — only when the caller wires the list.
  // Matched against the ACTIVE target (linked PRs carry their own branch; the
  // primary/attached branch resolves through the loaded PR's headRefName).
  const relatedSessions = useMemo(
    () =>
      sessions && active
        ? prRelatedSessions(sessions, active.repo, active.branch, pr)
        : [],
    [sessions, active?.repo, active?.branch, pr?.number, pr?.headRefName],
  );

  const files = pr?.files ?? NO_PR_FILES;
  const reviewedFiles =
    prViewed?.key === viewedKey ? prViewed.viewed : undefined;
  const hideReviewed = hideReviewedSetting === "1";
  const reviewFiles = useMemo(() => {
    const visible =
      hideReviewed && reviewedFiles
        ? files.filter((file) => !reviewedFiles.has(file.path))
        : [...files];
    if (fileOrder === "pull-request")
      return sortDirection === "asc" ? visible : visible.reverse();
    const direction = sortDirection === "asc" ? 1 : -1;
    return visible.sort((left, right) => {
      const result =
        fileOrder === "changes"
          ? left.additions + left.deletions - right.additions - right.deletions
          : left.path.localeCompare(right.path);
      return (result || left.path.localeCompare(right.path)) * direction;
    });
  }, [files, reviewedFiles, hideReviewed, fileOrder, sortDirection]);
  const visibleFileOrder = useMemo(
    () => reviewFiles.map((file) => file.path),
    [reviewFiles],
  );

  const currentGuide = guide?.key === guideKey ? guide.data : null;
  // Slicing the patch per section walks every byte of it, so it cannot run on
  // renders it has nothing to do with — while the guide is the open lens, that
  // would be once per keystroke in the review summary.
  const guideSections = useMemo(
    () =>
      currentGuide && diff?.patch
        ? sectionsWithPatches(currentGuide, diff.patch)
        : [],
    [currentGuide, diff?.patch],
  );

  // Every diff on the code page is the same commentable surface; only the
  // patch it is handed differs (the whole PR, or one guide section). Memoized
  // because it is the props object of every mounted file row: rebuilding it
  // re-renders the whole diff, however unrelated the state change was.
  const diffProps = useMemo(
    () =>
      diff && {
        diffStyle,
        wrapLines,
        structuralHighlighting: structuralSetting === "1",
        showFileStats: fileStatsSetting === "1",
        codeTheme,
        visibleFileOrder,
        stickyFileHeaders: true,
        defaultExpandedFiles: diffLoadPolicy.defaultExpandedFiles,
        allowExpandAll: diffLoadPolicy.allowExpandAll,
        viewedFiles: prViewed?.key === viewedKey ? prViewed.viewed : undefined,
        onToggleViewed: handleToggleViewed,
        disabled: !reviewing || !caps.reviewComments,
        disabledHint: !caps.reviewComments
          ? `Inline review comments aren't supported on ${provider.name}`
          : "Start a review to add inline comments.",
        submitLabel: "Add comment",
        placeholder: `Comment on #${diff.number}, added to your pending review…`,
        pendingComments: reviewing ? pending : undefined,
        onRemovePending: handleRemovePending,
        onSubmit: handleAddPending,
        imageSrcs,
        fileActions,
        editFile,
      },
    [
      diff,
      diffStyle,
      wrapLines,
      structuralSetting,
      fileStatsSetting,
      codeTheme,
      visibleFileOrder,
      prViewed,
      viewedKey,
      handleToggleViewed,
      reviewing,
      caps.reviewComments,
      provider.name,
      pending,
      handleRemovePending,
      handleAddPending,
      imageSrcs,
      fileActions,
      editFile,
      diffLoadPolicy.defaultExpandedFiles,
      diffLoadPolicy.allowExpandAll,
    ],
  );

  const showBar = targets.length > 1;
  const switcher = showBar ? (
    <div className={PR_REPO_TABS}>
      {targets.map((t) => (
        <button
          key={t.key}
          className={prRepoTabClass(t.key === active?.key)}
          onClick={() => setActiveKey(t.key)}
          title={
            t.linked
              ? `Linked PR · branch ${t.branch}`
              : t.discovered
                ? `PR opened by this session · branch ${t.branch}`
                : t.primary
                  ? "Primary repo"
                  : "Attached repo"
          }
        >
          {t.label}
          {t.linked && t.key === active?.key && (
            <span
              className={PR_REPO_TAB_X}
              role="button"
              title="Unlink this PR from the session"
              onClick={(e) => {
                e.stopPropagation();
                void handleUnlink(t);
              }}
            >
              <IconX size={12} />
            </span>
          )}
        </button>
      ))}
      {linkable && (
        <LinkPrControl
          sessionId={sessionId}
          variant="tab"
          onLinked={handleLinked}
        />
      )}
    </div>
  ) : null;

  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <LoadingState className="flex-1">Loading pull request…</LoadingState>
      </div>
    );

  if (loadError && !pr)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <InlineAlert
          className="m-4"
          retryLabel="Retry"
          onRetry={() => {
            setLoading(true);
            setLoadError(null);
            void load(true);
          }}
        >
          {loadError}
        </InlineAlert>
      </div>
    );

  if (!pr)
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
          {switcher}
          <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5">
            {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
            <PrCard title="Git status">
              <GitStatusRows
                git={git}
                pr={null}
                sessionId={sessionId}
                repo={active?.repo}
                send={send}
                onRefresh={load}
              />
            </PrCard>
            {linkable && !showBar && (
              <div className="flex flex-wrap items-center gap-2">
              <LinkPrControl
                sessionId={sessionId}
                variant="action"
                onLinked={handleLinked}
              />
              </div>
            )}
        </div>
      </div>
    );

  // Bot bookkeeping comments are pure HTML markers — hide them, and strip
  // leading markers from real comments' previews.
  const comments = (pr.comments || []).filter(
    (c) => stripHtmlComments(c.body) && !isOutdatedReviewComment(c.body),
  );
  const stateLabel = pr.isDraft
    ? "Draft"
    : pr.state === "OPEN"
      ? "Open"
      : pr.state === "MERGED"
        ? "Merged"
        : "Closed";
  // The state reads in the app's own PR language rather than a badge of its
  // own: the glyph carries the colour (prStatusMark, the same green/yellow/
  // red/purple the sidebar row and the workspace rows paint) and the word
  // beside it stays coarse. That way the header agrees with the sidebar entry
  // for this PR, including the states a badge cannot show at all: a conflict,
  // or checks still running.
  const statusMark = prStatusMark({ ...pr, checks: checkSummary });
  const canMergeAfterReview =
    pr.state === "OPEN" &&
    !pr.isDraft &&
    pr.mergeable !== "CONFLICTING" &&
    checkSummary.failed === 0 &&
    checkSummary.pending === 0;
  const reviewSubmitLabel =
    reviewEvent === "APPROVE"
      ? mergeAfterReview && canMergeAfterReview
        ? "Approve and merge"
        : "Approve"
      : reviewEvent === "REQUEST_CHANGES"
        ? "Request changes"
        : "Submit review";
  const rail = (
    <ReviewRail
      className={railStacked ? "min-w-0" : "w-[264px] shrink-0"}
      pr={pr}
      git={git}
      sessionId={sessionId}
      repo={active?.repo}
      provider={provider}
      caps={caps}
      checkSummary={checkSummary}
      send={send}
      onRefresh={load}
      onMerge={handleMerge}
      merging={merging}
      confirmMerge={confirmMerge}
      mergeError={mergeError}
      onOpenFile={scrollToFile}
      onOpenFiles={() => setPage("files")}
      onOpenSessions={sessions ? () => setSessionsOpen(true) : undefined}
      sessionCount={relatedSessions.length}
      focusChecksSeq={focusChecksSeq}
      compact={railStacked}
    />
  );

  const codeSettings = (
    <Popover.Root>
      <Tooltip label="Code view settings">
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label="Code view settings"
              icon={<IconSliders size={18} />}
            />
          }
        />
      </Tooltip>
      <Popover.Popup
        side="bottom"
        align="end"
        initialFocus
        className="w-[340px] p-2"
      >
        <Segmented
          label="Diff layout"
          value={diffStyle}
          onValueChange={(next) => changeDiffStyle(next as "unified" | "split")}
          className="grid w-full grid-cols-2"
        >
          <SegmentedOption value="split" className="justify-center py-1.5">
            <IconDiffSplit size={18} />
            Split
          </SegmentedOption>
          <SegmentedOption value="unified" className="justify-center py-1.5">
            <IconDiffUnified size={18} />
            Unified
          </SegmentedOption>
        </Segmented>

        <div className="mt-2 border-t border-divider py-1">
          <label className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span>Structural highlighting</span>
            <Switch
              size="sm"
              checked={structuralSetting === "1"}
              onCheckedChange={(checked) =>
                changeStructuralSetting(checked ? "1" : "0")
              }
            />
          </label>
          <label className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span>Wrap lines</span>
            <Switch
              size="sm"
              checked={wrapLines}
              onCheckedChange={changeWrapLines}
            />
          </label>
          <label className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span>Show changed lines per file</span>
            <Switch
              size="sm"
              checked={fileStatsSetting === "1"}
              onCheckedChange={(checked) =>
                changeFileStatsSetting(checked ? "1" : "0")
              }
            />
          </label>
        </div>

        <div className="border-t border-divider py-1">
          <div className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span className="shrink-0 whitespace-nowrap">Grouping</span>
            <OptionSelect
              label="Grouping"
              value={grouping}
              onChange={changeGrouping}
              size="sm"
              options={[
                { value: "none", label: "No grouping" },
                { value: "ai", label: "By purpose" },
              ]}
            />
          </div>
          <div className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span className="shrink-0 whitespace-nowrap">File list</span>
            <OptionSelect
              label="File list"
              value={fileListMode}
              onChange={changeFileListMode}
              size="sm"
              options={[
                { value: "flat", label: "Flat" },
                { value: "tree", label: "Tree" },
                { value: "hidden", label: "Hidden" },
              ]}
            />
          </div>
          <div className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span className="shrink-0 whitespace-nowrap">Order by</span>
            <span className="flex items-center gap-1">
              <Tooltip
                label={sortDirection === "asc" ? "Ascending" : "Descending"}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={
                    sortDirection === "asc"
                      ? "Sort descending"
                      : "Sort ascending"
                  }
                  icon={
                    sortDirection === "asc" ? (
                      <IconArrowUp size={17} />
                    ) : (
                      <IconArrowDown size={17} />
                    )
                  }
                  onClick={() =>
                    changeSortDirection(
                      sortDirection === "asc" ? "desc" : "asc",
                    )
                  }
                />
              </Tooltip>
              <OptionSelect
                label="File order"
                value={fileOrder}
                onChange={changeFileOrder}
                size="sm"
                options={[
                  { value: "path", label: "Path" },
                  { value: "changes", label: "Changed lines" },
                  { value: "pull-request", label: "Pull request" },
                ]}
              />
            </span>
          </div>
          <label className="flex min-h-10 items-center justify-between gap-4 px-2 text-label text-fg">
            <span className="shrink-0 whitespace-nowrap">Hide reviewed</span>
            <Switch
              size="sm"
              checked={hideReviewed}
              disabled={!reviewedFiles}
              onCheckedChange={(checked) =>
                changeHideReviewedSetting(checked ? "1" : "0")
              }
            />
          </label>
        </div>

        <div className="flex min-h-11 items-center justify-between gap-4 border-t border-divider px-2 pt-1 text-label text-fg">
          <span className="shrink-0 whitespace-nowrap">Code theme</span>
          <OptionSelect
            label="Code theme"
            value={codeTheme}
            onChange={changeCodeTheme}
            size="sm"
            options={[
              { value: "system", label: "Match app" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </div>
      </Popover.Popup>
    </Popover.Root>
  );

  /* The review has two pages, kept beside each other in the sticky bar so the
     navigation stays visible without taking width from the review canvas. */
  const pageTabs = (
    [
      ["overview", "Overview", comments.length || undefined],
      ["files", "Files changed", files.length || undefined],
    ] as const
  ).map(([key, label, count]) => (
    <button
      key={key}
      role="tab"
      aria-selected={page === key}
      className={`relative flex h-11 shrink-0 items-center gap-1.5 border-0 bg-transparent px-3 text-control-label font-medium transition-colors ${
        page === key ? "text-fg" : "text-dim hover:text-fg"
      }`}
      onClick={() => setPage(key)}
    >
      {page === key && (
        <motion.span
          layoutId={tabUnderlineId}
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
          transition={{ type: "tween", duration: duration.base, ease }}
        />
      )}
      {label}
      {count !== undefined && (
        <span
          className={`min-w-5 rounded-full px-[7px] py-px text-center text-meta font-semibold tabular-nums ${
            page === key ? "bg-accent-soft text-accent" : "bg-active text-dim"
          }`}
        >
          {count}
        </span>
      )}
    </button>
  ));

  const reviewBar = (
    <div className="flex h-11 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden bg-surface px-6 shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] phone:px-2 [&::-webkit-scrollbar]:hidden">
      <div
        className="flex shrink-0 items-center gap-0.5 self-stretch"
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Pull request pages"
      >
        {pageTabs}
      </div>
      {page === "files" && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {handEdited.length > 0 && send && (
            <Button
              variant="default"
              size="sm"
              onClick={tellAgentAboutEdits}
              title="Sends a note listing your hand-edits so they get committed and pushed"
            >
              Tell {AGENT_NAME} about {handEdited.length} edit
              {handEdited.length === 1 ? "" : "s"}
            </Button>
          )}
          <span className="flex shrink-0 items-center gap-1.5 text-label tabular-nums">
            <span className="text-green">+{pr.additions}</span>
            <span className="text-red">−{pr.deletions}</span>
          </span>
          <Menu.Root>
            <Tooltip label="Change the view">
              <Menu.Trigger
                render={
                  <Button variant="default" size="sm" className="text-fg" caret>
                    {CODE_VIEWS[codeView].label}
                  </Button>
                }
              />
            </Tooltip>
            <Menu.Popup align="end" className="min-w-[210px]">
              <Menu.RadioGroup
                value={codeView}
                onValueChange={(next) => {
                  const key = String(next) as CodeView;
                  if (key === "flow" && codeView !== "flow" && codeFlowError) {
                    setCodeFlow(null);
                    setCodeFlowError(null);
                  }
                  setCodeView(key);
                }}
              >
                {(Object.keys(CODE_VIEWS) as CodeView[]).map((key) => {
                  const { label, Icon } = CODE_VIEWS[key];
                  return (
                    <Menu.RadioItem
                      key={key}
                      value={key}
                      closeOnClick
                      disabled={
                        key === "flow" &&
                        ((!diff?.patch && !diff?.skippedFiles) || !prPatchVersion)
                      }
                    >
                      <Icon size={18} className={MENU_ICON} />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <Menu.Check on={codeView === key} />
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Root>
          {codeSettings}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="selectable relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
      data-review-canvas="true"
      ref={setRoot}
    >
      {switcher}

      {/* The PR identity names the canvas, so it stays edge to edge above the
          navigation and review content. */}
      <header
        className={`flex h-10 shrink-0 items-center gap-2.5 px-6 shadow-[inset_0_-1px_0_var(--border)] phone:px-3 ${statusMark.bgClassName}`}
      >
        {/* State, in the app's own PR language, filled rather than drawn: the
            tone washes the whole chip and the glyph and word share its ink.
            It is its own object, so it gets more air than the pieces of the
            identity line it precedes. */}
        <Tooltip label={statusMark.label}>
          <span
            className={`mr-1.5 flex h-6 shrink-0 items-center gap-1.5 ${statusMark.className}`}
          >
            <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
            {!headerCompact && (
              <span className="text-label font-medium">{stateLabel}</span>
            )}
          </span>
        </Tooltip>
        {/* Author and title in the session header's own breadcrumb shape: a
            tight picture-and-name pill, a chevron, then the name of the thing
            you are looking at. Same spacing and weights as RepoBar's
            `[icon] repo › title`, so the two headers read as one bar. */}
        <span className="flex shrink-0 items-center gap-[7px] text-item-title font-medium text-fg">
          <UserAvatar
            name={pr.author}
            login={provider.key === "github" ? pr.author : null}
            size={18}
            edge={false}
            title={pr.author}
          />
          {!headerCompact && (
            <span className="max-w-[180px] truncate">{pr.author}</span>
          )}
        </span>
        {!headerCompact && (
          <IconChevronRight size={18} className="shrink-0 text-faint" />
        )}
        {/* Title only. Counts, commits and the sessions on this PR are the
            rail's job, so the bar stays one line of identity.

            The title is the name of the page you are already on, so it is
            inert. The outbound jump rides the number, which is the reference
            everywhere else in the app. */}
        <h1
          className="flex min-w-0 flex-1 items-baseline gap-1 text-item-title font-medium leading-[1.2] text-fg"
          title={`${pr.title} #${pr.number}`}
        >
          <span className="truncate">{pr.title}</span>
          <Tooltip label={`Open on ${provider.name}`}>
            <a
              className="shrink-0 font-normal text-faint no-underline hover:text-link"
              href={pr.url}
              target="_blank"
              rel="noopener"
            >
              #{pr.number}
            </a>
          </Tooltip>
        </h1>
        {pr.staging?.url && (
          <Tooltip label="Open the preview environment">
            <a
              /* An icon-only control carries its glyph ~6px inside its box,
                 so the last one in the row is outdented to put that glyph on
                 the row's content edge — where the view control below it
                 sits, since a bordered control is flush with its own box. */
              className={`ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-control text-dim no-underline hover:bg-hover hover:text-fg ${pr.state === "OPEN" ? "" : "-mr-1.5"}`}
              href={pr.staging.url}
              target="_blank"
              rel="noopener"
              aria-label="Open the preview environment"
            >
              <IconGlobe size={19} />
            </a>
          </Tooltip>
        )}
        {pr.state === "OPEN" &&
          !pr.isDraft &&
          caps.reviewComments &&
          !reviewing && (
          /* The one call to action on this canvas, so it takes the accent
             plate. Green is the app's affirmative tone (approve, merge) and
             the state glyph beside it is already wearing it; a green Review
             button next to a green Open glyph made two different things
             claim the same colour. */
          <Button
            variant="primary"
            size="sm"
            className={pr.staging?.url ? undefined : "ml-auto"}
            onClick={() => {
              setReviewing(true);
              setPage("files");
            }}
          >
            Review
          </Button>
        )}
        {canMergeAfterReview && (
          <Button
            variant="success-strong"
            size="sm"
            className={
              !pr.staging?.url && !(caps.reviewComments && !reviewing)
                ? "ml-auto"
                : undefined
            }
            icon={!merging && !confirmMerge ? <IconGitMerge size={18} /> : undefined}
            disabled={merging}
            onClick={handleMerge}
            title="Squash and merge this pull request"
          >
            {merging
              ? "Merging…"
              : confirmMerge
                ? "Confirm merge"
                : headerCompact
                  ? "Merge"
                  : "Squash and merge"}
          </Button>
        )}
        <Menu.Root>
          <Tooltip label="Pull request actions">
            <Menu.Trigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="-mr-1.5"
                  aria-label="Pull request actions"
                  icon={<IconDotsHorizontal size={18} />}
                />
              }
            />
          </Tooltip>
          <Menu.Popup align="end">
            <Menu.Item
              render={<a href={pr.url} target="_blank" rel="noopener" />}
            >
              <BrandMark name={provider.key} size={18} className={MENU_ICON} />
              <span className="min-w-0 flex-1 truncate">
                Open on {provider.name}
              </span>
            </Menu.Item>
            {pr.staging?.url && (
              <Menu.Item
                render={
                  <a
                    href={pr.staging.url}
                    target="_blank"
                    rel="noopener"
                  />
                }
              >
                <IconGlobe size={18} className={MENU_ICON} />
                <span className="min-w-0 flex-1 truncate">Open preview</span>
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() =>
                copyPrLink(pr.url, { toast: "Pull request link copied" })
              }
            >
              <IconCopy size={18} className={MENU_ICON} />
              <span className="min-w-0 flex-1 truncate">Copy PR link</span>
            </Menu.Item>
            {pr.state === "OPEN" && (
              <>
                <Menu.Separator />
                {canMergeAfterReview && (
                  <Menu.Item
                    onClick={handleMerge}
                    closeOnClick={confirmMerge}
                    disabled={merging}
                  >
                    <IconGitMerge size={18} className={MENU_ICON} />
                    {merging
                      ? "Merging…"
                      : confirmMerge
                        ? "Confirm squash and merge"
                        : "Squash and merge"}
                  </Menu.Item>
                )}
                <Menu.Item
                  className="text-red data-[highlighted]:bg-red-soft"
                  onClick={handleClose}
                  closeOnClick={confirmClose}
                  disabled={closing}
                >
                  <IconX size={18} className={MENU_ICON} />
                  {closing
                    ? "Closing…"
                    : confirmClose
                      ? "Confirm close pull request"
                      : "Close pull request"}
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Root>
      </header>

      {caps.stacks && (
        <StackSection
          pr={pr}
          sessionId={sessionId}
          repo={active?.repo}
          onOpenPr={onOpenPr}
          onLinked={load}
        />
      )}
      {reviewBar}

      <div className="flex min-h-0 flex-1">
        {page === "files" && fileListMode !== "hidden" && files.length > 0 && (
          <PrFileTree
            files={reviewFiles}
            mode={fileListMode}
            showFileStats={fileStatsSetting === "1"}
            onOpenFile={scrollToFile}
          />
        )}

        <main
          className={`min-w-0 flex-1 overflow-y-auto bg-surface [--review-file-header-top:0px] ${reviewing ? "pb-24 phone:pb-36" : "pb-4"}`}
        >
          {page === "overview" ? (
            <SelectionToSession
              sessionId={sessionId}
              label={`${provider.changeAbbr} #${pr.number}`}
              send={send}
            >
              <div
                className={`mx-auto w-full max-w-[1120px] px-6 py-6 phone:px-3 ${railStacked ? "flex flex-col gap-6" : "flex gap-8"}`}
              >
                {railStacked && rail}
                <div className="flex min-w-0 flex-1 flex-col gap-5">
                  {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
                  <ConversationView
                    author={pr.author}
                    descriptionHtml={bodyHtml}
                    comments={comments}
                    repo={markdownRepo}
                    onAddToInput={onAddToInput}
                    pr={pr}
                  />
                </div>
                {!railStacked && rail}
              </div>
            </SelectionToSession>
          ) : (
            // The same 24px inset the chrome rows above use, so a file card's
            // edges land under the tab strip's first tab and the view control's
            // right edge rather than 4px inside them.
            <div className="mx-auto max-w-[1500px] px-6 py-6 phone:px-2">
              {codeView === "flow" ? (
                <CodeFlow
                  data={codeFlow?.key === codeFlowKey ? codeFlow.data : null}
                  loading={
                    codeFlowLoading ||
                    (codeFlow?.key !== codeFlowKey && !codeFlowError)
                  }
                  error={codeFlowError}
                  onRetry={() => void refreshCodeFlow()}
                  onOpenLocation={scrollToFile}
                />
              ) : !diff?.patch || !diffProps ? (
                <div className="py-12 text-center text-sm text-faint">
                  {diffError ? (
                    <>
                      <span className="text-red">{diffError}</span>
                      <button
                        className="ml-2 border-0 bg-transparent text-link"
                        onClick={() => {
                          setDiffLoading(true);
                          setDiffError(null);
                          void load(true);
                        }}
                      >
                        Retry
                      </button>
                    </>
                  ) : diffLoading ? (
                    "Loading pull request changes…"
                  ) : diffOutOfDate ? (
                    "The pull request changed while loading. It will refresh automatically."
                  ) : (
                    "No text diff is available for this pull request."
                  )}
                </div>
              ) : codeView === "guide" ? (
                guideLoading || (!currentGuide && !guideFailed) ? (
                  <>
                    <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                      Writing the review guide… You can review the file diff
                      while it groups the change by intent.
                    </div>
                    <CommentableDiff patch={diff.patch} {...diffProps} />
                  </>
                ) : guideFailed ? (
                  <div className="py-12 text-center text-sm text-faint">
                    Couldn't generate a guide for this PR.
                    <button
                      className="ml-2 border-0 bg-transparent text-link"
                      onClick={() => void loadGuide()}
                    >
                      Retry
                    </button>
                  </div>
                ) : currentGuide ? (
                  <>
                    <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                      <div className="text-meta font-medium leading-relaxed text-faint">
                        Review guide
                      </div>
                      <div>
                        <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                          {currentGuide.sections.length} focused review step
                          {currentGuide.sections.length === 1 ? "" : "s"}
                        </h2>
                        <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                          {reviewing
                            ? "Review the change by intent rather than alphabetically. Comments stay pending until you finish the review."
                            : "Read the change by intent rather than alphabetically."}
                        </p>
                      </div>
                    </div>
                    {guideSections.map((section, index, all) => (
                      <section
                        id={`review-guide-${index}`}
                        className="mb-8 scroll-mt-[64px]"
                        key={`${section.title}-${index}`}
                      >
                        <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                          <div className="text-meta text-faint">
                            {String(index + 1).padStart(2, "0")} /{" "}
                            {String(all.length).padStart(2, "0")}
                          </div>
                          <div>
                            <div className="text-item-title font-semibold text-fg">
                              {section.title}
                            </div>
                            <div className="mt-1 text-meta leading-relaxed text-dim">
                              {section.explanation}
                            </div>
                          </div>
                        </div>
                        {section.patch && (
                          <CommentableDiff
                            patch={section.patch}
                            {...diffProps}
                          />
                        )}
                      </section>
                    ))}
                  </>
                ) : null
              ) : (
                <CommentableDiff
                  patch={diff.patch}
                  {...diffProps}
                  groups={
                    grouping === "ai" && diffGroups?.oid === diff.headRefOid
                      ? diffGroups.groups || undefined
                      : undefined
                  }
                  groupsLoading={grouping === "ai" && diffGroupsLoading}
                />
              )}
            </div>
          )}
        </main>
      </div>

      {sessionsOpen && (
        <>
          <button
            className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
            aria-label="Close sessions"
            onClick={() => setSessionsOpen(false)}
          />
          <div
            className={`absolute right-5 ${showBar ? "top-[108px]" : "top-16"} z-30 w-[460px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 smooth-shadow-lg`}
          >
            <div className="mb-2 flex items-center">
              <span className="text-sm font-semibold text-fg">
                Sessions on this PR
              </span>
              <button
                className="ml-auto border-0 bg-transparent text-item-title text-faint hover:text-fg"
                onClick={() => setSessionsOpen(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <PrSessionsList
              sessions={relatedSessions}
              repo={active?.repo || ""}
              branch={active?.branch}
              pr={pr}
              currentSessionId={sessionId || undefined}
              onOpenSession={(id) => {
                setSessionsOpen(false);
                onOpenSessionById?.(id);
              }}
              send={send}
              addHandler={addHandler}
              compose
            />
          </div>
        </>
      )}

      {/* Review controls only exist while the person is actively reviewing.
          Passive PR browsing should not imply that a review is in progress. */}
      {reviewing && (
        <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-10 flex min-h-[54px] items-center gap-3 rounded-md border border-line-strong bg-panel/95 px-3 py-2 smooth-shadow-soft backdrop-blur phone:flex-col phone:items-stretch phone:gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              {reviewDone === "merged"
                ? "Approved and merged"
                : reviewDone
                  ? "Review submitted"
                  : !caps.reviewComments
                    ? "Review"
                    : pending.length > 0
                      ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                      : "No pending comments"}
            </div>
            <div
              className={`mt-0.5 truncate text-meta ${closeError ? "text-red" : "text-faint"}`}
              title={closeError || undefined}
            >
              {closeError ||
                (caps.reviewComments
                  ? "Comments are sent together when you finish the review"
                  : `${provider.name} has no reviews. Merge or close when you're done.`)}
            </div>
          </div>
          <div className="pointer-events-auto flex shrink-0 flex-wrap justify-end gap-2">
            {onOpenSession && (
              <Button
                variant="soft"
                className="text-xs"
                onClick={onOpenSession}
              >
                Open workspace
              </Button>
            )}
            <Button
              variant="soft"
              className="text-xs"
              onClick={() => setReviewing(false)}
            >
              Exit review
            </Button>
            {pr.state === "OPEN" && !pr.isDraft && caps.reviewComments && (
              <Button
                variant="success"
                className="text-xs"
                onClick={() => setReviewOpen(true)}
              >
                Finish review
              </Button>
            )}
          </div>
        </div>
      )}

      {reviewOpen && (
        <FinishReviewDialog
          prNumber={pr.number}
          pendingCount={pending.length}
          event={reviewEvent}
          onEventChange={setReviewEvent}
          defaultSummary={summaryDraft}
          canMerge={canMergeAfterReview}
          mergeAfterReview={mergeAfterReview}
          onMergeAfterReviewChange={setMergeAfterReview}
          error={reviewError || mergeError}
          submitting={submitting}
          submitLabel={reviewSubmitLabel}
          onSubmit={handleSubmitReview}
          onClose={(summary) => {
            setSummaryDraft(summary);
            setReviewOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The review canvas' "Finish review" dialog: pick a verdict, add an optional
 * summary, submit.
 *
 * Approving and merging are separate decisions, so they are separate controls.
 * The verdict rows are the choice; merging is an opt-in that starts off, which
 * keeps the primary action "Approve" until someone asks for more.
 *
 * The summary is held here rather than by the canvas: the canvas re-renders the
 * whole diff, and this is a field someone types a paragraph into. It is seeded
 * from `defaultSummary` and handed back on both exits, so closing the dialog
 * and reopening it still finds the draft.
 */
function FinishReviewDialog({
  prNumber,
  pendingCount,
  event,
  onEventChange,
  defaultSummary,
  canMerge,
  mergeAfterReview,
  onMergeAfterReviewChange,
  error,
  submitting,
  submitLabel,
  onSubmit,
  onClose,
}: {
  prNumber: number;
  pendingCount: number;
  event: ReviewEvent;
  onEventChange: (event: ReviewEvent) => void;
  defaultSummary: string;
  canMerge: boolean;
  mergeAfterReview: boolean;
  onMergeAfterReviewChange: (merge: boolean) => void;
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (summary: string) => void;
  onClose: (summary: string) => void;
}) {
  const [summary, setSummary] = useState(defaultSummary);
  const open = useEnterOnMount();
  // Without this Base UI focuses the first tabbable, which is the header's
  // close. A focus ring on the ✕ is the wrong first read for a dialog you
  // opened in order to write in it.
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const verdicts: Array<{ event: ReviewEvent; label: string; hint: string }> = [
    { event: "APPROVE", label: "Approve", hint: "Sign off on these changes" },
    {
      event: "COMMENT",
      label: "Comment",
      hint: "Leave feedback without a verdict",
    },
    {
      event: "REQUEST_CHANGES",
      label: "Request changes",
      hint: "Ask for another pass before merging",
    },
  ];
  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose(summary)}>
      <Modal.Content widthClassName="max-w-[30rem]" initialFocus={summaryRef}>
        <Modal.Header
          title="Finish review"
          description={
            pendingCount > 0
              ? `Your ${pendingCount} pending comment${pendingCount === 1 ? "" : "s"} on #${prNumber} are sent with this review.`
              : `Leave a review on #${prNumber}.`
          }
        />
        <div
          className="flex flex-col gap-1.5"
          role="radiogroup"
          aria-label="Review verdict"
        >
          {verdicts.map((verdict) => (
            <button
              key={verdict.event}
              type="button"
              role="radio"
              aria-checked={event === verdict.event}
              data-active={event === verdict.event || undefined}
              className="group focus-ring flex cursor-pointer items-start gap-2.5 rounded-row border border-line bg-surface px-3 py-2.5 text-left transition-[background-color,border-color] hover:bg-hover data-active:border-accent data-active:bg-accent-soft"
              onClick={() => onEventChange(verdict.event)}
            >
              <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong transition-colors group-data-active:border-accent group-data-active:bg-accent">
                <span className="size-1.5 rounded-full bg-on-accent opacity-0 group-data-active:opacity-100" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label font-semibold text-fg">
                  {verdict.label}
                </span>
                <span className="text-meta text-dim">{verdict.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <Textarea
          ref={summaryRef}
          size="sm"
          className="h-20 resize-none"
          placeholder={
            event === "APPROVE" || pendingCount > 0
              ? "Summary (optional)"
              : "Summary"
          }
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        {event === "APPROVE" && canMerge && (
          // Quieter than the verdict rows on purpose: merging is an extra you
          // opt into here, not a fourth thing to choose between.
          <label className="flex cursor-pointer items-center gap-2.5 px-0.5">
            <Checkbox
              checked={mergeAfterReview}
              onCheckedChange={onMergeAfterReviewChange}
            />
            <span className="text-supporting text-dim">
              Squash and merge as well
            </span>
          </label>
        )}
        {error && <div className="text-supporting text-red">{error}</div>}
        <Modal.Footer>
          <Button onClick={() => onClose(summary)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => onSubmit(summary)}
            disabled={submitting}
          >
            {submitting ? "Submitting…" : submitLabel}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
