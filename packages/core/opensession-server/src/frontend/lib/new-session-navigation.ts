export function shouldOpenCreatedSession(
	draft: { originPath: string; background?: boolean } | null,
	currentPath: string,
	creationSurfaceOpen: boolean,
): boolean {
	// Creation events without a tracked palette owner come from direct session
	// actions and retain their established navigate-on-success behavior.
	if (!draft) return true;
	// "Create in background" asked for the current view to stay put.
	if (draft.background) return false;
	return creationSurfaceOpen && draft.originPath === currentPath;
}
