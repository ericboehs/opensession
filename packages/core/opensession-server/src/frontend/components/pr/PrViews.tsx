import { renderPrCommentMarkdown } from "../../lib/markdown";
import { formatPrCommentPrompt, stripHtmlComments } from "../../lib/pr-prompts";
import type { PrComment, PrDetails } from "../../lib/types";

function PrDescriptionCard({
  author,
  descriptionHtml,
}: {
  author: string;
  descriptionHtml: string;
}) {
  if (!descriptionHtml)
    return (
      <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
        This pull request has no description.
      </div>
    );
  return (
    <article className="min-w-0 rounded-xl border border-line/60 bg-surface smooth-shadow-sm">
      <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-active text-meta font-semibold text-fg">
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

/**
 * The Overview page's main column: the description, then the conversation.
 *
 * It carries no heading of its own — the page tab above it already says where
 * you are, and a second "Conversation" title only pushed the description down.
 */
export function ConversationView({
  author,
  descriptionHtml,
  comments,
  repo,
  pr,
  onAddToInput,
}: {
  author: string;
  descriptionHtml: string;
  comments: PrComment[];
  /** The repo a bare `#5528` in a comment refers to (see markdown.ts). */
  repo?: string;
  pr?: PrDetails;
  /** Append one comment to the session's composer draft. */
  onAddToInput?: (text: string) => void;
}) {
  return (
    /* `w-full` is load-bearing, not belt-and-braces: this column is a flex item
       and `mx-auto` (an auto cross-axis margin) opts it out of stretching, so
       without it the box sizes to its content and `max-w` becomes a fixed 760px
       that a phone can't fit. */
    <div className="mx-auto flex w-full min-w-0 max-w-[760px] flex-col gap-4">
      <PrDescriptionCard author={author} descriptionHtml={descriptionHtml} />

      {comments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-xs text-faint">
          No comments yet.
        </div>
      ) : (
        comments.map((comment, index) => {
          const body = stripHtmlComments(comment.body);
          const timestamp = comment.createdAt
            ? new Date(comment.createdAt).toLocaleString()
            : null;
          return (
            <article
              /* A grid item's automatic minimum size is its min-content
                 width, so a wide comment (a deploy table, a long path) would
                 otherwise stretch the track past the viewport. */
              className="group min-w-0 rounded-xl border border-line/60 bg-surface smooth-shadow-sm"
              key={`${comment.url || comment.createdAt || index}`}
            >
              <div className="flex items-center gap-2 border-b border-divider px-4 py-3">
                <span className="flex size-7 items-center justify-center rounded-full bg-active text-meta font-semibold text-fg">
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
                {onAddToInput && pr && (
                  <button
                    className="rounded-md border-0 bg-transparent px-1.5 py-1 text-meta text-faint opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={() => onAddToInput(formatPrCommentPrompt(comment, pr))}
                  >
                    Add to session
                  </button>
                )}
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
        })
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
