import React, { useState } from "react";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { BottomSheet } from "../ui/sheet";
import { useIsPhone } from "../hooks/useIsPhone";
import { IconCheck, IconChevronRight } from "./icons";
import { TEAM, setCurrentUser, useCurrentUser } from "./UserPicker";

// The dropdown behind the "Michael" title in the top bar — the "Michael menu". It
// holds the account switcher (who you're acting as), the live connection status,
// and an entry into the full Settings page (theme, notifications, …). On desktop
// it's a Base UI menu (ui/menu: outside-click/Escape dismissal, keyboard nav and
// submenu positioning come from the primitive); on phones the same content opens
// as an iOS-style bottom sheet instead, with the account switcher inlined as a
// tappable list rather than a hover submenu.

function Avatar({ name, active }: { name: string; active?: boolean }) {
	return (
		<span
			className={cn(
				"inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
				active ? "bg-accent text-white" : "bg-active text-dim",
			)}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

const triggerChevron = (
	<svg width="14" height="14" viewBox="0 0 10 10" aria-hidden="true">
		<path
			d="M2 3.5L5 6.5L8 3.5"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

const gearIcon = (
	<svg width="18" height="18" viewBox="0 0 16 16" fill="none">
		<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
		<path
			d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	</svg>
);

/** Phone variant: the same trigger opens a bottom sheet with the account
 * switcher as an inline grouped list (no submenus on touch). */
function SettingsSheet({
	onOpenSettings,
	connected,
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
}) {
	const currentUser = useCurrentUser();
	const [open, setOpen] = useState(false);

	return (
		<>
			<button
				aria-label="Michael menu"
				className="inline-flex h-[38px] w-[38px] items-center justify-center rounded-md border-none bg-transparent p-0 text-faint active:bg-hover active:text-fg"
				onClick={() => setOpen(true)}
			>
				{triggerChevron}
			</button>
			{open && (
				<BottomSheet label="Michael menu" onClose={() => setOpen(false)}>
					{(dismiss) => (
						<div className="overflow-y-auto px-4 pb-4 pt-1">
							<div className="mb-2 px-1 text-[13px] font-semibold text-faint">
								Acting as
							</div>
							<div className="overflow-hidden rounded-xl border border-line bg-panel">
								{TEAM.map((name) => (
									<button
										key={name}
										className="flex w-full items-center gap-3 border-x-0 border-b border-t-0 border-solid border-line bg-transparent px-3.5 py-3 text-left last:border-b-0 active:bg-hover"
										onClick={() => {
											setCurrentUser(name);
											dismiss();
										}}
									>
										<Avatar name={name} active={name === currentUser} />
										<span className="min-w-0 flex-1 text-[15px] font-medium text-fg">
											{name}
										</span>
										{name === currentUser && (
											<IconCheck size={18} className="shrink-0 text-accent" />
										)}
									</button>
								))}
							</div>

							<div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
								<button
									className="flex w-full items-center gap-3 border-none bg-transparent px-3.5 py-3 text-left active:bg-hover"
									onClick={() => {
										dismiss();
										onOpenSettings?.();
									}}
								>
									<span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-dim">
										{gearIcon}
									</span>
									<span className="min-w-0 flex-1 text-[15px] font-medium text-fg">
										Settings
									</span>
									<IconChevronRight size={16} className="shrink-0 text-faint" />
								</button>
							</div>

							<div className="mt-4 flex items-center gap-2 px-2 text-[13px] font-medium text-dim">
								<span
									className={cn(
										"h-2 w-2 rounded-full",
										connected ? "bg-green" : "bg-red",
									)}
								/>
								{connected ? "Connected" : "Reconnecting…"}
							</div>
						</div>
					)}
				</BottomSheet>
			)}
		</>
	);
}

export function SettingsMenu({
	onOpenSettings,
	connected,
}: {
	onOpenSettings?: () => void;
	connected?: boolean;
}) {
	const currentUser = useCurrentUser();
	const isPhone = useIsPhone();

	if (isPhone)
		return <SettingsSheet onOpenSettings={onOpenSettings} connected={connected} />;

	return (
		<Menu.Root>
			<Menu.Trigger
				aria-label="Settings"
				className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border-none bg-transparent p-0 text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
			>
				{triggerChevron}
			</Menu.Trigger>

			<Menu.Popup align="start" sideOffset={8} className="min-w-[244px] p-3">
				<Menu.SubmenuRoot>
					<Menu.SubmenuTrigger className="gap-[9px] rounded-[7px] px-2 py-1.5">
						<Avatar name={currentUser} active />
						<span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
							<span className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-faint">
								Acting as
							</span>
							<span className="font-medium">{currentUser}</span>
						</span>
						<svg
							className="shrink-0 text-faint"
							width="12"
							height="12"
							viewBox="0 0 10 10"
							aria-hidden="true"
						>
							<path
								d="M3.5 2L6.5 5L3.5 8"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</Menu.SubmenuTrigger>
					<Menu.Popup className="min-w-[200px]">
						<Menu.RadioGroup
							value={currentUser}
							onValueChange={(value) => setCurrentUser(String(value))}
						>
							{TEAM.map((name) => (
								<Menu.RadioItem
									key={name}
									value={name}
									closeOnClick
									className="gap-[9px] rounded-[7px] px-2 py-1.5"
								>
									<Avatar name={name} active={name === currentUser} />
									<span className="min-w-0 flex-1 font-medium">{name}</span>
									{name === currentUser && (
										<svg
											className="shrink-0 text-accent"
											width="15"
											height="15"
											viewBox="0 0 16 16"
											fill="none"
										>
											<path
												d="M3.5 8.5l3 3 6-7"
												stroke="currentColor"
												strokeWidth="1.6"
												strokeLinecap="round"
												strokeLinejoin="round"
											/>
										</svg>
									)}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.SubmenuRoot>

				<Menu.Separator className="-mx-3 my-3.5" />

				<div className="flex items-center gap-2 px-2 py-0.5 text-xs text-dim">
					<span
						className={cn(
							"h-2 w-2 rounded-full",
							connected ? "bg-green" : "bg-red",
						)}
					/>
					{connected ? "Connected" : "Reconnecting…"}
				</div>

				<Menu.Separator className="-mx-3 my-3.5" />

				<Menu.Item onClick={() => onOpenSettings?.()}>
					{gearIcon}
					Settings
				</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	);
}
