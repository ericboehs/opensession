import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import type {
  GitStatusInfo,
  DiffFileGroup,
  PrCheck,
  PrComment,
  PrDetails,
  PrFile,
  PrReviewer,
  SessionWalkthrough,
} from "../lib/types";
import { WalkthroughCard } from "./WalkthroughCard";
import {
  API_BASE,
  fetchPr,
  fetchPrDiff,
  fetchPrDiffGroups,
  fetchGitStatus,
  fetchReviewGuide,
  gitPushApi,
  submitPrReviewApi,
  mergePrApi,
  linkPrApi,
  unlinkPrApi,
} from "../lib/api";
import {
  fetchPrPreview,
  fetchPrPreviewDiff,
  fetchPrPreviewGuide,
  submitPrPreviewReviewApi,
  mergePrPreviewApi,
} from "../lib/api";
import { toast } from "../ui/toast";
import type { FileDiffMetadata } from "@pierre/diffs";
import { CommentableDiff, type CommentTarget, type PendingComment } from "./CommentableDiff";
import { SelectionToSession } from "./SelectionToSession";
import { getCurrentUser } from "./UserPicker";
import { githubLoginFor } from "./UserAvatar";
import { renderMarkdown, renderPrCommentMarkdown } from "../lib/markdown";
import { providerFromUrl, avatarUrl, type Provider } from "../lib/provider";
import {
  IconArrowUp,
  IconCheck,
  IconGitMerge,
  IconMessage,
  IconClock,
  IconX,
  IconFile,
} from "./icons";

type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

interface Props {
  sessionId: string;
  /** When provided, renders an "Open session →" action (used by the Reviews view). */
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
  /** Session-less PR target; uses the same canvas with repo+branch APIs. */
  previewTarget?: { repo: string; branch: string };
}

interface PrDiffData {
  number: number;
  headRefOid: string;
  patch: string;
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
  label: string;
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

/** Provider-neutral PR-state glyph (open/draft share the branch icon). */
export function PrStateIcon({ state, isDraft }: { state: string; isDraft?: boolean }) {
  const common = { width: 15, height: 15, viewBox: "0 0 16 16", fill: "currentColor" as const };
  if (state === "MERGED")
    return (
      <svg {...common} aria-hidden>
        <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.251 2.251 0 1 0 1.5 0V7.5a3.5 3.5 0 0 0 3.5 3.5h1.128a2.251 2.251 0 1 0 0-1.5H8.5A2 2 0 0 1 6.5 7.5v-2.128ZM4.25 12a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5ZM12 9.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z" />
      </svg>
    );
  if (state === "CLOSED")
    return (
      <svg {...common} aria-hidden>
        <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.81-1.97 1.97a.75.75 0 1 1-1.06-1.06l1.97-1.97-1.97-1.97a.75.75 0 0 1 1.06-1.06l1.97 1.97 1.97-1.97a.75.75 0 1 1 1.06 1.06l-1.97 1.97 1.97 1.97a.75.75 0 1 1-1.06 1.06l-1.97-1.97ZM2.5 13.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
      </svg>
    );
  return (
    <svg {...common} aria-hidden>
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

/** One-line derived status: the state label + a tone + an optional qualifier. */
interface StatusLine {
  key: string;
  label: string; // Open / Merged / Closed / Draft
  qualifier: string | null; // Ready to merge / Blocked / Changes requested / …
  tone: "green" | "purple" | "red" | "yellow" | "muted";
}

function deriveStatus(pr: PrDetails): StatusLine {
  if (pr.state === "MERGED")
    return { key: "merged", label: "Merged", qualifier: null, tone: "purple" };
  if (pr.state === "CLOSED")
    return { key: "closed", label: "Closed", qualifier: null, tone: "muted" };
  if (pr.isDraft) return { key: "draft", label: "Draft", qualifier: null, tone: "muted" };
  if (pr.mergeable === "CONFLICTING")
    return { key: "conflicts", label: "Open", qualifier: "Merge conflicts", tone: "red" };
  const checks = summarize(pr.checks);
  if (checks.failed > 0)
    return { key: "failing", label: "Open", qualifier: "Checks failed", tone: "red" };
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    return { key: "changes", label: "Open", qualifier: "Changes requested", tone: "red" };
  if (checks.pending > 0)
    return { key: "running", label: "Open", qualifier: "Checks running", tone: "yellow" };
  if (pr.reviewDecision === "REVIEW_REQUIRED")
    return { key: "review", label: "Open", qualifier: "Review required", tone: "yellow" };
  return { key: "ready", label: "Open", qualifier: "Ready to merge", tone: "green" };
}

function summarize(checks: PrCheck[]) {
  let passed = 0,
    failed = 0,
    pending = 0;
  for (const c of checks) {
    const cls = checkClass(c.status, c.conclusion);
    if (cls === "check-success") passed++;
    else if (cls === "check-failure") failed++;
    else if (cls === "check-pending") pending++;
  }
  return { passed, failed, pending, total: checks.length };
}

export function PrPanel({
  sessionId,
  onOpenSession,
  onAddToInput,
  split,
  repos,
  linkedPrs,
  linkable,
  send,
  walkthrough,
  reviewCanvas,
  previewTarget,
}: Props) {
  // Local copy of the linked-PR list so link/unlink applies instantly; the
  // sessions list catches up on its next refresh.
  const [linkedLocal, setLinkedLocal] = useState<LinkedPrEntry[] | null>(null);
  const linked = linkedLocal ?? linkedPrs ?? [];
  const targets = useMemo<PrTarget[]>(
    () => [
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
        key: `${lp.repo} ${lp.branch}`,
        repo: lp.repo,
        branch: lp.branch,
        linked: true,
        label: lp.number ? `${lp.repo} #${lp.number}` : `${lp.repo}:${lp.branch}`,
      })),
    ],
    [repos, linked, previewTarget?.repo, previewTarget?.branch],
  );
  const [activeKey, setActiveKey] = useState<string | undefined>(
    () => (targets.find((t) => t.primary) ?? targets[0])?.key,
  );
  const active = targets.find((t) => t.key === activeKey) ?? targets[0];
  const [pr, setPr] = useState<PrDetails | null>(null);
  const [git, setGit] = useState<GitStatusInfo | null>(null);
  const [diff, setDiff] = useState<PrDiffData | null>(null);
  const [diffGroups, setDiffGroups] = useState<{
    oid: string;
    groups: DiffFileGroup[] | null;
  } | null>(null);
  const [diffGroupsLoading, setDiffGroupsLoading] = useState(false);
  const [diffGroupsRetry, setDiffGroupsRetry] = useState(0);
  const [loading, setLoading] = useState(true);
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
  const [mergeAfterReview, setMergeAfterReview] = useState(reviewCanvas === true);
  const [checksOpen, setChecksOpen] = useState(false);
  const [allFilesOpen, setAllFilesOpen] = useState(false);
  const [diffView, setDiffView] = useState<
    "intent" | "guide" | "diff" | "checks" | "conversation"
  >(() => (reviewCanvas ? "guide" : "diff"));
  const [guide, setGuide] = useState<ReviewGuideData | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideFailed, setGuideFailed] = useState(false);
  const [bodyOpen, setBodyOpen] = useState(false);
  const [bodyOverflows, setBodyOverflows] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const [prData, diffData, gitData] = await Promise.all([
        previewTarget
          ? fetchPrPreview(previewTarget.repo, previewTarget.branch)
          : fetchPr(sessionId, active?.repo, active?.branch),
        (previewTarget
          ? fetchPrPreviewDiff(previewTarget.repo, previewTarget.branch)
          : fetchPrDiff(sessionId, active?.repo, active?.branch)
        ).catch(() => null),
        // A linked PR has no local worktree in this session — no git state.
        previewTarget || active?.linked
          ? Promise.resolve(null)
          : fetchGitStatus(sessionId, active?.repo).catch(() => null),
      ]);
      setPr(prData);
      setDiff(diffData);
      setGit(gitData);
    } catch {
      setPr(null);
    } finally {
      setLoading(false);
    }
  }, [
    sessionId,
    active?.repo,
    active?.branch,
    active?.linked,
    previewTarget?.repo,
    previewTarget?.branch,
  ]);

  useEffect(() => {
    setLoading(true);
    setPending([]);
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [load]);

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

  // The guide is generated on demand (the first request per head commit takes
  // the model a while) — only fetch once the reviewer opens the Guide tab, and
  // refetch when a new push moves the head commit.
  useEffect(() => {
    if (diffView !== "guide" || !diff?.patch) return;
    if (guideLoading || guideFailed) return;
    if (guide && guide.headRefOid === diff.headRefOid) return;
    void loadGuide();
  }, [diffView, diff?.patch, diff?.headRefOid, guide, guideLoading, guideFailed, loadGuide]);

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
      setPending([]);
      setSummary("");
      setReviewOpen(false);
      setReviewEvent(reviewCanvas ? "APPROVE" : "COMMENT");
      setReviewDone(merged ? "merged" : result.url || "submitted");
      setTimeout(() => setReviewDone(null), 6000);
      await load();
    } catch (e: any) {
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
    try {
      if (previewTarget)
        await mergePrPreviewApi(
          previewTarget.repo,
          previewTarget.branch,
          "squash",
        );
      else await mergePrApi(sessionId, "squash", active?.repo, active?.branch);
      await load();
    } catch (e: any) {
      setMergeError(e.message || "Merge failed");
    } finally {
      setMerging(false);
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
    return stripped ? renderMarkdown(stripped) : "";
  }, [pr?.body]);
  const provider = useMemo(() => providerFromUrl(pr?.url), [pr?.url]);

  // Only offer the expand toggle when the clamped description is actually taller
  // than its collapsed height — a two-line PR body shouldn't get a "Show more".
  useEffect(() => {
    if (bodyOpen) return;
    const el = bodyRef.current;
    setBodyOverflows(!!el && el.scrollHeight - el.clientHeight > 4);
  }, [bodyHtml, bodyOpen]);

  // Files card → diff: scroll the matching file section into view (and open it).
  const scrollToFile = useCallback((path: string) => {
    const root = rootRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-diff-file="${CSS.escape(path)}"]`);
    if (!el) {
      const group = [...root.querySelectorAll<HTMLElement>("[data-diff-group-files]")].find(
        (header) => {
          try {
            return JSON.parse(header.dataset.diffGroupFiles || "[]").includes(path);
          } catch {
            return false;
          }
        },
      );
      if (group?.getAttribute("aria-expanded") === "false") {
        group.click();
        requestAnimationFrame(() => scrollToFile(path));
      }
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    const header = el.querySelector<HTMLElement>(".diff-file-header");
    if (header && header.getAttribute("aria-expanded") === "false") header.click();
  }, []);

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
  const showBar = targets.length > 1;
  const switcher = showBar ? (
    <div className="pr-repo-tabs">
      {targets.map((t) => (
        <button
          key={t.key}
          className={`pr-repo-tab ${t.key === active?.key ? "pr-repo-tab-active" : ""}`}
          onClick={() => setActiveKey(t.key)}
          title={
            t.linked
              ? `Linked PR — branch ${t.branch}`
              : t.primary
                ? "Primary repo"
                : "Attached repo"
          }
        >
          {t.label}
          {t.linked && t.key === active?.key && (
            <span
              className="pr-repo-tab-x"
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
      <div className="pr-panel">
        {switcher}
        <div className="panel-placeholder">Loading pull request…</div>
      </div>
    );

  if (!pr)
    return (
      <div className="pr-panel">
        {switcher}
        <div className="pr-panel-info">
          {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}
          <PrCard title="Status">
            <div className="prc-status-row">
              <span className="prc-state prc-state-muted">
                <PrStateIcon state="OPEN" />
                No pull request
              </span>
            </div>
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
            <div className="prc-actions">
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
  const comments = (pr.comments || []).filter((c) => stripHtmlComments(c.body));

  if (reviewCanvas) {
    const currentLogin = githubLoginFor(getCurrentUser())?.toLowerCase();
    const myReview = reviewers.find(
      (reviewer) => reviewer.login.toLowerCase() === currentLogin,
    );
    const needsReview =
      (pr.author.toLowerCase() === "tella-butler" &&
        pr.reviewDecision !== "APPROVED") ||
      myReview?.state === "PENDING";
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
    const openFile = (path: string) => {
      setDiffView("diff");
      requestAnimationFrame(() => scrollToFile(path));
    };

    return (
      <div
        className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface"
        data-review-canvas="true"
        ref={rootRef}
      >
        {switcher}

        <header className="flex min-h-[78px] shrink-0 items-center gap-5 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-faint">
              <span>{pr.author}</span>
              <span>·</span>
              <a
                className="cursor-text select-text hover:text-dim"
                href={pr.url}
                target="_blank"
                rel="noopener"
              >
                #{pr.number}
              </a>
              <span>·</span>
              <span>{active?.repo || "tella-fusion"}</span>
            </div>
            <a
              className="block truncate text-[17px] font-semibold tracking-[-0.015em] text-fg no-underline hover:text-accent"
              href={pr.url}
              target="_blank"
              rel="noopener"
            >
              {pr.title}
            </a>
            <div className="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-faint">
              <span className="truncate font-mono">{pr.headRefName}</span>
              <span>→</span>
              <span className="font-mono">{pr.baseRefName}</span>
              <span>·</span>
              <span>{pr.changedFiles} files</span>
              <span className="font-mono text-green">+{pr.additions}</span>
              <span className="font-mono text-red">−{pr.deletions}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-[760px]:hidden">
            {pr.staging?.url && (
              <a
                className="rounded-sm border border-line bg-transparent px-3 py-2 text-xs font-medium text-dim no-underline hover:border-line-strong hover:bg-hover hover:text-fg"
                href={pr.staging.url}
                target="_blank"
                rel="noopener"
              >
                Preview
              </a>
            )}
            {onOpenSession && (
              <button
                className="rounded-sm border border-line bg-transparent px-3 py-2 text-xs font-medium text-dim hover:border-line-strong hover:bg-hover hover:text-fg"
                onClick={onOpenSession}
              >
                Open session
              </button>
            )}
            {pr.state === "OPEN" && !pr.isDraft && (
              <>
                {needsReview ? (
                  <button
                    className="rounded-sm border border-fg bg-fg px-3 py-2 text-xs font-semibold text-surface hover:opacity-90"
                    onClick={() => setReviewOpen(true)}
                  >
                    Finish review
                  </button>
                ) : status.key !== "ready" ? (
                  <button
                    className="rounded-sm border border-line bg-transparent px-3 py-2 text-xs font-medium text-dim hover:border-line-strong hover:bg-hover hover:text-fg"
                    onClick={() => setReviewOpen(true)}
                  >
                    Review
                  </button>
                ) : null}
                <button
                  className={`rounded-sm border px-3 py-2 text-xs font-semibold ${
                    confirmMerge
                      ? "border-green bg-green text-surface"
                      : "border-green/40 bg-green-soft text-green hover:border-green"
                  }`}
                  onClick={handleMerge}
                  disabled={merging}
                >
                  {merging
                    ? "Merging…"
                    : confirmMerge
                      ? "Confirm squash & merge"
                      : "Squash & merge"}
                </button>
              </>
            )}
          </div>
        </header>

        <div className="flex h-11 shrink-0 overflow-x-auto border-b border-line">
          <ReviewSignal
            tone={
              checkSummary.failed > 0
                ? "red"
                : checkSummary.pending > 0
                  ? "yellow"
                  : "green"
            }
            label={
              checkSummary.failed > 0
                ? `${checkSummary.failed} checks failing`
                : checkSummary.pending > 0
                  ? `${checkSummary.pending} checks running`
                  : `${checkSummary.passed} checks passed`
            }
            detail={`${checkSummary.total} total`}
          />
          <ReviewSignal
            tone={pr.mergeable === "CONFLICTING" ? "red" : "green"}
            label={
              pr.mergeable === "CONFLICTING" ? "Merge conflict" : "No conflicts"
            }
            detail={pr.mergeStateStatus || "Cleanly mergeable"}
          />
          <ReviewSignal
            tone={needsReview ? "yellow" : "green"}
            label={needsReview ? "Your review needed" : status.qualifier || status.label}
            detail={
              myReview?.state === "PENDING"
                ? "Requested directly from you"
                : pr.author === "tella-butler"
                  ? "tella-butler pull request"
                  : pr.reviewDecision === "APPROVED"
                    ? "Approved"
                    : "Review status"
            }
          />
          {pr.staging?.url && (
            <ReviewSignal
              tone={pr.staging.status === "SUCCESS" ? "green" : "yellow"}
              label={
                pr.staging.status === "SUCCESS" ? "Preview ready" : "Preview building"
              }
              detail="Open staging build"
              href={pr.staging.url}
            />
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="w-[520px] shrink-0 overflow-y-auto border-r border-line bg-panel/30 px-4 py-4 max-[1100px]:hidden">
            <div className="mb-2 px-2 text-[11px] font-medium text-faint">
              Review
            </div>
            <div className="mb-5 grid gap-0.5">
              <button
                className={`flex items-center gap-2 rounded-sm border-0 px-2 py-2 text-left text-xs ${diffView === "guide" ? "bg-active text-fg" : "bg-transparent text-dim hover:bg-hover hover:text-fg"}`}
                onClick={() => setDiffView("guide")}
              >
                <span className="text-blue">✦</span>
                Review guide
              </button>
              <button
                className={`flex items-center gap-2 rounded-sm border-0 px-2 py-2 text-left text-xs ${diffView === "diff" ? "bg-active text-fg" : "bg-transparent text-dim hover:bg-hover hover:text-fg"}`}
                onClick={() => setDiffView("diff")}
              >
                <IconFile size={14} />
                Files changed
                <span className="ml-auto text-[10px] text-faint">{files.length}</span>
              </button>
              <button
                className={`flex items-center gap-2 rounded-sm border-0 px-2 py-2 text-left text-xs ${diffView === "checks" ? "bg-active text-fg" : "bg-transparent text-dim hover:bg-hover hover:text-fg"}`}
                onClick={() => setDiffView("checks")}
              >
                <IconCheck size={14} />
                Checks
                <span className="ml-auto text-[10px] text-faint">{checkSummary.total}</span>
              </button>
              <button
                className={`flex items-center gap-2 rounded-sm border-0 px-2 py-2 text-left text-xs ${diffView === "conversation" ? "bg-active text-fg" : "bg-transparent text-dim hover:bg-hover hover:text-fg"}`}
                onClick={() => setDiffView("conversation")}
              >
                <IconMessage size={14} />
                Conversation
                <span className="ml-auto text-[10px] text-faint">{comments.length}</span>
              </button>
            </div>

            {!!bodyHtml && (
              <>
                <div className="mb-2 px-2 text-[11px] font-medium text-faint">
                  Intent
                </div>
                <div
                  className="markdown mb-5 px-2 text-xs leading-relaxed text-dim"
                  dangerouslySetInnerHTML={{ __html: bodyHtml }}
                />
              </>
            )}

            <div className="mb-2 px-2 text-[11px] font-medium text-faint">
              Review path
            </div>
            <div className="mb-5 ml-2 border-l border-line">
              {guideSections.length > 0 ? (
                guideSections.map((section, index) => (
                  <button
                    key={`${section.title}-${index}`}
                    className="block w-full border-0 bg-transparent px-3 pb-3 text-left text-[11px] leading-snug text-dim hover:text-fg"
                    onClick={() =>
                      document
                        .getElementById(`review-guide-${index}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                  >
                    <span className="mr-1.5 font-mono text-faint">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {section.title}
                  </button>
                ))
              ) : (
                <div className="px-3 pb-2 text-[11px] text-faint">
                  {guideLoading ? "Writing review guide…" : "Open Guide to generate a path."}
                </div>
              )}
            </div>

            <div className="mb-2 px-2 text-[11px] font-medium text-faint">
              Files
            </div>
            <div className="grid gap-0.5">
              {files.slice(0, 12).map((file) => {
                const base = file.path.split("/").pop() || file.path;
                return (
                  <button
                    key={file.path}
                    className="flex min-w-0 items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left font-mono text-[11px] text-dim hover:bg-hover hover:text-fg"
                    onClick={() => openFile(file.path)}
                    title={file.path}
                  >
                    <span className="truncate">{base}</span>
                    <span className="ml-auto shrink-0 text-green">+{file.additions}</span>
                    <span className="shrink-0 text-red">−{file.deletions}</span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto bg-surface pb-24">
            <div className="sticky top-0 z-[7] flex h-[50px] items-center gap-2 border-b border-line bg-surface/95 px-5 backdrop-blur max-[600px]:px-2">
              <div className="flex min-w-0 gap-1 overflow-x-auto">
                <button
                  className={`shrink-0 rounded-sm border-0 px-2.5 py-1.5 text-xs ${diffView === "intent" ? "bg-active text-fg" : "bg-transparent text-faint hover:text-fg"}`}
                  onClick={() => setDiffView("intent")}
                >
                  Intent
                </button>
                <button
                  className={`shrink-0 rounded-sm border-0 px-2.5 py-1.5 text-xs ${diffView === "guide" ? "bg-active text-fg" : "bg-transparent text-faint hover:text-fg"}`}
                  onClick={() => setDiffView("guide")}
                >
                  Guide
                </button>
                <button
                  className={`shrink-0 rounded-sm border-0 px-2.5 py-1.5 text-xs ${diffView === "diff" ? "bg-active text-fg" : "bg-transparent text-faint hover:text-fg"}`}
                  onClick={() => setDiffView("diff")}
                >
                  Files
                </button>
                <button
                  className={`shrink-0 rounded-sm border-0 px-2.5 py-1.5 text-xs ${diffView === "checks" ? "bg-active text-fg" : "bg-transparent text-faint hover:text-fg"}`}
                  onClick={() => setDiffView("checks")}
                >
                  Checks
                </button>
                <button
                  className={`shrink-0 rounded-sm border-0 px-2.5 py-1.5 text-xs ${diffView === "conversation" ? "bg-active text-fg" : "bg-transparent text-faint hover:text-fg"}`}
                  onClick={() => setDiffView("conversation")}
                >
                  Conversation
                </button>
              </div>
              <span className="ml-auto shrink-0 text-[11px] text-faint max-[600px]:hidden">
                {diffView === "intent"
                  ? "PR description"
                  : diffView === "checks"
                    ? `${checkSummary.total} checks`
                    : diffView === "conversation"
                  ? `${comments.length} comment${comments.length === 1 ? "" : "s"}`
                  : pending.length > 0
                  ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                  : `${files.length} file${files.length === 1 ? "" : "s"}`}
              </span>
            </div>

            <div className="mx-auto max-w-[980px] px-5 py-6 max-[720px]:px-2">
              {diffView === "intent" ? (
                <IntentView author={pr.author} descriptionHtml={bodyHtml} />
              ) : diffView === "checks" ? (
                <ChecksView
                  checks={checkSummary.checks}
                  deployments={checkSummary.deployments}
                />
              ) : diffView === "conversation" ? (
                <ConversationView
                  author={pr.author}
                  descriptionHtml={bodyHtml}
                  comments={comments}
                />
              ) : !diff?.patch ? (
                <div className="py-12 text-center text-sm text-faint">
                  No text diff is available for this pull request.
                </div>
              ) : diffView === "guide" ? (
                guideLoading ? (
                  <>
                    <div className="mb-4 rounded-sm border border-line bg-panel px-3 py-2 text-xs text-faint">
                      Writing the review guide… You can review the file diff while it groups the change by intent.
                    </div>
                    <CommentableDiff
                      patch={diff.patch}
                      defaultExpandedFiles={10}
                      submitLabel="Add comment"
                      placeholder={`Comment on #${diff.number} — added to your pending review…`}
                      pendingComments={pending}
                      onRemovePending={handleRemovePending}
                      onSubmit={handleAddPending}
                      imageSrcs={prImageSrcs}
                    />
                  </>
                ) : guideFailed ? (
                  <div className="py-12 text-center text-sm text-faint">
                    Couldn't generate a guide for this PR.
                    <button
                      className="ml-2 border-0 bg-transparent text-accent"
                      onClick={() => void loadGuide()}
                    >
                      Retry
                    </button>
                  </div>
                ) : guide ? (
                  <>
                    <div className="mb-7 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                      <div className="text-[11px] font-medium leading-relaxed text-faint">
                        Review guide
                      </div>
                      <div>
                        <h2 className="m-0 text-[16px] font-semibold tracking-[-0.01em] text-fg">
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
                        className="mb-8 scroll-mt-[64px]"
                        key={`${section.title}-${index}`}
                      >
                        <div className="mb-3 grid grid-cols-[54px_minmax(0,1fr)] gap-4 px-1">
                          <div className="font-mono text-[10px] text-faint">
                            {String(index + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                          </div>
                          <div>
                            <div className="text-[13px] font-semibold text-fg">{section.title}</div>
                            <div className="mt-1 text-[11.5px] leading-relaxed text-dim">
                              {section.explanation}
                            </div>
                          </div>
                        </div>
                        {section.patch && (
                          <CommentableDiff
                            patch={section.patch}
                            defaultExpandedFiles={Math.max(
                              0,
                              10 -
                                all
                                  .slice(0, index)
                                  .reduce(
                                    (count, previous) =>
                                      count + previous.files.length,
                                    0,
                                  ),
                            )}
                            submitLabel="Add comment"
                            placeholder={`Comment on #${diff.number} — added to your pending review…`}
                            pendingComments={pending}
                            onRemovePending={handleRemovePending}
                            onSubmit={handleAddPending}
                            imageSrcs={prImageSrcs}
                          />
                        )}
                      </section>
                    ))}
                  </>
                ) : null
              ) : (
                <CommentableDiff
                  patch={diff.patch}
                  defaultExpandedFiles={10}
                  submitLabel="Add comment"
                  placeholder={`Comment on #${diff.number} — added to your pending review…`}
                  pendingComments={pending}
                  onRemovePending={handleRemovePending}
                  onSubmit={handleAddPending}
                  imageSrcs={prImageSrcs}
                />
              )}
            </div>
          </main>
        </div>

        <div className="pointer-events-none absolute bottom-4 left-[536px] right-4 z-10 flex min-h-[54px] items-center rounded-md border border-line-strong bg-panel/95 px-3 py-2 shadow-[0_12px_35px_rgba(0,0,0,0.3)] backdrop-blur max-[1100px]:left-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-fg">
              {reviewDone === "merged"
                ? "Approved and merged"
                : reviewDone
                  ? "Review submitted"
                  : pending.length > 0
                    ? `${pending.length} pending comment${pending.length === 1 ? "" : "s"}`
                    : "No pending comments"}
            </div>
            <div className="mt-0.5 truncate text-[10px] text-faint">
              Comments are sent together when you finish the review
            </div>
          </div>
          <div className="pointer-events-auto ml-3 flex shrink-0 gap-2">
            {onOpenSession && (
              <button
                className="rounded-sm border border-line bg-transparent px-3 py-2 text-xs text-dim hover:bg-hover hover:text-fg"
                onClick={onOpenSession}
              >
                Open session
              </button>
            )}
            {pr.state === "OPEN" && !pr.isDraft && (
              <button
                className="rounded-sm border border-green/40 bg-green-soft px-3 py-2 text-xs font-semibold text-green hover:border-green"
                onClick={() => setReviewOpen(true)}
              >
                Finish review
              </button>
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
            <div className="absolute bottom-5 right-5 z-30 w-[430px] max-w-[calc(100%-40px)] rounded-md border border-line-strong bg-panel p-4 shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
              <div className="mb-3 flex items-center">
                <span className="text-sm font-semibold text-fg">Finish review for #{pr.number}</span>
                <button
                  className="ml-auto border-0 bg-transparent text-lg text-faint hover:text-fg"
                  onClick={() => setReviewOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <textarea
                className="h-20 w-full resize-none rounded-sm border border-line bg-surface p-2.5 text-xs text-fg outline-none focus:border-line-strong"
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
                  <button
                    key={event}
                    className={`rounded-sm border px-2 py-2 text-[11px] ${reviewEvent === event ? "border-green/50 bg-green-soft text-green" : "border-line bg-surface text-dim hover:border-line-strong hover:text-fg"}`}
                    onClick={() => setReviewEvent(event)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {reviewEvent === "APPROVE" && canMergeAfterReview && (
                <label className="mb-3 flex cursor-pointer items-center gap-2 px-0.5 text-[11px] text-dim">
                  <input
                    type="checkbox"
                    checked={mergeAfterReview}
                    onChange={(event) => setMergeAfterReview(event.target.checked)}
                  />
                  Squash and merge immediately after approval
                </label>
              )}
              {reviewError && <div className="mb-2 text-xs text-red">{reviewError}</div>}
              {mergeError && <div className="mb-2 text-xs text-red">{mergeError}</div>}
              <div className="flex justify-end gap-2">
                <button
                  className="rounded-sm border border-line bg-transparent px-3 py-2 text-xs text-dim hover:bg-hover hover:text-fg"
                  onClick={() => setReviewOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="rounded-sm border border-fg bg-fg px-3 py-2 text-xs font-semibold text-surface disabled:opacity-50"
                  onClick={handleSubmitReview}
                  disabled={submitting}
                >
                  {submitting ? "Submitting…" : reviewSubmitLabel}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`pr-panel ${split ? "pr-panel-split" : ""}`} ref={rootRef}>
      {switcher}
      <div className="pr-panel-body">
      <SelectionToSession sessionId={sessionId} label={`${provider.changeAbbr} #${pr.number}`} send={send}>
        <div className="pr-panel-info">
          {/* Header — title + meta line, Linear-style */}
          <div className="prc-header">
            <a className="prc-title" href={pr.url} target="_blank" rel="noopener">
              {pr.title}
            </a>
            <div className="prc-meta">
              {pr.author && <span className="prc-meta-author">{pr.author}</span>}
              <span className="prc-meta-num">#{pr.number}</span>
              <span className="prc-meta-branches" title={`${pr.baseRefName} ← ${pr.headRefName}`}>
                <span className="prc-branch">{pr.baseRefName}</span>
                <span className="prc-branch-arrow">←</span>
                <span className="prc-branch">{pr.headRefName}</span>
              </span>
              <span className="prc-meta-diffstat">
                <span className="prc-add">+{pr.additions}</span>
                <span className="prc-del">−{pr.deletions}</span>
              </span>
            </div>
          </div>

          {/* Compact action row — primary merge, quiet secondaries (Linear-style). */}
          <div className="prc-actions">
            {pr.state === "OPEN" && !pr.isDraft && (
              <button
                className={`prc-btn prc-btn-primary ${confirmMerge ? "prc-btn-confirm" : ""}`}
                onClick={handleMerge}
                disabled={merging}
                title={`Squash and merge this ${provider.changeNoun} into its base branch`}
              >
                {merging ? "Merging…" : confirmMerge ? "Confirm squash & merge?" : "Squash & merge"}
              </button>
            )}
            <a className="prc-btn" href={pr.url} target="_blank" rel="noopener">
              Open on {provider.name} ↗
            </a>
            {onOpenSession && (
              <button className="prc-btn" onClick={onOpenSession}>
                Open session →
              </button>
            )}
            {linkable && !showBar && (
              <LinkPrControl sessionId={sessionId} variant="action" onLinked={handleLinked} />
            )}
          </div>
          {mergeError && <div className="pr-merge-error">{mergeError}</div>}

          {walkthrough && <WalkthroughCard walkthrough={walkthrough} />}

          {!!bodyHtml && (
            <div className="pr-body pr-body-top">
              <div
                ref={bodyRef}
                className={`pr-body-md markdown ${bodyOpen ? "" : "pr-body-clamped"}`}
                dangerouslySetInnerHTML={{ __html: bodyHtml }}
              />
              {(bodyOverflows || bodyOpen) && (
                <button className="pr-body-toggle" onClick={() => setBodyOpen((o) => !o)}>
                  {bodyOpen ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {/* Status card */}
          <PrCard title="Status">
            <div className="prc-status-row">
              <span className={`prc-state prc-state-${status.tone}`}>
                <PrStateIcon state={pr.state} isDraft={pr.isDraft} />
                {status.label}
              </span>
              {status.qualifier && (
                <span className={`prc-badge prc-badge-${status.tone}`}>{status.qualifier}</span>
              )}
            </div>
            <GitStatusRows
              git={git}
              pr={pr}
              sessionId={sessionId}
              repo={active?.repo}
              send={send}
              onRefresh={load}
            />
          </PrCard>

          {/* Reviewers card */}
          {reviewers.length > 0 && (
            <PrCard title="Reviewers">
              {reviewers.map((r) => (
                <ReviewerRow key={r.login} reviewer={r} provider={provider} />
              ))}
            </PrCard>
          )}

          {/* Checks card — one rollup row like Linear; the full list is opt-in. */}
          {pr.checks.length > 0 && (
            <PrCard title="Checks">
              <button
                className="prc-summary-row"
                onClick={() => setChecksOpen((o) => !o)}
                aria-expanded={checksOpen}
              >
                <span
                  className={`prc-summary-mark ${
                    checkSummary.failed > 0
                      ? "prc-tone-red"
                      : checkSummary.pending > 0
                        ? "prc-tone-yellow prc-mark-pending"
                        : "prc-tone-green"
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
                <span className="prc-summary-label">
                  {checkSummary.failed > 0
                    ? "Some checks failed"
                    : checkSummary.pending > 0
                      ? "Checks running"
                      : "All passed"}
                </span>
                <span className="prc-checks-counts">
                  {checkSummary.passed > 0 && (
                    <span className="check-success-text">✓ {checkSummary.passed}</span>
                  )}
                  {checkSummary.failed > 0 && (
                    <span className="check-failure-text">✕ {checkSummary.failed}</span>
                  )}
                  {checkSummary.pending > 0 && (
                    <span className="check-pending-text">● {checkSummary.pending}</span>
                  )}
                </span>
                <span className="prc-chevron">{checksOpen ? "▾" : "▸"}</span>
              </button>
              {checksOpen && (
                <>
                  {checkSummary.deployments.length > 0 && (
                    <div className="pr-checks-group">Deployments</div>
                  )}
                  {checkSummary.deployments.map((check, i) => (
                    <CheckRow key={`d${i}`} check={check} />
                  ))}
                  {checkSummary.deployments.length > 0 && checkSummary.checks.length > 0 && (
                    <div className="pr-checks-group">Checks</div>
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
                <span className="prc-meta-diffstat prc-head-diffstat">
                  <span className="prc-add">+{pr.additions}</span>
                  <span className="prc-del">−{pr.deletions}</span>
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
                <button className="prc-show-more" onClick={() => setAllFilesOpen((o) => !o)}>
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
                    className="pr-comments-add-all"
                    onClick={() => onAddToInput(formatPrCommentsPrompt(comments, pr))}
                  >
                    Add all to chat
                  </button>
                ) : undefined
              }
            >
              {comments.map((comment, i) => (
                <div className="pr-comment-row" key={`${comment.url || comment.createdAt || i}`}>
                  <span className="pr-comment-select" aria-hidden />
                  <div className="pr-comment-meta">
                    <span className="pr-comment-author">{comment.author || "comment"}</span>
                  </div>
                  <div className="pr-comment-body">{stripHtmlComments(comment.body)}</div>
                  {comment.url && (
                    <a className="pr-comment-link" href={comment.url} target="_blank" rel="noopener">
                      ↗
                    </a>
                  )}
                  {onAddToInput && (
                    <button
                      className="pr-comment-add"
                      onClick={() => onAddToInput(formatPrCommentPrompt(comment, pr))}
                    >
                      Add to chat
                    </button>
                  )}
                </div>
              ))}
            </PrCard>
          )}

        </div>
      </SelectionToSession>

      {diff?.patch && (
        <div className="pr-panel-diff">
          <div className="pr-diff-section">
            <div className="pr-diff-head">
              <div className="pr-diff-tabs" role="tablist">
                {(
                  [
                    ["diff", "Diff"],
                    ["guide", "Guide"],
                  ] as Array<["diff" | "guide", string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={diffView === key}
                    className={`pr-diff-tab ${diffView === key ? "active" : ""}`}
                    onClick={() => setDiffView(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="pr-checks-title">
                Review — comments stay pending until you submit
                {reviewDone &&
                  (reviewDone === "submitted" ? (
                    <span className="pr-comment-link">review submitted ✓</span>
                  ) : (
                    <a className="pr-comment-link" href={reviewDone} target="_blank" rel="noopener">
                      review submitted ↗
                    </a>
                  ))}
              </div>
            </div>
            {diffView === "guide" ? (
              guideLoading ? (
                <div className="pr-guide-status">Writing the review guide…</div>
              ) : guideFailed ? (
                <div className="pr-guide-status">
                  Couldn't generate a guide for this PR.
                  <button className="prc-show-more" onClick={() => void loadGuide()}>
                    Retry
                  </button>
                </div>
              ) : guide ? (
                sectionsWithPatches(guide, diff.patch).map((section, i, all) => (
                  <div className="pr-guide-section" key={`${section.title}-${i}`}>
                    <div className="pr-guide-count">
                      {String(i + 1).padStart(2, "0")} / {String(all.length).padStart(2, "0")}
                    </div>
                    <div className="pr-guide-title">{section.title}</div>
                    <div className="pr-guide-expl">{section.explanation}</div>
                    {section.patch && (
                      <CommentableDiff
                        patch={section.patch}
                        submitLabel="Add comment"
                        placeholder={`Comment on #${diff.number} — added to your pending review…`}
                        pendingComments={pending}
                        onRemovePending={handleRemovePending}
                        onSubmit={handleAddPending}
                        imageSrcs={prImageSrcs}
                      />
                    )}
                  </div>
                ))
              ) : null
            ) : (
              <CommentableDiff
                patch={diff.patch}
                groups={diffGroups?.oid === diff.headRefOid ? diffGroups.groups || undefined : undefined}
                groupsLoading={diffGroupsLoading}
                submitLabel="Add comment"
                placeholder={`Comment on #${diff.number} — added to your pending review…`}
                pendingComments={pending}
                onRemovePending={handleRemovePending}
                onSubmit={handleAddPending}
                imageSrcs={prImageSrcs}
              />
            )}
          </div>

          {pending.length > 0 && (
            <div className="pr-review-bar">
              <div className="pr-review-bar-row">
                <span className="pr-review-count">
                  {pending.length} pending comment{pending.length === 1 ? "" : "s"}
                </span>
                <button className="pr-review-toggle" onClick={() => setReviewOpen((o) => !o)}>
                  {reviewOpen ? "Hide" : "Finish review"}
                </button>
                {onAddToInput && (
                  <button
                    className="pr-review-toggle"
                    onClick={() => onAddToInput(formatPendingCommentsPrompt(pending, pr))}
                  >
                    Add to chat
                  </button>
                )}
              </div>

              {reviewOpen && (
                <div className="pr-review-form">
                  <textarea
                    className="pr-review-summary"
                    rows={3}
                    placeholder="Overall review summary (optional)…"
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                  />
                  <div className="pr-review-events">
                    {(
                      [
                        ["COMMENT", "Comment"],
                        ["APPROVE", "Approve"],
                        ["REQUEST_CHANGES", "Request changes"],
                      ] as Array<[ReviewEvent, string]>
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        className={`pr-review-event ${reviewEvent === key ? "active" : ""}`}
                        onClick={() => setReviewEvent(key)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {reviewError && <div className="diff-comment-error">{reviewError}</div>}
                  <button className="pr-review-submit" onClick={handleSubmitReview} disabled={submitting}>
                    {submitting ? "Submitting…" : `Submit review (${pending.length})`}
                  </button>
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

function PrDescriptionCard({
  author,
  descriptionHtml,
}: {
  author: string;
  descriptionHtml: string;
}) {
  if (!descriptionHtml)
    return (
      <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
        This pull request has no description.
      </div>
    );
  return (
    <article className="rounded-md border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-active text-[11px] font-semibold text-fg">
          {author.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="text-xs font-semibold text-fg">{author}</div>
          <div className="text-[10px] text-faint">Opened this pull request</div>
        </div>
      </div>
      <div
        className="markdown px-4 py-4 text-[13px] leading-relaxed text-dim"
        dangerouslySetInnerHTML={{ __html: descriptionHtml }}
      />
    </article>
  );
}

function IntentView({
  author,
  descriptionHtml,
}: {
  author: string;
  descriptionHtml: string;
}) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          Intent
        </h2>
        <p className="mt-1 text-xs text-faint">Pull request description</p>
      </div>
      <PrDescriptionCard author={author} descriptionHtml={descriptionHtml} />
    </div>
  );
}

function ChecksView({
  checks,
  deployments,
}: {
  checks: PrCheck[];
  deployments: PrCheck[];
}) {
  const total = checks.length + deployments.length;
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          Checks
        </h2>
        <p className="mt-1 text-xs text-faint">
          {total} result{total === 1 ? "" : "s"}
        </p>
      </div>
      {total === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No checks reported.
        </div>
      ) : (
        <div className="grid gap-4">
          {checks.length > 0 && (
            <section className="rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 px-2 pb-2 text-xs font-semibold text-fg">CI checks</h3>
              {checks.map((check, index) => (
                <CheckRow key={`${check.name}-${index}`} check={check} />
              ))}
            </section>
          )}
          {deployments.length > 0 && (
            <section className="rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 px-2 pb-2 text-xs font-semibold text-fg">Deployments</h3>
              {deployments.map((check, index) => (
                <CheckRow key={`${check.name}-${index}`} check={check} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ConversationView({
  author,
  descriptionHtml,
  comments,
}: {
  author: string;
  descriptionHtml: string;
  comments: PrComment[];
}) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          Conversation
        </h2>
        <p className="mt-1 text-xs text-faint">
          {comments.length} comment{comments.length === 1 ? "" : "s"}
        </p>
      </div>

      <div className="mb-4">
        <PrDescriptionCard author={author} descriptionHtml={descriptionHtml} />
      </div>

      {comments.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No comments yet.
        </div>
      ) : (
        <div className="grid gap-4">
          {comments.map((comment, index) => {
            const body = stripHtmlComments(comment.body);
            const timestamp = comment.createdAt
              ? new Date(comment.createdAt).toLocaleString()
              : null;
            return (
              <article
                className="rounded-md border border-line bg-panel"
                key={`${comment.url || comment.createdAt || index}`}
              >
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <span className="flex size-7 items-center justify-center rounded-full bg-active text-[11px] font-semibold text-fg">
                    {(comment.author || "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-fg">
                      {comment.author || "Unknown"}
                    </div>
                    {timestamp && (
                      <div className="text-[10px] text-faint">{timestamp}</div>
                    )}
                  </div>
                  {comment.url && (
                    <a
                      className="text-[11px] text-faint no-underline hover:text-fg"
                      href={comment.url}
                      target="_blank"
                      rel="noopener"
                    >
                      Open on GitHub
                    </a>
                  )}
                </div>
                <div
                  className="markdown px-4 py-4 text-[13px] leading-relaxed text-dim"
                  dangerouslySetInnerHTML={{ __html: renderPrCommentMarkdown(body) }}
                />
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewSignal({
  tone,
  label,
  detail,
  href,
}: {
  tone: "green" | "yellow" | "red";
  label: string;
  detail: string;
  href?: string;
}) {
  const content = (
    <>
      <span
        className={`flex size-[18px] shrink-0 items-center justify-center rounded-full border ${
          tone === "green"
            ? "border-green/40 text-green"
            : tone === "red"
              ? "border-red/40 text-red"
              : "border-yellow/40 text-yellow"
        }`}
      >
        {tone === "green" ? (
          <IconCheck size={11} />
        ) : tone === "red" ? (
          <IconX size={11} />
        ) : (
          <IconClock size={11} />
        )}
      </span>
      <span>
        <span
          className={`block text-[11px] font-semibold leading-tight ${
            tone === "green"
              ? "text-green"
              : tone === "red"
                ? "text-red"
                : "text-yellow"
          }`}
        >
          {label}
        </span>
        <span className="block text-[9px] leading-tight text-faint">{detail}</span>
      </span>
    </>
  );
  const className =
    "flex min-w-[155px] items-center gap-2 border-r border-line px-4 no-underline";
  return href ? (
    <a className={className} href={href} target="_blank" rel="noopener">
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

/**
 * The "Link PR" affordance: a "+" chip in the tab bar (or a quiet button in
 * the actions row when there's no bar yet) that expands into a paste-a-URL
 * input. Linking accepts any PR in a registered repo.
 */
function LinkPrControl({
  sessionId,
  variant,
  onLinked,
}: {
  sessionId: string;
  variant: "tab" | "action";
  onLinked: (all: LinkedPrEntry[], linked: LinkedPrEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const url = val.trim();
    if (!url || busy) return;
    setBusy(true);
    try {
      const res = await linkPrApi(sessionId, url);
      onLinked(res.all, res.linked);
      toast(
        `Linked ${res.linked.repo}${res.linked.number ? ` #${res.linked.number}` : ""}`,
      );
      setVal("");
      setOpen(false);
    } catch (e: any) {
      toast(e.message || "Couldn't link that PR");
    } finally {
      setBusy(false);
    }
  }

  if (!open)
    return (
      <button
        className={variant === "tab" ? "pr-repo-tab pr-link-add" : "prc-btn"}
        onClick={() => setOpen(true)}
        title="Link another PR to this session"
      >
        {variant === "tab" ? "+" : "Link PR…"}
      </button>
    );

  return (
    <form
      className="pr-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        autoFocus
        className="pr-link-input"
        placeholder="Paste a GitHub PR URL…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button
        type="submit"
        className="pr-link-submit"
        disabled={busy || !val.trim()}
      >
        {busy ? "Linking…" : "Link"}
      </button>
    </form>
  );
}

/** A Linear-style titled card: label row + a bordered body of rows. */
function PrCard({
  title,
  headExtra,
  children,
}: {
  title: string;
  headExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="prc-card">
      <div className="prc-card-head">
        <span className="prc-card-title">{title}</span>
        {headExtra}
      </div>
      <div className="prc-card-body">{children}</div>
    </div>
  );
}

function ReviewerRow({ reviewer, provider }: { reviewer: PrReviewer; provider: Provider }) {
  const src = reviewer.isTeam ? null : avatarUrl(reviewer.login, provider, 40);
  const meta = reviewerStateMeta(reviewer.state);
  return (
    <div className="prc-reviewer">
      {src ? (
        <img className="prc-reviewer-avatar" src={src} alt="" loading="lazy" />
      ) : (
        <span className="prc-reviewer-avatar prc-reviewer-avatar-fallback" aria-hidden>
          {reviewer.login.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="prc-reviewer-name">{reviewer.login}</span>
      <span className={`prc-reviewer-state prc-tone-${meta.tone}`} title={meta.label}>
        {meta.icon}
      </span>
    </div>
  );
}

function reviewerStateMeta(state: PrReviewer["state"]): {
  label: string;
  tone: "green" | "red" | "muted" | "yellow";
  icon: React.ReactNode;
} {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", tone: "green", icon: <IconCheck size={16} /> };
    case "CHANGES_REQUESTED":
      return { label: "Requested changes", tone: "red", icon: <IconX size={16} /> };
    case "COMMENTED":
      return { label: "Commented", tone: "muted", icon: <IconMessage size={16} /> };
    default:
      return { label: "Awaiting review", tone: "yellow", icon: <IconClock size={16} /> };
  }
}

function FileRow({ file, onClick }: { file: PrFile; onClick?: () => void }) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
  return (
    <button
      type="button"
      className="prc-file"
      onClick={onClick}
      disabled={!onClick}
      title={file.path}
    >
      <IconFile size={16} className="prc-file-icon" />
      <span className="prc-file-name">
        {dir && <span className="prc-file-dir">{dir}</span>}
        {base}
      </span>
      <span className="prc-file-stat">
        {file.additions > 0 && <span className="prc-add">+{file.additions}</span>}
        {file.deletions > 0 && <span className="prc-del">−{file.deletions}</span>}
      </span>
    </button>
  );
}

type PrCheckRank = "check-success" | "check-failure" | "check-pending" | "check-neutral";

export function checkClass(status: string, conclusion: string): PrCheckRank {
  if (status !== "COMPLETED" && status !== "") return "check-pending";
  // StatusContexts (Vercel deploys) report a state, not a status — a pending
  // deploy is "COMPLETED"/PENDING here and must not read as neutral.
  if (conclusion === "PENDING" || conclusion === "EXPECTED") return "check-pending";
  switch (conclusion) {
    case "SUCCESS":
      return "check-success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ERROR":
      return "check-failure";
    default:
      return "check-neutral";
  }
}

// Vercel previews arrive as StatusContexts named "Preview – <project>" (no
// workflow); everything with a workflow is CI.
export function isDeployment(check: PrCheck): boolean {
  return (
    !check.workflowName &&
    (/^preview\b/i.test(check.name) || /vercel|deploy/i.test(check.name))
  );
}

function formatCheckDuration(check: PrCheck): string | null {
  if (!check.startedAt || !check.completedAt) return null;
  const secs = Math.round(
    (new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime()) / 1000,
  );
  if (secs <= 0) return null;
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)}m`;
}

function formatPendingCommentsPrompt(comments: PendingComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const range =
        c.startLine && c.startLine !== c.endLine
          ? `${c.startLine}-${c.endLine}`
          : String(c.endLine);
      return `${i + 1}. ${c.path}:${range}\n${c.text}`;
    })
    .join("\n\n");
  return `Please address these pending review comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

function trimCommentBody(body: string): string {
  return body.trim().replace(/\n{3,}/g, "\n\n");
}

/** Bot comments hide bookkeeping in HTML comments (`<!-- marker -->`) — drop them from previews. */
function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export function formatPrCommentPrompt(comment: PrComment, pr: PrDetails): string {
  const author = comment.author ? ` from ${comment.author}` : "";
  const link = comment.url ? `\nURL: ${comment.url}` : "";
  return `Please address this PR comment${author} on PR #${pr.number} (${pr.title}).${link}\n\n${trimCommentBody(comment.body)}`;
}

function formatPrCommentsPrompt(comments: PrComment[], pr: PrDetails): string {
  const body = comments
    .map((c, i) => {
      const by = c.author ? ` by ${c.author}` : "";
      const link = c.url ? `\n${c.url}` : "";
      return `${i + 1}. Comment${by}${link}\n${trimCommentBody(c.body)}`;
    })
    .join("\n\n");
  return `Please review these PR comments on PR #${pr.number} (${pr.title}).\n\n${body}`;
}

export function CheckRow({ check }: { check: PrCheck }) {
  const cls = checkClass(check.status, check.conclusion);
  const mark = cls === "check-success" ? "✓" : cls === "check-failure" ? "✕" : "●";
  const duration = formatCheckDuration(check);
  return (
    <div className="pr-check pr-check-row">
      <a className="pr-check-main" href={check.url} target="_blank" rel="noopener">
        <span className={`pr-check-mark ${cls}-text ${cls === "check-pending" ? "pr-check-mark-pending" : ""}`}>
          {mark}
        </span>
        <span className="pr-check-name">{check.name}</span>
        {duration && <span className="pr-check-duration">{duration}</span>}
        {check.url && <span className="pr-check-open">↗</span>}
      </a>
    </div>
  );
}

/**
 * Local/remote discrepancy rows for the Status card: each gets a line with one
 * action on the right. Push is a direct server-side `git push`; the judgment
 * calls (create the PR, resolve conflicts, update from base, commit stray
 * changes) prompt the session — Michael does the work, not a bare button.
 */
function GitStatusRows({
  git,
  pr,
  sessionId,
  repo,
  send,
  onRefresh,
}: {
  git: GitStatusInfo | null;
  pr: PrDetails | null;
  sessionId: string;
  repo?: string;
  send?: (msg: any) => void;
  onRefresh: () => Promise<void> | void;
}) {
  const [pushing, setPushing] = useState(false);
  const [prompted, setPrompted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = pr?.baseRefName || git?.baseBranch || "main";

  function promptSession(label: string, content: string) {
    if (!send) return;
    send({ type: "prompt", sessionId, user: getCurrentUser(), content });
    setPrompted(label);
    setTimeout(() => setPrompted(null), 6000);
  }

  async function handlePush() {
    if (pushing) return;
    setPushing(true);
    setError(null);
    try {
      await gitPushApi(sessionId, repo);
      await onRefresh();
    } catch (e: any) {
      setError(e.message || "Push failed");
    } finally {
      setPushing(false);
    }
  }

  const rows: Array<{
    key: string;
    label: string;
    tone: string;
    strong?: boolean;
    action?: React.ReactNode;
  }> = [];

  // Base-sync (rebase) status — lead with it so the panel answers "am I behind
  // main?" at a glance. Shown for any real feature branch (not the base branch
  // itself, not a merged PR): a reassuring green "up to date" when in sync, and
  // a prominent yellow "N behind" with a one-click Update (rebase) when not.
  if (git && git.branch && git.branch !== base && pr?.state !== "MERGED") {
    const behind = git.behindBase;
    rows.push({
      key: "base-sync",
      label:
        behind > 0
          ? `${behind} commit${behind === 1 ? "" : "s"} behind ${base}`
          : `Up to date with ${base}`,
      tone: behind > 0 ? "yellow" : "green",
      strong: behind > 0,
      action:
        behind > 0 && send ? (
          <button
            className="prc-action"
            onClick={() =>
              promptSession(
                "update from " + base,
                `Update this branch with the latest origin/${base} (rebase preferred), resolve any conflicts, and push.`,
              )
            }
          >
            Update
          </button>
        ) : undefined,
    });
  }

  if (!pr && git) {
    rows.push({
      key: "no-pr",
      label: "Not pushed as a PR yet",
      tone: "muted",
      action: send && (
        <button
          className="prc-action"
          onClick={() =>
            promptSession(
              "create a PR",
              "Commit any remaining work, push the branch, and open a PR for it.",
            )
          }
        >
          Create PR
        </button>
      ),
    });
  }
  if (git && git.ahead > 0) {
    rows.push({
      key: "ahead",
      label: `${git.ahead} commit${git.ahead === 1 ? "" : "s"} ahead of remote`,
      tone: "yellow",
      action: (
        <button className="prc-action" onClick={handlePush} disabled={pushing}>
          {pushing ? "Pushing…" : "Push"}
        </button>
      ),
    });
  }
  if (git && git.uncommittedFiles > 0) {
    rows.push({
      key: "dirty",
      label: `${git.uncommittedFiles} uncommitted file${git.uncommittedFiles === 1 ? "" : "s"}`,
      tone: "yellow",
      action: send && (
        <button
          className="prc-action"
          onClick={() =>
            promptSession("commit the changes", "Commit and push the current work in the worktree.")
          }
        >
          Commit
        </button>
      ),
    });
  }
  if (pr?.mergeable === "CONFLICTING") {
    rows.push({
      key: "conflicts",
      label: "Resolve conflicts",
      tone: "red",
      action: send && (
        <button
          className="prc-action"
          onClick={() =>
            promptSession(
              "resolve the conflicts",
              `The PR has merge conflicts with ${base}. Rebase this branch on the latest origin/${base}, resolve the conflicts, and push.`,
            )
          }
        >
          Resolve
        </button>
      ),
    });
  }
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((row) => (
        <div key={row.key} className={`prc-git-row${row.strong ? " prc-git-row-strong" : ""}`}>
          <span className={`prc-git-dot prc-tone-${row.tone}`} />
          <span className="prc-git-label">{row.label}</span>
          {row.action}
        </div>
      ))}
      {prompted && <div className="prc-git-note">Asked Michael to {prompted} ✓</div>}
      {error && <div className="prc-git-note prc-git-note-error">{error}</div>}
    </>
  );
}
