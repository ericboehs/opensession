/**
 * The single source of truth for the GitHub App's permissions.
 *
 * One definition renders three ways — the create-app URL (what GitHub grants
 * the App), the read installation token, and the write installation token — so
 * they can never drift apart. Drift is exactly what left real Apps missing
 * `checks` and `issues`: the create builders under-requested, the mints asked
 * for scopes the App was never granted, and every installation token 422'd and
 * fell back silently to the bot PAT.
 *
 * A mint is all-or-nothing: it succeeds only if every requested scope is a
 * subset of what the installation holds. So each mint set below is a strict
 * subset of the grant set, and the grant set is what the create URL requests.
 */

/** The full set the App is granted at creation — the create-URL permission
 *  params, and the superset of every mint. */
export const GITHUB_APP_GRANT_PERMISSIONS: Record<string, string> = {
	actions: "read", // workflow runs/logs for trusted autofix diagnosis
	checks: "read", // CI check runs — App-only; no PAT can read them
	statuses: "read", // commit statuses, the other half of the status rollup
	contents: "write", // push fixes, clone
	pull_requests: "write", // reviews, comments, open/merge
	issues: "write", // issue and PR comments
	members: "read", // team roster / attribution
	deployments: "read", // Vercel preview deployment + status polling
	metadata: "read", // required baseline
};

/** Read installation token (pr-info's statusCheckRollup) — the read view of the
 *  grant. Contents/pull_requests/issues at read, plus checks/statuses, members,
 *  deployments, and metadata as granted. No `actions`: the rollup needs check runs and statuses, not workflow
 *  runs, and requesting an ungranted scope would 422 the token. */
export const GITHUB_APP_READ_PERMISSIONS: Record<string, string> = {
	checks: "read",
	statuses: "read",
	pull_requests: "read",
	contents: "read",
	issues: "read",
	members: "read",
	deployments: "read",
	metadata: "read",
};

/** Write installation token (the PR agent) — exactly what writes need. No
 *  read-only scopes: their absence must not 422 a token that never touches
 *  them. */
export const GITHUB_APP_WRITE_PERMISSIONS: Record<string, string> = {
	pull_requests: "write",
	issues: "write",
	contents: "write",
	metadata: "read",
};

/** Repository-scoped token projected only to trusted GitHub code workflows.
 * It can push/reply and inspect the failing checks and workflow logs it must
 * diagnose, but remains bound to the one owner-verified repository. */
export const GITHUB_APP_CODE_PERMISSIONS: Record<string, string> = {
	...GITHUB_APP_WRITE_PERMISSIONS,
	actions: "read",
	checks: "read",
	statuses: "read",
};
