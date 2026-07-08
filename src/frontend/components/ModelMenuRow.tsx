import React from "react";
import { Menu } from "../ui/menu";
import { IconSparkle, IconCheck, IconChevronRight } from "./icons";
import type { ModelOption } from "../lib/api";
import { ENGINE_LABELS, opencodeModelParts, shortModelLabel } from "./ModelEffortSelect";

/**
 * A full-width "Model: <name> ›" row for the phone ⋯ overflow menu, mirroring
 * the repo menu-row: tapping it opens a Base UI menu of the available models
 * (grouped by engine — Claude / Codex / OpenCode), current one checked. The
 * composer's model pill is hidden on phones and the header's native <select>
 * is a fiddly OS picker, so this is the comfortable way to switch the model
 * on mobile.
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
	const label = current
		? shortModelLabel(current.id, models)
		: opencodeModelParts(effective)?.model || prettyLabel(effective);
	// Group by engine, generically — a config-driven engine (OpenCode) gets its
	// own header instead of being dropped or shown as raw slashed ids. With a
	// single engine present the headers are noise, so it stays a flat list.
	const engineOrder = ["claude", "codex", "opencode"];
	const engines = [
		...engineOrder.filter((e) => models.some((m) => m.provider === e)),
		...[...new Set(models.map((m) => m.provider))].filter(
			(e) => !engineOrder.includes(e),
		),
	];

	const row = (m: ModelOption) => {
		const oc = opencodeModelParts(m.id);
		return (
			<Menu.Item
				key={m.id}
				onClick={() => onChange(m.id === defaultModel ? "" : m.id)}
			>
				<span className="min-w-0 flex-1 truncate">
					{oc ? oc.model : m.label}
				</span>
				{oc && <span className="shrink-0 text-faint">{oc.provider}</span>}
				{m.id === effective && <IconCheck size={18} className="text-dim" />}
			</Menu.Item>
		);
	};

	return (
		<Menu.Root>
			<Menu.Trigger className="flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[10px] border border-line-strong bg-transparent px-3 py-[7px] text-[13px] font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg">
				<IconSparkle size={18} className="shrink-0 text-faint" />
				<span className="min-w-0 flex-1 truncate text-left">{label}</span>
				<IconChevronRight size={16} className="shrink-0 text-faint" />
			</Menu.Trigger>
			<Menu.Popup align="start" sideOffset={6} className="min-w-[220px]">
				{engines.length > 1 ? (
					engines.map((engine, i) => (
						<React.Fragment key={engine}>
							{i > 0 && <Menu.Separator />}
							<Menu.Group>
								<Menu.GroupLabel>{ENGINE_LABELS[engine] || engine}</Menu.GroupLabel>
								{models.filter((m) => m.provider === engine).map(row)}
							</Menu.Group>
						</React.Fragment>
					))
				) : (
					models.map(row)
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
