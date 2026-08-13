import { renderPrCommentMarkdown } from "../../lib/markdown";
import { stripHtmlComments } from "../../lib/pr-prompts";
import type { PrCheck, PrComment, PrCommit } from "../../lib/types";
import { CheckRow } from "./CheckRow";

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
    <article className="min-w-0 rounded-md border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-active text-[11px] font-semibold text-fg">
          {author.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <div className="text-xs font-semibold text-fg">{author}</div>
          <div className="text-meta text-faint">Opened this pull request</div>
        </div>
      </div>
      <div
        className="markdown px-4 py-4 text-body leading-relaxed text-dim"
        dangerouslySetInnerHTML={{ __html: descriptionHtml }}
      />
    </article>
  );
}

export function ChecksView({
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
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
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
            <section className="min-w-0 rounded-md border border-line bg-panel p-3">
              <h3 className="m-0 px-2 pb-2 text-xs font-semibold text-fg">CI checks</h3>
              {checks.map((check, index) => (
                <CheckRow key={`${check.name}-${index}`} check={check} />
              ))}
            </section>
          )}
          {deployments.length > 0 && (
            <section className="min-w-0 rounded-md border border-line bg-panel p-3">
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

export function CommitsView({
  commits,
  showNotes,
}: {
  commits: PrCommit[];
  /** capabilities.commitNotes — git-notes annotations exist on this host
   *  (code.storage). GitHub payloads never carry notes and never set this. */
  showNotes?: boolean;
}) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
          Commits
        </h2>
        <p className="mt-1 text-xs text-faint">
          {commits.length} commit{commits.length === 1 ? "" : "s"}
        </p>
      </div>
      {commits.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No commits reported.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line bg-panel">
          {commits.map((commit) => (
            <article
              className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0"
              key={commit.oid}
            >
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-dim">
                <CommitIcon />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-fg">{commit.messageHeadline}</div>
                {commit.messageBody && (
                  <div className="mt-1 line-clamp-2 whitespace-pre-wrap text-meta leading-relaxed text-dim">
                    {commit.messageBody}
                  </div>
                )}
                <div className="mt-1.5 text-meta text-faint">
                  {commit.author}
                  {commit.authoredDate ? ` committed ${new Date(commit.authoredDate).toLocaleString()}` : ""}
                </div>
                {showNotes && !!commit.notes?.length && (
                  <div className="mt-2 grid gap-1.5">
                    {commit.notes.map((note) => (
                      <div
                        className="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-meta leading-relaxed text-dim"
                        key={note.ref}
                      >
                        <span className="mr-1.5 font-medium text-faint">{note.ref}</span>
                        <span className="whitespace-pre-wrap">{note.text}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <code className="shrink-0 rounded-sm border border-line bg-surface px-2 py-1 text-meta text-dim">
                {commit.oid.slice(0, 7)}
              </code>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConversationView({
  author,
  descriptionHtml,
  comments,
  repo,
}: {
  author: string;
  descriptionHtml: string;
  comments: PrComment[];
  /** The repo a bare `#5528` in a comment refers to (see markdown.ts). */
  repo?: string;
}) {
  return (
    /* `w-full` is load-bearing, not belt-and-braces: this column is a flex item
       and `mx-auto` (an auto cross-axis margin) opts it out of stretching, so
       without it the box sizes to its content and `max-w` becomes a fixed 760px
       that a phone can't fit. */
    <div className="mx-auto w-full min-w-0 max-w-[760px]">
      <div className="mb-6">
        <h2 className="m-0 text-section-title font-semibold tracking-[-0.01em] text-fg">
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
                /* A grid item's automatic minimum size is its min-content
                   width, so a wide comment (a deploy table, a long path) would
                   otherwise stretch the track past the viewport. */
                className="min-w-0 rounded-md border border-line bg-panel"
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
                      <div className="text-meta text-faint">{timestamp}</div>
                    )}
                  </div>
                  {comment.url && (
                    <a
                      className="text-meta text-faint no-underline hover:text-fg"
                      href={comment.url}
                      target="_blank"
                      rel="noopener"
                    >
                      Open on GitHub
                    </a>
                  )}
                </div>
                <div
                  className="markdown px-4 py-4 text-body leading-relaxed text-dim"
                  dangerouslySetInnerHTML={{
                    __html: renderPrCommentMarkdown(body, { repo }),
                  }}
                />
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function CommitIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.5 7.25a3.5 3.5 0 0 0-6.92 0H1.75a.75.75 0 0 0 0 1.5h2.83a3.5 3.5 0 0 0 6.92 0h2.75a.75.75 0 0 0 0-1.5H11.5ZM8 10a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z" />
    </svg>
  );
}
