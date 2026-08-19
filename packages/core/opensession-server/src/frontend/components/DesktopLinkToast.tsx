import { useState } from "react";
import { IconX } from "./icons";
import { desktopProtocolUrlFromBrowser } from "../lib/desktop-link";
import { SIDEBAR_TOAST_CARD } from "../lib/sidebar-toast-classes";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";

export function DesktopLinkToast() {
	const [dismissed, setDismissed] = useState(false);
	const url = desktopProtocolUrlFromBrowser();
	if (!url || dismissed) return null;

	return (
		<div
			className={SIDEBAR_TOAST_CARD}
			role="region"
			aria-label="Open in app"
		>
			{/* Names the destination, not the product: you are already in the
			    product, so repeating its name here just said the button twice.
			    "Open in app" is what the web reaches for when it hands off to
			    a native client, and the platform is implied because the toast
			    only renders on a Mac (desktop-link.ts gates on it). */}
			<span className="min-w-0 flex-1 truncate text-label font-medium leading-[1.3] text-fg">
				Open in app
			</span>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					variant="primary"
					size="sm"
					onClick={() => {
						// A user-initiated hidden navigation can open a custom protocol while
						// keeping this web page available when no desktop app handles it.
						const frame = document.createElement("iframe");
						frame.hidden = true;
						frame.setAttribute("aria-hidden", "true");
						frame.src = url;
						document.body.appendChild(frame);
						setTimeout(() => frame.remove(), 1_500);
					}}
				>
					Open
				</Button>
				<Tooltip label="Dismiss" side="top">
					<Button
						variant="ghost"
						size="sm"
						icon={<IconX size={16} />}
						aria-label="Dismiss"
						onClick={() => setDismissed(true)}
					/>
				</Tooltip>
			</div>
		</div>
	);
}
