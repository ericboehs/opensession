/**
 * Provider-agnostic naming for the code-review UI. Backstage talks to GitHub
 * today (the `gh` CLI is the only backend), but the UI copy shouldn't hardcode
 * "GitHub" — it derives the provider from a PR's URL host so the same
 * components read correctly if a repo ever lives on GitLab or Bitbucket, and so
 * the generic surfaces (the sidebar tab, the Reviews module) can just say
 * "code review" / "pull request" without naming a vendor.
 */

export interface Provider {
	/** Stable key: github | gitlab | bitbucket | git (unknown host). */
	key: string;
	/** Display name for "Open on <name>": GitHub, GitLab, Bitbucket, or "the provider". */
	name: string;
	/** What this provider calls a change: "pull request" / "merge request". */
	changeNoun: string;
	/** Abbreviated change noun for chips: "PR" / "MR". */
	changeAbbr: string;
}

const GITHUB: Provider = { key: "github", name: "GitHub", changeNoun: "pull request", changeAbbr: "PR" };
const GITLAB: Provider = { key: "gitlab", name: "GitLab", changeNoun: "merge request", changeAbbr: "MR" };
const BITBUCKET: Provider = { key: "bitbucket", name: "Bitbucket", changeNoun: "pull request", changeAbbr: "PR" };
const GENERIC: Provider = { key: "git", name: "the provider", changeNoun: "pull request", changeAbbr: "PR" };

/**
 * Infer the provider from a PR/MR URL. Defaults to GitHub — it's the only
 * backend wired up, so a missing/opaque URL should still read as GitHub rather
 * than the vague "the provider".
 */
export function providerFromUrl(url: string | null | undefined): Provider {
	if (!url) return GITHUB;
	let host = "";
	try {
		host = new URL(url).host.toLowerCase();
	} catch {
		host = url.toLowerCase();
	}
	if (host.includes("gitlab")) return GITLAB;
	if (host.includes("bitbucket")) return BITBUCKET;
	if (host.includes("github")) return GITHUB;
	// Unknown self-hosted host: assume GitHub Enterprise (the supported backend)
	// rather than the anonymous fallback.
	return url ? GITHUB : GENERIC;
}

/** Avatar URL for a login on the given provider. GitHub serves `/<login>.png`. */
export function avatarUrl(login: string, provider: Provider, size = 40): string | null {
	if (!login) return null;
	if (provider.key === "github")
		return `https://github.com/${encodeURIComponent(login)}.png?size=${size}`;
	return null;
}
