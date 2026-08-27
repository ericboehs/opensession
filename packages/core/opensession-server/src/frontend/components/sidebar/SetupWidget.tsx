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
import { Tooltip } from "../../ui/tooltip";
import {
	IconArrowRight,
	IconBranches,
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

export function SetupWidget({
	hasCreatedSession,
	onOpenSettings,
	onNewSession,
}: {
	hasCreatedSession: boolean;
	onOpenSettings: (section?: SettingsSectionKey) => void;
	onNewSession: () => void;
}) {
	const [dismissed, setDismissed] = useState(setupWidgetDismissed);
	const setup = useSetupStatus();
	if (dismissed || !setup.status) return null;

	const items = setupWidgetItems(setup.status, hasCreatedSession);
	const pending = items.filter((item) => !item.complete);
	const visibleItems = visibleSetupWidgetItems(items);
	if (pending.length === 0) return null;

	return (
		<aside
			aria-labelledby="sidebar-setup-title"
			className={utilityClassName("absolute right-3 bottom-[max(12px,env(safe-area-inset-bottom,0px))] left-3 z-20 rounded-xl bg-popup p-2 smooth-shadow-sm")}
			onPointerEnter={() => void setup.refetch()}
			onFocusCapture={() => void setup.refetch()}
		>
			<div className={utilityClassName("flex min-h-10 items-center gap-2 pl-2")}>
				<h2 id="sidebar-setup-title" className={utilityClassName("m-0 text-label font-semibold text-fg")}>
					Get started
				</h2>
				<span className={utilityClassName("ml-auto tabular-nums text-meta text-faint")}>
					{pending.length} left
				</span>
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

			<div className={utilityClassName("flex flex-col")}>
				{visibleItems.map((item) => (
					<button
						key={item.id}
						type="button"
						className={utilityClassName("focus-ring flex min-h-10 w-full items-center gap-2 rounded-control px-2 text-left text-label font-medium text-fg transition-[background-color,scale] duration-[var(--dur-micro)] hover:bg-hover active:scale-[0.96] phone:min-h-11")}
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
						<span className={utilityClassName("min-w-0 truncate")}>{item.label}</span>
					</button>
				))}
			</div>

			<button
				type="button"
				className={utilityClassName("focus-ring mt-1 flex min-h-10 w-full items-center gap-1 rounded-control px-2 text-left text-meta font-medium text-dim transition-[background-color,scale] duration-[var(--dur-micro)] hover:bg-hover hover:text-fg active:scale-[0.96] phone:min-h-11")}
				onClick={() => onOpenSettings("setup")}
			>
				<span>Open setup</span>
				<IconArrowRight className={utilityClassName("ml-auto")} size={20} />
			</button>
		</aside>
	);
}
