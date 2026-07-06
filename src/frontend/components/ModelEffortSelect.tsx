import React from "react";
import type { ModelOption, ClaudeAccountOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconCheck, IconChevronRight } from "./icons";

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
	/**
	 * Pinnable Claude subscriptions. When present (and onAccountChange is wired),
	 * a "Subscription" submenu lets this session force a specific account; "" =
	 * auto (personal-first, pool fallback). Only meaningful for Claude models —
	 * callers pass an empty list for Codex sessions to hide the submenu.
	 */
	accounts?: ClaudeAccountOption[];
	/** Pinned account id; "" / undefined = auto. */
	accountId?: string;
	onAccountChange?: (accountId: string) => void;
	disabled?: boolean;
	title?: string;
	className?: string;
};

const PRIMARY_MODEL_IDS = [
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-sonnet-5",
	"gpt-5.5",
] as const;
const PRIMARY_MODEL_ID_SET = new Set<string>(PRIMARY_MODEL_IDS);

/** Display name without the vendor noise: "Claude Fable 5" → "Fable 5",
 * "GPT-5.5 (Codex)" → "GPT-5.5". */
export function shortModelLabel(id: string, models: ModelOption[]): string {
	const raw = models.find((m) => m.id === id)?.label || id || "Default";
	return raw.replace(/^Claude\s+/i, "").replace(/\s*\(Codex\)$/i, "");
}

type ModelMenuOption = {
	value: string;
	label: string;
	id: string;
};

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
	accounts,
	accountId,
	onAccountChange,
	disabled,
	title,
	className,
}: Props) {
	const effectiveModel = model || defaultModel;
	const modelLabel = shortModelLabel(effectiveModel, models);
	const effortLabel = EFFORTS.find((e) => e.id === effort)?.label ?? "High";
	const hasEffort = !!onEffortChange;
	const hasSubscription = !!onAccountChange && !!accounts && accounts.length > 0;
	const currentAccount = accountId
		? accounts?.find((a) => a.id === accountId)
		: undefined;
	const subscriptionLabel = currentAccount ? currentAccount.name : "Auto";

	const optionFor = (id: string): ModelMenuOption => ({
		value: id === defaultModel ? "" : id,
		label: shortModelLabel(id, models),
		id,
	});
	const availableModelIds = new Set(models.map((m) => m.id));
	const primaryOptions = PRIMARY_MODEL_IDS
		.filter((id) => availableModelIds.has(id))
		.map((id) => optionFor(id));
	const otherOptions = [
		...(PRIMARY_MODEL_ID_SET.has(defaultModel) ? [] : [optionFor(defaultModel)]),
		...models
			.filter((m) => m.id !== defaultModel && !PRIMARY_MODEL_ID_SET.has(m.id))
			.map((m) => optionFor(m.id)),
	];
	const isSelected = (option: ModelMenuOption) =>
		option.value === model || (option.value === "" && (model === "" || model === defaultModel));

	const renderModelOption = (option: ModelMenuOption) => {
		const selected = isSelected(option);
		return (
			<Menu.Item
				key={option.value || option.id}
				onClick={() => onModelChange(option.value)}
				disabled={modelDisabled}
				title={modelDisabled ? modelTitle : undefined}
				className={cn("justify-between gap-3", selected && "bg-hover", modelDisabled && "opacity-55")}
			>
				<span className="min-w-0 truncate">{option.label}</span>
				{selected && <IconCheck className="shrink-0 text-dim" size={17} />}
			</Menu.Item>
		);
	};

	return (
		<Menu.Root>
			<Menu.Trigger
				type="button"
				// Quiet pill: no outline at rest, hover state only, no chevron.
				className={cn(
					"border-transparent hover:border-transparent hover:bg-hover",
					className,
				)}
				title={title}
				disabled={disabled || (!hasEffort && modelDisabled)}
				aria-label={hasEffort ? "Model and reasoning effort" : "Model"}
			>
				<span className="palette-pill-label">{modelLabel}</span>
				{hasEffort && <span className="flex-none text-faint">{effortLabel}</span>}
			</Menu.Trigger>
			<Menu.Popup align="end" sideOffset={6} className="max-w-[min(360px,calc(100vw-1rem))]">
				{primaryOptions.map(renderModelOption)}
				{otherOptions.length > 0 && (
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger className="justify-between gap-3">
							<span className="min-w-0 truncate">Other models</span>
							<IconChevronRight className="shrink-0 text-dim" size={17} />
						</Menu.SubmenuTrigger>
						<Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
							{otherOptions.map(renderModelOption)}
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}
				{(hasEffort || hasSubscription) && <Menu.Separator className="my-1" />}
				{hasEffort && (
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger className="justify-between gap-3">
							<span className="min-w-0 truncate">Effort</span>
							<span className="flex flex-none items-center gap-1 text-dim">
								{effortLabel}
								<IconChevronRight className="shrink-0 text-dim" size={17} />
							</span>
						</Menu.SubmenuTrigger>
						<Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
							{EFFORTS.map((e) => {
								const selected = (effort ?? "high") === e.id;
								return (
									<Menu.Item
										key={e.id}
										onClick={() => onEffortChange!(e.id)}
										className={cn("justify-between gap-3", selected && "bg-hover")}
									>
										<span className="min-w-0 truncate">{e.label}</span>
										{selected && (
											<IconCheck className="shrink-0 text-dim" size={17} />
										)}
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}
				{hasSubscription && (
					<Menu.SubmenuRoot>
						<Menu.SubmenuTrigger className="justify-between gap-3">
							<span className="min-w-0 truncate">Subscription</span>
							<span className="flex flex-none items-center gap-1 text-dim">
								{subscriptionLabel}
								<IconChevronRight className="shrink-0 text-dim" size={17} />
							</span>
						</Menu.SubmenuTrigger>
						<Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
							<Menu.Item
								onClick={() => onAccountChange!("")}
								className={cn("justify-between gap-3", !accountId && "bg-hover")}
							>
								<span className="min-w-0 truncate">Auto</span>
								{!accountId && (
									<IconCheck className="shrink-0 text-dim" size={17} />
								)}
							</Menu.Item>
							{accounts!.map((a) => {
								const selected = a.id === accountId;
								return (
									<Menu.Item
										key={a.id}
										onClick={() => onAccountChange!(a.id)}
										className={cn("justify-between gap-3", selected && "bg-hover")}
									>
										<span className="min-w-0 truncate">
											{a.name}
											{a.owner ? ` · ${a.owner}` : ""}
											{a.usable ? "" : " · exhausted"}
										</span>
										{selected && (
											<IconCheck className="shrink-0 text-dim" size={17} />
										)}
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.SubmenuRoot>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
