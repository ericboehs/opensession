import { repoLabel } from "../lib/repo-label";
import { AGENT_NAME } from "../lib/brand";
import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
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
import { CommentableDiff, type CommentTarget, type PendingComment } from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { renderMarkdown } from "../lib/markdown";
import { useMarkdownRepo } from "./MarkdownBody";
import { isOutdatedReviewComment } from "../lib/pr-comments";
import { providerFromUrl, prCapabilities } from "../lib/provider";
import { pollWhileVisible, PR_WEBHOOK_FALLBACK_POLL_MS } from "../lib/poll";
import { Textarea } from "../ui/input";
import {
  IconCheck,
  IconDotsHorizontal,
  IconMessage,
  IconReturn,
  IconX,
  IconFile,
} from "./icons";
import { Menu, MENU_ICON } from "../ui/menu";
import { Tooltip } from "../ui/tooltip";

import { checkClass, deriveStatus, isDeployment, summarize } from "../lib/pr-status-derive";
import {
  CHECKS_GROUP,
  GIT_NOTE,
  PR_BODY_CLAMPED,
  PR_BODY_MD,
  PR_BODY_TOGGLE,
  PR_COMMENT_ADD,
  PR_COMMENT_AUTHOR,
  PR_COMMENT_BODY,
  PR_COMMENT_LINK,
  PR_COMMENT_META,
  PR_COMMENT_ROW,
  PR_COMMENT_SELECT,
  PR_COMMENTS_ADD_ALL,
  PR_GUIDE_COUNT,
  PR_GUIDE_EXPL,
  PR_GUIDE_SECTION,
  PR_GUIDE_TITLE,
  PR_REPO_TAB_X,
  PR_REPO_TABS,
  prRepoTabClass,
} from "../lib/pr-tone-classes";
import {
  formatPendingCommentsPrompt,
  formatPrCommentPrompt,
  formatPrCommentsPrompt,
  stripHtmlComments,
} from "../lib/pr-prompts";
import { CheckRow } from "./pr/CheckRow";
import { PrStateIcon } from "./pr/PrStateIcon";
import { ChecksView, CommitIcon, CommitsView, ConversationView } from "./pr/PrViews";
import { LinkPrControl } from "./pr/LinkPrControl";
import { PrCard } from "./pr/PrCard";
import { StackCard, StackSection } from "./pr/Stack";
import { FileRow, ReviewerRow } from "./pr/PrRows";
import { GitDivergenceStrip, GitStatusRows } from "./pr/GitStatus";
import { InlineAlert, LoadingState } from "../ui/state";
import { CodeFlow } from "./CodeFlow";
import { revealDiffFile } from "../lib/diff-navigation";

// Re-exported so existing importers of these (formerly local) helpers keep working.
export { checkClass, isDeployment, formatPrCommentPrompt, CheckRow, PrStateIcon };

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open workspace" action (used by the Reviews view). */
  onOpenSession?: () => void;
  /** Append PR/check/comment context to this session's composer draft. */
  onAddToInput?: (text: string) => void;
  /** Side-by-side info|diff layout (Reviews drawer, session Review tab). */
  split?: boolean;
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
   * Preselect one of the targets — the PR chips in the Workspace strip open the
   * Review tab on a specific PR. `seq` is bumped per click so clicking the same
   * chip again re-focuses it after the user has switched tabs by hand.
   */
  focusTarget?: { repo?: string; branch?: string; view?: "checks"; seq: number };
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
  /** Diff-first review canvas used by the Pull requests sidebar inbox. */
  reviewCanvas?: boolean;
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

/**
 * One selectable PR in the panel: the primary repo's, an attached repo's, or a
 * manually linked one. Primary/attached target by repo id (the server resolves
 * the branch); linked PRs carry an explicit branch since they can live on any
 * branch — including another branch of the primary repo.
 */
interface PrTarget {
  key: string;
  repo: string;
  branch?: string;
  primary?: boolean;
  linked?: boolean;
  /** Found via the session link in the PR body, not stored on the session. */
  discovered?: boolean;
  label: string;
}

/** First target per key wins — a PR reached two ways (linked and discovered,
 *  or an attached repo whose branch also carries a discovered PR) is one tab. */
function dedupeTargets(targets: PrTarget[]): PrTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    // An attached/primary repo tab has no branch of its own (the server
    // resolves it), so it can't collide with a branch-keyed target.
    const key = t.branch ? `${t.repo}\u0000${t.branch}` : `repo:${t.repo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
  const resolve = (file: string): string | null => {
    if (byFile.has(file)) return file;
    for (const path of byFile.keys())
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
  split,
  repos,
  linkedPrs,
  discoveredPrs,
  focusTarget,
  linkable,
  send,
  walkthrough,
  reviewCanvas,
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
  const linked = linkedLocal ?? linkedPrs ?? [];
  const targets = useMemo<PrTarget[]>(
    () => dedupeTargets([
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
        linked: true,
        label: lp.number
          ? `${repoLabel(lp.repo)} #${lp.number}`
          : `${repoLabel(lp.repo)}:${lp.branch}`,
      })),
      // Last, so an explicit link (which owns the unlink affordance) wins the
      // dedupe over the same PR discovered from its body footer.
      ...(previewTarget ? [] : discoveredPrs ?? []).map((dp) => ({
        key: `${dp.repo} ${dp.branch}`,
        repo: dp.repo,
        branch: dp.branch,
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
  // A PR chip in the Workspace strip opened the Review tab on a specific PR.
  // Keyed on `seq` so re-clicking the same chip re-focuses it, and so a
  // re-render never fights the user's own tab choice.
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget.repo) {
      const match =
        targets.find(
          (t) =>
            t.repo === focusTarget.repo &&
            (focusTarget.branch ? t.branch === focusTarget.branch : !t.branch),
        ) ?? targets.find((t) => t.repo === focusTarget.repo);
      if (match) setActiveKey(match.key);
    }
    if (focusTarget.view) setDiffView(focusTarget.view);
  }, [focusTarget?.seq]);
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
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>(() =>
    reviewCanvas ? "APPROVE" : "COMMENT",
  );
  const [summary, setSummary] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewDone, setReviewDone] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [mergeAfterReview, setMergeAfterReview] = useState(reviewCanvas === true);
  const [checksOpen, setChecksOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [allFilesOpen, setAllFilesOpen] = useState(false);
  const [diffView, setDiffView] = useState<
    "guide" | "diff" | "flow" | "checks" | "conversation" | "commits"
  >(() => "diff");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
    const stored = localStorage.getItem("opensession-pr-diff-style");
    if (stored === "unified" || stored === "split") return stored;
    // Side-by-side columns don't fit a phone viewport, so phones default to unified.
    return window.matchMedia("(max-width: 720px)").matches ? "unified" : "split";
  });
  const changeDiffStyle = (style: "unified" | "split") => {
    setDiffStyle(style);
    try {
      localStorage.setItem("opensession-pr-diff-style", style);
    } catch {}
  };
  // Long lines scroll sideways by default (GitHub's behaviour). Wrapping keeps
  // them all on screen, which matters most in split view where each side is
  // half as wide.
  const [wrapLines, setWrapLines] = useState(
    () => localStorage.getItem("opensession-pr-diff-wrap") === "1",
  );
  const changeWrapLines = (wrap: boolean) => {
    setWrapLines(wrap);
    try {
      localStorage.setItem("opensession-pr-diff-wrap", wrap ? "1" : "0");
    } catch {}
  };
  const [guide, setGuide] = useState<ReviewGuideData | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  const [codeFlow, setCodeFlow] = useState<{ key: string; data: CodeFlowResult } | null>(null);
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
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const loadGenerationRef = useRef(0);
  const activeLoadTargetRef = useRef(loadTargetKey);
  const loadInFlightRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  activeLoadTargetRef.current = loadTargetKey;

  const load = useCallback((force = false): Promise<void> => {
    if (loadTargetKey !== activeLoadTargetRef.current) return Promise.resolve();
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
    const prRequest = (previewTarget
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
        if (isCurrent()) setLoadError(e?.message || "Failed to load the pull request.");
        commitDiff();
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const diffRequest = (previewTarget
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
        if (isCurrent()) setDiffError(e?.message || "Failed to load pull request changes.");
        commitDiff();
      });
    // A linked PR has no local worktree in this session — no git state.
    const gitRequest = (previewTarget || active?.linked
      ? Promise.resolve(null)
      : fetchGitStatus(sessionId, active?.repo)
    )
      .then((data) => {
        if (isCurrent()) setGit(data);
      })
      .catch(() => {
        if (isCurrent()) setGit(null);
      });

    const promise = Promise.allSettled([prRequest, diffRequest, gitRequest]).then(
      () => undefined,
    );
    loadInFlightRef.current = { key: loadTargetKey, promise };
    void promise.then(() => {
      if (loadInFlightRef.current?.promise === promise) loadInFlightRef.current = null;
    });
    return promise;
  }, [
    sessionId,
    loadTargetKey,
    active?.repo,
    active?.branch,
    active?.linked,
    previewTarget?.repo,
    previewTarget?.branch,
  ]);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    setDiffLoading(true);
    setDiffError(null);
    setPr(null);
    setDiff(null);
    setGit(null);
    setPending([]);
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
    if (!diff?.patch || files.length < 3) {
      setDiffGroups(null);
      setDiffGroupsLoading(false);
      return;
    }
    setDiffGroups(null);
    setDiffGroupsLoading(true);
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retryLater = () => {
      retryTimer = setTimeout(() => setDiffGroupsRetry((attempt) => attempt + 1), 125_000);
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
    pr?.files?.length,
    diffGroupsRetry,
  ]);

  const loadGuide = useCallback(async () => {
    setGuideLoading(true);
    setGuideFailed(false);
    try {
      const data = previewTarget
        ? await fetchPrPreviewGuide(previewTarget.repo, previewTarget.branch)
        : await fetchReviewGuide(sessionId, active?.repo, active?.branch);
      if (data) setGuide(data);
      else setGuideFailed(true);
    } catch {
      setGuideFailed(true);
    } finally {
      setGuideLoading(false);
    }
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    previewTarget?.repo,
    previewTarget?.branch,
  ]);

  const prPatchVersion = diff?.diffVersion || "";
  const codeFlowKey = diff && prPatchVersion ? `${loadTargetKey}\0${diff.headRefOid}\0${prPatchVersion}` : "";
  const loadCodeFlow = useCallback(async () => {
    if ((!diff?.patch && !diff?.skippedFiles) || !codeFlowKey) return;
    const generation = ++codeFlowGenerationRef.current;
    setCodeFlowLoading(true);
    setCodeFlowError(null);
    try {
      const data = previewTarget
        ? await fetchPrPreviewCodeFlow(previewTarget.repo, previewTarget.branch)
        : await fetchPrCodeFlow(sessionId, active?.repo, active?.branch);
      if (!data) throw new Error("Code flow isn't available for this pull request.");
      if (data.diffVersion !== prPatchVersion) {
        if (generation === codeFlowGenerationRef.current) {
          setCodeFlowError("The pull request updated while code flow was loading. Try again.");
        }
        return;
      }
      if (generation === codeFlowGenerationRef.current)
        setCodeFlow({ key: codeFlowKey, data });
    } catch (error: any) {
      if (generation === codeFlowGenerationRef.current)
        setCodeFlowError(error?.message || "Couldn't load code flow.");
    } finally {
      if (generation === codeFlowGenerationRef.current) setCodeFlowLoading(false);
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
  useEffect(() => {
    if (diffView !== "guide" || !diff?.patch) return;
    if (guideLoading || guideFailed) return;
    if (guide && guide.headRefOid === diff.headRefOid) return;
    void loadGuide();
  }, [diffView, diff?.patch, diff?.headRefOid, guide, guideLoading, guideFailed, loadGuide]);

  useEffect(() => {
    if (diffView !== "flow" || codeFlowLoading || codeFlowError) return;
    if (!diff?.patch && !diff?.skippedFiles) {
      if (diffLoading || diffOutOfDate) return;
      setDiffView("diff");
      return;
    }
    if (codeFlow && codeFlow.key !== codeFlowKey) {
      setCodeFlowError("The pull request updated. Refresh code flow to analyze the latest diff.");
      return;
    }
    if (!codeFlow) void loadCodeFlow();
  }, [diffView, diff?.patch, diffLoading, diffOutOfDate, codeFlow, codeFlowKey, codeFlowLoading, codeFlowError, loadCodeFlow]);

  // Conversation stays first in the DOM, but narrow screens should still reveal
  // the selected tab (Files changed is the default review surface).
  useEffect(() => {
    if (!reviewCanvas) return;
    requestAnimationFrame(() => {
      const tab = rootRef.current?.querySelector<HTMLElement>(
        '[role="tablist"] [aria-selected="true"]',
      );
      const tabList = tab?.parentElement;
      if (!tab || !tabList || tabList.scrollWidth <= tabList.clientWidth) return;
      tabList.scrollTo({
        left: tab.offsetLeft - (tabList.clientWidth - tab.offsetWidth) / 2,
      });
    });
  }, [diffView, pr?.number, reviewCanvas]);

  // Inline comments don't post one-by-one — they accumulate as pending and ship
  // together when the reviewer finishes the review (the provider's native flow).
  async function handleAddPending(target: CommentTarget, text: string) {
    setPending((prev) => [...prev, { ...target, text, id: crypto.randomUUID() }]);
    setReviewDone(null);
  }

  function handleRemovePending(id: string) {
    setPending((prev) => prev.filter((c) => c.id !== id));
  }

  async function handleSubmitReview() {
    if (submitting) return;
    const actionTargetKey = loadTargetKey;
    if (
      pending.length === 0 &&
      !summary.trim() &&
      reviewEvent !== "APPROVE"
    ) {
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
          side: (c.side === "deletions" ? "LEFT" : "RIGHT") as
            | "LEFT"
            | "RIGHT",
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
      if (reviewCanvas && reviewEvent === "APPROVE" && mergeAfterReview) {
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
      setSummary("");
      setReviewOpen(false);
      setReviewEvent(reviewCanvas ? "APPROVE" : "COMMENT");
      setReviewDone(merged ? "merged" : result.url || "submitted");
      setTimeout(() => setReviewDone(null), 6000);
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
      if (actionTargetKey === activeLoadTargetRef.current)
        setMergeError(e.message || "Merge failed");
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
      return cls === "check-failure" ? 0 : cls === "check-pending" ? 1 : cls === "check-success" ? 3 : 2;
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
    // The mirrored walkthrough section is link-only (GitHub can't reach the
    // tailnet media) — drop it here, where WalkthroughCard renders the real thing.
    const stripped = pr.body
      .replace(
        /<!-- opensession:walkthrough -->[\s\S]*?<!-- \/opensession:walkthrough -->/,
        "",
      )
      .trim();
    return stripped ? renderMarkdown(stripped, { repo: markdownRepo }) : "";
  }, [pr?.body, markdownRepo]);
  const provider = useMemo(() => providerFromUrl(pr?.url), [pr?.url]);
  // Host capability gating: absent (GitHub, older cache entries) means all
  // true, so nothing GitHub-shaped ever disappears. code.storage payloads
  // carry an explicit set (no checks/reviewers/comments/viewed state/stacks).
  const caps = prCapabilities(pr?.capabilities);

  // Landing on the checks tab of a PR whose host has none (tab switch from a
  // GitHub PR, a stale focusTarget) would strand the view on a hidden tab.
  useEffect(() => {
    if (!caps.checks && diffView === "checks") setDiffView("diff");
  }, [caps.checks, diffView]);

  // Only offer the expand toggle when the clamped description is actually taller
  // than its collapsed height — a two-line PR body shouldn't get a "Show more".
  useEffect(() => {
    if (bodyOpen) return;
    const el = bodyRef.current;
    setBodyOverflows(!!el && el.scrollHeight - el.clientHeight > 4);
  }, [bodyHtml, bodyOpen]);

  // Files card → diff: scroll the matching file section into view (and open it).
  const scrollToFile = useCallback((path: string) => {
    if (diffView === "flow") {
      setDiffView("diff");
      requestAnimationFrame(() => requestAnimationFrame(() => revealDiffFile(rootRef.current, path)));
      return;
    }
    revealDiffFile(rootRef.current, path);
  }, [diffView]);

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
        setPrViewed({ key: viewedKey, prId: res.prId, viewed: new Set(res.viewed) });
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
        <LinkPrControl sessionId={sessionId} variant="tab" onLinked={handleLinked} />
      )}
    </div>
  ) : null;

  if (loading)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {switcher}
        <LoadingState>Loading pull request…</LoadingState>
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
        <div className={`flex min-h-0 flex-1 flex-col ${reviewCanvas ? "h-full overflow-y-auto" : ""}`}>
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
                <LinkPrControl sessionId={sessionId} variant="action" onLinked={handleLinked} />
              </div>
            )}
        </div>
      </div>
    );

  const status = deriveStatus(pr);
  const files = pr.files || [];
  const reviewers = pr.reviewers || [];
  // Bot bookkeeping comments are pure HTML markers — hide them, and strip
  // leading markers from real comments' previews.
  const comments = (pr.comments || []).filter(
    (c) => stripHtmlComments(c.body) && !isOutdatedReviewComment(c.body),
  );

  if (reviewCanvas) {
    const canMergeAfterReview =
      pr.state === "OPEN" &&
      !pr.isDraft &&
      pr.mergeable !== "CONFLICTING" &&
      checkSummary.failed === 0 &&
      checkSummary.pending === 0;
    const guideSections =
      guide && diff?.patch ? sectionsWithPatches(guide, diff.patch) : [];
    const reviewSubmitLabel =
      reviewEvent === "APPROVE"
        ? mergeAfterReview && canMergeAfterReview
          ? "Approve & merge"
          : "Approve"
        : reviewEvent === "REQUEST_CHANGES"
          ? "Request changes"
          : "Submit review";
    return (
      <div
        className="selectable relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
        data-review-canvas="true"
        ref={rootRef}
      >
        {switcher}

        {/* The whole PR — title, branch line, git status, stack, tabs — lives
            inside the one scroll container so the identity scrolls away with
            the diff. Only the tab row sticks, so the reviewer keeps a way back
            to Conversation/Commits/Checks once they're deep in a file. */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-surface pb-24 [--review-file-header-top:106px] phone:pb-36">
          <header className="flex min-h-[96px] shrink-0 items-center gap-5 px-6 py-4 phone:min-h-[78px] phone:px-3">
            <div className="min-w-0 flex-1">
              <a
                className="block truncate text-page-title font-semibold tracking-[-0.025em] text-fg no-underline hover:text-link phone:text-section-title"
                href={pr.url}
                target="_blank"
                rel="noopener"
              >
                {pr.title} <span className="font-normal text-faint">#{pr.number}</span>
              </a>
              <div className="mt-2 flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-dim">
                <span className="truncate">
                  <strong>{pr.author}</strong> wants to merge {pr.commits?.length || 0} commit{pr.commits?.length === 1 ? "" : "s"} into
                  {" "}<span className="rounded-sm bg-blue-soft px-1.5 py-0.5 text-blue">{pr.baseRefName}</span>
                  {" "}from <span className="rounded-sm bg-blue-soft px-1.5 py-0.5 text-blue">{pr.headRefName}</span>
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 max-[760px]:hidden">
              {sessions && (
                <button
                  className="border-0 bg-transparent px-1 py-2 text-xs font-medium text-dim hover:text-fg"
                  onClick={() => setSessionsOpen(true)}
                  title="Sessions linked to this PR"
                >
                  Sessions{relatedSessions.length > 0 ? ` · ${relatedSessions.length}` : ""}
                </button>
              )}
              {pr.staging?.url && (
                <a
                  className="px-1 py-2 text-xs font-medium text-dim no-underline hover:text-fg"
                  href={pr.staging.url}
                  target="_blank"
                  rel="noopener"
                >
                  Preview
                </a>
              )}
              {onOpenSession && (
                <button
                  className="border-0 bg-transparent px-1 py-2 text-xs font-medium text-dim hover:text-fg"
                  onClick={onOpenSession}
                >
                  Open workspace
                </button>
              )}
            </div>
          </header>

          {/* Only the branch work that is still outstanding — the PR verdict and
              its Merge button belong to the session header's status bar, which is
              on screen whether or not the workspace panel is open. */}
          <GitDivergenceStrip
            git={git}
            pr={pr}
            sessionId={sessionId}
            repo={active?.repo}
            send={send}
            onRefresh={load}
            onMerge={handleMerge}
            merging={merging}
            confirmMerge={confirmMerge}
          />

          {/* Where this PR sits in its chain of layers — directly under Git
              status, because it reframes what that status means. */}
          {caps.stacks && (
            <StackSection pr={pr} sessionId={sessionId} repo={active?.repo} onOpenPr={onOpenPr} onLinked={load} />
          )}

          {/* The row's bottom line is an inset shadow, not a border: the active tab
              covers it with its own surface-coloured bottom border while sitting
              flush inside the box, so nothing overflows vertically (a 1px overflow
              here parks a scrollbar, since legacy.css opts Chrome out of overlay
              scrollbars). Horizontal scrollbars are hidden for the same reason. */}
          <div
            className="sticky top-0 z-[8] flex h-[52px] shrink-0 items-end gap-1 overflow-x-auto overflow-y-hidden bg-surface px-6 shadow-[inset_0_-1px_0_var(--border)] [scrollbar-width:none] phone:px-2 [&::-webkit-scrollbar]:hidden"
            role="tablist"
          >
            {([
              ["conversation", "Conversation", comments.length, <IconMessage size={17} />],
              ["commits", "Commits", pr.commits?.length || 0, <CommitIcon />],
              ["checks", "Checks", checkSummary.total, <IconCheck size={17} />],
              ["diff", "Files changed", files.length, <IconFile size={17} />],
            ] as const)
              .filter(([key]) => key !== "checks" || caps.checks)
              .map(([key, label, count, icon]) => {
              const activeTab = key === "diff" ? diffView === "diff" || diffView === "guide" || diffView === "flow" : diffView === key;
              return (
                <button
                  key={key}
                  role="tab"
                  aria-selected={activeTab}
                  className={`flex h-[44px] shrink-0 items-center gap-2 rounded-t-md border px-4 text-control-label font-medium ${activeTab ? "border-line border-b-surface bg-surface text-fg" : "border-transparent bg-transparent text-dim hover:border-line hover:bg-hover hover:text-fg"}`}
                  onClick={() => setDiffView(key)}
                >
                  {icon}
                  {label}
                  <span className="rounded-full bg-active px-2 py-0.5 text-meta font-semibold text-dim">{count}</span>
                </button>
              );
            })}
            <span className="ml-auto mb-3 shrink-0 text-meta phone:hidden">
              <span className="text-green">+{pr.additions}</span>{" "}
              <span className="text-red">−{pr.deletions}</span>
            </span>
          </div>

          {(diffView === "diff" || diffView === "guide" || diffView === "flow") && (
            <div className="sticky top-[52px] z-[7] flex h-[54px] items-center gap-2 overflow-x-auto border-b border-line bg-surface/95 px-6 backdrop-blur [scrollbar-width:none] phone:px-2 [&::-webkit-scrollbar]:hidden">
              <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`rounded-sm border-0 px-3 py-1.5 text-xs font-medium ${diffView === "diff" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                  onClick={() => setDiffView("diff")}
                  aria-pressed={diffView === "diff"}
                >
                  All changes
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`rounded-sm border-0 px-3 py-1.5 text-xs font-medium ${diffView === "guide" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                  onClick={() => setDiffView("guide")}
                  aria-pressed={diffView === "guide"}
                >
                  Review guide
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={`rounded-sm border-0 px-3 py-1.5 text-xs font-medium ${diffView === "flow" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                  onClick={() => {
                    if (diffView !== "flow" && codeFlowError) {
                      setCodeFlow(null);
                      setCodeFlowError(null);
                    }
                    setDiffView("flow");
                  }}
                  aria-pressed={diffView === "flow"}
                  disabled={(!diff?.patch && !diff?.skippedFiles) || !prPatchVersion}
                >
                  Code flow
                </Button>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-3">
                {handEdited.length > 0 && send && (
                  <Button
                    variant="default"
                    size="xs"
                    className="min-h-0 px-2 py-0.5 text-meta"
                    onClick={tellAgentAboutEdits}
                    title="Sends a note listing your hand-edits so they get committed and pushed"
                  >
                    Tell {AGENT_NAME} about {handEdited.length} edit
                    {handEdited.length === 1 ? "" : "s"}
                  </Button>
                )}
                {pending.length > 0 && (
                  <span className="text-meta text-faint">
                    {pending.length} pending comment{pending.length === 1 ? "" : "s"}
                  </span>
                )}
                {diffView !== "flow" && <div className="inline-flex rounded-md border border-line bg-panel p-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`rounded-sm border-0 px-2.5 py-1 text-meta font-medium ${diffStyle === "unified" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                    onClick={() => changeDiffStyle("unified")}
                  >
                    Unified
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`rounded-sm border-0 px-2.5 py-1 text-meta font-medium ${diffStyle === "split" ? "bg-active text-fg" : "hover:bg-transparent"}`}
                    onClick={() => changeDiffStyle("split")}
                  >
                    Split
                  </Button>
                </div>}
                {diffView !== "flow" && (
                  <Menu.Root>
                    <Tooltip label="Diff options">
                      <Menu.Trigger
                        render={
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label="Diff options"
                            icon={<IconDotsHorizontal size={18} />}
                          />
                        }
                      />
                    </Tooltip>
                    <Menu.Popup align="end">
                      <Menu.CheckboxItem
                        checked={wrapLines}
                        onCheckedChange={changeWrapLines}
                        closeOnClick
                      >
                        <IconReturn size={18} className={MENU_ICON} />
                        <span className="min-w-0 flex-1 truncate">Wrap long lines</span>
                        {wrapLines && <IconCheck className="shrink-0 text-accent" size={17} />}
                      </Menu.CheckboxItem>
                    </Menu.Popup>
                  </Menu.Root>
                )}
              </div>
            </div>
          )}

          <div className={`${diffView === "diff" || diffView === "guide" || diffView === "flow" ? "mx-auto max-w-[1500px] px-5 py-5 phone:px-2" : "mx-auto max-w-[900px] px-5 py-7 phone:px-3"}`}>
              {diffView === "checks" ? (
                <ChecksView
                  checks={checkSummary.checks}
                  deployments={checkSummary.deployments}
                />
              ) : diffView === "commits" ? (
                <CommitsView commits={pr.commits || []} showNotes={caps.commitNotes} />
              ) : diffView === "conversation" ? (
                <div className="flex flex-col gap-5">
                  {walkthrough && (
                    <WalkthroughCard walkthrough={walkthrough} />
                  )}
                  <ConversationView
                    author={pr.author}
                    descriptionHtml={bodyHtml}
                    comments={comments}
                    repo={markdownRepo}
                  />
                </div>
              ) : diffView === "flow" ? (
                <CodeFlow
                  data={codeFlow?.key === codeFlowKey ? codeFlow.data : null}
                  loading={codeFlowLoading || (codeFlow?.key !== codeFlowKey && !codeFlowError)}
                  error={codeFlowError}
                  onRetry={() => void refreshCodeFlow()}
                  onOpenLocation={scrollToFile}
                />
              ) : !diff?.patch ? (
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
                  ) : diffLoading
                    ? "Loading pull request changes…"
                    : diffOutOfDate
                      ? "The pull request changed while loading. It will refresh automatically."
                      : "No text diff is available for this pull request."}
                </div>
              ) : diffView === "guide" ? (
                guideLoading ? (
                  <>
                    <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                      Writing the review guide… You can review the file diff while it groups the change by intent.
                    </div>
                    <CommentableDiff
                      patch={diff.patch}
                      diffStyle={diffStyle}
                      wrapLines={wrapLines}
                      stickyFileHeaders
                      defaultExpandedFiles={Infinity}
                      viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                      onToggleViewed={handleToggleViewed}
                      disabled={!caps.reviewComments}
                      disabledHint={`Inline review comments aren't supported on ${provider.name}`}
                      submitLabel="Add comment"
                      placeholder={`Comment on #${diff.number}, added to your pending review…`}
                      pendingComments={pending}
                      onRemovePending={handleRemovePending}
                      onSubmit={handleAddPending}
                      imageSrcs={imageSrcs}
                      editFile={editFile}
                    />
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
                ) : guide ? (
                  <>
                    <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                      <div className="text-meta font-medium leading-relaxed text-faint">
                        Review guide
                      </div>
                      <div>
                        <h2 className="m-0 text-item-title font-semibold tracking-[-0.01em] text-fg">
                          {guide.sections.length} focused review step{guide.sections.length === 1 ? "" : "s"}
                        </h2>
                        <p className="mt-1 max-w-[680px] text-xs leading-relaxed text-dim">
                          Review the change by intent rather than alphabetically. Comments stay pending until you finish the review.
                        </p>
                      </div>
                    </div>
                    {guideSections.map((section, index, all) => (
                      <section
                        id={`review-guide-${index}`}
                        className="mb-8 scroll-mt-[118px]"
                        key={`${section.title}-${index}`}
                      >
                        <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                          <div className="text-meta text-faint">
                            {String(index + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                          </div>
                          <div>
                            <div className="text-body font-semibold text-fg">{section.title}</div>
                            <div className="mt-1 text-meta leading-relaxed text-dim">
                              {section.explanation}
                            </div>
                          </div>
                        </div>
                        {section.patch && (
                          <CommentableDiff
                            patch={section.patch}
                            diffStyle={diffStyle}
                            wrapLines={wrapLines}
                            stickyFileHeaders
                            defaultExpandedFiles={Infinity}
                            viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                            onToggleViewed={handleToggleViewed}
                            disabled={!caps.reviewComments}
                            disabledHint={`Inline review comments aren't supported on ${provider.name}`}
                            submitLabel="Add comment"
                            placeholder={`Comment on #${diff.number}, added to your pending review…`}
                            pendingComments={pending}
                            onRemovePending={handleRemovePending}
                            onSubmit={handleAddPending}
                            imageSrcs={imageSrcs}
                            editFile={editFile}
                          />
                        )}
                      </section>
                    ))}
                  </>
                ) : null
              ) : (
                <CommentableDiff
                  patch={diff.patch}
                  diffStyle={diffStyle}
                  wrapLines={wrapLines}
                  stickyFileHeaders
                  defaultExpandedFiles={Infinity}
                  viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                  onToggleViewed={handleToggleViewed}
                  disabled={!caps.reviewComments}
                  disabledHint={`Inline review comments aren't supported on ${provider.name}`}
                  submitLabel="Add comment"
                  placeholder={`Comment on #${diff.number}, added to your pending review…`}
                  pendingComments={pending}
                  onRemovePending={handleRemovePending}
                  onSubmit={handleAddPending}
                  imageSrcs={imageSrcs}
                  editFile={editFile}
                />
              )}
          </div>
        </main>

        {sessionsOpen && (
          <>
            <button
              className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
              aria-label="Close sessions"
              onClick={() => setSessionsOpen(false)}
            />
            <div className="absolute right-5 top-[92px] z-30 w-[460px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 smooth-shadow-lg">
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

        {/* Caption and actions share a row until the actions need the whole
            width — on a phone the three buttons alone are wider than the bar,
            so side-by-side pushed them off its right edge. */}
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
              <Button className="text-xs" onClick={onOpenSession}>
                Open workspace
              </Button>
            )}
            {/* Close lives here rather than at the foot of the Conversation tab:
                the bar is the one chrome visible from every sub-tab, and burying
                the only close affordance under a long comment list meant people
                went to GitHub for it. Two-click confirm, same as merge. */}
            {pr.state === "OPEN" && (
              <Button
                /* Outline while it's still a proposal, solid once the next
                   click commits — same pair the confirm modals use. */
                variant={confirmClose ? "destructive" : "danger"}
                className="text-xs"
                onClick={handleClose}
                disabled={closing}
                title="Close this pull request without merging. The branch and its commits stay available."
              >
                {closing ? "Closing…" : confirmClose ? "Confirm close" : "Close"}
              </Button>
            )}
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

        {reviewOpen && (
          <>
            <button
              className="absolute inset-0 z-20 cursor-default border-0 bg-black/25"
              aria-label="Close review form"
              onClick={() => setReviewOpen(false)}
            />
            <div className="absolute bottom-5 right-5 z-30 w-[430px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 smooth-shadow-lg">
              <div className="mb-3 flex items-center">
                <span className="text-sm font-semibold text-fg">Finish review for #{pr.number}</span>
                <button
                  className="ml-auto border-0 bg-transparent text-item-title text-faint hover:text-fg"
                  onClick={() => setReviewOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <Textarea
                size="sm"
                className="h-20 resize-none p-2.5"
                placeholder="Review summary (optional for approval)…"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
              <div className="my-2.5 grid grid-cols-3 gap-1.5">
                {(
                  [
                    ["COMMENT", "Comment"],
                    ["APPROVE", "Approve"],
                    ["REQUEST_CHANGES", "Request changes"],
                  ] as Array<[ReviewEvent, string]>
                ).map(([event, label]) => (
                  <Button
                    key={event}
                    size="sm"
                    className={`rounded-sm px-2 py-2 text-meta shadow-none ${reviewEvent === event ? "border-green/50 bg-green-soft text-green hover:border-green/50 hover:text-green" : "bg-surface"}`}
                    onClick={() => setReviewEvent(event)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {reviewEvent === "APPROVE" && canMergeAfterReview && (
                <label className="mb-3 flex cursor-pointer items-center gap-2 px-0.5 text-meta text-dim">
                  <Checkbox checked={mergeAfterReview} onCheckedChange={setMergeAfterReview} />
                  Squash and merge immediately after approval
                </label>
              )}
              {reviewError && <div className="mb-2 text-xs text-red">{reviewError}</div>}
              {mergeError && <div className="mb-2 text-xs text-red">{mergeError}</div>}
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  onClick={() => setReviewOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSubmitReview}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : reviewSubmitLabel}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${split ? "lg:grid lg:grid-cols-[minmax(0,760px)_minmax(0,1fr)] lg:items-start lg:gap-6" : ""}`}
      ref={rootRef}
    >
      {switcher}
      <div className="flex min-h-0 flex-1 flex-col lg:contents">
      <SelectionToSession sessionId={sessionId} label={`${provider.changeAbbr} #${pr.number}`} send={send}>
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-4 sm:px-5 lg:mx-0 lg:max-w-none lg:px-0 lg:py-0">
          {/* Header — title + meta line, Linear-style */}
          <div className="flex flex-col gap-2 rounded-panel border border-line bg-panel px-4 py-4 sm:px-5">
            <a
              className="text-section-title font-semibold leading-tight text-fg no-underline hover:text-link"
              href={pr.url}
              target="_blank"
              rel="noopener"
            >
              {pr.title}
            </a>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
              {pr.author && <span className="font-medium text-dim">{pr.author}</span>}
              <span>#{pr.number}</span>
              <span
                className="inline-flex items-center gap-1 text-meta text-dim"
                title={`${pr.baseRefName} ← ${pr.headRefName}`}
              >
                <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">{pr.baseRefName}</span>
                <span className="text-faint">←</span>
                <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">{pr.headRefName}</span>
              </span>
              <span className="inline-flex items-center gap-1.5 text-meta">
                <span className="text-green">+{pr.additions}</span>
                <span className="text-red">−{pr.deletions}</span>
              </span>
            </div>
          </div>

          {linkable && !showBar && (
            <div>
              <LinkPrControl sessionId={sessionId} variant="action" onLinked={handleLinked} />
            </div>
          )}

          {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}

          {!!bodyHtml && (
            <div className="-mt-1.5">
              <div
                ref={bodyRef}
                className={`markdown ${PR_BODY_MD} ${bodyOpen ? "" : PR_BODY_CLAMPED}`}
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
              {(bodyOverflows || bodyOpen) && (
                <button className={PR_BODY_TOGGLE} onClick={() => setBodyOpen((o) => !o)}>
                  {bodyOpen ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {/* Stack map — where this PR sits in its chain of layers. Above Git
              status because it reframes everything below it: the diff, the
              base branch, and whether a merge is even in order yet. */}
          {caps.stacks && (
            <StackCard pr={pr} sessionId={sessionId} repo={active?.repo} onOpenPr={onOpenPr} onLinked={load} />
          )}

          <PrCard title="Git status">
            <GitStatusRows
              git={git}
              pr={pr}
              sessionId={sessionId}
              repo={active?.repo}
              send={send}
              onRefresh={load}
              onMerge={handleMerge}
              merging={merging}
              confirmMerge={confirmMerge}
            />
            {mergeError && <div className={`${GIT_NOTE} text-red`}>{mergeError}</div>}
          </PrCard>

          {/* Sessions card — every session linked to this PR + start a new one. */}
          {sessions && (
            <PrCard title="Sessions">
              <PrSessionsList
                sessions={relatedSessions}
                repo={active?.repo || ""}
                branch={active?.branch}
                pr={pr}
                currentSessionId={sessionId || undefined}
                onOpenSession={onOpenSessionById}
                send={send}
                addHandler={addHandler}
                compose
              />
            </PrCard>
          )}

          {/* Reviewers card */}
          {caps.reviewers && reviewers.length > 0 && (
            <PrCard title="Reviewers">
              {reviewers.map((r) => (
                <ReviewerRow key={r.login} reviewer={r} provider={provider} />
              ))}
            </PrCard>
          )}

          {/* Checks card — one rollup row like Linear; the full list is opt-in. */}
          {caps.checks && pr.checks.length > 0 && (
            <PrCard title="Checks">
              <button
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-body text-fg transition-[background] hover:bg-hover"
                onClick={() => setChecksOpen((o) => !o)}
                aria-expanded={checksOpen}
              >
                <span
                  className={`inline-flex w-4 shrink-0 items-center justify-center text-meta [&>svg]:block ${
                    checkSummary.failed > 0
                      ? "text-red"
                      : checkSummary.pending > 0
                        ? "prc-mark-pending text-yellow animate-[pulse_1.4s_infinite]"
                        : "text-green"
                  }`}
                >
                  {checkSummary.failed > 0 ? (
                    <IconX size={15} />
                  ) : checkSummary.pending > 0 ? (
                    "●"
                  ) : (
                    <IconCheck size={15} />
                  )}
                </span>
                <span className="min-w-0 flex-1 text-label font-semibold">
                  {checkSummary.failed > 0
                    ? "Some checks failed"
                    : checkSummary.pending > 0
                      ? "Checks running"
                      : "All passed"}
                </span>
                <span className="inline-flex gap-2 text-meta tabular-nums">
                  {checkSummary.passed > 0 && (
                    <span className="text-green">✓ {checkSummary.passed}</span>
                  )}
                  {checkSummary.failed > 0 && (
                    <span className="text-red">✕ {checkSummary.failed}</span>
                  )}
                  {checkSummary.pending > 0 && (
                    <span className="text-yellow">● {checkSummary.pending}</span>
                  )}
                </span>
                <span className="text-meta text-faint">{checksOpen ? "▾" : "▸"}</span>
              </button>
              {checksOpen && (
                <>
                  {checkSummary.deployments.length > 0 && (
                    <div className={CHECKS_GROUP}>Deployments</div>
                  )}
                  {checkSummary.deployments.map((check, i) => (
                    <CheckRow key={`d${i}`} check={check} />
                  ))}
                  {checkSummary.deployments.length > 0 && checkSummary.checks.length > 0 && (
                    <div className={CHECKS_GROUP}>Checks</div>
                  )}
                  {checkSummary.checks.map((check, i) => (
                    <CheckRow key={`c${i}`} check={check} />
                  ))}
                </>
              )}
            </PrCard>
          )}

          {/* Files changed card — rows visible by default, long lists capped. */}
          {files.length > 0 && (
            <PrCard
              title={`${files.length} file${files.length === 1 ? "" : "s"} changed`}
              headExtra={
                <span className="inline-flex items-center gap-1.5 text-meta">
                  <span className="text-green">+{pr.additions}</span>
                  <span className="text-red">−{pr.deletions}</span>
                </span>
              }
            >
              {(allFilesOpen ? files : files.slice(0, 8)).map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  onClick={diff?.patch ? () => scrollToFile(f.path) : undefined}
                />
              ))}
              {files.length > 8 && (
                <button
                  className="mt-1 self-start text-xs font-medium text-link hover:text-fg"
                  onClick={() => setAllFilesOpen((o) => !o)}
                >
                  {allFilesOpen ? "Show fewer" : `Show all ${files.length} files`}
                </button>
              )}
            </PrCard>
          )}

          {comments.length > 0 && (
            <PrCard
              title="Comments"
              headExtra={
                onAddToInput ? (
                  <button
                    className={PR_COMMENTS_ADD_ALL}
                    onClick={() => onAddToInput(formatPrCommentsPrompt(comments, pr))}
                  >
                    Add all to session
                  </button>
                ) : undefined
              }
            >
              {comments.map((comment, i) => (
                <div className={PR_COMMENT_ROW} key={`${comment.url || comment.createdAt || i}`}>
                  <span className={PR_COMMENT_SELECT} aria-hidden />
                  <div className={PR_COMMENT_META}>
                    <span className={PR_COMMENT_AUTHOR}>{comment.author || "comment"}</span>
                  </div>
                  <div className={PR_COMMENT_BODY}>{stripHtmlComments(comment.body)}</div>
                  {comment.url && (
                    <a className={PR_COMMENT_LINK} href={comment.url} target="_blank" rel="noopener">
                      ↗
                    </a>
                  )}
                  {onAddToInput && (
                    <button
                      className={PR_COMMENT_ADD}
                      onClick={() => onAddToInput(formatPrCommentPrompt(comment, pr))}
                    >
                      Add to session
                    </button>
                  )}
                </div>
              ))}
            </PrCard>
          )}

        </div>
      </SelectionToSession>

      {(diffLoading || diffOutOfDate || diffError) && !diff?.patch && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line lg:border-l lg:border-t-0">
          {diffError ? (
            <InlineAlert
              className="m-4"
              retryLabel="Retry"
              onRetry={() => {
                setDiffLoading(true);
                setDiffError(null);
                void load(true);
              }}
            >
              {diffError}
            </InlineAlert>
          ) : (
            <LoadingState>
              {diffOutOfDate
                ? "The pull request changed while loading. It will refresh automatically."
                : "Loading pull request changes…"}
            </LoadingState>
          )}
        </div>
      )}
      {diff?.patch && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-line lg:border-l lg:border-t-0">
          <div className="flex min-h-0 flex-1 flex-col bg-panel">
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel/95 px-4 py-3 backdrop-blur sm:px-5">
              <div className="inline-flex rounded-md border border-line bg-surface p-1" role="tablist">
                {(
                  [
                    ["diff", "Diff"],
                    ["guide", "Guide"],
                  ] as Array<["diff" | "guide", string]>
                ).map(([key, label]) => (
                  <Button
                    key={key}
                    variant="ghost"
                    size="sm"
                    role="tab"
                    aria-selected={diffView === key}
                    className={`rounded-sm border-0 px-2.5 py-1 text-xs font-medium ${diffView === key ? "bg-panel text-fg smooth-shadow-sm" : "text-faint hover:bg-transparent"}`}
                    onClick={() => setDiffView(key)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <div className="text-right text-meta text-faint">
                {caps.reviewComments
                  ? "Review. Comments stay pending until you submit."
                  : `Read-only. ${provider.name} has no review comments.`}
                {reviewDone &&
                  (reviewDone === "submitted" ? (
                    <span className="ml-2 text-green">review submitted ✓</span>
                  ) : (
                    <a
                      className="ml-2 text-link no-underline hover:text-fg"
                      href={reviewDone}
                      target="_blank"
                      rel="noopener"
                    >
                      review submitted ↗
                    </a>
                  ))}
              </div>
            </div>
            {diffView === "guide" ? (
              guideLoading ? (
                <div className="px-4 py-6 text-sm text-faint sm:px-5">Writing the review guide…</div>
              ) : guideFailed ? (
                <div className="flex items-center gap-3 px-4 py-6 text-sm text-faint sm:px-5">
                  Couldn't generate a guide for this PR.
                  <button className="text-xs font-medium text-link hover:text-fg" onClick={() => void loadGuide()}>
                    Retry
                  </button>
                </div>
              ) : guide ? (
                sectionsWithPatches(guide, diff.patch).map((section, i, all) => (
                  <div className={PR_GUIDE_SECTION} key={`${section.title}-${i}`}>
                    <div className={PR_GUIDE_COUNT}>
                      {String(i + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                    </div>
                    <div className={PR_GUIDE_TITLE}>{section.title}</div>
                    <div className={PR_GUIDE_EXPL}>{section.explanation}</div>
                    {section.patch && (
                      <CommentableDiff
                        patch={section.patch}
                        defaultExpandedFiles={Infinity}
                        viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                        onToggleViewed={handleToggleViewed}
                        disabled={!caps.reviewComments}
                        disabledHint={`Inline review comments aren't supported on ${provider.name}`}
                        submitLabel="Add comment"
                        placeholder={`Comment on #${diff.number}, added to your pending review…`}
                        pendingComments={pending}
                        onRemovePending={handleRemovePending}
                        onSubmit={handleAddPending}
                        imageSrcs={imageSrcs}
                      />
                    )}
                  </div>
                ))
              ) : null
            ) : (
              <CommentableDiff
                patch={diff.patch}
                defaultExpandedFiles={Infinity}
                viewedFiles={prViewed?.key === viewedKey ? prViewed.viewed : undefined}
                onToggleViewed={handleToggleViewed}
                groups={diffGroups?.oid === diff.headRefOid ? diffGroups.groups || undefined : undefined}
                groupsLoading={diffGroupsLoading}
                disabled={!caps.reviewComments}
                disabledHint={`Inline review comments aren't supported on ${provider.name}`}
                submitLabel="Add comment"
                placeholder={`Comment on #${diff.number}, added to your pending review…`}
                pendingComments={pending}
                onRemovePending={handleRemovePending}
                onSubmit={handleAddPending}
                imageSrcs={imageSrcs}
              />
            )}
          </div>

          {pending.length > 0 && (
			<div className="sticky bottom-0 z-20 border-t border-line bg-surface/80 px-4 py-3 backdrop-blur sm:px-5">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-fg">
                  {pending.length} pending comment{pending.length === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  className="text-meta"
                  onClick={() => setReviewOpen((o) => !o)}
                >
                  {reviewOpen ? "Hide" : "Finish review"}
                </Button>
                {onAddToInput && (
                  <Button
                    size="sm"
                    className="text-meta"
                    onClick={() => onAddToInput(formatPendingCommentsPrompt(pending, pr))}
                  >
                    Add to session
                  </Button>
                )}
              </div>

              {reviewOpen && (
                <div className="mt-3 flex flex-col gap-3">
                  <Textarea
                    size="sm"
                    className="min-h-[84px] px-3"
                    rows={3}
                    placeholder="Overall review summary (optional)…"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["COMMENT", "Comment"],
                        ["APPROVE", "Approve"],
                        ["REQUEST_CHANGES", "Request changes"],
                      ] as Array<[ReviewEvent, string]>
                    ).map(([key, label]) => (
                      <Button
                        key={key}
                        size="sm"
                        className={`rounded-sm px-2.5 py-2 text-meta shadow-none ${reviewEvent === key ? "border-green/45 bg-green-soft text-green hover:border-green/45 hover:text-green" : "bg-panel"}`}
                        onClick={() => setReviewEvent(key)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  {reviewError && <div className="text-[12px] text-red">{reviewError}</div>}
                  <Button
                    variant="primary"
                    size="sm"
                    className="self-start"
                    onClick={handleSubmitReview}
                    disabled={submitting}
                  >
                    {submitting ? "Submitting…" : `Submit review (${pending.length})`}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
