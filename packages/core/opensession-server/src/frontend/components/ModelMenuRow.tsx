import React from "react";
import { Menu } from "../ui/menu";
import { IconSparkle, IconChevronRight } from "./icons";
import type { ModelOption } from "../lib/api";
import { useEngines } from "../hooks/useEngines";
import { baseModelId, engineModelId, modelEngine } from "../lib/model-engine";
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
	// Pi-routed ids resolve to their base list entry (the prefix is routing).
	const effectiveBase = baseModelId(effective);
	const current = models.find((m) => m.id === effectiveBase);
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

	// Engine choice is the id's routing prefix, so it is read off the current
	// model and written by recomposing it — no separate engine state.
	const engineOptions = useEngines().engines.filter((e) => e.available);
	const activeEngine = modelEngine(effective);
	const activeEngineLabel =
		engineOptions.find((e) => e.id === activeEngine)?.label ||
		ENGINE_LABELS[activeEngine] ||
		activeEngine;

	// Legacy rows keep the full registry label so they never read as
	// duplicates of the friendly names above them.
	const row = (m: ModelOption, raw = false) => {
		// Engine stays sticky: a model change recomposes the current engine's
		// prefix over the new id. An entry that can't route there is disabled.
		const routed =
			activeEngine === "opencode"
				? m.id === defaultModel
					? ""
					: m.id
				: engineModelId(activeEngine, m.id);
		return (
			<Menu.Item
				key={m.id}
				disabled={routed === null}
				title={routed === null ? `Not available on the ${activeEngineLabel} engine` : undefined}
				className={routed === null ? "opacity-55" : undefined}
				onClick={() => onChange(routed ?? (m.id === defaultModel ? "" : m.id))}
			>
				<span className="min-w-0 flex-1 truncate">
					{raw ? m.label : shortModelLabel(m.id, models)}
				</span>
				<Menu.Check on={m.id === effectiveBase} size={18} className="text-dim" />
			</Menu.Item>
		);
	};

	return (
		<Menu.Root>
			<Menu.Trigger className="flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-control border border-line-strong bg-transparent px-3 py-[7px] text-control-label font-medium text-faint hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg">
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
				{engineOptions.length > 1 && (
					<>
						<Menu.Separator />
						<Menu.Group>
							<Menu.GroupLabel>Engine</Menu.GroupLabel>
							{engineOptions.map((e) => {
								const next = engineModelId(e.id, effective);
								return (
									<Menu.Item
										key={e.id}
										disabled={!next}
										title={
											next ? undefined : `${label} isn't available on the ${e.label} engine`
										}
										className={next ? undefined : "opacity-55"}
										onClick={() => next && onChange(next === defaultModel ? "" : next)}
									>
										<span className="min-w-0 flex-1 truncate">{e.label}</span>
										<Menu.Check on={e.id === activeEngine} size={18} className="text-dim" />
									</Menu.Item>
								);
							})}
						</Menu.Group>
					</>
				)}
			</Menu.Popup>
		</Menu.Root>
	);
}
