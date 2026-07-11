// Binds the pure VimEngine (lib/vim) to the composer's controlled textarea.
// The engine never touches the DOM: this hook feeds it keydowns with the
// current { text, selection }, routes text changes through the parent's
// onChange (keeping React the owner of the value) and applies the returned
// selection after the commit. Toggling the pref off mid-session drops the
// engine — and any half-typed command state — back to plain typing.

import { useEffect, useRef, useState } from "react";
import { VimEngine, type VimMode } from "../lib/vim";

export function useVimMode({
	enabled,
	textareaRef,
	value,
	onChange,
}: {
	enabled: boolean;
	textareaRef: React.RefObject<HTMLTextAreaElement | null>;
	value: string;
	onChange: (value: string) => void;
}): {
	mode: VimMode;
	/** Returns true when the key was consumed (caller must not process it further). */
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
} {
	const engineRef = useRef<VimEngine | null>(null);
	const [mode, setMode] = useState<VimMode>("insert");

	useEffect(() => {
		if (!enabled) {
			engineRef.current = null;
			setMode("insert");
		}
	}, [enabled]);

	function handleKeyDown(e: React.KeyboardEvent): boolean {
		if (!enabled) return false;
		const el = textareaRef.current;
		if (!el) return false;
		if (!engineRef.current) engineRef.current = new VimEngine();
		const engine = engineRef.current;
		const res = engine.handleKey(e, {
			text: value,
			start: el.selectionStart,
			end: el.selectionEnd,
		});
		setMode(engine.mode);
		if (!res) return false;
		e.preventDefault();
		if (res.text !== value) onChange(res.text);
		// Apply the selection after React commits the (possibly new) value —
		// setting it before the value lands would clamp against the old text.
		queueMicrotask(() => {
			textareaRef.current?.setSelectionRange(res.start, res.end);
		});
		return true;
	}

	return { mode, handleKeyDown };
}
