import React, { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
	EditorView,
	keymap,
	drawSelection,
	ViewPlugin,
	Decoration,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
	autocompletion,
	completionKeymap,
	type CompletionContext,
} from "@codemirror/autocomplete";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { UndoManager } from "yjs";
import { createNoteSync, type NoteSync } from "../lib/notes-sync";
import { fetchWikiTree } from "../lib/api";
import type { WSClientMessage, WSServerMessage } from "../lib/types";

export type MentionKind = "session" | "note" | "doc";

export interface MentionItem {
	kind: MentionKind;
	id: string; // session id / note id / doc path
	label: string;
}

interface Props {
	noteId: string;
	user: string;
	/** True while the app WebSocket is open; gates/re-fires the room join. */
	connected: boolean;
	send: (msg: WSClientMessage) => void;
	addHandler: (h: (msg: WSServerMessage) => void) => () => void;
	/** Candidates for @-mentions; docs are lazy-loaded internally. */
	sessions: { id: string; title: string }[];
	notes: { id: string; title: string }[];
	/** Click on a rendered mention chip → navigate. */
	onOpenMention: (kind: MentionKind, target: string) => void;
}

const ICON: Record<MentionKind, string> = {
	session: "💬",
	note: "📝",
	doc: "📄",
};

const MENTION_RE = /\[([^\]]+)\]\((session|note|doc):([^)]+)\)/g;

/** Atomic, clickable inline chip replacing `[label](kind:target)` markdown. */
class ChipWidget extends WidgetType {
	constructor(
		readonly kind: MentionKind,
		readonly target: string,
		readonly label: string,
		readonly navRef: React.MutableRefObject<Props["onOpenMention"]>,
	) {
		super();
	}
	eq(o: ChipWidget) {
		return (
			o.kind === this.kind && o.target === this.target && o.label === this.label
		);
	}
	toDOM() {
		const span = document.createElement("span");
		span.className = `note-chip note-chip-${this.kind}`;
		span.textContent = `${ICON[this.kind]} ${this.label}`;
		span.title = `${this.kind}: ${this.target}`;
		span.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.navRef.current(this.kind, this.target);
		});
		return span;
	}
	ignoreEvent() {
		return false; // let our mousedown handler run
	}
}

function buildChips(
	view: EditorView,
	navRef: React.MutableRefObject<Props["onOpenMention"]>,
): DecorationSet {
	const ranges: { from: number; to: number; deco: any }[] = [];
	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		MENTION_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = MENTION_RE.exec(text))) {
			const start = from + m.index;
			const end = start + m[0].length;
			ranges.push({
				from: start,
				to: end,
				deco: Decoration.replace({
					widget: new ChipWidget(m[2] as MentionKind, m[3], m[1], navRef),
				}),
			});
		}
	}
	return Decoration.set(
		ranges.map((r) => r.deco.range(r.from, r.to)),
		true,
	);
}

function chipPlugin(navRef: React.MutableRefObject<Props["onOpenMention"]>) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildChips(view, navRef);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged)
					this.decorations = buildChips(u.view, navRef);
			}
		},
		{
			decorations: (v) => v.decorations,
			// Make chips behave as a single unit for the caret (skip/delete whole).
			provide: (plugin) =>
				EditorView.atomicRanges.of(
					(view) => view.plugin(plugin)?.decorations || Decoration.none,
				),
		},
	);
}

// Colors are driven off the app's CSS variables (set on html[data-theme]) so the
// editor follows Light/Dark instead of being locked to the old dark palette —
// hardcoded light-on-dark text was invisible on the light surface.
const noteTheme = EditorView.theme({
	"&": { color: "var(--text)", backgroundColor: "transparent", height: "100%" },
	".cm-content": {
		fontFamily: "Menlo, Monaco, 'Courier New', monospace",
		fontSize: "14px",
		lineHeight: "1.6",
		padding: "16px 18px",
		caretColor: "var(--text)",
	},
	".cm-scroller": { overflow: "auto" },
	"&.cm-focused": { outline: "none" },
	".cm-cursor": { borderLeftColor: "var(--text)" },
	".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
		backgroundColor: "var(--bg-active)",
	},
	".cm-line": { padding: "0" },
});

const noteHighlight = HighlightStyle.define([
	{
		tag: t.heading1,
		color: "var(--text)",
		fontWeight: "700",
		fontSize: "19px",
	},
	{
		tag: t.heading2,
		color: "var(--text)",
		fontWeight: "700",
		fontSize: "19px",
	},
	{
		tag: [t.heading3, t.heading4, t.heading5, t.heading6],
		color: "var(--text)",
		fontWeight: "700",
	},
	{ tag: t.strong, color: "var(--text)", fontWeight: "700" },
	{ tag: t.emphasis, fontStyle: "italic" },
	{ tag: t.link, color: "var(--accent)" },
	{ tag: t.url, color: "var(--accent)" },
	{ tag: t.list, color: "var(--text-dim)" },
	{ tag: t.quote, color: "var(--text-dim)" },
	{ tag: t.monospace, color: "var(--purple)" },
	{ tag: t.strikethrough, textDecoration: "line-through" },
]);

export function NoteEditor({
	noteId,
	user,
	connected,
	send,
	addHandler,
	sessions,
	notes,
	onOpenMention,
}: Props) {
	const hostRef = useRef<HTMLDivElement | null>(null);

	// Join the note room once the socket is open, and re-join on reconnect. The
	// server replies with a full `note_state` sync, which the inbound handler in
	// createNoteSync applies. Sending before the socket opens would be dropped.
	useEffect(() => {
		if (connected) send({ type: "watch_note", noteId, user });
	}, [connected, noteId, user, send]);

	// Latest props for closures inside the (long-lived) CodeMirror instance.
	const navRef = useRef(onOpenMention);
	navRef.current = onOpenMention;
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	const notesRef = useRef(notes);
	notesRef.current = notes;
	const docsRef = useRef<MentionItem[]>([]);

	// Lazy-load wiki docs once for the mention picker.
	useEffect(() => {
		let alive = true;
		fetchWikiTree()
			.then((tree) => {
				if (!alive) return;
				const out: MentionItem[] = [];
				const walk = (nodes: any[]) => {
					for (const n of nodes) {
						if (n.type === "file")
							out.push({
								kind: "doc",
								id: n.path,
								label: n.name.replace(/\.(md|mdx)$/, ""),
							});
						else if (n.children) walk(n.children);
					}
				};
				walk(Array.isArray(tree) ? tree : []);
				docsRef.current = out;
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);

	// (Re)build the editor whenever the open note changes.
	useEffect(() => {
		if (!hostRef.current) return;
		let sync: NoteSync;
		try {
			sync = createNoteSync({ noteId, user, send, addHandler });
		} catch (e) {
			console.error("[NoteEditor] sync init failed:", e);
			return;
		}
		const undoManager = new UndoManager(sync.ytext);

		const mentionSource = (ctx: CompletionContext) => {
			const word = ctx.matchBefore(/@[\w-]*/);
			if (!word || (word.from === word.to && !ctx.explicit)) return null;
			const q = word.text.slice(1).toLowerCase();
			const all: MentionItem[] = [
				...sessionsRef.current.map((s) => ({
					kind: "session" as const,
					id: s.id,
					label: s.title,
				})),
				...notesRef.current
					.filter((n) => n.id !== noteId)
					.map((n) => ({ kind: "note" as const, id: n.id, label: n.title })),
				...docsRef.current,
			];
			const options = all
				.filter((o) => o.label.toLowerCase().includes(q))
				.slice(0, 20)
				.map((o) => ({
					label: `${ICON[o.kind]} ${o.label}`,
					type: o.kind,
					apply: `[${o.label}](${o.kind}:${o.id})`,
				}));
			// We've already filtered by the typed query; tell CM not to re-filter
			// (its default match runs against the option labels and would discard
			// everything, since the labels don't contain the leading "@").
			return { from: word.from, options, filter: false };
		};

		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: sync.ytext.toString(),
				extensions: [
					history(),
					drawSelection(),
					EditorView.lineWrapping,
					markdown(),
					syntaxHighlighting(noteHighlight),
					noteTheme,
					autocompletion({ override: [mentionSource] }),
					chipPlugin(navRef),
					yCollab(sync.ytext, sync.awareness, { undoManager }),
					keymap.of([
						...yUndoManagerKeymap,
						...completionKeymap,
						...defaultKeymap,
						...historyKeymap,
					]),
				],
			}),
		});

		return () => {
			view.destroy();
			sync.destroy();
		};
	}, [noteId, user, send, addHandler]);

	return <div className="note-cm" ref={hostRef} />;
}

export default NoteEditor;
