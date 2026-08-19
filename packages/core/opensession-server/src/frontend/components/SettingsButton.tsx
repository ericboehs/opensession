import React from "react";
import {
	APP_LOGO_BUTTON,
	APP_LOGO_IMAGE,
	APP_LOGO_STATUS,
} from "../lib/app-header-classes";
import { Tooltip } from "../ui/tooltip";
import { useCurrentUser } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";

// The trigger that opens Settings, plus the live connection dot. It used to be
// an account menu (switcher + sign out + a Settings item); one click now goes
// straight to the Settings page, and the account itself — who sessions act as,
// and sign out — lives at the bottom of that page (SettingsAccount.tsx).
//
// Trigger shapes via `variant`:
//   "brand" — the mobile top bar logo.
//   "user"  — avatar + connection dot in the desktop sidebar's chrome row,
//             where the app shouldn't re-brand itself inside its own titlebar.

export function SettingsButton({
	onOpenSettings,
	connected,
	variant = "user",
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
	variant?: "brand" | "user";
}) {
	const currentUser = useCurrentUser();
	const status = connected ? "Connected" : "Reconnecting…";

	if (variant === "brand")
		return (
			<button
				aria-label="Open settings"
				className={APP_LOGO_BUTTON}
				onClick={() => onOpenSettings?.()}
			>
				<img className={APP_LOGO_IMAGE} src="/mac-app-icon.png" alt="" />
			</button>
		);

	return (
		<Tooltip label="Settings">
			<button
				aria-label="Open settings"
				className="flex shrink-0 items-center rounded-control border-none bg-transparent p-1 text-fg hover:bg-hover"
				onClick={() => onOpenSettings?.()}
			>
				<span className="relative inline-flex shrink-0">
					<UserAvatar name={currentUser} size={24} />
					{/* The only place this variant reports the live connection. */}
					<span
						className={APP_LOGO_STATUS}
						style={{ background: connected ? "var(--green)" : "var(--red)" }}
						title={status}
					/>
				</span>
			</button>
		</Tooltip>
	);
}
