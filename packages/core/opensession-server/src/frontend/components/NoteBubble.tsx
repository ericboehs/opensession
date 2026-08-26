import React, { useEffect, useRef, useState } from "react";
import type { SessionNote } from "../lib/types";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { toast } from "../ui/toast";
import { deleteSessionNoteApi, editSessionNoteApi } from "../lib/api";
import { IconDotsHorizontal, IconPencil, IconTrash } from "./icons";
import { MentionText } from "./MentionText";
import { UserAvatar } from "./UserAvatar";
import { getCurrentUser } from "./UserPicker";
import { openLightbox } from "./MediaLightbox";
import { noAutofill } from "../lib/composer-autofill";
import { noteSurface } from "../lib/tinted-surface";

/**
 * A team note interleaved into the session transcript — a human-to-human
 * message the agent never sees (Plain's "internal note" concept, for our own
 * sessions). Backed by src/server/session-notes.ts; rendered with a
 * deliberate yellow tint so it can't be mistaken for a prompt or an answer.
 *
 * A note is one person speaking, so only its author can edit or delete it —
 * the menu is hidden for everyone else, and the server enforces the same rule
 * rather than trusting that (403 for anyone who asks anyway).
 */

function noteTime(ts: number): string {
	const d = new Date(ts);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (d.toDateString() === new Date().toDateString()) return time;
	return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function NoteBubble({
	note,
	sessionId,
}: {
	note: SessionNote;
	/** Absent in read-only hosts (the sub-agent pane); no session, no menu. */
	sessionId?: string;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(note.text);
	const [busy, setBusy] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const mine = note.user.trim().toLowerCase() === getCurrentUser().trim().toLowerCase();

	useEffect(() => {
		if (!editing) return;
		const el = textareaRef.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		el.style.height = "";
		el.style.height = `${el.scrollHeight}px`;
	}, [editing]);

	async function save() {
		const text = draft.trim();
		if (!sessionId || !text || busy) return;
		if (text === note.text) {
			setEditing(false);
			return;
		}
		setBusy(true);
		await (async () => {
// The broadcast puts the stored note back into the transcript, so
			// there's nothing to write locally.
			await editSessionNoteApi(sessionId, note.id, text, getCurrentUser());
			setEditing(false);
})().catch(async (e: any) => {
toast(e?.message || "Failed to edit note");
}).finally(async () => {
setBusy(false);
});
	}

	async function remove() {
		if (!sessionId || busy) return;
		setBusy(true);
		await (async () => {
await deleteSessionNoteApi(sessionId, note.id, getCurrentUser());
})().catch(async (e: any) => {
toast(e?.message || "Failed to delete note");
}).finally(async () => {
setBusy(false);
});
	}

	return (
		<div
			// A note is a transcript block like any other, so it takes the same
			// centered reading column the turns, footers and walkthrough cards use
			// (mx-auto + --session-col) instead of spanning the whole pane, and the
			// same mt-2/mb-6 rhythm as the column's other card blocks (AskCard,
			// WalkthroughCard) so it doesn't crowd whatever follows it.
			//
			// `group` so the actions can stay quiet until the note is hovered.
			className="group relative mx-auto mb-6 mt-2 w-full max-w-[var(--session-col)] rounded-2xl px-4 py-3.5"
			style={{ background: noteSurface("transparent") }}
		>
			<div className="mb-1 flex items-center gap-2">
				<UserAvatar name={note.user} size={18} />
				<span className="text-supporting font-semibold text-fg">{note.user}</span>
				<span
					className="text-meta font-semibold"
					style={{ color: "var(--yellow)" }}
					title="Only the team sees this note"
				>
					Note
				</span>
				<span className="text-meta text-faint">
					{noteTime(note.ts)}
					{note.editedAt ? " · edited" : ""}
				</span>
				{mine && sessionId && !editing && (
					<Menu.Root>
						<Menu.Trigger
							aria-label="Note actions"
							// Quiet until you want it: visible on hover, on keyboard
							// focus, and while its own menu is open — never hover-only,
							// which would strand touch and keyboard.
							className={cn(
								"ml-auto flex size-7 shrink-0 items-center justify-center rounded-control border-0 bg-transparent text-dim opacity-0 transition-opacity",
								"hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100",
								"data-[popup-open]:bg-hover data-[popup-open]:text-fg data-[popup-open]:opacity-100",
							)}
						>
							<IconDotsHorizontal size={16} />
						</Menu.Trigger>
						<Menu.Popup align="end">
							<Menu.Item
								onClick={() => {
									setDraft(note.text);
									setEditing(true);
								}}
							>
								<IconPencil size={18} className="text-faint" />
								Edit
							</Menu.Item>
							<Menu.Separator />
							<Menu.Item onClick={remove} className="text-red">
								<IconTrash size={18} />
								Delete
							</Menu.Item>
						</Menu.Popup>
					</Menu.Root>
				)}
			</div>
			{editing ? (
				<div className="flex flex-col gap-2">
					<textarea
						ref={textareaRef}
						value={draft}
						disabled={busy}
						{...noAutofill}
						onChange={(e) => {
							setDraft(e.target.value);
							e.target.style.height = "";
							e.target.style.height = `${e.target.scrollHeight}px`;
						}}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								setEditing(false);
								setDraft(note.text);
							}
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								void save();
							}
						}}
						className="w-full resize-none rounded-lg border border-[color:color-mix(in_srgb,var(--yellow-tint)_45%,transparent)] bg-surface px-2.5 py-2 text-body leading-relaxed text-fg outline-none focus-visible:border-[color:var(--yellow)]"
					/>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => void save()}
							disabled={busy || !draft.trim()}
							className="rounded-control bg-accent px-2.5 py-1 text-label font-medium text-on-accent enabled:hover:bg-accent-hover disabled:cursor-default disabled:opacity-50"
						>
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setEditing(false);
								setDraft(note.text);
							}}
							disabled={busy}
							className="rounded-control px-2.5 py-1 text-label font-medium text-dim hover:bg-hover hover:text-fg"
						>
							Cancel
						</button>
						<span className="text-meta text-faint">⌘↵ to save · Esc to cancel</span>
					</div>
				</div>
			) : (
				<>
					{note.text && (
						<div className="whitespace-pre-wrap text-body leading-relaxed text-fg">
							<MentionText text={note.text} />
						</div>
					)}
					{!!note.images?.length && (
						<div className="mt-2 flex flex-wrap gap-2">
							{note.images.map((src, index) => (
								<button
									key={src}
									type="button"
									className="focus-ring block cursor-zoom-in rounded-lg leading-[0]"
									onClick={(event) =>
										openLightbox(
											note.images!.map((image) => ({ kind: "image", src: image })),
											index,
											event.currentTarget,
										)
									}
									aria-label="Open note image"
								>
									<img
										src={src}
										alt=""
										loading="lazy"
										className="max-h-60 max-w-full rounded-lg border border-line-strong object-contain"
									/>
								</button>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
