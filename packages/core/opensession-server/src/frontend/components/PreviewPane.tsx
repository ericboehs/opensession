import { useEffect, useRef, useState } from "react";
import type { PreviewStatus } from "../lib/api";
import { startPreviewApi, stopPreviewApi } from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Button } from "../ui/button";
import { PageLoader } from "../ui/page-loader";

/**
 * Full-width Preview view-tab (a sibling of Review/Preview environment/Assets): the
 * session's dev server embedded in an iframe, with a toolbar to break out to
 * a real browser window, reload, or stop the preview. The app's CSP already
 * allowlists framing from the app origin (frame-ancestors https://os.tella.dev).
 *
 * Status comes from the parent (SessionViewer polls it for the header button
 * anyway); this pane starts the preview when opened while nothing runs, shows
 * the starting state, and swaps to the iframe once the URL is live. In the
 * Mac shell the break-out lands in the system browser (the Electron window-
 * open handler externalizes non-app origins).
 */
export function PreviewPane({
	session,
	status,
	onClose,
}: {
	session: UnifiedSession;
	status: PreviewStatus | null;
	onClose: () => void;
}) {
	const [reloadNonce, setReloadNonce] = useState(0);
	const [stopping, setStopping] = useState(false);
	const kickedRef = useRef(false);

	const url =
		status?.running && status.previewUrl
			? withPreviewPath(status.previewUrl, session.previewPath)
			: null;

	// Opening the tab IS the start intent: kick the claim once when nothing is
	// running or starting yet (pool claims serve in seconds).
	useEffect(() => {
		if (kickedRef.current || !status) return;
		if (!status.running && !status.starting && status.bootable !== false) {
			kickedRef.current = true;
			startPreviewApi(session.id).catch(() => {});
		}
	}, [status, session.id]);
	useEffect(() => {
		kickedRef.current = false;
	}, [session.id]);

	async function stop() {
		setStopping(true);
		try {
			await stopPreviewApi(session.id);
			onClose();
		} finally {
			setStopping(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-2 border-b border-divider bg-panel px-3 py-1.5">
				<span
					className={`h-2 w-2 shrink-0 rounded-full ${url ? "bg-green-500" : "animate-pulse bg-amber-400"}`}
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1 truncate text-supporting font-medium text-dim">
					{url ?? (status?.starting || !status ? "Starting the dev server…" : "Preview stopped")}
				</div>
				<Button
					size="sm"
					variant="soft"
					disabled={!url}
					onClick={() => setReloadNonce((n) => n + 1)}
				>
					Reload
				</Button>
				<Button
					size="sm"
					variant="soft"
					disabled={!url}
					onClick={() => url && window.open(url, `preview-${session.id}`, "noopener")}
					title="Open in a separate browser window"
				>
					Open in browser
				</Button>
				<Button
					size="sm"
					variant="soft"
					className="hover:bg-red-soft hover:text-red"
					disabled={stopping || (!status?.running && !status?.starting)}
					onClick={stop}
					title="Stop the dev server and release its container"
				>
					{stopping ? "Stopping…" : "Stop"}
				</Button>
			</div>
			{url ? (
				<iframe
					key={`${url}#${reloadNonce}`}
					className="block min-h-0 w-full flex-1 border-0 bg-white"
					src={url}
					title={`Preview · ${session.title || session.id}`}
					allow="clipboard-read; clipboard-write; fullscreen"
					sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"
				/>
			) : (
				<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
					<PageLoader className="text-dim" />
					<div className="text-item-title font-semibold text-fg">
						{status?.starting || !status ? "Starting the dev server…" : "Preview is not running"}
					</div>
					<div className="max-w-sm text-supporting font-medium leading-relaxed text-dim">
						{status?.starting || !status
							? "Warm claims serve in seconds; a big branch jump can take a minute to compile."
							: "It may have been stopped or released. Close and reopen this tab to start it again."}
					</div>
				</div>
			)}
		</div>
	);
}
