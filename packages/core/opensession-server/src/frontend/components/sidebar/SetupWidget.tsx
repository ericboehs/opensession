import { utilityClassName } from "../../ui/cn";
import { useState } from "react";
import { useSetupStatus } from "../../hooks/useSetupStatus";
import type { SettingsSectionKey } from "../../lib/settings-sections";
import {
	dismissSetupWidget,
	setupWidgetDismissed,
	setupWidgetItems,
	visibleSetupWidgetItems,
	type SetupWidgetItem,
} from "../../lib/setup-widget";
import { cn } from "../../ui/cn";
import { Tooltip } from "../../ui/tooltip";
import {
	IconArrowRight,
	IconBranches,
	IconCheck,
	IconCheckCircleFilled,
	IconChevronDown,
	IconConnections,
	IconGlobe,
	IconMessage,
	IconPeople,
	IconPlug,
	IconServer,
	IconShapes,
	IconX,
} from "../icons";

function SetupStepIcon({ id }: { id: SetupWidgetItem["id"] }) {
	switch (id) {
		case "server":
			return <IconServer size={20} />;
		case "github":
			return <IconConnections size={20} />;
		case "models":
			return <IconShapes size={20} />;
		case "repository":
			return <IconBranches size={20} />;
		case "domain":
			return <IconGlobe size={20} />;
		case "tools":
			return <IconPlug size={20} />;
		case "members":
			return <IconPeople size={20} />;
		case "session":
			return <IconMessage size={20} />;
	}
}

function SetupStep({
	item,
	complete,
	onOpenSettings,
	onNewSession,
}: {
	item: SetupWidgetItem;
	complete: boolean;
	onOpenSettings: (section?: SettingsSectionKey) => void;
	onNewSession: () => void;
}) {
	return (
		<button
			type="button"
			className={cn(
				"focus-ring flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-label font-medium transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover active:scale-[0.96] phone:min-h-11",
				complete ? "text-dim" : "text-fg",
			)}
			onClick={() =>
				item.target === "new-session"
					? onNewSession()
					: onOpenSettings(item.target)
			}
		>
			<span
				className={utilityClassName("flex size-7 shrink-0 items-center justify-center text-dim")}
				aria-hidden="true"
			>
				<SetupStepIcon id={item.id} />
			</span>
			<span className={utilityClassName("min-w-0 flex-1 truncate")}>{item.label}</span>
			{complete ? (
				<IconCheckCircleFilled
					size={20}
					className={utilityClassName("shrink-0 text-accent")}
					aria-hidden="true"
				/>
			) : (
				<span
					className={utilityClassName("flex size-5 shrink-0 items-center justify-center rounded-sm border border-line text-transparent")}
					aria-hidden="true"
				>
					<IconCheck size={16} />
				</span>
			)}
		</button>
	);
}

export function SetupWidget({
	placement,
	hasCreatedSession,
	onOpenSettings,
	onNewSession,
}: {
	placement: "desktop" | "phone";
	hasCreatedSession: boolean;
	onOpenSettings: (section?: SettingsSectionKey) => void;
	onNewSession: () => void;
}) {
	const [dismissed, setDismissed] = useState(setupWidgetDismissed);
	const [completedOpen, setCompletedOpen] = useState(false);
	const setup = useSetupStatus();
	if (dismissed || !setup.status) return null;

	const items = setupWidgetItems(setup.status, hasCreatedSession);
	const completed = items.filter((item) => item.complete);
	const pending = items.filter((item) => !item.complete);
	const visibleItems = visibleSetupWidgetItems(items);
	if (pending.length === 0) return null;

	const progress = (completed.length / items.length) * 100;
	const completedLabel = `${completed.length} ${completed.length === 1 ? "step" : "steps"} checked`;

	return (
		<aside
			aria-labelledby="sidebar-setup-title"
			className={cn(
				utilityClassName("z-20 rounded-xl bg-popup p-2 smooth-shadow-sm"),
				placement === "desktop"
					? utilityClassName("fixed right-4 bottom-20 w-72")
					: utilityClassName("mx-3 mt-3 mb-20 flex-none"),
			)}
			style={placement === "phone" ? { order: 100 } : undefined}
			onPointerEnter={() => void setup.refetch()}
			onFocusCapture={() => void setup.refetch()}
		>
			<div className={utilityClassName("flex min-h-10 items-center gap-2 pl-2")}>
				<h2 id="sidebar-setup-title" className={utilityClassName("m-0 shrink-0 text-label font-semibold text-fg")}>
					Get started
				</h2>
				<span className={utilityClassName("shrink-0 tabular-nums text-meta text-faint")}>
					{completed.length} of {items.length}
				</span>
				<div
					role="progressbar"
					aria-label="Setup progress"
					aria-valuemin={0}
					aria-valuemax={items.length}
					aria-valuenow={completed.length}
					className={utilityClassName("h-1 w-8 shrink-0 overflow-hidden rounded-[999px] bg-active")}
				>
					<div
						className={utilityClassName("h-full rounded-[999px] bg-accent")}
						style={{ width: `${progress}%` }}
					/>
				</div>
				<Tooltip label="Dismiss">
					<button
						type="button"
						aria-label="Dismiss setup checklist"
						className={utilityClassName("focus-ring flex size-10 shrink-0 items-center justify-center rounded-control text-faint transition-[color,background-color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:size-11")}
						onClick={() => {
							dismissSetupWidget();
							setDismissed(true);
						}}
					>
						<IconX size={20} />
					</button>
				</Tooltip>
			</div>

			{completed.length > 0 && (
				<div>
					<button
						type="button"
						aria-expanded={completedOpen}
						className={utilityClassName("focus-ring flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-label font-medium text-dim transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:min-h-11")}
						onClick={() => setCompletedOpen((open) => !open)}
					>
						<IconCheckCircleFilled size={20} className={utilityClassName("ml-1 shrink-0 text-accent")} />
						<span className={utilityClassName("min-w-0 flex-1 truncate")}>{completedLabel}</span>
						<IconChevronDown
							size={20}
							className={cn(
								utilityClassName("shrink-0 transition-transform duration-[var(--dur-micro)]"),
								completedOpen && utilityClassName("rotate-180"),
							)}
						/>
					</button>
					{completedOpen && (
						<div className={utilityClassName("flex flex-col")}>
							{completed.map((item) => (
								<SetupStep
									key={item.id}
									item={item}
									complete
									onOpenSettings={onOpenSettings}
									onNewSession={onNewSession}
								/>
							))}
						</div>
					)}
				</div>
			)}

			<div className={utilityClassName("flex flex-col")}>
				{visibleItems.map((item) => (
					<SetupStep
						key={item.id}
						item={item}
						complete={false}
						onOpenSettings={onOpenSettings}
						onNewSession={onNewSession}
					/>
				))}
			</div>

			<button
				type="button"
				className={utilityClassName("focus-ring mt-1 flex min-h-10 w-full items-center gap-1 rounded-control px-2 text-left text-meta font-medium text-faint transition-[background-color,color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:min-h-11")}
				onClick={() => onOpenSettings("setup")}
			>
				<span>Open setup</span>
				<IconArrowRight className={utilityClassName("ml-auto")} size={20} />
			</button>
		</aside>
	);
}
