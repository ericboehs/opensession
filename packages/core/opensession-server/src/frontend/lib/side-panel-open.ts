/** The workspace side panel is a browser-wide view choice. */
export const SIDE_PANEL_OPEN_KEY = "opensession-panel-open";

/**
 * The summary card is the default workspace view. Once the person opens or
 * closes the side panel, keep that choice across workspaces and reloads.
 */
export function sidePanelOpen(
	storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
	return storage.getItem(SIDE_PANEL_OPEN_KEY) === "true";
}

export function storeSidePanelOpen(
	open: boolean,
	storage: Pick<Storage, "setItem"> = localStorage,
): void {
	storage.setItem(SIDE_PANEL_OPEN_KEY, String(open));
}
