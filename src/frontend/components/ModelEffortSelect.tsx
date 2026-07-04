import React from "react";
import type { ModelOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { IconCheck, IconChevronDown, IconChevronRight } from "./icons";

export const EFFORTS = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
];

type Props = {
	models: ModelOption[];
	defaultModel: string;
	/** Current model id; "" = default. */
	model: string;
	onModelChange: (model: string) => void;
	/** Model is set elsewhere (e.g. Slack-owned sessions) — effort stays switchable. */
	modelDisabled?: boolean;
	modelTitle?: string;
	/** When effort isn't wired, the menu is just the model list. */
	effort?: string;
	onEffortChange?: (effort: string) => void;
	disabled?: boolean;
	title?: string;
	className?: string;
};

function providerDot(id: string, models: ModelOption[]): string {
	const found = models.find((m) => m.id === id);
	const codex = found ? found.provider === "codex" : id.startsWith("gpt") || id.startsWith("codex");
	return `composer-model-dot ${codex ? "dot-codex" : "dot-claude"}`;
}

/**
 * Combined model + reasoning-effort pill (Claude-app-style): one trigger on the
 * composer's right edge opening the model list, with the effort level behind an
 * "Effort ›" submenu at the bottom. Unlike PaletteSelect there is no
 * native-select phone fallback: the nested effort submenu doesn't map to a
 * <select>, and Base UI menus handle touch fine.
 */
export function ModelEffortSelect({
	models,
	defaultModel,
	model,
	onModelChange,
	modelDisabled,
	modelTitle,
	effort,
	onEffortChange,
	disabled,
	title,
	className,
}: Props) {
	const effectiveModel = model || defaultModel;
	const modelLabel =
		models.find((m) => m.id === effectiveModel)?.label || effectiveModel || "Default";
	const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? "High";
	const hasEffort = !!onEffortChange;

	// "" (default) first, labeled with the default model's name, then the rest.
	const modelOptions = [
		{
			value: "",
			label: models.find((m) => m.id === defaultModel)?.label || defaultModel || "Default",
			dotId: defaultModel,
		},
		...models
			.filter((m) => m.id !== defaultModel)
			.map((m) => ({ value: m.id, label: m.label, dotId: m.id })),
	];

	return (
		<Menu.Root>
			<Menu.Trigger
				type="button"
				className={className}
				title={title}
				disabled={disabled || (!hasEffort && modelDisabled)}
				aria-label={hasEffort ? "Model and reasoning effort" : "Model"}
			>
				<span className={providerDot(effectiveModel, models)} />
				<span className="palette-pill-label">
					{modelLabel}
					{hasEffort ? ` · ${effortLabel}` : ""}
				</span>
				<IconChevronDown className="palette-chevron" size={22} />
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={6} className="palette-select-menu">
				{modelOptions.map((option) => {
					// An explicitly-set default model counts as the default row.
					const selected =
						option.value === model || (option.value === "" && model === defaultModel);
					return (
						<Menu.Item
							key={option.value}
							onClick={() => onModelChange(option.value)}
							disabled={modelDisabled}
							title={modelDisabled ? modelTitle : undefined}
							className={`palette-select-menu-item ${selected ? "is-selected" : ""} ${modelDisabled ? "opacity-55" : ""}`}
						>
							<span className="flex min-w-0 items-center gap-2">
								<span className={providerDot(option.dotId, models)} />
								<span className="palette-select-menu-label">{option.label}</span>
							</span>
							{selected && <IconCheck className="palette-select-menu-check" size={17} />}
						</Menu.Item>
					);
				})}
				{hasEffort && (
					<>
						<Menu.Separator className="my-1" />
						<Menu.SubmenuRoot>
							<Menu.SubmenuTrigger className="palette-select-menu-item">
								<span className="palette-select-menu-label">Effort</span>
								<span className="flex flex-none items-center gap-1 text-dim">
									{effortLabel}
									<IconChevronRight className="palette-select-menu-check" size={17} />
								</span>
							</Menu.SubmenuTrigger>
							<Menu.Popup className="palette-select-menu">
								{EFFORTS.map((e) => {
									const selected = (effort ?? "high") === e.id;
									return (
										<Menu.Item
											key={e.id}
											onClick={() => onEffortChange!(e.id)}
											className={`palette-select-menu-item ${selected ? "is-selected" : ""}`}
										>
											<span className="palette-select-menu-label">{e.label}</span>
											{selected && (
												<IconCheck className="palette-select-menu-check" size={17} />
											)}
										</Menu.Item>
									);
								})}
							</Menu.Popup>
						</Menu.SubmenuRoot>
					</>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
