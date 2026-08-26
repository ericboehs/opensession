/**
 * What shipped in a repo that has no pull requests.
 *
 * A `sharedCheckout` repo (Open Session's own, self-hosting from one tree)
 * lands work as commits straight on the default branch, so the PR cache has
 * nothing to say about it and the feed showed the repo as if it had shipped
 * nothing all year. The commits themselves are the shipping record, and they
 * are already on disk: this reads them with `git log` rather than the API, so
 * it costs no GitHub quota and works for a repo with no `ghRepo` at all.
 *
 * Only `sharedCheckout` repos are read. Everywhere else a merge is a PR, and
 * listing both would show the same work twice.
 */
import { $ } from "bun";
import { configuredRepos } from "./config";
import { personKeyForGitAuthor } from "./shared/user-mappings";

export interface RecentCommit {
	/** Repo id, as in `configuredRepos()`. */
	repo: string;
	sha: string;
	title: string;
	/** GitHub commit page; absent for a repo with no `ghRepo`. */
	url?: string;
	/** Git author name, for repos whose authors aren't teammates. */
	author: string;
	/** Web user-picker key ("kent"), or null when the author isn't a teammate. */
	person: string | null;
	committedAt: string;
	filesChanged: number;
	additions: number;
	deletions: number;
	/** The session that wrote it, when one can be named (commit-sessions.ts). */
	sessionId?: string;
}

/** How far back to read per repo. A flat commit count was the wrong unit: a
 *  repo shipping 200 commits a day burned a 250-commit budget in thirty
 *  hours, so the feed could not reach yesterday however far you scrolled.
 *  The read is a date range now, with a count ceiling so a runaway repo still
 *  costs a bounded `git log`. */
const READ_DAYS = 45;
const READ_LIMIT = 4000;
/** What a caller gets when it doesn't ask for a window. A few days keeps the
 *  first page cheap; the feed widens it from there. */
export const DEFAULT_DAYS = 3;
const CACHE_TTL_MS = 60_000;

const RECORD = "\x1e";
const FIELD = "\x1f";

/**
 * Parse `git log --shortstat` written with the record/field separators below.
 * Exported for the test; every call site goes through `getRecentCommits`.
 */
export function parseCommitLog(
	stdout: string,
	repo: { id: string; ghRepo?: string },
): RecentCommit[] {
	const out: RecentCommit[] = [];
	for (const chunk of stdout.split(RECORD)) {
		if (!chunk.trim()) continue;
		const [head, ...rest] = chunk.split("\n");
		const [sha, author, email, date, ...titleParts] = head.split(FIELD);
		if (!sha || !date) continue;
		// The subject is last and can't contain a newline, but it can contain
		// anything else — including our field separator, in principle.
		const title = titleParts.join(FIELD).trim();
		const stat = rest.join("\n");
		out.push({
			repo: repo.id,
			sha,
			title: title || sha.slice(0, 7),
			...(repo.ghRepo ? { url: `https://github.com/${repo.ghRepo}/commit/${sha}` } : {}),
			author: author || "",
			person: personKeyForGitAuthor(author, email),
			committedAt: date,
			filesChanged: Number(stat.match(/(\d+) files? changed/)?.[1] || 0),
			additions: Number(stat.match(/(\d+) insertions?\(\+\)/)?.[1] || 0),
			deletions: Number(stat.match(/(\d+) deletions?\(-\)/)?.[1] || 0),
		});
	}
	return out;
}

/** The branch to read: what's on the remote, falling back to the local branch
 *  so a checkout that has never fetched still reports its own history. */
async function shippedRef(dir: string, defaultBranch: string): Promise<string | null> {
	for (const ref of [`origin/${defaultBranch}`, defaultBranch, "HEAD"]) {
		const ok = await $`git -C ${dir} rev-parse --verify --quiet ${ref}`.quiet().nothrow();
		if (ok.exitCode === 0) return ref;
	}
	return null;
}

async function readRepoCommits(repo: {
	id: string;
	repo: string;
	ghRepo?: string;
	defaultBranch: string;
}): Promise<RecentCommit[]> {
	const ref = await shippedRef(repo.repo, repo.defaultBranch);
	if (!ref) return [];
	// The committer date, not the author date: a commit that was written in the
	// morning and rebased on at noon shipped at noon, and sorting the feed by
	// when it was written buries it under work that landed after it.
	const format = `${RECORD}%H${FIELD}%an${FIELD}%ae${FIELD}%cI${FIELD}%s`;
	const log = await $`git -C ${repo.repo} log ${ref} --no-merges --since=${`${READ_DAYS}.days.ago`} -n ${READ_LIMIT} --shortstat --format=${format}`
		.quiet()
		.nothrow();
	if (log.exitCode !== 0) return [];
	return parseCommitLog(log.stdout.toString(), repo);
}

/** The deep read, and when `git log` ran. Callers need the second: it is the
 *  instant this list is complete as of, and nothing later can be in it. */
interface CommitRead {
	data: RecentCommit[];
	ts: number;
}

let cache: CommitRead | null = null;
let inFlight: Promise<CommitRead> | null = null;

export interface RecentCommitPage {
	commits: RecentCommit[];
	/** The window actually served, after clamping to what is read. */
	days: number;
	/** There is older history to ask for. False means this is all of it, so a
	 *  caller offering "show more" can stop offering it. */
	hasMore: boolean;
}

/**
 * Recent commits on the default branch of every repo that ships without PRs,
 * newest first, from the last `days`.
 *
 * One deep read is cached and every window is a slice of it, so widening the
 * feed costs an array filter rather than another `git log` — and the response
 * stays proportional to what was asked for, which is what keeps the first page
 * of a busy repo small.
 */
export async function getRecentCommits(days = DEFAULT_DAYS): Promise<RecentCommitPage> {
	const { data: all, ts: readAt } = await readAllCommits();
	// Name the session behind each one. Every commit read is offered, not just
	// the window asked for: a transcript is read once, so a sha the sweep walks
	// past without looking for is a link lost for good. Which is also why the
	// sweep is told when this list was read, since a cached list is a list that
	// does not yet know about the last minute of commits.
	await linkSessions(all, readAt);
	const window = clampDays(days);
	const cutoff = Date.now() - window * 86_400_000;
	const commits = all.filter((commit) => new Date(commit.committedAt).getTime() >= cutoff);
	return { commits, days: window, hasMore: commits.length < all.length };
}

/** Newest commits attributed to any of these sessions. This is the provenance
 * query for workspace summaries: unlike a branch diff, it keeps answering
 * after a shared-checkout commit has been pushed onto the default branch. */
export async function getRecentCommitsForSessions(
	sessionIds: ReadonlySet<string>,
	limit = 20,
): Promise<RecentCommit[]> {
	if (sessionIds.size === 0 || limit <= 0) return [];
	const { data: all, ts: readAt } = await readAllCommits();
	await linkSessions(all, readAt);
	return all
		.filter((commit) => Boolean(commit.sessionId && sessionIds.has(commit.sessionId)))
		.slice(0, limit);
}

async function linkSessions(commits: RecentCommit[], readAt: number): Promise<void> {
	try {
		const { commitSessions } = await import("./commit-sessions");
		const sessions = await commitSessions(commits, readAt);
		for (const commit of commits) {
			const session = sessions.get(commit.sha);
			if (session) commit.sessionId = session;
		}
	} catch {
		// A feed without session links is still a feed.
	}
}

/** Windows outside the read range can't be honoured, so they aren't offered. */
export function clampDays(days: number): number {
	if (!Number.isFinite(days)) return DEFAULT_DAYS;
	return Math.min(READ_DAYS, Math.max(1, Math.floor(days)));
}

async function readAllCommits(): Promise<CommitRead> {
	if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache;
	if (inFlight) return inFlight;
	inFlight = (async () => {
		// Stamped before the read, not after: a commit made while `git log` was
		// running may or may not be in what it returned, and claiming otherwise
		// is what would let the sweep walk past it.
		const ts = Date.now();
		const repos = Object.values(configuredRepos()).filter(
			(repo) => repo.sharedCheckout && repo.repo,
		);
		const perRepo = await Promise.all(repos.map((repo) => readRepoCommits(repo).catch(() => [])));
		const data = perRepo
			.flat()
			.sort((a, b) => (b.committedAt || "").localeCompare(a.committedAt || ""));
		cache = { data, ts };
		return cache;
	})().finally(() => {
		inFlight = null;
	});
	return inFlight;
}
