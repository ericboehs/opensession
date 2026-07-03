/** Shared identifiers for the github PR agent. */

/** Internal/automation event key — the seeded automation subscribes to this. */
export const PR_EVENT_KEY = "github:pull_request";
/** Name of the seeded (disabled-by-default) review automation. */
export const REVIEW_AUTOMATION_NAME = "github-pr-review";

/** Internal event key published when a PR is merged into tella-fusion. */
export const PR_MERGED_EVENT_KEY = "github:pr_merged";
/** Name of the seeded docs-sync automation (fires on PR merge). */
export const DOCS_SYNC_AUTOMATION_NAME = "docs-sync";
/** Branch prefix for docs-sync's own PRs — skipped on merge so it can't loop. */
export const DOCS_SYNC_BRANCH_PREFIX = "auto-docs-sync-";
/** #proj-help-center — where docs-sync announces the PRs it opens. */
export const DOCS_SYNC_SLACK_CHANNEL = "C09BAFFK8F8";

/**
 * Marker in tella-butler's Vercel preview-table PR comment (edited in place as
 * deploys progress). Same string pr-info.ts's parseStaging keys on.
 */
export const PREVIEW_COMMENT_MARKER = "add-pr-comment:tella-vercel-preview";

export const LABEL_REVIEW = "michael-review";
export const LABEL_AUTOFIX = "michael-auto-fix";
export const LABEL_SIMPLIFY = "michael-simplify";
export const LABEL_ADVERSARIAL = "michael-adversarial";
