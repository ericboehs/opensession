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
 * PR trigger labels. Canonical names are the generic os-* ones; the legacy
 * michael-* names keep working — matching accepts either alias
 * (labelMatches) and removal clears both (labelAliases). The persisted
 * comment markers (github-rest.ts <!-- michael-* -->) stay literal: existing
 * PR comments carry them and they're never user-facing.
 */
export const LABEL_REVIEW = "os-review";
export const LABEL_AUTOFIX = "os-auto-fix";
export const LABEL_SIMPLIFY = "os-simplify";
export const LABEL_ADVERSARIAL = "os-adversarial";

const CANONICAL_PREFIX = "os-";
const LEGACY_PREFIX = "michael-";

/** A label's canonical os-* form (legacy michael-* folds onto it). */
export function canonicalLabel(name: string): string {
  return name.startsWith(LEGACY_PREFIX)
    ? CANONICAL_PREFIX + name.slice(LEGACY_PREFIX.length)
    : name;
}

/** Does an applied label mean this canonical trigger (either alias)? */
export function labelMatches(name: string, canonical: string): boolean {
  return canonicalLabel(name) === canonical;
}

/** Every accepted name for a canonical label — for removal after a run. */
export function labelAliases(canonical: string): string[] {
  return [canonical, LEGACY_PREFIX + canonical.slice(CANONICAL_PREFIX.length)];
}
