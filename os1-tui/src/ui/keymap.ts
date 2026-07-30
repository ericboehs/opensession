/**
 * The tmux keymap, as a pure state machine.
 *
 * Two things make this worth isolating from the components: the prefix
 * (`ctrl+b`, then a key) is genuinely stateful, and modal keys mean the same
 * keystroke does different things depending on where focus is. Both are exactly
 * the kind of logic that rots silently inside a render function — here a test
 * can drive every path with plain objects.
 */

export type Pane = "sidebar" | "transcript" | "composer";

export type Mode =
	/** Moving around: sidebar/transcript focused, keys are commands. */
	| "nav"
	/** Typing a prompt. Printable keys belong to the input. */
	| "composer"
	/** An AskUserQuestion card is up; number keys pick an option. */
	| "ask"
	/** tmux copy-mode: scrolling the transcript. */
	| "scroll"
	/** Fuzzy session picker (^b w). */
	| "picker"
	/** Command prompt (^b :). */
	| "command"
	/** Help overlay (^b ?). */
	| "help";

export type Action =
	| { type: "next-tab" }
	| { type: "prev-tab" }
	| { type: "jump-tab"; index: number }
	| { type: "focus-pane"; direction: "next" | "prev" }
	| { type: "move-cursor"; delta: number }
	| { type: "open-selected" }
	| { type: "new-session" }
	| { type: "close-tab" }
	| { type: "cancel-run" }
	| { type: "rename" }
	| { type: "archive" }
	| { type: "detach" }
	| { type: "reconnect" }
	| { type: "toggle-help" }
	| { type: "open-picker" }
	| { type: "open-command" }
	| { type: "enter-scroll" }
	| { type: "exit-mode" }
	| {
			type: "scroll";
			by: "line-up" | "line-down" | "page-up" | "page-down" | "top" | "bottom";
	  }
	| { type: "load-earlier" }
	| { type: "focus-composer" }
	| { type: "submit"; busyMode: "queue" | "steer" }
	| { type: "answer-option"; index: number }
	| { type: "toggle-zoom" }
	| { type: "cycle-scope" }
	/** Leave `os`. The sessions keep running on the server. */
	| { type: "quit" }
	/**
	 * ctrl+c. Interrupts the running turn (that's what it means inside a
	 * session) and arms a quit: pressing it again right away exits, which is
	 * what a terminal user reaches for when nothing else has worked.
	 */
	| { type: "interrupt-or-quit" };

/** The subset of OpenTUI's KeyEvent this map reads. */
export type Key = {
	name: string;
	ctrl?: boolean;
	shift?: boolean;
	meta?: boolean;
	option?: boolean;
	sequence?: string;
};

export type KeymapState = {
	mode: Mode;
	pane: Pane;
	/** The prefix has been pressed; the next key is a prefix command. */
	prefixArmed: boolean;
};

export type Resolution = {
	action?: Action;
	/** Next prefix state. */
	prefixArmed: boolean;
	/** True when this key was a keymap command and must not reach the input. */
	consumed: boolean;
};

export const DEFAULT_PREFIX = "b";

function none(state: KeymapState): Resolution {
	return { prefixArmed: state.prefixArmed, consumed: false };
}

function act(action: Action, prefixArmed = false): Resolution {
	return { action, prefixArmed, consumed: true };
}

/**
 * The prefix command table — tmux's, with OpenSession verbs where tmux has no
 * equivalent. Shared by every mode: `^b d` detaches even mid-typing, which is
 * what tmux users expect.
 */
function prefixCommand(key: Key, prefix: string): Resolution {
	// `^b ^b` is how you cancel an armed prefix.
	if (key.ctrl && key.name === prefix) return act({ type: "exit-mode" });
	if (key.name >= "0" && key.name <= "9" && key.name.length === 1 && !key.ctrl) {
		return act({ type: "jump-tab", index: Number(key.name) });
	}
	switch (key.name) {
		case "c":
			return act({ type: "new-session" });
		case "n":
			return act({ type: "next-tab" });
		case "p":
			return act({ type: "prev-tab" });
		case "o":
			return act({ type: "focus-pane", direction: "next" });
		case ";":
			return act({ type: "focus-pane", direction: "prev" });
		case "f":
			return act({ type: "cycle-scope" });
		case "q":
			return act({ type: "quit" });
		case "w":
			return act({ type: "open-picker" });
		case "x":
			return act({ type: "cancel-run" });
		case "&":
			return act({ type: "close-tab" });
		case ",":
			return act({ type: "rename" });
		case "z":
			return act({ type: "toggle-zoom" });
		case "d":
			return act({ type: "detach" });
		case "r":
			return act({ type: "reconnect" });
		case "a":
			return act({ type: "archive" });
		case "[":
			return act({ type: "enter-scroll" });
		case "?":
		case "/":
			return act({ type: "toggle-help" });
		case ":":
			return act({ type: "open-command" });
		case "escape":
			return act({ type: "exit-mode" });
		default:
			// Unknown prefix key: swallow it (tmux beeps) rather than letting it
			// fall through into the composer as text.
			return { prefixArmed: false, consumed: true };
	}
}

/**
 * Movement that works from every mode, including mid-typing.
 *
 * **alt/option+arrows** are the primary binding: ctrl+arrows are already spoken
 * for almost everywhere `os` runs — tmux binds them to pane resize, iTerm2 and
 * Terminal.app to word-jump, and an outer tmux swallows them before the app
 * ever sees them. They stay as an alias for terminals that do pass them
 * through, so nobody's muscle memory breaks. Letter chords (ctrl+h/j/k/l) are
 * deliberately *not* bound: ctrl+h is backspace and ctrl+j is a newline on
 * every terminal, so binding them would break typing in the composer.
 *
 * Prefixed movement (`^b o`, `^b n`/`^b p`) is the always-available fallback
 * when a terminal eats both modifiers.
 */
function globalMovement(key: Key): Resolution | undefined {
	const alt = !!(key.meta || key.option);
	if (!key.ctrl && !alt) return undefined;
	switch (key.name) {
		case "left":
			return act({ type: "prev-tab" });
		case "right":
			return act({ type: "next-tab" });
		case "up":
			return act({ type: "focus-pane", direction: "prev" });
		case "down":
			return act({ type: "focus-pane", direction: "next" });
		default:
			return undefined;
	}
}

export function resolveKey(
	key: Key,
	state: KeymapState,
	prefix: string = DEFAULT_PREFIX,
): Resolution {
	// 1. An armed prefix wins over everything.
	if (state.prefixArmed) return prefixCommand(key, prefix);

	// 2. Arm the prefix.
	if (key.ctrl && key.name === prefix) {
		return { prefixArmed: true, consumed: true };
	}

	// 3. ctrl+c, from every mode. The renderer has exitOnCtrlC off (inside a
	//    session ^c means "interrupt the turn"), which used to leave it doing
	//    nothing at all — the first thing anyone presses when they want out.
	//    It now interrupts *and* arms a quit; the app decides which.
	if (key.ctrl && key.name === "c") {
		return act({ type: "interrupt-or-quit" });
	}

	// 4. Modified enter steers, from inside the composer. ctrl+enter needs the
	//    kitty keyboard protocol to be distinguishable from a bare CR at all (we
	//    ask for it at startup); alt/option+enter is an ESC-prefixed sequence that
	//    every terminal reports, so it's the portable alias.
	if (
		(key.ctrl || key.meta || key.option) &&
		(key.name === "return" || key.name === "enter") &&
		state.mode === "composer"
	) {
		return act({ type: "submit", busyMode: "steer" });
	}

	// 5. Global movement (alt+arrows, ctrl+arrows) — deliberately ahead of the
	//    per-mode tables so it works while typing.
	const movement = globalMovement(key);
	if (movement) return movement;

	switch (state.mode) {
		case "nav":
			switch (key.name) {
				case "up":
					return state.pane === "sidebar"
						? act({ type: "move-cursor", delta: -1 })
						: act({ type: "scroll", by: "line-up" });
				case "down":
					return state.pane === "sidebar"
						? act({ type: "move-cursor", delta: 1 })
						: act({ type: "scroll", by: "line-down" });
				case "k":
					return act({ type: "move-cursor", delta: -1 });
				case "j":
					return act({ type: "move-cursor", delta: 1 });
				case "return":
				case "enter":
					return state.pane === "sidebar"
						? act({ type: "open-selected" })
						: act({ type: "focus-composer" });
				case "i":
					return act({ type: "focus-composer" });
				case "pageup":
					return act({ type: "scroll", by: "page-up" });
				case "pagedown":
					return act({ type: "scroll", by: "page-down" });
				case "g":
					return act({ type: "scroll", by: key.shift ? "bottom" : "top" });
				case "tab":
					return act({
						type: "focus-pane",
						direction: key.shift ? "prev" : "next",
					});
				case "f":
					return act({ type: "cycle-scope" });
				case "?":
					return act({ type: "toggle-help" });
				case "q":
					// Quit from plain nav: sessions run on the server, so leaving
					// costs nothing and "q" is the first key anyone tries.
					return act({ type: "quit" });
				case "escape":
					return act({ type: "exit-mode" });
				default:
					return none(state);
			}

		case "composer":
			if (key.name === "escape") return act({ type: "exit-mode" });
			if (key.name === "return" || key.name === "enter") {
				// Shift+enter is a newline in the input, not a send.
				if (key.shift) return none(state);
				return act({ type: "submit", busyMode: "queue" });
			}
			// Everything else is text for the input.
			return none(state);

		case "ask":
			if (key.name >= "1" && key.name <= "9" && key.name.length === 1) {
				return act({ type: "answer-option", index: Number(key.name) - 1 });
			}
			if (key.name === "escape") return act({ type: "exit-mode" });
			if (key.name === "i") return act({ type: "focus-composer" });
			return none(state);

		case "scroll":
			switch (key.name) {
				case "up":
				case "k":
					return act({ type: "scroll", by: "line-up" });
				case "down":
				case "j":
					return act({ type: "scroll", by: "line-down" });
				case "pageup":
					return act({ type: "scroll", by: "page-up" });
				case "pagedown":
				case "space":
					return act({ type: "scroll", by: "page-down" });
				case "g":
					return act({ type: "scroll", by: key.shift ? "bottom" : "top" });
				case "b":
					return act({ type: "load-earlier" });
				case "q":
				case "escape":
					return act({ type: "exit-mode" });
				default:
					// Copy-mode swallows stray keys instead of scrolling by accident.
					return { prefixArmed: false, consumed: true };
			}

		case "picker":
		case "command":
			if (key.name === "escape") return act({ type: "exit-mode" });
			if (key.name === "return" || key.name === "enter") {
				return act({ type: "open-selected" });
			}
			if (key.name === "up") return act({ type: "move-cursor", delta: -1 });
			if (key.name === "down") return act({ type: "move-cursor", delta: 1 });
			return none(state);

		case "help":
			// Any key dismisses help — it's a reference, not a mode you work in.
			return act({ type: "toggle-help" });
	}
}

/** Rows for the help overlay and the README, kept in one place. */
export const KEY_HELP: { keys: string; label: string }[] = [
	{ keys: "q · ^b q", label: "quit (sessions keep running on the server)" },
	{ keys: "ctrl+c", label: "interrupt the turn · again to quit" },
	{ keys: "alt+←/→", label: "previous / next tab (ctrl+←/→ too)" },
	{ keys: "alt+↑/↓", label: "focus pane (sidebar · transcript · composer)" },
	{ keys: "tab · ^b o", label: "focus the next pane" },
	{ keys: "↑/↓ · j/k", label: "move in the focused pane" },
	{ keys: "enter", label: "open session · focus composer" },
	{ keys: "i", label: "jump to the composer" },
	{ keys: "enter (composer)", label: "send — queues behind a running turn" },
	{ keys: "ctrl+enter · alt+enter", label: "send as a steer instead" },
	{ keys: "1…9", label: "answer a pending question" },
	{ keys: "f · ^b f", label: "sidebar scope: mine → team → all" },
	{ keys: "^b c", label: "new session" },
	{ keys: "^b w", label: "session picker" },
	{ keys: "^b n · ^b p", label: "next · previous tab" },
	{ keys: "^b 0…9", label: "jump to tab" },
	{ keys: "^b x", label: "cancel the running turn" },
	{ keys: "^b &", label: "close tab" },
	{ keys: "^b ,", label: "rename session" },
	{ keys: "^b a", label: "archive session" },
	{ keys: "^b z", label: "zoom the transcript" },
	{ keys: "^b [", label: "scroll mode (b loads earlier, q exits)" },
	{ keys: "^b :", label: "command prompt" },
	{ keys: "^b r", label: "reconnect" },
	{ keys: "^b d", label: "detach (same as quit)" },
	{ keys: "^b ?", label: "this help" },
];
