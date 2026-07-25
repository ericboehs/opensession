import React from "react";
import type { AppNotification } from "../lib/types";
import { Menu } from "../ui/menu";
import { IconBell } from "./icons";

/**
 * Sidebar notification bell: the per-user inbox every push notification
 * mirrors into (server push.ts → GET /api/notifications). Opening the menu
 * marks everything seen (client-local stamp); clicking a row deep-links to
 * the notification's in-app path.
 */

function ago(ts: number): string {
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

export function NotificationsBell({
	items,
	unseen,
	onOpened,
	onNavigate,
}: {
	items: AppNotification[];
	/** Count shown on the badge; cleared by onOpened. */
	unseen: number;
	/** Called when the menu opens — mark everything seen. */
	onOpened: () => void;
	/** Open a notification's in-app path. */
	onNavigate: (url: string) => void;
}) {
	return (
		<Menu.Root onOpenChange={(open) => open && onOpened()}>
			<Menu.Trigger
				className="relative flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md text-dim hover:bg-hover hover:text-fg"
				aria-label="Notifications"
				title="Notifications"
			>
				<IconBell size={17} />
				{unseen > 0 && (
					<span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-[3px] text-[9.5px] font-bold leading-none text-white">
						{unseen > 99 ? "99+" : unseen}
					</span>
				)}
			</Menu.Trigger>
			<Menu.Popup align="start" className="w-[320px]">
				{items.length === 0 ? (
					<div className="px-3 py-6 text-center text-[12.5px] text-dim">
						Nothing yet — mentions, review requests and agent questions land
						here.
					</div>
				) : (
					items.slice(0, 30).map((n) => (
						<Menu.Item
							key={n.id}
							onClick={() => n.url && onNavigate(n.url)}
							className="flex-col items-start gap-0.5 py-2"
						>
							<span className="w-full truncate text-[12.5px] font-semibold text-fg">
								{n.title}
							</span>
							{n.body && (
								<span className="line-clamp-2 w-full text-[12px] leading-snug text-dim">
									{n.body}
								</span>
							)}
							<span className="text-[10.5px] text-faint">{ago(n.ts)}</span>
						</Menu.Item>
					))
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
