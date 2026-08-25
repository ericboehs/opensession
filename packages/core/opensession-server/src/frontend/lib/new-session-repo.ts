import { AUTO_REPO, NO_REPO } from "./session-repo";

/**
 * Pick the repository value for a fresh composer once the registered repo list
 * is known. An instance with no repositories starts in Scratch rather than
 * keeping Auto, which would eventually ask the server for a nonexistent
 * default checkout.
 */
export function newSessionDefaultRepo(
	options: ReadonlyArray<{ id: string; default?: boolean }>,
	workspaceChoice: string,
): string {
	if (options.length === 0) return NO_REPO;
	return (
		(workspaceChoice === AUTO_REPO ||
		options.some((option) => option.id === workspaceChoice)
			? workspaceChoice
			: "") ||
		options.find((option) => option.default)?.id ||
		AUTO_REPO
	);
}
