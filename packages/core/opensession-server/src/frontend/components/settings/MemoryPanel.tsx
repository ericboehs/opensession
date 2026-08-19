import { useEffect, useState } from "react";
import {
	addMemoryEntryApi,
	deleteMemoryEntryApi,
	fetchMemory,
	relativeTime,
	updateMemoryEntryApi,
	type MemoryEntryDto,
	type MemoryScopeDto,
} from "../../lib/api";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/input";
import {
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsPanel,
	SettingsSection,
} from "../../ui/settings";
import { EmptyState, InlineAlert } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconPencil, IconPlus, IconTrash } from "../icons";
import { getCurrentUser } from "../UserPicker";

// ── Memory: the repo/user/team/channel stores behind the opensession-memory
// tools and Slack channel memory — view, add, edit and delete entries. ──

const MEMORY_GROUPS: {
	kind: MemoryScopeDto["scope"]["kind"];
	title: string;
	/** Fixed groups render even when empty (there's always an add target). */
	fixed: boolean;
}[] = [
	{ kind: "team", title: "Team", fixed: true },
	{ kind: "repo", title: "Repos", fixed: true },
	{ kind: "user", title: "People", fixed: false },
	{ kind: "channel", title: "Slack channels", fixed: false },
];

function MemoryEntryRow({
	scopeKey,
	entry,
	onChanged,
}: {
	scopeKey: string;
	entry: MemoryEntryDto;
	onChanged: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(entry.text);
	const [busy, setBusy] = useState(false);

	async function save() {
		const text = draft.trim();
		if (!text || text === entry.text) return setEditing(false);
		setBusy(true);
		try {
			await updateMemoryEntryApi(scopeKey, entry.id, text);
			setEditing(false);
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to update memory", { variant: "error" });
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		setBusy(true);
		try {
			await deleteMemoryEntryApi(scopeKey, entry.id);
			toast("Memory forgotten", { variant: "success" });
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to delete memory", { variant: "error" });
			setBusy(false);
		}
	}

	if (editing)
		return (
			<div className="border-b border-line px-5 py-3 last:border-b-0">
				<Textarea
					rows={2}
					value={draft}
					autoFocus
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
						if (e.key === "Escape") setEditing(false);
					}}
				/>
				<div className="mt-1.5 flex items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						disabled={busy || !draft.trim()}
						onClick={save}
					>
						Save
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setDraft(entry.text);
							setEditing(false);
						}}
					>
						Cancel
					</Button>
					{/* Both shortcuts were already wired and undiscoverable. */}
					<span className="ml-auto text-meta text-faint">⌘↵ to save · Esc to cancel</span>
				</div>
			</div>
		);

	return (
		<div className="group flex items-start gap-2 border-b border-line px-5 py-3 last:border-b-0">
			<div className="min-w-0 flex-1">
				<div className="text-item-title font-medium leading-snug text-fg">
					{entry.text}
				</div>
				<div className="mt-0.5 text-meta font-medium text-faint">
					{entry.by} · {relativeTime(entry.at)}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					size="sm"
					variant="ghost"
					aria-label="Edit memory"
					icon={<IconPencil size={16} />}
					disabled={busy}
					onClick={() => {
						setDraft(entry.text);
						setEditing(true);
					}}
				/>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Forget memory"
					className="hover:text-red"
					icon={<IconTrash size={16} />}
					disabled={busy}
					onClick={remove}
				/>
			</div>
		</div>
	);
}

function MemoryScopeCard({
	scoped,
	onChanged,
}: {
	scoped: MemoryScopeDto;
	onChanged: () => void;
}) {
	const [adding, setAdding] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);

	async function add() {
		const text = draft.trim();
		if (!text) return;
		setBusy(true);
		try {
			await addMemoryEntryApi(scoped.scope.key, text, getCurrentUser() || "settings");
			setDraft("");
			setAdding(false);
			toast("Memory saved", { variant: "success" });
			onChanged();
		} catch (e: any) {
			toast(e?.message || "Failed to add memory", { variant: "error" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<SettingsSection className="mb-2 overflow-hidden p-0">
			<div className="flex items-center justify-between border-b border-line px-5 py-2.5">
				<div className="text-supporting font-semibold text-fg">
					{scoped.scope.label}
				</div>
				<Button
					size="sm"
					variant="ghost"
					aria-label={`Add memory to ${scoped.scope.label}`}
					icon={<IconPlus size={16} />}
					onClick={() => setAdding(true)}
				>
					Add
				</Button>
			</div>
			{scoped.entries.length === 0 && !adding && (
				<div className="px-5 py-3 text-item-title font-medium text-faint">
					No memories yet.
				</div>
			)}
			{/* Directly under the Add button that opened it. It used to render
			    after every entry, so on a long scope the form appeared far below
			    the button and clicking Add looked like it did nothing. */}
			{adding && (
				<div className="border-b border-line px-5 py-3">
					<Textarea
						rows={2}
						placeholder="A durable, self-contained fact…"
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) add();
							if (e.key === "Escape") setAdding(false);
						}}
					/>
					<div className="mt-1.5 flex items-center gap-2">
						<Button
							variant="primary"
							size="sm"
							disabled={busy || !draft.trim()}
							onClick={add}
						>
							Save
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
							Cancel
						</Button>
						<span className="ml-auto text-meta text-faint">⌘↵ to save · Esc to cancel</span>
					</div>
				</div>
			)}
			{scoped.entries.map((e) => (
				<MemoryEntryRow
					key={e.id}
					scopeKey={scoped.scope.key}
					entry={e}
					onChanged={onChanged}
				/>
			))}
		</SettingsSection>
	);
}

export function MemoryPanel() {
	const [scopes, setScopes] = useState<MemoryScopeDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	function reload() {
		fetchMemory()
			.then((r) => setScopes(r.scopes))
			.catch((e) => setError(e.message));
	}
	useEffect(reload, []);

	const header = (
		<SettingsHeader
			title="Memory"
			description="Facts that matching sessions remember. Team memory spans the workspace, repo memory follows the repo, and people memory follows whoever is prompting."
		/>
	);

	if (!scopes)
		return (
			<SettingsPanel>
				{header}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					// Only the fixed groups: those always render, so their labels
					// are known before the scopes are. People and Slack channels
					// appear only if there are any, and a label standing in for a
					// group that may not exist is a claim rather than a placeholder.
					MEMORY_GROUPS.filter((g) => g.fixed).map((g) => (
						<div key={g.kind}>
							<SettingsGroupLabel>{g.title}</SettingsGroupLabel>
							<SettingCardSkeleton
								rows={2}
								label={`Loading ${g.title.toLowerCase()} memory`}
							/>
						</div>
					))
				)}
			</SettingsPanel>
		);

	return (
		<SettingsPanel>
			{header}
			{MEMORY_GROUPS.map((g) => {
				const inGroup = scopes.filter((s) => s.scope.kind === g.kind);
				if (!inGroup.length && !g.fixed) return null;
				return (
					<div key={g.kind}>
						<SettingsGroupLabel>{g.title}</SettingsGroupLabel>
						{inGroup.map((s) => (
							<MemoryScopeCard key={s.scope.key} scoped={s} onChanged={reload} />
						))}
						{!inGroup.length && (
							<EmptyState placement="card">Nothing remembered yet.</EmptyState>
						)}
					</div>
				);
			})}
		</SettingsPanel>
	);
}
