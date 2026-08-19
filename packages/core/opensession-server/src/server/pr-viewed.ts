/**
 * GitHub's per-viewer "Viewed" state on PR files, over the GraphQL API
 * (`viewerViewedState` + the markFileAsViewed/unmarkFileAsViewed mutations).
 *
 * Viewed state is per GitHub account, so calls prefer the requester's
 * connected GitHub token (github-auth.ts) and fall back to the bot PAT —
 * with the fallback every teammate shares the bot's view, which is still the
 * pre-existing single-user behavior. GitHub also owns the staleness
 * semantics: a file changed after being viewed comes back DIRTY, which we
 * treat as not viewed (same as github.com's file list).
 */

import type { RouteContext } from "./routes/context";
import { githubCredentialForLogin, githubUserLoginForRun } from "./github-auth";
import { botGhToken } from "./github-limit";
import { fetchWithTimeout } from "./shared/fetch-with-timeout";

export interface PrViewedFiles {
	/** GraphQL node id for the PR — clients echo it back on toggles. */
	prId: string;
	/** Paths whose viewerViewedState is VIEWED (DIRTY/UNVIEWED excluded). */
	viewed: string[];
}

/** The requester's GitHub token: their connected account, else the bot PAT. */
async function viewerToken(
	ctx: RouteContext,
	claimedUser?: string | null,
): Promise<string | null> {
	const login = ctx.authUser?.login ?? githubUserLoginForRun(claimedUser);
	if (login) {
		const cred = githubCredentialForLogin(login);
		if (cred?.env.GH_TOKEN) return cred.env.GH_TOKEN;
	}
	return botGhToken();
}

async function graphql(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<any> {
	const res = await fetchWithTimeout(
		"https://api.github.com/graphql",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		},
		15_000,
	);
	const data = (await res.json().catch(() => null)) as any;
	if (!res.ok || !data || data.errors?.length) {
		const message =
			data?.errors?.[0]?.message || data?.message || `GitHub HTTP ${res.status}`;
		throw new Error(message);
	}
	return data.data;
}

const VIEWED_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`;

/** All VIEWED paths on a PR for the requesting viewer, plus the PR node id. */
export async function getPrViewedFiles(
	ctx: RouteContext,
	claimedUser: string | null,
	ghRepo: string,
	number: number,
): Promise<PrViewedFiles> {
	const token = await viewerToken(ctx, claimedUser);
	if (!token) throw new Error("No GitHub credential available");
	const [owner, name] = ghRepo.split("/");
	const viewed: string[] = [];
	let prId = "";
	let cursor: string | null = null;
	// 100 files/page; 30 pages ≈ GitHub's own 3000-file diff display cap.
	for (let page = 0; page < 30; page++) {
		const data = await graphql(token, VIEWED_QUERY, {
			owner,
			name,
			number,
			cursor,
		});
		const pull = data?.repository?.pullRequest;
		if (!pull) throw new Error("Pull request not found");
		prId = pull.id;
		for (const node of pull.files?.nodes || []) {
			if (node?.viewerViewedState === "VIEWED") viewed.push(node.path);
		}
		if (!pull.files?.pageInfo?.hasNextPage) break;
		cursor = pull.files.pageInfo.endCursor;
	}
	return { prId, viewed };
}

/** Mark or unmark one file as viewed for the requesting viewer. */
export async function setPrFileViewed(
	ctx: RouteContext,
	claimedUser: string | null,
	prId: string,
	filePath: string,
	viewed: boolean,
): Promise<void> {
	const token = await viewerToken(ctx, claimedUser);
	if (!token) throw new Error("No GitHub credential available");
	const mutation = viewed
		? `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
		: `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`;
	await graphql(token, mutation, { id: prId, path: filePath });
}
