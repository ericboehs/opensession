import type { ModelOption } from "../lib/api";
import { Menu } from "../ui/menu";
import { cn } from "../ui/cn";
import { IconArrowDownRight } from "./icons";
import { shortModelLabel } from "./ModelEffortSelect";

/**
 * Orchestrator/executor relationship chips for the session header. A session
 * spawned as a worker via opensession-sessions `create_session` carries a
 * `parentSessionId`; the reverse edge (a session's own workers) is derived by
 * the caller from the sessions list. This surfaces both so you can hop between
 * an orchestrator (e.g. a Fable session) and the executor workers it delegated
 * to (e.g. gpt-5.5 sessions) — the whole point of making the engines
 * interchangeable is being able to see and steer the tree.
 */

export interface RelatedSession {
	id: string;
	title: string;
	model?: string;
	isRunning?: boolean;
}

function shortModel(model: string | undefined, models: ModelOption[]): string | null {
	if (!model) return null;
	return shortModelLabel(model, models);
}

const chip =
	"inline-flex max-w-[220px] items-center gap-1 rounded-control px-1.5 py-[2px] text-label font-medium text-dim transition-colors hover:bg-hover hover:text-fg";

export function SessionRelations({
	parent,
	workers,
	models,
	onOpen,
}: {
	parent?: RelatedSession | null;
	workers?: RelatedSession[];
	models: ModelOption[];
	onOpen: (id: string) => void;
}) {
	const hasWorkers = !!workers && workers.length > 0;
	if (!parent && !hasWorkers) return null;
	const workerLabel = hasWorkers
		? `${workers!.length} delegated worker${workers!.length > 1 ? "s" : ""}`
		: "";

	return (
		<div className="flex items-center gap-1.5">
			{parent && (
				<button
					type="button"
					className={chip}
					onClick={() => onOpen(parent.id)}
					title={`Worker of “${parent.title}”${
						shortModel(parent.model, models)
							? ` · orchestrated by ${shortModel(parent.model, models)}`
							: ""
					}`}
				>
					{/* rotated to point up-left: "this belongs to a parent above".
					    Sized in CSS: the `size` prop floors at 20px (icons.tsx), which
					    outweighs this chip's 13px label. */}
					<IconArrowDownRight className="size-[18px] shrink-0 rotate-180" />
					<span className="truncate">worker of {parent.title}</span>
				</button>
			)}
			{hasWorkers && (
				<Menu.Root>
					{/* Count only: the arrow already says "delegated to", so the word
					    "workers" was two thirds of the chip carrying no information.
					    The glyph and the number take that room instead, and the
					    accessible name still spells it out. */}
					<Menu.Trigger
						className={cn(chip, "data-[popup-open]:bg-hover data-[popup-open]:text-fg")}
						aria-label={workerLabel}
						title={workerLabel}
					>
						<IconArrowDownRight className="size-5 shrink-0" />
						<span className="tabular-nums">{workers!.length}</span>
					</Menu.Trigger>
					<Menu.Popup align="start" className="max-w-[300px]">
						{/* GroupLabel MUST live inside a Group — bare it throws Base UI
						    error #31 and white-screens the app on open. */}
						<Menu.Group>
							<Menu.GroupLabel>Delegated workers</Menu.GroupLabel>
							{workers!.map((w) => (
								<Menu.Item key={w.id} onClick={() => onOpen(w.id)}>
									<span
										className={cn(
											"h-1.5 w-1.5 shrink-0 rounded-full",
											w.isRunning ? "bg-yellow" : "bg-line-strong",
										)}
									/>
									<span className="truncate">{w.title}</span>
									{shortModel(w.model, models) && (
										<span className="ml-auto shrink-0 pl-2 text-meta text-faint">
											{shortModel(w.model, models)}
										</span>
									)}
								</Menu.Item>
							))}
						</Menu.Group>
					</Menu.Popup>
				</Menu.Root>
			)}
		</div>
	);
}
