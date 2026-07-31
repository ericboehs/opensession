import React from "react";
import { Menu } from "../ui/menu";
import { IconSparkle, IconCheck, IconChevronRight } from "./icons";
import type { ModelOption } from "../lib/api";
import {
	ENGINE_LABELS,
	LEGACY_GROUP_LABEL,
	opencodeModelParts,
	shortModelLabel,
	splitModelOptions,
} from "./ModelEffortSelect";

/**
 * A full-width "Model: <name> ›" row for the phone ⋯ overflow menu, mirroring
 * the repo menu-row: tapping it opens a Base UI menu of the available models
 * (friendly names first, native claude/codex entries under a de-emphasized
 * "Legacy (direct SDK)" group), current one checked. The composer's model pill
 * is hidden on phones and the header's native <select> is a fiddly OS picker,
 * so this is the comfortable way to switch the model on mobile.
 *
 * `onChange` gets "" for the default model (matching the header select's empty
 * option) so the session keeps following the default rather than pinning it.
 */
export function ModelMenuRow({
	models,
	model,
	defaultModel,
	onChange,
	prettyLabel,
}: {
	models: ModelOption[];
	/** Current model id; "" = follow the default. */
	model: string;
	defaultModel: string;
	onChange: (model: string) => void;
	/** Fallback label when a model id isn't in `models` yet. */
	prettyLabel: (id: string) => string;
}) {
	const effective = model || defaultModel;
	const current = models.find((m) => m.id === effective);
	const label =
		current || opencodeModelParts(effective)
			? shortModelLabel(effective, models)
			: prettyLabel(effective);
	// Opencode entries are the main list (the engine is an implementation
	// detail, so no engine headers); natives tuck under a legacy group. When no
	// opencode models are configured, fall back to the generic engine grouping.
	const { opencode, legacy } = splitModelOptions(models);
	const engineOrder = ["claude", "codex", "opencode"];
	const engines = [
		...engineOrder.filter((e) => models.some((m) => m.provider === e)),
		...[...new Set(models.map((m) => m.provider))].filter(
			(e) => !engineOrder.includes(e),
		),
	];

	// Legacy rows keep the full registry label so they never read as
	// duplicates of the friendly names above them.
	const row = (m: ModelOption, raw = false) => (
		<Menu.Item
			key={m.id}
			onClick={() => onChange(m.id === defaultModel ? "" : m.id)}
		>
			<span className="min-w-0 flex-1 truncate">
				{raw ? m.label : shortModelLabel(m.id, models)}
			</span>
			{m.id === effective && <IconCheck size={18} className="text-dim" />}
		</Menu.Item>
	);

	return (
		<Menu.Root>
			<Menu.Trigger className="flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[10px] border border-line-strong bg-transparent px-3 py-[7px] text-control-label font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg">
				<IconSparkle size={18} className="shrink-0 text-faint" />
				<span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
					<span className="text-meta font-semibold leading-none text-faint">Model</span>
					<span className="truncate text-control-label leading-[1.2] text-fg">{label}</span>
				</span>
				<IconChevronRight size={16} className="shrink-0 text-faint" />
			</Menu.Trigger>
			<Menu.Popup align="start" sideOffset={6} className="min-w-[220px]">
				{opencode.length > 0 ? (
					<>
						{opencode.map((m) => row(m))}
						{legacy.length > 0 && (
							<>
								<Menu.Separator />
								<Menu.Group>
									<Menu.GroupLabel>{LEGACY_GROUP_LABEL}</Menu.GroupLabel>
									{legacy.map((m) => row(m, true))}
								</Menu.Group>
							</>
						)}
					</>
				) : engines.length > 1 ? (
					engines.map((engine, i) => (
						<React.Fragment key={engine}>
							{i > 0 && <Menu.Separator />}
							<Menu.Group>
								<Menu.GroupLabel>{ENGINE_LABELS[engine] || engine}</Menu.GroupLabel>
								{models.filter((m) => m.provider === engine).map((m) => row(m))}
							</Menu.Group>
						</React.Fragment>
					))
				) : (
					models.map((m) => row(m))
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
