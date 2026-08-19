import { useState } from "react";
import { linkPrStackApi } from "../../lib/api";
import { stackLayersTopFirst } from "../../lib/pr-stack";
import { prPath } from "../../lib/share-link";
import type { PrDetails } from "../../lib/types";
import { Button } from "../../ui/button";
import { toast } from "../../ui/toast";
import { PrStateIcon } from "./PrStateIcon";
import { Badge } from "../../ui/badge";

/**
 * The stack map: every layer of a GitHub stack, top layer first (the trunk
 * sits under the last row, the way the stack is drawn on github.com). The row
 * for the PR being viewed is marked rather than linked — it's already here.
 *
 * Also carries the "link into a stack" action for a session that was branched off
 * another session's branch but whose PRs were never linked (pr.stackBase, set by
 * the session PR route).
 */
/**
 * The stack map body: every layer of a GitHub stack, top layer first (the
 * trunk sits under the last row, the way the stack is drawn on github.com).
 * The row for the PR being viewed is marked rather than linked — it's already
 * here. Rendered by both PrPanel layouts through the wrappers below.
 *
 * Also carries the "link into a stack" action for a session that was branched off
 * another session's branch but whose PRs were never linked (pr.stackBase, set by
 * the session PR route).
 */
function StackBody({
  pr,
  sessionId,
  repo,
  onOpenPr,
  onLinked,
}: {
  pr: PrDetails;
  sessionId?: string;
  /** Registered repo id, for building in-app links to the other layers. */
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onLinked: () => void;
}) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stack = pr.stack;

  const link = async () => {
    if (!sessionId) return;
    setLinking(true);
    setError(null);
    try {
      await linkPrStackApi(sessionId);
      toast("Linked into a stack");
      onLinked();
    } catch (e: any) {
      setError(e?.message || "Couldn't link the stack");
    } finally {
      setLinking(false);
    }
  };

  if (!stack)
    return (
      <>
        <div className="text-xs leading-relaxed text-dim">
          This branch was cut from{" "}
          <Badge variant="outline">
            {pr.stackBase}
          </Badge>{" "}
          but the PRs aren't a stack on GitHub yet, so each is still reviewed against the whole chain.
        </div>
        <div className="flex items-center gap-3 pt-1">
          <Button
            size="sm"
            onClick={link}
            disabled={linking}
          >
            {linking ? "Linking…" : "Link into a stack"}
          </Button>
          {error && <span className="text-xs text-red">{error}</span>}
        </div>
      </>
    );

  // Top of the stack first — the trunk is the base line below the last row.
  const layers = stackLayersTopFirst(stack);
  return (
    <>
      {layers.map((layer) => {
        const current = layer.number === pr.number;
        const tone =
          layer.state === "MERGED"
            ? "text-purple"
            : layer.state === "CLOSED"
              ? "text-red"
              : layer.isDraft
                ? "text-faint"
                : "text-green";
        const body = (
          <>
            <span className={`shrink-0 ${tone}`}>
              <PrStateIcon state={layer.state} isDraft={layer.isDraft} />
            </span>
            <span className="min-w-0 flex-1 truncate">{layer.title}</span>
            <span className="shrink-0 text-faint">#{layer.number}</span>
          </>
        );
        if (current)
          return (
            <div
              key={layer.number}
              className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-xs font-medium text-fg"
              aria-current="true"
            >
              {body}
            </div>
          );
        // Other layers open in THIS review panel, not on github.com — the PR
        // title above is already the link out. Falls back to the GitHub URL
        // only when the repo id is unknown, so a row is never a dead end.
        const inApp = repo ? prPath(repo, layer.headRefName) : null;
        return (
          <a
            key={layer.number}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-dim no-underline hover:bg-surface hover:text-fg"
            href={inApp || layer.url}
            {...(inApp ? {} : { target: "_blank", rel: "noopener" })}
            onClick={(e) => {
              // Modified clicks keep native new-tab behavior.
              if (!inApp || !onOpenPr || e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              onOpenPr(repo!, layer.headRefName);
            }}
            title={layer.headRefName}
          >
            {body}
          </a>
        );
      })}
      <div className="border-t border-line pt-2 text-meta text-faint">
        Bottom of the stack merges into{" "}
        <span className="rounded-sm border border-line bg-surface px-1.5 py-0.5">
          {stack.baseRefName}
        </span>
      </div>
    </>
  );
}

/**
 * Whether this PR has anything stack-shaped to say: a real stack, or a session
 * stacked locally whose PRs a human could still link. Both layouts gate on
 * this so a standalone PR never grows an empty section.
 */
function hasStackToShow(pr: PrDetails, sessionId?: string): boolean {
  return !!pr.stack || (!!pr.stackBase && !!sessionId);
}

/** Where this PR sits in its chain of layers, under the review header. */
export function StackSection({
  pr,
  sessionId,
  repo,
  onOpenPr,
  onLinked,
}: {
  pr: PrDetails;
  sessionId?: string;
  repo?: string;
  onOpenPr?: (repo: string, branch: string) => void;
  onLinked: () => void;
}) {
  if (!hasStackToShow(pr, sessionId)) return null;
  return (
    <section className="shrink-0 px-6 pb-4 phone:px-3">
      <h2 className="m-0 mb-1 flex items-center gap-2 text-xs font-semibold text-dim">
        Stack
        {pr.stack && (
          <span className="font-normal text-faint">
            {pr.stack.position} of {pr.stack.size}
          </span>
        )}
      </h2>
      <div className="flex max-w-[680px] flex-col gap-1">
        <StackBody pr={pr} sessionId={sessionId} repo={repo} onOpenPr={onOpenPr} onLinked={onLinked} />
      </div>
    </section>
  );
}
