import React from "react";
import { Menu } from "../ui/menu";
import { IconSparkle, IconCheck, IconChevronRight } from "./icons";
import type { ModelOption } from "../lib/api";

/**
 * A full-width "Model: <name> ›" row for the phone ⋯ overflow menu, mirroring
 * the repo menu-row: tapping it opens a Base UI menu of the available models
 * (grouped Claude / Codex), current one checked. The composer's model pill is
 * hidden on phones and the header's native <select> is a fiddly OS picker, so
 * this is the comfortable way to switch the model on mobile.
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
	const label = current?.label || prettyLabel(effective);
	const claude = models.filter((m) => m.provider === "claude");
	const codex = models.filter((m) => m.provider === "codex");

	const row = (m: ModelOption) => (
		<Menu.Item
			key={m.id}
			onClick={() => onChange(m.id === defaultModel ? "" : m.id)}
		>
			<span className="min-w-0 flex-1 truncate">{m.label}</span>
			{m.id === effective && <IconCheck size={18} className="text-dim" />}
		</Menu.Item>
	);

	return (
		<Menu.Root>
			<Menu.Trigger className="flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[10px] border border-line-strong bg-transparent px-3 py-[7px] text-[13px] font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg">
				<IconSparkle size={18} className="shrink-0 text-faint" />
				<span className="min-w-0 flex-1 truncate text-left">{label}</span>
				<IconChevronRight size={16} className="shrink-0 text-faint" />
			</Menu.Trigger>
			<Menu.Popup align="start" sideOffset={6} className="min-w-[220px]">
				{codex.length > 0 ? (
					<>
						<Menu.Group>
							<Menu.GroupLabel>Claude</Menu.GroupLabel>
							{claude.map(row)}
						</Menu.Group>
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>Codex</Menu.GroupLabel>
							{codex.map(row)}
						</Menu.Group>
					</>
				) : (
					claude.map(row)
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
